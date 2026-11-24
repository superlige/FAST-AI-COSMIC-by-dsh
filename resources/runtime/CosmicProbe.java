import kd.bos.context.RequestContext;
import kd.bos.dc.api.model.Account;
import kd.bos.dc.utils.AccountUtils;
import kd.bos.threads.ThreadPools;

import java.lang.reflect.Method;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 探针宿主：把一段普通 Java 代码放进「能访问苍穹业务库」的环境里执行。
 *
 * 干了三件苍穹强制要求、少一件就跑不起来的事：
 * 1. 照工程自己的启动类把环境的系统属性设好（老模板调 devRemote() 这类只配置的方法，新模板调 main，
 *    main 里的 start() 走到空替身 Booter.main 就返回），不起 Jetty；
 * 2. 建好 RequestContext（租户 + 账套 + 用户），否则 ORM 不知道连哪个库；
 * 3. 把探针代码丢进 ThreadPools 创建的线程里跑 —— 苍穹禁止在 main 线程访问数据库，
 *    直接在 main 里查会抛 "Please use the thread pool utils (kd.bos.threads.ThreadPools)"。
 * 外加一件不强制但少了就废掉一半能力的：装 {@link ServiceBridge}，
 * 否则任何走 RPC 分发的 API（executeOperate / FormView.activate …）一律抛 ServiceLookup not implemented。
 *
 * 用法：java -cp <probe-dir>;build/cosmic-pathing.jar CosmicProbe <探针类名>
 * 探针类需要有 public static void run() throws Exception。
 *
 * 工程相关的配置（账套 / 用户 / 租户 / 启动类）全部由 driver.mjs 以 -Dcosmic.* 传进来，
 * 值来自 config.mjs：能从工程文件探测的自动探测，探不出来的从 skill 根目录的 config.json 读。
 * **这里一个默认值都不写死** —— 写死了就等于「换台机器不改配置也能跑，只是跑错了」，
 * 而账套选错、用户 id 选错这两件事都不会报错，只会把结果和「修改人」悄悄记到别处。
 *
 * 环境变量（单次覆盖 -D 传进来的值）：
 *   COSMIC_ACCOUNT  账套编码或账套 id
 *   COSMIC_USER     用户 id。写元数据/写业务数据时它就是落库的「修改人」。查 id 用 UserProbe。
 */
public class CosmicProbe {

    /** 以下五项由 driver.mjs 传入，缺任何一项都会在 initEnv() 里带着修复指引中止 */
    static final String DEFAULT_ACCOUNT = System.getProperty("cosmic.account");
    static final String DEFAULT_USER = System.getProperty("cosmic.user");
    static final String TENANT = System.getProperty("cosmic.tenant", "ierp");
    /** 调试启动类全限定名，以及它里面那个「只配置、不 start()」的方法 */
    static final String APP_CLASS = System.getProperty("cosmic.appClass");
    static final String APP_METHOD = System.getProperty("cosmic.appMethod");

    public static void main(String[] args) throws Exception {
        if (args.length < 1) {
            System.err.println("usage: CosmicProbe <ProbeClassName>");
            System.exit(2);
        }
        initEnv();

        String want = env("COSMIC_ACCOUNT", DEFAULT_ACCOUNT);
        String accountId = resolveAccount(want);
        if (accountId == null) {
            System.err.println("[PROBE-ERR] 找不到账套：" + want);
            printAccountChoices();
            System.exit(3);
        }

        RequestContext rc = RequestContext.create();
        rc.setTenantId(TENANT);
        rc.setAccountId(accountId);
        rc.setUserId(env("COSMIC_USER", DEFAULT_USER));
        RequestContext.set(rc);
        System.out.println("[PROBE] tenant=" + TENANT + " account=" + want + "(" + accountId + ")");

        int code = runInPool(args[0]);
        //苍穹起了一堆非守护线程，不显式退出会一直挂着
        System.exit(code);
    }

    /**
     * 只设置系统属性，不启动 Jetty —— 复用工程自己的启动类（cosmic.appClass#cosmic.appMethod，
     * 老模板是 DebugApplication.devRemote()，新模板是 DebugApplication.main），避免和它的配置漂移。
     * 包可见：CosmicProbeServer（常驻宿主）复用同一套初始化，两条路径不能漂移
     */
    static void initEnv() throws Exception {
        requireConfig();
        //要赶在平台第一次建数据源之前：连接串模板只读一次
        tuneDbLink();
        configureLikeTheProject();
        prewarmLocalHostLookup();
        //调度服务只有请求点名时才起（startSchedule），起了也只当执行节点：不选主、不触发环境里的定时计划。
        //部署模式在调度配置类第一次加载时读一次，所以在这里先设好；环境自己配了就用环境的，startSchedule 会拒绝起。
        if (System.getProperty(SCHEDULE_MODE_KEY) == null) {
            System.setProperty(SCHEDULE_MODE_KEY, SCHEDULE_MODE);
        }
        //装在这里而不是每个探针里：冷探针和常驻宿主都从 initEnv() 进，两条路径不会漂移。
        //装不上不中止 —— 不用分发的探针照跑，用到分发的那个会在自己的报错里看到这条原因。
        String bridge = ServiceBridge.install();
        if (!ServiceBridge.ok()) {
            System.out.println("[PROBE] 服务分发桥 " + bridge
                    + "（走 RPC 分发的 API 会抛 ServiceLookup not implemented）");
        }
    }

    /**
     * 照工程自己的启动类把系统属性设好。两种启动类：
     * 配置写在单独方法里的（老模板的 devRemote()），只调那个方法；
     * 配置和 start() 都写在 main 里的（新模板，cosmic.appMethod=main），调 main ——
     * start() 最后调的 Booter.main 在探针进程里是个空替身（同目录 Booter.java），走到那里就返回，不起服务。
     */
    private static void configureLikeTheProject() throws Exception {
        Class<?> app = Class.forName(APP_CLASS);
        if (!"main".equals(APP_METHOD)) {
            Method m = app.getDeclaredMethod(APP_METHOD);
            m.setAccessible(true);
            m.invoke(null);
            return;
        }
        Method main = app.getDeclaredMethod("main", String[].class);
        main.setAccessible(true);
        main.invoke(null, (Object) new String[0]);
        if (!"true".equals(System.getProperty(kd.bos.service.bootstrap.Booter.REACHED))) {
            System.out.println("[PROBE] " + APP_CLASS + ".main 跑完了，却没走到起服务那一步（Booter.main）："
                    + "它设的配置可能不全。在工程配置里把 appMethod 换成只配置、不启动的那个方法名");
        }
    }

    /**
     * 「把每个进程第一次用才付的账提前付」这一类做法的总开关，只给对照测量和排查用：
     * 启动参数 -Dcosmic.prewarm=off 时，本机名反查、编译器热身、许可信息预读都不做，探针产物也不跨进程沿用。
     */
    static boolean prewarmOn() {
        return !"off".equals(System.getProperty("cosmic.prewarm"));
    }

    /**
     * 平台带的 ClickHouse 驱动第一次建客户端时，会把本机每块网卡的每个地址都反查一遍主机名，结果记在它的静态字段里。
     * 机器上有虚拟网卡（VPN、蓝牙、Wi-Fi 直连）时，每个 IPv6 本地地址要等约 0.8 秒才查不出来，真机上合计 4.4 秒，
     * 而且正卡在平台建第一个数据源的路上。这里在后台先建一个客户端（构造函数除了这次反查什么都不做），
     * 和读配置中心同时进行；平台走到那一步时用的是已经记好的结果。
     * 类路径上没有这个驱动、或者建不出来，就什么都不做。
     */
    private static void prewarmLocalHostLookup() {
        if (!prewarmOn()) {
            return;
        }
        Thread warm = new Thread(() -> {
            try {
                Class.forName("com.clickhouse.client.http.ClickHouseHttpClient", true,
                        CosmicProbe.class.getClassLoader()).getConstructor().newInstance();
            } catch (Throwable absent) {
                //没有这个驱动的平台版本不用热
            }
        }, "cosmic-prewarm-localhost");
        warm.setDaemon(true);
        warm.start();
    }

    /** 连库方式定下来以后的一句话，放在这个系统属性里，常驻宿主记进自己的日志 */
    static final String DB_LINK_STATE = "cosmic.dbLink.state";
    private static final String DB_URL_TEMPLATE = "jdbc_url_generator/mysql.xml";

    /**
     * 本机进程离数据库远，平台默认的连库方式在这里成了等待：每条 SQL 来回三趟（预编译放在服务器做、游标分批取结果），
     * 取回来的内容不压缩。平台按数据库引擎包里的 jdbc_url_generator/mysql.xml 拼连接串，这几项是模板里写死的默认值，
     * 配置中心改不了。这里把平台自己的那份模板取出来、只改三项，放到类路径最前面的目录（本类所在的目录）顶掉它：
     * useServerPrepStmts=false、useCursorFetch=false（一条 SQL 一趟发完），useCompression=true（传输压缩）。
     * 真机上四个只读探针跑两遍 14.4 秒降到 4.2 秒，第一次打开检测单 69 秒降到 22.6 秒。
     *
     * 模板每个平台版本可能不一样，所以每次都从平台包里现取，不带一份自己的；找不到要改的项就不顶，照平台默认连。
     * -Dcosmic.dbLink=platform 时也不顶，并把以前放的那份删掉。出任何岔子都退回平台默认，不拦启动。
     */
    static String tuneDbLink() {
        String state;
        java.io.File target = null;
        try {
            java.io.File home = new java.io.File(
                    CosmicProbe.class.getProtectionDomain().getCodeSource().getLocation().toURI());
            if (!home.isDirectory()) {
                state = "平台默认（宿主不是从目录加载的，没处放模板）";
            } else {
                target = new java.io.File(home, DB_URL_TEMPLATE);
                state = "platform".equals(System.getProperty("cosmic.dbLink", "fast"))
                        ? "平台默认（配置里关了）"
                        : installDbUrlTemplate(target);
            }
        } catch (Throwable failed) {
            state = "平台默认（没换成：" + failed + "）";
        }
        if (target != null && state.startsWith("平台默认") && target.exists() && !target.delete()) {
            state = "不确定（该用平台默认，但以前放的模板删不掉：" + target + "）";
        }
        System.setProperty(DB_LINK_STATE, state);
        return state;
    }

    private static String installDbUrlTemplate(java.io.File target) throws Exception {
        java.net.URL platform = null;
        java.util.Enumeration<java.net.URL> all = CosmicProbe.class.getClassLoader().getResources(DB_URL_TEMPLATE);
        while (all.hasMoreElements()) {
            java.net.URL candidate = all.nextElement();
            //目录里的那份是自己上次放的，要的是平台包里的原件
            if ("jar".equals(candidate.getProtocol())) {
                platform = candidate;
                break;
            }
        }
        if (platform == null) {
            return "平台默认（平台包里没找到连接串模板）";
        }
        java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
        java.net.URLConnection opened = platform.openConnection();
        //不走 jar 缓存：缓存会把平台包一直开着，Windows 上别的进程就替换不了它
        opened.setUseCaches(false);
        java.io.InputStream in = opened.getInputStream();
        try {
            byte[] buffer = new byte[8192];
            for (int n = in.read(buffer); n >= 0; n = in.read(buffer)) {
                bytes.write(buffer, 0, n);
            }
        } finally {
            in.close();
        }
        String original = new String(bytes.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
        String prepare = "(<kv\\s+key=\"useServerPrepStmts\"\\s+value=\")true(\"\\s*/>)";
        String cursor = "(<kv\\s+key=\"useCursorFetch\"\\s+value=\")true(\"\\s*/>)";
        String compress = "(<kv\\s+key=\"useCompression\"\\s+value=\")[^\"]*(\"\\s*/>)";
        if (!java.util.regex.Pattern.compile(prepare).matcher(original).find()
                || !java.util.regex.Pattern.compile(cursor).matcher(original).find()) {
            return "平台默认（平台的连接串模板里没有要改的那两项，这个版本的写法变了）";
        }
        String tuned = original.replaceAll(cursor, "$1false$2");
        tuned = java.util.regex.Pattern.compile(compress).matcher(tuned).find()
                ? tuned.replaceAll(compress, "$1true$2")
                : tuned.replaceAll(prepare, "$1true$2<kv key=\"useCompression\" value=\"true\"/>");
        tuned = tuned.replaceAll(prepare, "$1false$2");
        byte[] wanted = tuned.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        //内容没变就不重写：冷进程和常驻进程都走这里，别互相踩
        if (!target.isFile() || !java.util.Arrays.equals(java.nio.file.Files.readAllBytes(target.toPath()), wanted)) {
            target.getParentFile().mkdirs();
            java.io.File fresh = java.io.File.createTempFile("mysql", ".xml", target.getParentFile());
            java.nio.file.Files.write(fresh.toPath(), wanted);
            java.nio.file.Files.move(fresh.toPath(), target.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
        return "一趟发完、传输压缩（预编译在本机做、不用游标）";
    }

    static final String SCHEDULE_MODE_KEY = "Schedule.deployMode";
    static final String SCHEDULE_MODE = "EXECUTE_NODE";
    /**
     * 提交发起工作流、异步后台任务要的三个平台服务，取自环境的 bos.lifecycle.servicelist，按它写的依赖顺序
     * （wfengineservice 依赖 scheduleservice、executorservice）。清单里其余几项是网页端和监控，探针用不上。
     * IDEA 启动的苍穹由 Booter.main 按那份清单全起；探针宿主只调启动类的配置方法，一个都不起，
     * 平台派发后台任务时报「调度服务已停止」，提交照样成功、流程却没发起。
     */
    private static final String[] SCHEDULE_SERVICES = {
            "kd.bos.schedule.server.ScheduleService",
            "kd.bos.schedule.executor.ExecutorService",
            "kd.bos.workflow.service.impl.WorkflowEngineService",
    };

    /**
     * 起调度服务，只当执行节点：派发和执行后台任务（发起工作流就是一个），不参加选主，
     * 所以不触发环境里的定时计划，也不跑选主节点那套改调度表的初始化。
     * 起了停不下来（停了执行服务，已派出去的任务就没人接），开到进程退出。每个进程只该调一次。
     *
     * @return 给人看的一句状态；起不全就抛异常，说清哪个没起来
     */
    static String startSchedule() throws Exception {
        Object mode = kd.bos.schedule.zk.ZkConfig.getDeployMode();
        if (!SCHEDULE_MODE.equals(String.valueOf(mode))) {
            throw new IllegalStateException("调度部署模式是 " + mode + "，不是 " + SCHEDULE_MODE
                    + "：这样起会参加选主、触发环境里的定时计划，不起。模式来自环境配置 " + SCHEDULE_MODE_KEY);
        }
        StringBuilder bad = new StringBuilder();
        for (String name : SCHEDULE_SERVICES) {
            kd.bos.framework.lifecycle.Service service =
                    (kd.bos.framework.lifecycle.Service) Class.forName(name).newInstance();
            service.start();
            if (!service.isStarted()) {
                bad.append(' ').append(name.substring(name.lastIndexOf('.') + 1));
            }
        }
        if (bad.length() > 0) {
            throw new IllegalStateException("调度服务没起全，没起来的：" + bad.toString().trim());
        }
        return "调度服务已启动（执行节点，不选主），开到常驻进程退出";
    }

    /**
     * 缺配置就带着修复指引中止。放在 initEnv() 里 —— 冷探针和常驻宿主都从这里进，
     * 一个入口挡住两条路径，不会出现「常驻那条忘了校验」。
     */
    static void requireConfig() {
        StringBuilder miss = new StringBuilder();
        if (blank(APP_CLASS)) miss.append("\n  cosmic.appClass   调试启动类全限定名");
        if (blank(APP_METHOD)) miss.append("\n  cosmic.appMethod  启动类里「只配置不 start()」的那个方法名，配置写在 main 里的填 main");
        if (blank(env("COSMIC_ACCOUNT", DEFAULT_ACCOUNT))) miss.append("\n  cosmic.account    账套编码或账套 id");
        if (blank(env("COSMIC_USER", DEFAULT_USER))) {
            miss.append("\n  cosmic.user       用户 id —— 写操作时它就是落库的修改人，没有默认值是故意的");
        }
        if (miss.length() == 0) {
            return;
        }
        throw new IllegalStateException("探针缺配置：" + miss
                + "\n这些值由 cosmic 按工程配置传入。两种可能："
                + "\n  ① 没经 cosmic 起这个进程（别手工 java -cp … CosmicProbe，用 cosmic_probe）；"
                + "\n  ② 工程配置没配全 —— cosmic_doctor 看缺哪一项。");
    }

    private static boolean blank(String s) {
        return s == null || s.trim().isEmpty();
    }

    /** 入参可以是账套编码也可以是账套 id。包可见，同上 */
    static String resolveAccount(String want) {
        List<Account> accounts = AccountUtils.getAllAccountsOfCurrentEnv();
        if (accounts == null) {
            return null;
        }
        for (Account a : accounts) {
            if (want.equals(a.getAccountNumber()) || want.equals(a.getAccountId())) {
                return a.getAccountId();
            }
        }
        return null;
    }

    /**
     * 账套对不上时把这个环境里能选的账套（数据中心）逐个列出来：给人看的一行，加一条 {"t":"account"} 记录。
     * 配置向导靠这几条让人从列表里选，而不是凭记忆敲编码。列表只要配置中心连得上就拿得到，不需要先有账套。
     */
    static void printAccountChoices() {
        List<Account> accounts;
        try {
            accounts = AccountUtils.getAllAccountsOfCurrentEnv();
        } catch (Throwable failed) {
            System.out.println("[PROBE] 账套列表取不到：" + failed);
            return;
        }
        if (accounts == null || accounts.isEmpty()) {
            System.out.println("[PROBE] 这个环境一个账套都没列出来（配置中心连不上，或租户不对）");
            return;
        }
        System.out.println("[PROBE] 这个环境可选的账套 " + accounts.size() + " 个：");
        for (Account a : accounts) {
            System.out.println("[PROBE]   " + a.getAccountNumber() + "  id=" + a.getAccountId() + "  " + a.getAccountName());
            System.out.println("[PROBE-JSON] {\"t\":\"account\",\"number\":" + jsonText(a.getAccountNumber())
                    + ",\"id\":" + jsonText(a.getAccountId()) + ",\"name\":" + jsonText(a.getAccountName()) + "}");
        }
    }

    private static String jsonText(String s) {
        if (s == null) {
            return "\"\"";
        }
        StringBuilder out = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            if (c == '"' || c == '\\') {
                out.append('\\').append(c);
            } else if (c < 0x20) {
                out.append(String.format("\\u%04x", (int) c));
            } else {
                out.append(c);
            }
        }
        return out.append('"').toString();
    }

    /** 苍穹禁止 main 线程访问数据库，必须借 ThreadPools 的线程 */
    private static int runInPool(String probeClass) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>();
        ThreadPools.executeOnceIncludeRequestContext("cosmic-probe", () -> {
            try {
                Class<?> c = Class.forName(probeClass);
                c.getMethod("run").invoke(null);
            } catch (Throwable t) {
                error.set(t.getCause() != null ? t.getCause() : t);
            } finally {
                done.countDown();
            }
        });
        done.await();
        Throwable t = error.get();
        if (t != null) {
            System.out.println("[PROBE-ERR] " + t);
            //没有栈的异常是探针自己下的结论（断言没过、输入不成立），上面那一行已经是全部
            if (t.getStackTrace().length > 0) {
                t.printStackTrace(System.out);
            }
            return 1;
        }
        System.out.println("[PROBE-OK] " + probeClass);
        return 0;
    }

    static String env(String key, String def) {
        String v = System.getenv(key);
        return v == null || v.trim().isEmpty() ? def : v;
    }
}
