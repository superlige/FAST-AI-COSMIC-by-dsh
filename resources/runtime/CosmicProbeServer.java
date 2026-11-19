import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.io.PrintWriter;
import java.lang.reflect.Field;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.Permission;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.StandardJavaFileManager;
import javax.tools.StandardLocation;
import javax.tools.ToolProvider;

import kd.bos.context.RequestContext;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.threads.ThreadPools;

/**
 * 常驻探针宿主：把「苍穹初始化 + 元数据子系统首次加载」这 30 秒只付一次。
 *
 * 实测拆解（见 reference/probes.md）：一次冷探针 30~37 秒里，javac 5.8s + devRemote 7.9s +
 * 元数据子系统首次初始化 16~23s 全是每次重付的固定开销，真正的业务逻辑不到 1 秒。
 * 元数据那段是**一次性**的 —— 第 1 个实体 16 秒，第 2 个 0.9 秒，第 3 个 71 毫秒。
 * 所以常驻之后每个请求只剩「编译 + 反射调用」，1 秒级。
 *
 * 服务只读探针，以及 S27 起真提交的验证运行（run op / form / print …）：它们走平台正常的保存、
 * 操作路径提交，缓存跟着刷新，和一台整天在提交的真实服务器是一回事。
 * 元数据写入（APPLY=1）S27 1.14 起也在这里写：本地调试是轻量级部署，每个 JVM 的「Redis」是自己的一份，
 * 平台保存清的是写入进程自己的缓存 —— 冷进程写、这里读，这里永远是旧的；这里写，这里马上是新的。
 * 本次确认过的写入目标经 prop= 行带进来（见 REQUEST_PROPS）。绕过平台直接写库的仍由 driver 强制走冷进程。
 *
 * 协议（行文本，UTF-8）：
 *   请求  PROBE / src=<路径> / class=<类名> / account=<账套> / user=<id> / env=<K>=<base64 V> / END
 *         PING      —— 返回状态，给 driver 的 status 用
 *         SYNC      —— 把业务类目录里变了的 .class 换进本进程（S27 3.1），换不进去就回 ERR，driver 退回重起
 *         SHUTDOWN  —— 优雅退出
 *   响应  首行 RESULT <OK|ERR|TIMEOUT|STALE|BUSY|COMPILE_FAIL> <exitCode>，其后是探针的完整输出
 */
public class CosmicProbeServer {

    private static final int DEFAULT_PORT = 8099;
    /** 空闲这么久自动退出 —— 16G 机器上别让人忘了 stop 一直占着 */
    private static final long IDLE_EXIT_MS = 30 * 60 * 1000L;
    /** 单个探针最多跑这么久。超时后线程杀不掉，只能把整个 server 标记为脏 */
    private static final long REQ_TIMEOUT_MS = 120 * 1000L;
    /** Reviewed long tasks may opt in, but no request can hold the server forever. */
    private static final long MAX_REQ_TIMEOUT_MS = 10 * 60 * 1000L;
    private static final String SELFTEST_KEY = "COSMIC_PROBE_ENV_SELFTEST";
    /**
     * 只在一次请求里生效的系统属性：写元数据的 APPLY（S27 1.14 起在常驻进程里写）要带上本次确认过的
     * 写入目标（IsvGuard 读 cosmic.targets），改数据带改前快照。跑前设上、跑完清掉，
     * 名单外的一律丢掉 —— 这条通道不能拿来改 JVM 别的配置。
     */
    private static final java.util.List<String> REQUEST_PROPS =
            java.util.Arrays.asList("cosmic.targets", "cosmic.baseline", "cosmic.schedule");
    /** 调度服务（见 CosmicProbe.startSchedule）：请求带 cosmic.schedule=1 才起，起过就一直开着。null = 没起 */
    private static volatile String schedule = null;
    /** 起调度服务失败过：可能已起了一半，同一进程里不再重试 */
    private static volatile String scheduleError = null;

    private static volatile long lastActive = System.currentTimeMillis();
    /** 上一个请求超时没回来，整个 server 不可信了 */
    private static volatile boolean poisoned = false;
    /** 独立只读心跳；不经过探针队列，不碰平台上下文，也不延长空闲寿命。 */
    private static volatile String serviceState = "starting";
    /** executing 时走到哪一步：compile / run；不在执行时为空。心跳照报，界面拿它点灯。 */
    private static volatile String execStep = "";
    private static int served = 0;
    private static int seq = 0;
    private static long startedAt;

    private static Map<String, String> processEnv;
    private static Map<String, String> envBaseline;
    private static JavaCompiler compiler;
    private static StandardJavaFileManager fileManager;
    private static File hotRoot;
    private static File probesDir;
    /** 被监视的二开业务类来源，**每个代码模块一个**（classes 目录，或老 classpath 下
     *  lib/cus 的 jar）：任何一个变了，常驻进程里的业务类就是旧的了。
     *  只盯第一个的老写法在多模块工程上会漏 —— 另一个模块重编后 server 照跑不误，
     *  跑出来的结论用的是旧类，**不报任何错**。 */
    private static final List<File> watched = new ArrayList<File>();
    private static final List<Long> watchedMtime = new ArrayList<Long>();
    private static final List<Long> watchedSize = new ArrayList<Long>();
    private static String accountWant;
    private static String accountId;
    /** 启动时用的用户；心跳口和 PING 都报它，让调用方对得上「这个进程是用谁的身份起的」 */
    private static String userWant;
    /** 心跳口的端口；PING 也报，登记丢了、被别的进程覆盖了，调用方能照它把登记和心跳文件补回来 */
    private static volatile int healthPort = 0;
    /** 业务类目录里每个 .class 上次对齐时的 mtime（路径 → mtime），SYNC 拿它找出变了哪些 */
    private static final Map<String, Long> classStamps = new HashMap<String, Long>();

    /**
     * 宿主自己的参数（probe.* 这几项）由 driver 写在主类后面，写法同 -D：-D名字=值。
     * 不写成 JVM 的 -D：JRebel 拿 JVM 的全部 -D 参数当它启动缓存的对照依据，这几项里有按版本变的路径，
     * 写在 -D 里每换一个版本 JRebel 就要重新生成一次缓存（多 15～20 秒、多一份 7 MB 的文件）。
     * 在这里设成系统属性，后面照旧用 System.getProperty 读。
     */
    private static void hostProperties(String[] args) {
        for (String arg : args) {
            int eq = arg.indexOf('=');
            if (arg.startsWith("-D") && eq > 2) {
                System.setProperty(arg.substring(2, eq), arg.substring(eq + 1));
            }
        }
    }

    public static void main(String[] args) throws Exception {
        hostProperties(args);
        int port = Integer.parseInt(CosmicProbe.env("PROBE_SERVER_PORT", String.valueOf(DEFAULT_PORT)));
        startHealthServer();
        //这三个路径由 driver 传绝对路径进来：class 是从 build/probe-classes 加载的，
        //从 CodeSource 反推 skill 目录会推到 build/ 上去
        probesDir = new File(System.getProperty("probe.probesDir", "probes"));
        hotRoot = new File(System.getProperty("probe.hotOut", "build/probe-hot"));
        File argfile = new File(System.getProperty("probe.argfile", "build/cosmic-javac.args"));

        log("启动中 …");
        CosmicProbe.initEnv();
        log("连数据库的方式：" + System.getProperty(CosmicProbe.DB_LINK_STATE));

        accountWant = CosmicProbe.env("COSMIC_ACCOUNT", CosmicProbe.DEFAULT_ACCOUNT);
        accountId = CosmicProbe.resolveAccount(accountWant);
        if (accountId == null) {
            log("!! 找不到账套：" + accountWant);
            System.exit(3);
        }
        userWant = CosmicProbe.env("COSMIC_USER", CosmicProbe.DEFAULT_USER);
        setContext(userWant);

        initEnvReflection();
        initCompiler(argfile);
        initWatchedJar(argfile);
        log("换类方式：" + hotSwapMode());

        //预热：把元数据子系统初始化那十几秒在这里付掉。用原厂实体，任何账套都有。
        //它在池子线程里跑，主线程本来只是干等，这段时间拿来把编译器热一遍
        long t = System.currentTimeMillis();
        serviceState = "warming";
        CountDownLatch warmed = startInPool(() -> EntityMetadataCache.getDataEntityType("bos_org"));
        warmCompiler();
        await(warmed, REQ_TIMEOUT_MS);
        log("元数据预热完成 " + (System.currentTimeMillis() - t) + " ms");

        installExitGuard();
        startIdleWatcher();

        startedAt = System.currentTimeMillis();
        try (ServerSocket ss = listen(port)) {
            serviceState = "ready";
            log("就绪 port=" + port + " account=" + accountWant + " pid=" + pid());
            warmLicense();
            //串行 accept：探针一次跑一个。反射改 env 也因此不需要考虑并发
            while (true) {
                try (Socket sock = ss.accept()) {
                    handle(sock);
                } catch (Throwable e) {
                    log("!! 处理请求出错 " + e);
                } finally {
                    execStep = "";
                    serviceState = poisoned ? "unhealthy" : "ready";
                }
            }
        }
    }

    /**
     * 占住请求端口。占不到就立刻退出：端口是按运行时版本算出来的，被占着说明同一个版本的常驻进程已经在跑
     * （两边几乎同时起、它先到）。留着不退的话，这个进程收不到任何请求，却占着两个 G 内存和一条苍穹连接，
     * 要等空闲半小时才走；调用方的登记要是写的是它，它一走，端口上那个还在跑的就没人认了。
     */
    private static ServerSocket listen(int port) throws Exception {
        try {
            return new ServerSocket(port, 16, InetAddress.getByName("127.0.0.1"));
        } catch (java.net.BindException e) {
            log("!! 端口 " + port + " 已被占用：同一版本的常驻进程已经在跑，本进程退出");
            System.setSecurityManager(null);
            System.exit(4);
            throw e;
        }
    }

    // ---------- 请求处理 ----------

    private static void handle(Socket sock) throws Exception {
        BufferedReader in = new BufferedReader(
                new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
        PrintWriter out = new PrintWriter(
                new java.io.OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8), true);

        String head = in.readLine();
        if (head == null) {
            return;
        }
        lastActive = System.currentTimeMillis();

        if ("PING".equals(head)) {
            out.println("RESULT OK 0");
            out.println("pid=" + pid());
            out.println("key=" + System.getProperty("probe.runtimeKey", ""));
            out.println("account=" + accountWant);
            out.println("user=" + userWant);
            out.println("health=" + healthPort);
            out.println("started=" + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date(startedAt)));
            out.println("served=" + served);
            out.println("poisoned=" + poisoned);
            out.println("stale=" + isStale());
            out.println("jar=" + (watched.isEmpty() ? "(未监视)" : joinPaths(watched)));
            out.println("hotswap=" + hotSwapMode());
            out.println("schedule=" + (schedule == null ? "off" : "on"));
            return;
        }
        if ("SYNC".equals(head)) {
            serviceState = "syncing";
            out.print(hotSync());
            out.flush();
            return;
        }
        if ("SHUTDOWN".equals(head)) {
            out.println("RESULT OK 0");
            out.flush();
            log("收到 SHUTDOWN，退出");
            System.setSecurityManager(null);
            System.exit(0);
            return;
        }
        if (!"PROBE".equals(head)) {
            out.println("RESULT ERR 2");
            out.println("未知指令：" + head);
            return;
        }

        serviceState = "executing";
        long requestAt = System.currentTimeMillis();

        String src = null;
        String cls = null;
        String user = CosmicProbe.DEFAULT_USER;
        String account = accountWant;
        long timeoutMs = REQ_TIMEOUT_MS;
        Map<String, String> env = new LinkedHashMap<>();
        Map<String, String> props = new LinkedHashMap<>();
        String line;
        while ((line = in.readLine()) != null && !"END".equals(line)) {
            int eq = line.indexOf('=');
            if (eq < 0) {
                continue;
            }
            String k = line.substring(0, eq);
            String v = line.substring(eq + 1);
            if ("src".equals(k)) {
                src = v;
            } else if ("class".equals(k)) {
                cls = v;
            } else if ("user".equals(k)) {
                user = v;
            } else if ("account".equals(k)) {
                account = v;
            } else if ("timeoutMs".equals(k)) {
                try {
                    timeoutMs = Math.max(REQ_TIMEOUT_MS, Math.min(MAX_REQ_TIMEOUT_MS, Long.parseLong(v)));
                } catch (NumberFormatException ignored) {
                    timeoutMs = REQ_TIMEOUT_MS;
                }
            } else if ("env".equals(k)) {
                int e2 = v.indexOf('=');
                if (e2 > 0) {
                    env.put(v.substring(0, e2), new String(
                            Base64.getDecoder().decode(v.substring(e2 + 1)), StandardCharsets.UTF_8));
                }
            } else if ("prop".equals(k)) {
                int e2 = v.indexOf('=');
                if (e2 > 0 && REQUEST_PROPS.contains(v.substring(0, e2))) {
                    props.put(v.substring(0, e2), new String(
                            Base64.getDecoder().decode(v.substring(e2 + 1)), StandardCharsets.UTF_8));
                }
            }
        }

        //① 上个请求超时没回来 —— 这个进程里还有个线程在乱跑，不能再信它
        if (poisoned) {
            out.println("RESULT BUSY 1");
            out.println("上一次执行超时，旧线程未确认结束，本次请求未执行；调用方先更换常驻进程");
            return;
        }
        //② 二开 jar 变了 —— 常驻进程里的业务类是旧的，跑出来的结论是假的
        long staleAt = System.currentTimeMillis();
        boolean staleNow = isStale();
        long staleMs = System.currentTimeMillis() - staleAt;
        if (staleNow) {
            out.println("RESULT STALE 1");
            File changed = staleOne();
            out.println("检测到 " + (changed == null ? "二开业务类来源"
                    : changed.isDirectory() ? "代码模块的 classes 目录 " + changed.getPath() : changed.getName())
                    + " 已变更（fast / deploy 过了），常驻进程里的业务类是旧的");
            return;
        }
        if (src == null || cls == null) {
            out.println("RESULT ERR 2");
            out.println("请求缺少 src / class");
            return;
        }
        //③ 换账套要重建上下文；元数据缓存会因此冷一次，但不会串味
        if (!account.equals(accountWant)) {
            String id = CosmicProbe.resolveAccount(account);
            if (id == null) {
                out.println("RESULT ERR 3");
                out.println("找不到账套：" + account);
                return;
            }
            accountWant = account;
            accountId = id;
            log("切换账套 -> " + account);
        }
        setContext(user);
        applyEnv(env);
        props.forEach(System::setProperty);
        String scheduleLine = "";
        if ("1".equals(props.get("cosmic.schedule")) && schedule == null) {
            //起不来就不跑探针：没有调度服务的提交照样报成功，流程却没发起
            String failed = startSchedule();
            if (failed != null) {
                for (String key : REQUEST_PROPS) {
                    System.clearProperty(key);
                }
                restoreEnv();
                out.println("RESULT ERR 1");
                out.println("[PROBE-ERR] " + failed);
                return;
            }
            scheduleLine = "[PROBE] " + schedule + "\n";
        }

        String output;
        String status;
        int code = 0;
        File outDir = new File(hotRoot, String.valueOf(++seq));
        long prepareMs = System.currentTimeMillis() - requestAt;
        long compileMs = 0;
        long runMs = 0;
        String reused = "";
        try {
            execStep = "compile";
            long t0 = System.currentTimeMillis();
            File srcFile = new File(src);
            //源码、共用源码、业务类都和上次编它的时候一样：接着用那份产物，不重编（S57）
            String stamp = srcFile.isFile() ? sourceStamp(srcFile) : null;
            String[] last = compiledProbes.get(srcFile.getPath());
            String err = null;
            if (stamp != null && last != null && last[0].equals(stamp) && new File(last[1]).isDirectory()) {
                outDir = new File(last[1]);
                reused = "（沿用 " + outDir.getName() + " 的产物）";
            } else {
                //产物按印记放在磁盘上：上一个进程照同样的印记编过、而且编完了，接着用，不重编
                File kept = stamp == null || !CosmicProbe.prewarmOn() ? null : keptDir(srcFile, stamp);
                if (kept != null && new File(kept, KEPT_DONE).isFile()) {
                    outDir = kept;
                    reused = "（沿用上个进程的产物）";
                    new File(kept, KEPT_DONE).setLastModified(System.currentTimeMillis());
                    compiledProbes.put(srcFile.getPath(), new String[]{stamp, outDir.getPath()});
                } else {
                    if (kept != null) {
                        //没编完的半截产物（进程中途被停、上次没编过）清掉再编
                        deleteTree(kept);
                        outDir = kept;
                    }
                    err = compile(srcFile, outDir);
                    if (err == null && stamp != null) {
                        compiledProbes.put(srcFile.getPath(), new String[]{stamp, outDir.getPath()});
                        new File(outDir, KEPT_DONE).createNewFile();
                    } else {
                        compiledProbes.remove(srcFile.getPath());
                    }
                }
            }
            compileMs = System.currentTimeMillis() - t0;
            if (err != null) {
                status = "COMPILE_FAIL";
                code = 1;
                output = err;
            } else {
                execStep = "run";
                long t1 = System.currentTimeMillis();
                Result r = execute(cls, outDir, timeoutMs);
                runMs = System.currentTimeMillis() - t1;
                status = poisoned ? "TIMEOUT" : r.error == null ? "OK" : "ERR";
                code = r.error == null ? 0 : 1;
                output = r.output;
            }
        } finally {
            //只进常驻进程自己的日志：一次请求的时间花在哪一段，量得出来才知道该省哪一段
            //（scripts/measure-probe-call.ts 按这一行的写法读，改写法两边一起改）
            String warmNote = licenseWarmNote;
            if (warmNote != null) {
                licenseWarmNote = null;
                log(warmNote);
            }
            log("#" + seq + " " + cls + " 准备 " + prepareMs + " ms（查业务类 " + staleMs + "），编译 "
                    + compileMs + " ms" + reused + "，运行 " + runMs + " ms，"
                    + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS").format(new Date(requestAt)) + " 收到");
            restoreEnv();
            for (String key : REQUEST_PROPS) {
                System.clearProperty(key);
            }
        }
        served++;
        out.println("RESULT " + status + " " + code);
        out.print(scheduleLine);
        out.print(output);
        out.flush();
    }

    // ---------- 编译 ----------

    /**
     * 一个探针上次编出来的产物放在哪、当时是照什么编的（源文件路径 → {印记, 产物目录}）。
     *
     * 每次请求都重编是这条路上最大的一笔固定开销：真机上查一条数据，编译 2.8～3.1 秒、运行 0.3 秒，
     * 一次会话一百多次调用就是五六分钟在重编没动过的源码（S57）。产物可以接着用；类加载器照旧每次新建，
     * 探针里的静态变量不会从上一次带过来。
     */
    private static final Map<String, String[]> compiledProbes = new HashMap<String, String[]>();

    /**
     * 产物留在磁盘上，进程重起以后接着用。常驻进程写完元数据、换账套、闲久了都会重起，重起后用到的每个探针
     * 都要再编一遍（真机每个 2～3 秒）；源码、共用源码、业务类、类路径、宿主都没变时，编出来的东西和上次一模一样。
     *
     * 目录名是「源文件路径 + sourceStamp 的印记 + buildStamp」的摘要，哪一样变了就是另一个目录。
     * 编完才写 KEPT_DONE，没有这个文件的目录当作半截产物、清掉重编。超过 7 天没人用的在启动时清掉。
     */
    private static final String KEPT_DONE = ".compiled";
    private static final long KEPT_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;

    /** 类路径上每个包的名字、大小、修改时间，加上宿主自己那份类和 Java 版本：换了平台包、换了宿主，旧产物就不认了 */
    private static String buildStamp = "";

    private static File keptDir(File src, String stamp) throws Exception {
        return new File(new File(hotRoot, "kept"), md5(src.getPath() + '|' + stamp + '|' + buildStamp));
    }

    private static void pruneKept() {
        File[] all = new File(hotRoot, "kept").listFiles();
        if (all == null) {
            return;
        }
        long now = System.currentTimeMillis();
        for (File dir : all) {
            File done = new File(dir, KEPT_DONE);
            long last = done.isFile() ? done.lastModified() : dir.lastModified();
            if (now - last > KEPT_MAX_AGE_MS) {
                deleteTree(dir);
            }
        }
    }

    private static String md5(String text) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest(text.getBytes(StandardCharsets.UTF_8))) {
            hex.append(String.format("%02x", b));
        }
        return hex.toString();
    }

    /**
     * 编译结果取决于的三样东西合成的印记，哪一样变了都重编：
     * 探针自己的源码（按内容）；它能引用到的共用源码（sourcepath 下每个 .java 的名字、大小、修改时间）；
     * 二开业务类（请求走到这里时磁盘上的类已经和常驻进程对齐，用对齐时记下的那份印记）。
     */
    private static String sourceStamp(File src) throws Exception {
        java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
        md.update(Files.readAllBytes(src.toPath()));
        StringBuilder rest = new StringBuilder();
        File[] shared = probesDir == null ? null : probesDir.listFiles();
        if (shared != null) {
            Arrays.sort(shared);
            for (File f : shared) {
                if (f.getName().endsWith(".java")) {
                    rest.append(f.getName()).append(':').append(f.length())
                            .append(':').append(f.lastModified()).append(';');
                }
            }
        }
        rest.append('|').append(watchedMtime).append('|').append(watchedSize);
        md.update(rest.toString().getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte b : md.digest()) {
            hex.append(String.format("%02x", b));
        }
        return hex.toString();
    }

    /**
     * 进程内编译。省掉的不只是 javac 那个 JVM 的启动，更重要的是 fileManager 复用 ——
     * 那 5.8 秒的大头是给 4400 个 jar 建索引，只建一次。
     *
     * @return null 表示成功，否则是给人看的错误全文
     */
    private static String compile(File src, File outDir) throws Exception {
        if (!src.isFile()) {
            return "找不到探针源文件：" + src.getPath();
        }
        outDir.mkdirs();
        fileManager.setLocation(StandardLocation.CLASS_OUTPUT, Collections.singletonList(outDir));
        DiagnosticCollector<JavaFileObject> diag = new DiagnosticCollector<>();
        Iterable<? extends JavaFileObject> units = fileManager.getJavaFileObjects(src);
        //-implicit:class 让探针引用的共用类（IsvGuard / MetaResolve）跟着编译，
        //跟冷路径 driver.mjs 里给 javac 的开关保持一致。
        //-Xprefer:source：classpath 上有宿主的类目录，冷路径编出来的同名探针类也躺在那；默认挑更新的那份，
        //挑中 class 就不重编，运行时这个探针由本次的类加载器装、它用的共用类却由系统类加载器装，
        //包内可见的方法一调就 IllegalAccessError。有源码的一律按源码编，只有宿主自己的类从类目录取
        JavaCompiler.CompilationTask task = compiler.getTask(null, fileManager, diag,
                Arrays.asList("-encoding", "UTF-8", "-implicit:class", "-Xprefer:source"), null, units);
        if (Boolean.TRUE.equals(task.call())) {
            return null;
        }
        StringBuilder sb = new StringBuilder("[FAIL] 探针 " + src.getName() + " 编译失败：\n");
        diag.getDiagnostics().forEach(d -> sb.append(d).append('\n'));
        return sb.toString();
    }

    /**
     * 编译器第一次用要付两笔一次性的账：装它自己的类、把类路径上几千个包的目录各读一遍。不热的话这笔账记在
     * 进程起来后的第一个探针头上。这里编一个只引用一个平台类的空壳，产物丢在临时目录、编完删掉。
     * 只在启动时由主线程调：编译器和文件管理器不能两处同时用。编不过不碍事，照常启动。
     */
    private static void warmCompiler() {
        if (!CosmicProbe.prewarmOn()) {
            return;
        }
        long t = System.currentTimeMillis();
        File dir = null;
        try {
            dir = Files.createTempDirectory("cosmic-javac-warm").toFile();
            File src = new File(dir, "CosmicJavacWarm.java");
            Files.write(src.toPath(), "class CosmicJavacWarm { kd.bos.dataentity.entity.DynamicObject o; }"
                    .getBytes(StandardCharsets.UTF_8));
            String failed = compile(src, new File(dir, "out"));
            log("编译器热身 " + (System.currentTimeMillis() - t) + " ms" + (failed == null ? "" : "（没编过，不碍事）"));
        } catch (Throwable e) {
            log("编译器热身没做成（不碍事）：" + e);
        } finally {
            deleteTree(dir);
        }
    }

    /**
     * 一个进程里第一次打开单据时，平台要先把许可信息读进本进程：许可模式、产品信息、分组运行信息各读一次许可快照
     * （真机每次 2 秒多），中间还要向配置中心登记发号器、抢几次分布式锁，合计十秒上下，全记在那一次调用头上。
     * 就绪以后在后台线程先读一遍，开单时平台用的就是读好的。
     *
     * 只调纯读的入口，都没有参数：前两个是平台公开的 LicenseServiceHelper，第三个是许可包里的取值方法。
     * 检查类的接口（checkUserInGroup、checkLicenseRight）不在这里调：它们会记一条许可使用日志。
     * 哪个读不成都不管，平台用到时照常自己读；这时来了请求也不碍事，两边各用各的连接。
     */
    private static final String[][] LICENSE_READS = {
        {"kd.bos.servicehelper.license.LicenseServiceHelper", "getModeType"},
        {"kd.bos.servicehelper.license.LicenseServiceHelper", "getProductInfo"},
        {"kd.bos.license.util.LicGroupRuntimeUtil", "getAllGroupRumtimeInfos"},
    };

    private static void warmLicense() {
        if (!CosmicProbe.prewarmOn()) {
            return;
        }
        ThreadPools.executeOnceIncludeRequestContext("cosmic-probe-warmup", () -> {
            long t = System.currentTimeMillis();
            int done = 0;
            StringBuilder failed = new StringBuilder();
            for (String[] read : LICENSE_READS) {
                try {
                    Class.forName(read[0]).getMethod(read[1]).invoke(null);
                    done++;
                } catch (Throwable e) {
                    failed.append("；").append(read[1]).append(" 没读成：").append(e);
                }
            }
            licenseWarmNote = "许可信息预读 " + done + "/" + LICENSE_READS.length + " 项，"
                    + (System.currentTimeMillis() - t) + " ms" + failed;
        });
    }

    /**
     * 预读在后台线程里做，做完的那一刻多半有请求在跑，那时的标准输出是那次请求的日志。
     * 结果先记在这里，由主线程在请求收尾时写进常驻进程自己的日志。
     */
    private static volatile String licenseWarmNote;

    private static void deleteTree(File file) {
        if (file == null) {
            return;
        }
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteTree(child);
            }
        }
        file.delete();
    }

    // ---------- 执行 ----------

    private static class Result {
        String output;
        Throwable error;
    }

    /**
     * 本次编译产物必须赢过父加载器：server 自己是从 build/probe-classes 起的，那里躺着冷路径
     * （`--cold` / `APPLY=1`）留下的同名旧 class。父优先的话第一次热跑就把旧类钉死在 JVM 里，
     * 之后改源码、重编译全都白搭 —— 输出稳定是旧的，还不报任何错。
     * 只对 outDir 里真有 .class 的名字走子优先，kd.* 照旧走父加载器（元数据热缓存在那）。
     */
    private static class ProbeClassLoader extends URLClassLoader {
        private final File dir;

        ProbeClassLoader(File dir, ClassLoader parent) throws Exception {
            super(new URL[]{dir.toURI().toURL()}, parent);
            this.dir = dir;
        }

        @Override
        protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
            synchronized (getClassLoadingLock(name)) {
                Class<?> c = findLoadedClass(name);
                if (c == null && new File(dir, name.replace('.', '/') + ".class").isFile()) {
                    c = findClass(name);
                }
                if (c == null) {
                    c = super.loadClass(name, false);
                }
                if (resolve) {
                    resolveClass(c);
                }
                return c;
            }
        }

        /** 这次运行里已经加载过的探针类；没加载过就是 null，不为找它去加载。 */
        Class<?> loaded(String name) {
            synchronized (getClassLoadingLock(name)) {
                return findLoadedClass(name);
            }
        }
    }

    /**
     * 探针跑完的收尾，探针怎么结束（正常、抛错、断言没过）都走。
     *
     * 表单、列表模拟按 --skip 摘掉的插件改的是全 JVM 共享的 FormConfig，要保持到运行结束
     * （平台 activate 时还会再读一遍清单），登记在 HeadlessUiSupport 里。这里还原：
     * 不还原的话，之后所有跑到这张表单的探针都少插件，而且不报任何错。这次没用到它就什么都不做。
     */
    private static void afterRun(ProbeClassLoader cl) {
        Class<?> support = cl.loaded("HeadlessUiSupport");
        if (support == null) {
            return;
        }
        try {
            support.getMethod("restoreHeld").invoke(null);
        } catch (Throwable t) {
            //还原不了，这个进程里有表单的插件清单是摘过的：之后的结论不能信
            poisoned = true;
            System.out.println("[PROBE] ⚠ 摘掉的插件没还原：" + (t.getCause() != null ? t.getCause() : t)
                    + "；下次调用前会更换常驻进程");
        }
    }

    /**
     * 每次新建 ClassLoader 加载探针：探针类全新，苍穹的类走父加载器（热缓存正来自这里）。
     */
    private static Result execute(String cls, File outDir, long timeoutMs) {
        Result result = new Result();
        PrintStream origOut = System.out;
        PrintStream origErr = System.err;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AtomicReference<Throwable> error = new AtomicReference<>();
        try (ProbeClassLoader cl = new ProbeClassLoader(outDir,
                CosmicProbeServer.class.getClassLoader())) {
            PrintStream cap = new PrintStream(buf, true, "UTF-8");
            System.setOut(cap);
            System.setErr(cap);
            boolean finished = runInPool(() -> {
                //探针内部若按上下文加载类，没这一行会落到 server 自己的 loader 上
                Thread.currentThread().setContextClassLoader(cl);
                try {
                    Class.forName(cls, true, cl).getMethod("run").invoke(null);
                } catch (Throwable t) {
                    Throwable real = t.getCause() != null ? t.getCause() : t;
                    if (real instanceof ProbeExitError) {
                        //探针自己调了 System.exit —— 冷模式下无所谓，常驻模式下会杀掉 server
                        System.out.println("[PROBE] (探针调用了 System.exit("
                                + ((ProbeExitError) real).status + ")，已拦截；常驻模式下不要这么写)");
                        return;
                    }
                    error.set(real);
                } finally {
                    afterRun(cl);
                }
            }, timeoutMs);
            if (!finished) {
                poisoned = true;
                error.set(new IllegalStateException(
                        "探针超过 " + (timeoutMs / 1000) + " 秒未结束，线程无法安全终止；"
                        + "本次操作可能仍在执行或已落库，不要直接重跑。下次调用前会更换常驻进程"));
            }
        } catch (Throwable t) {
            error.set(t);
        } finally {
            System.setOut(origOut);
            System.setErr(origErr);
        }

        Throwable t = error.get();
        StringBuilder sb = new StringBuilder(new String(buf.toByteArray(), StandardCharsets.UTF_8));
        if (t != null) {
            sb.append("[PROBE-ERR] ").append(t).append('\n');
            //没有栈的异常是探针自己下的结论（断言没过、输入不成立），上面那一行已经是全部
            if (t.getStackTrace().length > 0) {
                java.io.StringWriter sw = new java.io.StringWriter();
                t.printStackTrace(new PrintWriter(sw));
                sb.append(sw);
            }
        } else {
            sb.append("[PROBE-OK] ").append(cls).append('\n');
        }
        result.output = sb.toString();
        result.error = t;
        return result;
    }

    /** 起调度服务，成功返回 null、schedule 记下状态；失败返回原因。起服务要连库，同样借线程池。 */
    private static String startSchedule() {
        if (scheduleError != null) {
            return scheduleError + "（这个常驻进程里起过一次没起全，不再重试；重起常驻进程再试）";
        }
        AtomicReference<Throwable> error = new AtomicReference<>();
        long t = System.currentTimeMillis();
        boolean finished = runInPool(() -> {
            try {
                schedule = CosmicProbe.startSchedule();
            } catch (Throwable e) {
                error.set(e);
            }
        }, REQ_TIMEOUT_MS);
        if (!finished) {
            poisoned = true;
            return "调度服务 " + (REQ_TIMEOUT_MS / 1000) + " 秒没起完，旧线程未确认结束；下次调用前会更换常驻进程";
        }
        if (error.get() != null) {
            log("!! 调度服务起不来 " + error.get());
            scheduleError = "调度服务起不来：" + error.get();
            return scheduleError;
        }
        log(schedule + " " + (System.currentTimeMillis() - t) + " ms");
        return null;
    }

    /** 苍穹禁止 main 线程访问数据库，一律借 ThreadPools 的线程 */
    private static boolean runInPool(Runnable body, long timeoutMs) {
        return await(startInPool(body), timeoutMs);
    }

    private static CountDownLatch startInPool(Runnable body) {
        CountDownLatch done = new CountDownLatch(1);
        ThreadPools.executeOnceIncludeRequestContext("cosmic-probe-hot", () -> {
            try {
                body.run();
            } finally {
                done.countDown();
            }
        });
        return done;
    }

    private static boolean await(CountDownLatch done, long timeoutMs) {
        try {
            return done.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    // ---------- 初始化 ----------

    private static void setContext(String userId) {
        RequestContext rc = RequestContext.create();
        rc.setTenantId(CosmicProbe.TENANT);
        rc.setAccountId(accountId);
        rc.setUserId(userId);
        RequestContext.set(rc);
    }

    private static void initCompiler(File argfile) throws Exception {
        compiler = ToolProvider.getSystemJavaCompiler();
        if (compiler == null) {
            //ToolProvider 只认 java.home/../lib/tools.jar，**不看 classpath**；而本机 PATH 上的
            //java 来自独立 JRE（jre1.8_191），那条路径根本不存在。driver 已经把 JDK 的
            //tools.jar 挂到 classpath 上了，直接向 JavacTool 要就行
            compiler = (JavaCompiler) Class.forName("com.sun.tools.javac.api.JavacTool")
                    .getMethod("create").invoke(null);
            log("ToolProvider 拿不到编译器（java.home=" + System.getProperty("java.home")
                    + "），已回退到 classpath 上的 JavacTool");
        }
        fileManager = compiler.getStandardFileManager(null, null, StandardCharsets.UTF_8);
        //argfile 是单行 -cp "a;b;c"（380KB）。命令行 32KB 上限对内存里的字符串不适用，
        //所以这里不需要 @argfile 那套绕法，直接把路径喂给 fileManager
        String text = new String(Files.readAllBytes(argfile.toPath()), StandardCharsets.UTF_8).trim();
        int q1 = text.indexOf('"');
        int q2 = text.lastIndexOf('"');
        if (q1 < 0 || q2 <= q1) {
            throw new IllegalStateException("argfile 格式不认识（期望 -cp \"…\"）：" + argfile);
        }
        List<File> cp = new ArrayList<>();
        for (String p : text.substring(q1 + 1, q2).split(File.pathSeparator)) {
            if (!p.trim().isEmpty()) {
                cp.add(new File(p.trim()));
            }
        }
        //宿主自己的类目录也要在：探针会用到宿主带的无头视图（cosmic.headless.HeadlessViews）。
        //只放 class 不放源码，javac 不会把它重编进本次产物，加载时照旧落到系统类加载器
        cp.add(new File(CosmicProbeServer.class.getProtectionDomain().getCodeSource().getLocation().toURI()));
        fileManager.setLocation(StandardLocation.CLASS_PATH, cp);
        fileManager.setLocation(StandardLocation.SOURCE_PATH, Collections.singletonList(probesDir));
        log("编译器就绪，classpath " + cp.size() + " 项，sourcepath=" + probesDir);
        //宿主和自带探针的源码跟着版本目录走（产物目录就在版本目录下），这里只用记类路径：换了哪个包都算变了。
        //目录不记：二开业务类由 sourceStamp 里那份印记管
        long t = System.currentTimeMillis();
        StringBuilder jars = new StringBuilder(argfile.getPath()).append('|').append(System.getProperty("java.version"));
        for (File entry : cp) {
            if (entry.isFile()) {
                jars.append('|').append(entry.getName()).append(':').append(entry.length()).append(':').append(entry.lastModified());
            }
        }
        buildStamp = md5(jars.toString());
        pruneKept();
        log("类路径印记 " + buildStamp.substring(0, 8) + "，" + (System.currentTimeMillis() - t) + " ms");
    }

    /**
     * 探针靠 System.getenv() 读参数，而进程 env 是启动时固定的 —— 反射改它是唯一
     * 不用动 19 个现有探针的办法。JDK 锁死 1.8（苍穹只支持这个），探针又是串行执行的，
     * 所以这个 hack 在这里是稳的。
     */
    @SuppressWarnings("unchecked")
    private static void initEnvReflection() throws Exception {
        Class<?> pe = Class.forName("java.lang.ProcessEnvironment");
        Exception last = null;
        //Windows 上是 theCaseInsensitiveEnvironment（TreeMap<String,String>）；
        //其它平台的 theEnvironment 键值是 ProcessEnvironment.Variable/Value，取到也用不了，
        //所以下面的自检必须留着 —— 拿错字段要在启动时就炸，不能等到参数悄悄不生效
        for (String name : new String[]{"theCaseInsensitiveEnvironment", "theEnvironment"}) {
            try {
                Field f = pe.getDeclaredField(name);
                f.setAccessible(true);
                processEnv = (Map<String, String>) f.get(null);
                break;
            } catch (NoSuchFieldException e) {
                last = e;
            }
        }
        if (processEnv == null) {
            throw new IllegalStateException("反射不到 ProcessEnvironment 的 env map", last);
        }
        processEnv.put(SELFTEST_KEY, "1");
        if (!"1".equals(System.getenv(SELFTEST_KEY))) {
            throw new IllegalStateException("反射改 env 不生效（getenv 读不到刚写的值），常驻模式不可用");
        }
        processEnv.remove(SELFTEST_KEY);
        envBaseline = new HashMap<>(processEnv);
        log("env 反射自检通过，baseline " + envBaseline.size() + " 项");
    }

    /**
     * 每次请求先整体恢复到 baseline 再套用本次参数 —— 不能用增量 put，
     * 否则上一次的 LIMIT_FIELD 会漏到这一次，而这种污染极难发现
     */
    private static void applyEnv(Map<String, String> env) {
        processEnv.clear();
        processEnv.putAll(envBaseline);
        processEnv.putAll(env);
    }

    private static void restoreEnv() {
        processEnv.clear();
        processEnv.putAll(envBaseline);
    }

    /** 从 classpath 里认出二开业务类的来源，不用另外配 cosmic_home。
     *
     *  优先盯代码模块的 classes 目录 —— `fast` 用 javac 直接往那里编，而 runtime/cosmic-run.gradle
     *  已把它排到 Class-Path 第一位，业务类的真实来源就是它。老 classpath（代码模块以 jar
     *  形式出现）下退回盯 lib/cus 的那个 jar，行为跟以前一致。
     *
     *  **逐个模块解析、全部盯上**：只盯第一个等于「另外那些模块改了不算脏」，而那种
     *  跑法不报任何错，结论却是拿旧类得出来的。
     *
     *  代码模块名从 -Dcosmic.codeModules 来（driver.mjs 传，值来自 config.mjs 的探测/配置）。 */
    private static void initWatchedJar(File argfile) throws Exception {
        String[] mods = System.getProperty("cosmic.codeModules", "").split(",");
        String text = new String(Files.readAllBytes(argfile.toPath()), StandardCharsets.UTF_8);
        List<String> entries = new ArrayList<String>();
        for (String p : text.split("[;\"]")) {
            String s = p.trim().replace('\\', '/');
            while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
            if (!s.isEmpty()) entries.add(s);
        }
        for (String m : mods) {
            if (m.trim().isEmpty()) continue;
            File dir = null, jar = null;
            for (String e : entries) {
                if (dir == null && isCodeClassesDir(e, m)) dir = new File(e);
                else if (jar == null && isCodeJar(e, m)) jar = new File(e);
            }
            File w = (dir != null && dir.isDirectory()) ? dir : jar;
            if (w == null || !w.exists()) {
                log("!! 代码模块 " + m + " 在 classpath 上既没有 classes 目录也没有 lib/cus 的 jar，"
                        + "它不参与脏检测");
                continue;
            }
            long[] st = stamp(w, classStamps, null);
            watched.add(w);
            watchedMtime.add(st[0]);
            watchedSize.add(st[1]);
            log("监视 " + w.getPath() + " mtime=" + st[0] + " size=" + st[1]);
        }
        if (watched.isEmpty()) {
            log("!! 一个代码模块都没盯上，脏检测停用（cosmic.codeModules="
                    + System.getProperty("cosmic.codeModules", "(空)") + "）");
        }
    }

    private static String joinPaths(List<File> fs) {
        StringBuilder sb = new StringBuilder();
        for (File f : fs) {
            if (sb.length() > 0) sb.append(File.pathSeparator);
            sb.append(f.getPath());
        }
        return sb.toString();
    }

    /** 嵌套模块 `apps:order` 在磁盘上是 apps/order —— 名字里的冒号要换成斜杠再比 */
    private static boolean isCodeClassesDir(String s, String m) {
        return s.endsWith("/" + m.trim().replace(':', '/') + "/build/classes/java/main");
    }

    /** lib/cus 下形如 <模块名>-<版本>.jar（嵌套模块打出来的是末段）。按 basename 前缀匹配，
     *  别用 contains —— 会把别的模块的 jar（名字里恰好含这段）也认进来。 */
    private static boolean isCodeJar(String s, String m) {
        if (!s.contains("/lib/cus/") || !s.endsWith(".jar")) return false;
        String name = s.substring(s.lastIndexOf('/') + 1);
        String last = m.trim();
        int i = last.lastIndexOf(':');
        if (i >= 0) last = last.substring(i + 1);
        return !last.isEmpty() && name.startsWith(last + "-");
    }

    /**
     * 给一个来源拍快照：{ 最新 mtime, 大小 }。
     *   目录：最新 mtime 取递归最大值、连目录自己（改一个 .class 不一定动到父目录的 mtime）；
     *         大小取文件个数，用来接住「只删了一个类」这种 mtime 反而变旧的情况。
     *   jar：取它自己的 mtime 和字节数。
     * classes 不为 null 时顺带记下每个 .class 的 mtime，names 不为 null 时再记类名 —— 热替换用。
     *
     * 一趟走完：原来 mtime、个数、.class 清单各走一遍目录，用 File.lastModified 一个个问。
     * 真机 2026-09-19 一趟就要 1 秒（600 多个类），每次探针请求前的过期检查付两趟、换一次类付三趟。
     * walkFileTree 在 Windows 上属性随目录列表一起回来，不再一个文件一次系统调用。
     */
    private static long[] stamp(File f, final Map<String, Long> classes, final Map<String, String> names) {
        if (!f.isDirectory()) {
            return new long[]{f.lastModified(), f.length()};
        }
        final long[] acc = {f.lastModified(), 0};
        final java.nio.file.Path root = f.toPath();
        try {
            Files.walkFileTree(root, new java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
                @Override
                public java.nio.file.FileVisitResult preVisitDirectory(java.nio.file.Path d,
                        java.nio.file.attribute.BasicFileAttributes a) {
                    acc[0] = Math.max(acc[0], a.lastModifiedTime().toMillis());
                    return java.nio.file.FileVisitResult.CONTINUE;
                }

                @Override
                public java.nio.file.FileVisitResult visitFile(java.nio.file.Path p,
                        java.nio.file.attribute.BasicFileAttributes a) {
                    long m = a.lastModifiedTime().toMillis();
                    acc[0] = Math.max(acc[0], m);
                    acc[1]++;
                    String file = p.getFileName().toString();
                    if (classes != null && file.endsWith(".class")) {
                        classes.put(p.toString(), m);
                        if (names != null) {
                            String rel = root.relativize(p).toString();
                            names.put(p.toString(), rel.substring(0, rel.length() - ".class".length())
                                    .replace(File.separatorChar, '.').replace('/', '.'));
                        }
                    }
                    return java.nio.file.FileVisitResult.CONTINUE;
                }

                @Override
                public java.nio.file.FileVisitResult visitFileFailed(java.nio.file.Path p, java.io.IOException e) {
                    //javac 正在写的文件可能一闪而过：跳过它，下一次快照会看见
                    return java.nio.file.FileVisitResult.CONTINUE;
                }
            });
        } catch (java.io.IOException e) {
            log("!! 拍快照失败 " + f + "：" + e);
        }
        return acc;
    }

    private static boolean isStale() {
        return staleOne() != null;
    }

    /** 哪一个变了 —— 报名字比只说「脏了」有用：多模块时人要知道是哪个模块被重编了 */
    private static File staleOne() {
        for (int i = 0; i < watched.size(); i++) {
            File f = watched.get(i);
            long[] st = stamp(f, null, null);
            if (st[0] != watchedMtime.get(i) || st[1] != watchedSize.get(i)) return f;
        }
        return null;
    }

    // ---------- 热替换（S27 3.1） ----------

    /**
     * 换类入口。常驻进程启动时由 driver 用 -javaagent 挂上（jar 里只有一份清单），JVM 在 main 之前
     * 调 premain，把 Instrumentation 交到这里。挂 JRebel 的时候不挂它：两家同时改类会互相打架。
     */
    public static class HotSwapAgent {
        static volatile java.lang.instrument.Instrumentation inst;

        public static void premain(String args, java.lang.instrument.Instrumentation i) {
            inst = i;
        }

        public static void agentmain(String args, java.lang.instrument.Instrumentation i) {
            inst = i;
        }
    }

    /** jrebel：JRebel 负责换类；instrument：本进程自己换（JDK 自带：方法体、private static/final 方法）；none：换不了，只能重起 */
    private static String hotSwapMode() {
        if (System.getProperty("cosmic.jrebel") != null) {
            return "jrebel";
        }
        return HotSwapAgent.inst != null ? "instrument" : "none";
    }

    /**
     * 把业务类目录里变了的 .class 换进本进程。
     *
     * 为什么能换：业务类都是系统类加载器从各模块 build/classes 读的，平台每次建插件拿的是同一个
     * Class（TypesContainer → Class.forName），原地换掉之后下一次打开单据、跑操作就是新代码。
     *
     * 只换已经加载过的：没加载过的下次用到时直接从磁盘读新的，不用管。
     * JDK 8 自带的换类能换：方法体、加减 private static / private final 方法（不用 this 的 lambda
     * 编出来就是这种，真机 2026-09-19 实测加 private static 方法换进去了）。换不了：加减字段、
     * 加减其它方法（public、private 实例方法、用 this 的 lambda）、改签名、改继承 —— 整批被拒，
     * 整批是原子的，拒了就一个都没换，回 ERR，driver 退回重起，不会半新半旧。
     *
     * 静态字段的初始值不会重算（换类不重跑 static 块），平台缓存着的单例对象也还是旧构造出来的：
     * 这两种改动换进去了也不等于生效，只能重起。driver 的说明里写了这一条。
     */
    private static synchronized String hotSync() {
        if (poisoned) {
            return "RESULT BUSY 1\nreason=上一次执行超时，旧线程未确认结束，本次换类未执行\n";
        }
        String mode = hotSwapMode();
        long t0 = System.currentTimeMillis();
        Map<String, Long> now = new HashMap<String, Long>();
        Map<String, String> names = new HashMap<String, String>();
        //这一趟的快照留着，换成功后直接拿来对齐过期检查 —— 不再回头重走目录，
        //走完之后才写进来的文件也因此不会被当成「已经换过」
        List<long[]> fresh = new ArrayList<long[]>();
        for (File w : watched) {
            if (!w.isDirectory()) {
                return "RESULT ERR 1\nmode=" + mode + "\nreason=业务类来自 jar（" + w.getName() + "），不能热替换\n";
            }
            fresh.add(stamp(w, now, names));
        }
        Map<String, String> byName = new LinkedHashMap<String, String>();
        for (Map.Entry<String, Long> e : now.entrySet()) {
            if (!e.getValue().equals(classStamps.get(e.getKey()))) {
                byName.put(names.get(e.getKey()), e.getKey());
            }
        }
        int removed = 0;
        for (String k : classStamps.keySet()) {
            if (!now.containsKey(k)) {
                removed++;
            }
        }

        int redefined = 0;
        int notLoaded = 0;
        //分段计时：真机 2026-09-19 换 1 个类要 3 秒多，得知道是扫目录、找类还是 JVM 换类本身
        long scanMs = System.currentTimeMillis() - t0;
        String split = "扫目录 " + scanMs + " ms";
        if ("instrument".equals(mode)) {
            java.lang.instrument.Instrumentation inst = HotSwapAgent.inst;
            List<java.lang.instrument.ClassDefinition> defs = new ArrayList<java.lang.instrument.ClassDefinition>();
            List<String> loaded = new ArrayList<String>();
            ClassLoader app = ClassLoader.getSystemClassLoader();
            try {
                for (Class<?> c : inst.getAllLoadedClasses()) {
                    String path = byName.get(c.getName());
                    //探针自己的加载器里不会有业务类（探针编译不带业务源码），有也只是跑完的那一次在用
                    if (path == null || c.getClassLoader() instanceof ProbeClassLoader) {
                        continue;
                    }
                    if (c.getClassLoader() != app) {
                        return "RESULT ERR 1\nmode=" + mode + "\nreason=" + c.getName() + " 是别的类加载器（"
                                + c.getClassLoader() + "）加载的，不知道它从哪读，不换\n";
                    }
                    defs.add(new java.lang.instrument.ClassDefinition(c, Files.readAllBytes(new File(path).toPath())));
                    loaded.add(c.getName());
                }
                long found = System.currentTimeMillis();
                split += "，找已加载的类 " + (found - t0 - scanMs) + " ms";
                if (!defs.isEmpty()) {
                    inst.redefineClasses(defs.toArray(new java.lang.instrument.ClassDefinition[0]));
                }
                split += "，JVM 换类 " + (System.currentTimeMillis() - found) + " ms";
            } catch (UnsupportedOperationException e) {
                return "RESULT ERR 1\nmode=" + mode + "\nreason=结构变了，JDK 自带的换类换不了（"
                        + e.getMessage() + "）\nnames=" + firstNames(loaded) + "\n";
            } catch (Throwable e) {
                return "RESULT ERR 1\nmode=" + mode + "\nreason=换类失败：" + e + "\nnames=" + firstNames(loaded) + "\n";
            }
            redefined = defs.size();
            notLoaded = byName.size() - loaded.size();
        } else if ("jrebel".equals(mode)) {
            //JRebel 自己盯着 classes 目录，类下次被用到时换。这里只确认它真的挂上了，
            //没挂上就等于没人换 —— 那样答 OK 就是拿旧类跑、不报错。
            String why = jrebelProblem();
            if (why != null) {
                return "RESULT ERR 1\nmode=" + mode + "\nreason=" + why + "\n";
            }
        } else {
            return "RESULT ERR 1\nmode=" + mode + "\nreason=本进程启动时没挂上换类入口\n";
        }

        classStamps.clear();
        classStamps.putAll(now);
        for (int i = 0; i < watched.size(); i++) {
            watchedMtime.set(i, fresh.get(i)[0]);
            watchedSize.set(i, fresh.get(i)[1]);
        }
        long ms = System.currentTimeMillis() - t0;
        log("热替换（" + mode + "）：变了 " + byName.size() + " 个类，换了 " + redefined + " 个，" + ms + " ms（"
                + split + "）");
        return "RESULT OK 0\nmode=" + mode + "\nchanged=" + byName.size() + "\nredefined=" + redefined
                + "\nnotLoaded=" + notLoaded + "\nremoved=" + removed + "\nms=" + ms + "\nsplit=" + split
                + "\nnames=" + firstNames(byName.keySet()) + "\n";
    }

    /** JRebel 挂上了吗。挂上了返回 null，否则返回一句原因 */
    private static String jrebelProblem() {
        try {
            Class<?> factory = Class.forName("org.zeroturnaround.javarebel.ReloaderFactory");
            Object reloader = factory.getMethod("getInstance").invoke(null);
            Object enabled = reloader.getClass().getMethod("isReloadEnabled").invoke(reloader);
            return Boolean.TRUE.equals(enabled) ? null : "JRebel 挂上了但换类没开（isReloadEnabled=false）";
        } catch (ClassNotFoundException e) {
            return "要求用 JRebel 换类，但本进程里没有 JRebel（-agentpath 没生效）";
        } catch (Throwable e) {
            return "查不了 JRebel 的状态：" + e;
        }
    }

    private static String firstNames(java.util.Collection<String> names) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (String name : names) {
            if (n++ == 10) {
                sb.append(",…");
                break;
            }
            if (sb.length() > 0) {
                sb.append(',');
            }
            sb.append(name);
        }
        return sb.toString();
    }

    /** 探针里一句 System.exit() 会带走整个 server，拦下来变成一条提示 */
    private static void installExitGuard() {
        try {
            System.setSecurityManager(new SecurityManager() {
                @Override
                public void checkExit(int status) {
                    throw new ProbeExitError(status);
                }

                //必须全放行：苍穹内部到处是权限检查，拦一个就炸
                @Override
                public void checkPermission(Permission perm) {
                }

                @Override
                public void checkPermission(Permission perm, Object context) {
                }

                //下面这些本来就都放行，单独写出来是为了不付「先造一个权限对象」的钱：默认实现每次读文件
                //都 new FilePermission，构造时要把路径规范化。真机量过（S57）：走一遍 684 个业务类，
                //没防护 27 毫秒，只放行 checkPermission 是 476 毫秒，一个文件多 0.7 毫秒——
                //每次请求前查业务类变没变、JRebel 看类文件、javac 读 jar、平台读文件，全在付。
                @Override
                public void checkRead(String file) {
                }

                @Override
                public void checkRead(String file, Object context) {
                }

                @Override
                public void checkRead(java.io.FileDescriptor fd) {
                }

                @Override
                public void checkWrite(String file) {
                }

                @Override
                public void checkWrite(java.io.FileDescriptor fd) {
                }

                @Override
                public void checkDelete(String file) {
                }

                @Override
                public void checkExec(String cmd) {
                }

                @Override
                public void checkLink(String lib) {
                }

                @Override
                public void checkPropertyAccess(String key) {
                }

                @Override
                public void checkPropertiesAccess() {
                }

                @Override
                public void checkPackageAccess(String pkg) {
                }

                @Override
                public void checkPackageDefinition(String pkg) {
                }

                @Override
                public void checkConnect(String host, int port) {
                }

                @Override
                public void checkConnect(String host, int port, Object context) {
                }

                @Override
                public void checkListen(int port) {
                }

                @Override
                public void checkAccept(String host, int port) {
                }

                @Override
                public void checkAccess(Thread t) {
                }

                @Override
                public void checkAccess(ThreadGroup g) {
                }

                @Override
                public void checkCreateClassLoader() {
                }

                @Override
                public void checkSetFactory() {
                }

                @Override
                public void checkSecurityAccess(String target) {
                }
            });
            log("System.exit 防护已装");
        } catch (Throwable t) {
            //装不上不是致命的，只是探针调 exit 会杀掉 server
            log("!! System.exit 防护装不上（" + t + "），探针里不要调 System.exit");
        }
    }

    private static class ProbeExitError extends Error {
        final int status;

        ProbeExitError(int status) {
            super("System.exit(" + status + ") intercepted");
            this.status = status;
        }
    }

    private static void startHealthServer() throws Exception {
        final String file = System.getProperty("probe.healthFile");
        if (file == null) return; // 兼容旧 driver。
        final ServerSocket health = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
        healthPort = health.getLocalPort();
        final String identity = "pid=" + pid() + "\nkey=" + System.getProperty("probe.runtimeKey", "") + "\n";
        final String account = CosmicProbe.env("COSMIC_ACCOUNT", CosmicProbe.DEFAULT_ACCOUNT);
        final String user = CosmicProbe.env("COSMIC_USER", CosmicProbe.DEFAULT_USER);
        Files.write(new File(file).toPath(), (identity + "port=" + health.getLocalPort() + "\n").getBytes(StandardCharsets.UTF_8));
        Thread t = new Thread(() -> {
            while (!health.isClosed()) {
                try (Socket sock = health.accept()) {
                    sock.setSoTimeout(1000);
                    BufferedReader in = new BufferedReader(new InputStreamReader(sock.getInputStream(), StandardCharsets.UTF_8));
                    if (!"HEALTH".equals(in.readLine())) continue;
                    PrintWriter out = new PrintWriter(new java.io.OutputStreamWriter(sock.getOutputStream(), StandardCharsets.UTF_8), true);
                    out.println("RESULT OK 0");
                    out.print(identity);
                    out.println("state=" + (poisoned ? "unhealthy" : serviceState));
                    out.println("step=" + execStep);
                    out.println("account=" + account);
                    out.println("user=" + user);
                    out.println("lastActive=" + lastActive);
                } catch (Exception e) {
                    // 一个失联的读者不影响业务服务。
                }
            }
        }, "probe-health");
        t.setDaemon(true);
        t.start();
    }

    private static void startIdleWatcher() {
        Thread t = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(60_000);
                } catch (InterruptedException e) {
                    return;
                }
                if (System.currentTimeMillis() - lastActive > IDLE_EXIT_MS) {
                    log("空闲超过 " + (IDLE_EXIT_MS / 60000) + " 分钟，自动退出");
                    System.setSecurityManager(null);
                    System.exit(0);
                }
            }
        }, "probe-idle-watcher");
        t.setDaemon(true);
        t.start();
    }

    private static String pid() {
        String n = java.lang.management.ManagementFactory.getRuntimeMXBean().getName();
        int at = n.indexOf('@');
        return at > 0 ? n.substring(0, at) : n;
    }

    private static void log(String msg) {
        System.out.println("[PSERVER] " + msg);
    }
}
