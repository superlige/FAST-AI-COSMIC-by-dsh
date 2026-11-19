import kd.bos.metadata.entity.EntityMetadata;

/**
 * 硬红线：**绝对禁止修改、删除任何原厂元数据。**
 *
 * 本工程的 ISV 从 -Dcosmic.isv 来（Harness 传，值默认取自 gradle.properties 的
 * systemProp.developer_flag）。只有 ISV 相符**且**标识以 <isv>_ 开头的元数据才准写。
 * 其余一律是原厂（kingdee）或别的 ISV 的东西 —— 改了会在补丁/升级时被覆盖或直接冲突，
 * 而且元数据全租户共用，砸的是所有人的环境。
 *
 * ISV 没传进来时**拒绝一切写入**，不是放行。红线的默认值只能是「全关」。
 *
 * 每个写元数据的探针在动手之前都必须先过这里。**没有绕过开关，这是故意的**：
 * 真需要动原厂元数据，去开发平台走标准的扩展/继承流程，别用探针。
 *
 * 实体走下面这两道。**非实体元数据（BOTP 规则 / 打印模板 / 工作流模型）不能继承实体判据** ——
 * 它们不是 EntityMetadata，归属字段各不相同，逐个家族实测定的判据见各自方法的注释。
 *
 * 两道检查，任何一道不过就抛异常中止：
 *   1. em.getIsv() 必须等于本 ISV —— 这是元数据里记的真值，最可靠
 *      （实测：某二开单据是本 ISV，bos_org 是 kingdee）
 *   2. 标识必须以 <isv>_ 开头 —— 用户定的规则，也拦得住二开单据上继承来的原厂字段
 *      （billstatus / billno / creator 这些没有前缀，删掉是灾难）
 *
 * **第三道只在 APPLY=1 时生效：写入目标确认**（-Dcosmic.targets，见 targets()）。
 * 上面两道拦的是「这东西不是你的」，第三道拦的是**「这东西不是你报给用户的那个」** ——
 * 事前报的清单和事中真正落库的对象对不上，在此之前没有任何东西会响。
 */
public final class IsvGuard {

    /** 本工程的 ISV。没传进来就是空串 —— 此时 requireIsv() 会拒绝一切写入。 */
    public static final String ISV = System.getProperty("cosmic.isv", "").trim().toLowerCase();
    public static final String PREFIX = ISV + "_";

    private IsvGuard() {
    }

    /**
     * 本次**已确认的写入目标**（-Dcosmic.targets，由 cosmic_authorize 的用户确认产生，
     * Harness 传入，逗号分隔）。空 = 没确认过任何对象。
     *
     * 这是 ISV 红线之外的第二道，管的是另一件事：ISV 拦「这东西不是你的」，它拦
     * **「这东西不是你报给用户的那个」**。事前报的清单和事中真正落库的对象对不上，
     * 在此之前没有任何东西会响 —— 而元数据全租户共用，砸的是所有人的环境。
     *
     * 只在 APPLY=1 时生效：dry-run 本来就是「先看看会改成什么样」，正是确认清单之前该做的事。
     * 每次检查现读系统属性：冷进程由启动参数带进来；常驻 JVM（S27 1.14 起元数据 APPLY 在那里写）
     * 由这次请求的 prop= 行带进来，跑前设上、跑完清掉。不在类加载时读一次存起来：本类万一从常驻进程
     * 自己的类路径加载（而不是每次请求新编的那份），存下的就是启动时的空清单。
     */
    private static java.util.List<String> targets() {
        return splitTargets(System.getProperty("cosmic.targets", ""));
    }

    /**
     * 本次运行**会碰到的**写入目标，按发现顺序去重（dry-run 也记）。
     *
     * 为什么要有它：清单是用户点确认的那一份，而真正被 IsvGuard 比对的是探针落库时逐个碰到
     * 的对象。两者以前只能靠人对齐——探针在写模式打一行「写入目标 <实体>.<布局>」，可它打的
     * 是它当时手上那一个，字段那几个要到 APPLY 那一刻才被检查。照着那一行去授权，字段一个都
     * 不在清单里，APPLY 当场被拦，**整份授权作废、dry-run 白做**（2026-09-14 真机实测）。
     *
     * 现在改成：每过一道 assertOwn* 就把「这道门到时候会要的那个完整目标」记下来，dry-run
     * 结束前由 {@link #reportTargets()} 打成一行可照抄的清单。清单和门禁从此是同一份判据
     * 算出来的，不是两处各写一遍。
     */
    private static final java.util.List<String> PLANNED = new java.util.ArrayList<String>();

    /** 最近一次 assertOwnEntity 认过的实体标识：字段、布局的完整目标要拼在它前面。 */
    private static String owner = "";

    private static void planned(String target) {
        String t = nz(target).toLowerCase();
        if (!t.isEmpty() && !PLANNED.contains(t)) {
            PLANNED.add(t);
        }
    }

    /**
     * 本次会碰到的完整目标清单，`cosmic_authorize` 的 targets 照抄这一行即可。
     *
     * 整张单只在「没有任何更细的目标」时才列：确认了 `单据.字段` 就等于确认了这张单
     * （见 {@link #assertConfirmedEntity}），两个都列会让用户看到一个比实际更大的范围。
     */
    public static java.util.List<String> plannedTargets() {
        java.util.List<String> out = new java.util.ArrayList<String>();
        for (String t : PLANNED) {
            boolean covered = false;
            for (String other : PLANNED) {
                if (!other.equals(t) && other.startsWith(t + ".")) {
                    covered = true;
                    break;
                }
            }
            if (!covered) {
                out.add(t);
            }
        }
        return out;
    }

    /**
     * 把清单打成一行。写探针在 dry-run 结束之前调一次，Harness 从这一行取走，
     * 授权时少一个就当场拒绝——不必等到 APPLY 被 JVM 拦。
     */
    public static void reportTargets() {
        java.util.List<String> targets = plannedTargets();
        if (targets.isEmpty()) {
            return;
        }
        System.out.println("[PROBE] 写入目标清单（确认单上的写入范围就是这一行，"
                + "APPLY 时碰到清单外的对象会被拦下）：" + String.join(", ", targets));
    }

    private static java.util.List<String> splitTargets(String raw) {
        java.util.List<String> out = new java.util.ArrayList<String>();
        for (String s : nz(raw).split(",")) {
            String t = s.trim().toLowerCase();
            if (!t.isEmpty() && !out.contains(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** 真要落库才查目标清单。dry-run 放行，那一步的作用就是给确认清单提供依据。 */
    private static boolean applying() {
        return "1".equals(nz(System.getenv("APPLY")).trim());
    }

    /** 实体：确认了整张单、或确认了它下面任何一个字段，都算确认过这张单。 */
    private static void assertConfirmedEntity(String number) {
        planned(number);
        if (!applying()) {
            return;
        }
        String n = nz(number).toLowerCase();
        for (String t : targets()) {
            if (t.equals(n) || t.startsWith(n + ".")) {
                return;
            }
        }
        denyTarget("实体 " + q(number), n);
    }

    /**
     * 字段：清单里写的是「实体.字段」或「实体.分录.字段」，而调用方手上只有裸 key
     *（assertOwnField 的签名就只有它），所以比的是**末段**。
     *
     * 归属那一半由 assertConfirmedEntity 管 —— 写字段的探针必然先过实体那道，
     * 两道合起来才等于「这张单上的这个字段」。裸 key 单独比不够严，但它拦得住
     * 「确认的是 A 字段、实际改的是 B 字段」，那正是这道门禁要拦的东西。
     */
    private static void assertConfirmedField(String key) {
        planned(owner.isEmpty() ? key : owner + "." + key);
        if (!applying()) {
            return;
        }
        String k = nz(key).toLowerCase();
        for (String t : targets()) {
            if (t.indexOf(':') >= 0) {
                continue;
            }
            int dot = t.lastIndexOf('.');
            if (dot >= 0 && t.substring(dot + 1).equals(k)) {
                return;
            }
        }
        denyTarget("字段 " + q(key), "<实体>." + k);
    }

    /**
     * 已知宿主时按完整路径确认。布局等对象不是实体字段，但它们仍挂在一个确定实体下；
     * 只比末段会让「清单里明明有这个裸 key」看起来像门禁自相矛盾，也无法给出可照抄的修复值。
     */
    private static void assertConfirmedUnder(String what, String host, String key) {
        String expected = nz(host).toLowerCase() + "." + nz(key).toLowerCase();
        planned(expected);
        if (!applying()) {
            return;
        }
        if (targets().contains(expected)) {
            return;
        }
        denyTarget(what + " " + q(key), expected);
    }

    /** 带家族前缀的目标（tpl: / botp: / wf: / data:），它们的标识空间跟实体分不开 */
    private static void assertConfirmedTagged(String kind, String value, String what) {
        planned(kind + ":" + nz(value));
        if (!applying()) {
            return;
        }
        if (targets().contains(kind + ":" + nz(value).toLowerCase())) {
            return;
        }
        denyTarget(what, kind + ":" + nz(value).toLowerCase());
    }

    private static void denyTarget(String what, String expected) {
        System.out.println("[PROBE] !! 拒绝：" + what + " 缺少匹配的完整写入目标");
        blocked();
        if (targets().isEmpty()) {
            System.out.println("[PROBE] !! 清单是空的 —— 一个对象都没确认过就 APPLY=1，"
                    + "Harness 本该拦在起 JVM 之前");
        } else {
            System.out.println("[PROBE] !! 已确认 " + targets().size() + " 个："
                    + String.join(", ", targets()));
        }
        System.out.println("[PROBE] !! 目标按完整路径匹配；只确认裸 key 或清单里出现同名末段都不算命中。");
        System.out.println("[PROBE] !! 需要确认的目标：" + expected);
        System.out.println("[PROBE] !! 它不在用户确认过的写入范围里，没有写。真要改它：重新预演，"
                + "让它出现在写入目标清单里，用户确认后再写");
        throw new IllegalStateException("IsvGuard 拒绝：" + what + " 缺少完整目标 " + expected);
    }

    /**
     * ISV 必须有值且形状合法才准继续。
     *
     * 校验形状是因为 PREFIX 会被拼进 SQL 的 like 里（见 EnvDiagProbe）；更重要的是，
     * 一个畸形的 ISV 会让下面两道检查变成「谁都能过」或「谁都过不了」，而前者是灾难。
     */
    private static void requireIsv() {
        if (ISV.isEmpty()) {
            deny("没拿到本工程的 ISV（-Dcosmic.isv 没传）。红线的默认值只能是全关。"
                    + "用 cosmic_doctor action=check 检查 isv");
        }
        if (!ISV.matches("[a-z0-9]+")) {
            deny("ISV 「" + ISV + "」形状不合法（只允许小写字母和数字）");
        }
    }

    /** 写整张单之前调。em 用调用方已经 readMeta 出来的那个，不重复读。 */
    public static void assertOwnEntity(String number, EntityMetadata em) {
        requireIsv();
        String isv = em.getIsv();
        System.out.println("[PROBE] ISV 检查 " + number + "  isv=" + isv
                + "  bizapp=" + em.getBizappNumber());

        if (!ISV.equalsIgnoreCase(nz(isv))) {
            deny("实体 " + number + " 的 ISV 是 " + q(isv) + "，不是 " + ISV
                    + " —— 这是原厂或别家 ISV 的元数据");
        }
        if (!number.toLowerCase().startsWith(PREFIX)) {
            deny("实体标识 " + number + " 没有 " + PREFIX + " 前缀");
        }
        owner = nz(number).toLowerCase();
        assertConfirmedEntity(number);
    }

    /**
     * 往一张单据里造数据、改数据之前调（DataSeedProbe / DataUpdateProbe）。
     *
     * **不查 ISV**（2026-09-15 用户决定）：这里连的是测试环境，改数据不改元数据，原厂单据、别家 ISV
     * 的单据也照样能造、能改。「绝对禁止改原厂元数据」那条红线管的是元数据，数据不在它的范围里。
     * S27 起数据写入也不用确认（S21～S23 那道确认单和写入目标检查去掉了），这里只报目标，
     * 回执照 `data:<单据>` 列出这次写过哪些单。
     */
    public static void assertDataTarget(String number) {
        //平台服务云里的表单装的是平台自己的配置和登记，写它等于写元数据，不走「写数据不用确认」这条路
        //（S37 批 8：09-28 复测模型用 DataSeedProbe 往 openapi_apilist 落了一条接口登记，探针自己还打着「只写数据、不动元数据」）
        String[] cloud = cloudOf(number);
        if (cloud != null && PLATFORM_CLOUDS.contains(cloud[0].toUpperCase())) {
            System.out.println("[PROBE] !! 拒绝：" + number + " 属于" + cloud[1] + "（" + cloud[0]
                    + "，苍穹平台自己的服务云），存的是平台的配置和登记，不是业务数据");
            blocked();
            System.out.println("[PROBE] !! 造数据、改数据只写业务单据和基础资料；改这类登记属于写元数据，要先问用户");
            throw new IllegalStateException("IsvGuard 拒绝：" + number + " 是平台配置 / 登记（" + cloud[1] + "），不按数据写");
        }
        // S27（用户 2026-09-19 定：连的必然是纯测试环境）：写业务数据不用确认，只报目标、不查清单。
        // 元数据写入的几道检查一个没动。
        System.out.println("[PROBE] 数据写入目标 data:" + nz(number).toLowerCase()
                + "（只写数据、不动元数据，不限 ISV；测试环境，不用确认）");
        planned("data:" + nz(number));
    }

    /**
     * 改 BOTP 转换规则之前调。转换规则不是 EntityMetadata（不在 MetaCategory 里，
     * 自成一张 T_BOTP_ConvertRule），所以走不了 assertOwnEntity，判据换成表上的三列。
     *
     * 源单和目标单都要查：原厂单据下推到二开单据的规则 FISV 也是本 ISV（规则是二开方建的），
     * 但只要有一头是原厂的，改动就会影响到原厂单据的下推行为，照样按红线拦。
     */
    public static void assertOwnBotpRule(String ruleId, String isv, String source, String target) {
        requireIsv();
        System.out.println("[PROBE] ISV 检查 规则 " + ruleId + "  isv=" + isv
                + "  " + source + " -> " + target);

        if (!ISV.equalsIgnoreCase(nz(isv))) {
            deny("转换规则 " + ruleId + " 的 ISV 是 " + q(isv) + "，不是 " + ISV);
        }
        if (nz(source).toLowerCase().startsWith(PREFIX) == false) {
            deny("规则 " + ruleId + " 的源单 " + q(source) + " 没有 " + PREFIX + " 前缀");
        }
        if (nz(target).toLowerCase().startsWith(PREFIX) == false) {
            deny("规则 " + ruleId + " 的目标单 " + q(target) + " 没有 " + PREFIX + " 前缀");
        }
        assertConfirmedTagged("botp", ruleId, "转换规则 " + q(ruleId));
    }

    /**
     * 只读入口用：这张打印模板本身是不是本 ISV 的。
     *
     * 打印模板有**两个实体，判据只能取本体那个**：目录 `bos_manageprinttpl` 上根本没有 isv 列
     * （实测 1518 行一个都没有），本体 `bos_print_meta` 上才有（实测 zlgd 218 / kingdee 52 /
     * kdtest 4 / 空 1281）。所以传进来的 isv 必须是 `DesignMetadata.getIsv()`，
     * 不是从目录查的。
     *
     * 编码前缀单独用也不够：实测 199 张模板编码以 <isv>_ 开头但 isv 不是本 ISV。两道都要过。
     *
     * @param number       调用方要操作的模板编码
     * @param actualNumber 从本体读回来的编码，两者不一致说明 id 解析串了
     * @param isv          本体上的 isv
     */
    public static void assertOwnPrintTplSelf(String number, String actualNumber, String isv) {
        requireIsv();
        if (number == null || !number.toLowerCase().startsWith(PREFIX)) {
            deny("模板编码 " + q(number) + " 没有 " + PREFIX + " 前缀");
        }
        if (!number.equals(actualNumber)) {
            deny("模板编码对不上：要的是 " + q(number) + "，读回来的是 " + q(actualNumber)
                    + " —— 模板 id 解析串了，别接着往下写");
        }
        if (!ISV.equalsIgnoreCase(nz(isv))) {
            deny("模板 " + number + " 的 ISV 是 " + q(isv) + "，不是 " + ISV
                    + " —— 这是原厂或别家 ISV 的模板");
        }
    }

    /**
     * 改打印模板之前调。比只读那道多一条：**挂靠单据也得是本 ISV**。
     *
     * 模板挂在原厂单据上时，改它改的是**原厂单据的打印行为** —— 判据跟 BOTP 规则同一个理由：
     * 有一头是原厂的就拦。实测本 ISV 的 218 张模板里有 11 张属于这一类
     * （`zlgd_saloutbill_lylb001` → `im_saloutbill` 这种）。**它们不是不能改，是不走探针改** ——
     * 扩原厂单据走开发平台的扩展流程，这是本工程一贯的规矩。
     *
     * 只读不受这条限制（读原厂元数据从来都可以），所以只有写通道调这个方法。
     */
    public static void assertOwnPrintTpl(String number, String actualNumber, String isv,
                                         String hostForm) {
        assertOwnPrintTplSelf(number, actualNumber, isv);
        if (nz(hostForm).toLowerCase().startsWith(PREFIX) == false) {
            deny("模板 " + number + " 挂在 " + q(hostForm) + " 上，不是 " + PREFIX
                    + " 单据 —— 改它就是改原厂单据的打印行为。走开发平台的扩展流程");
        }
        //只挂在写通道上：只读的四个打印探针调的是 assertOwnPrintTplSelf，读不该要确认
        assertConfirmedTagged("tpl", number, "打印模板 " + q(number));
    }

    /**
     * 改工作流模型之前调。**当前没有任何写通道调它 —— 工作流一期只读**；
     * 它先摆在这里，是为了判据定在写通道接上之前，而不是接上那天现想。
     *
     * 实测结论（812 个模型全量）：**`wf_model` 上没有任何归属字段** —— 42 个属性里没有 isv，
     * 目录侧也没有。编码列 `key` 同样不可用：key 以 <isv>_ 开头的只有 12 个，
     * 而挂在本 ISV 单据上的有 289 个 —— 平台生成的 key 长 `Proc_er_tripreqbill_audit_1` 这样，
     * 跟谁建的没关系。
     *
     * 所以唯一可用的判据是挂靠单据 `entrabill` 的前缀，**比另外两个家族弱一档**：
     * 它证明不了「这个模型是本 ISV 建的」，只证明「它管的是本 ISV 的单据」。
     * 这就是工作流写入留在二期、且要单独授权的原因。
     */
    public static void assertOwnWfModel(String modelKey, String entraBill) {
        requireIsv();
        System.out.println("[PROBE] ISV 检查 流程模型 " + q(modelKey) + "  entrabill=" + q(entraBill));
        if (nz(entraBill).toLowerCase().startsWith(PREFIX) == false) {
            deny("流程模型 " + q(modelKey) + " 挂在 " + q(entraBill) + " 上，不是 " + PREFIX
                    + " 单据。wf_model 上没有归属字段，挂靠单据是唯一判据，所以拦得比别处严");
        }
        assertConfirmedTagged("wf", modelKey, "流程模型 " + q(modelKey));
    }

    /** 改/删/加某个字段之前调。 */
    public static void assertOwnField(String key) {
        requireIsv();
        if (key == null || !key.toLowerCase().startsWith(PREFIX)) {
            deny("字段标识 " + q(key) + " 没有 " + PREFIX + " 前缀 —— "
                    + "二开单据上没有前缀的字段是从原厂模板继承来的（billstatus、billno、"
                    + "creator 这类），动不得");
        }
        assertConfirmedField(key);
    }

    /** 改已知实体下的布局；写入确认必须精确到 `实体.布局`。 */
    public static void assertOwnLayout(String entity, String key) {
        requireIsv();
        if (key == null || !key.toLowerCase().startsWith(PREFIX)) {
            deny("布局标识 " + q(key) + " 没有 " + PREFIX + " 前缀");
        }
        assertConfirmedUnder("布局", entity, key);
    }

    /**
     * 建在原厂或别家实体上的本 ISV 布局（例如在原厂合同上建的移动单据）：布局本身是本 ISV 的、带前缀，可以改；
     * 实体是别人的，一处都不能动——调用方保证只存布局。写入确认照样精确到 `实体.布局`。
     */
    public static void assertOwnLayoutOnForeignEntity(String entity, String entityIsv, String key, String layoutIsv) {
        requireIsv();
        System.out.println("[PROBE] ISV 检查 布局 " + key + "  isv=" + layoutIsv + "，建在 " + entity + "（isv=" + entityIsv
                + "）上：只改布局，实体不动");
        if (!ISV.equalsIgnoreCase(nz(layoutIsv))) {
            deny("布局 " + key + " 的 ISV 是 " + q(layoutIsv) + "，不是 " + ISV);
        }
        if (key == null || !key.toLowerCase().startsWith(PREFIX)) {
            deny("布局标识 " + q(key) + " 没有 " + PREFIX + " 前缀");
        }
        assertConfirmedUnder("布局", entity, key);
    }

    /** 加、删本单据自己的操作之前调：要带前缀（没有前缀的是模板或标准产品带来的）；写入确认精确到 `实体.操作`。 */
    public static void assertOwnOperation(String key) {
        requireIsv();
        if (key == null || !key.toLowerCase().startsWith(PREFIX)) {
            deny("操作标识 " + q(key) + " 没有 " + PREFIX + " 前缀 —— 没有前缀的操作是模板或标准产品带来的，加删不得");
        }
        assertConfirmedUnder("操作", owner, key);
    }

    /**
     * 给本单据上的某个操作挂插件、摘插件之前调。操作可以是模板带来的（保存、提交这类）：
     * 插件登记在本单据自己的实体上，模板不动，所以不查操作的前缀，只把 `实体.操作` 记进写入目标。
     */
    public static void assertOperationHost(String key) {
        requireIsv();
        assertConfirmedUnder("操作", owner, key);
    }

    /**
     * 改本单据的单据头或某个分录自身的配置（拆分表）之前调。分录可以是模板带来的（entryentity 这类没有前缀的）：
     * 配置存在本单据自己的实体上，模板不动，所以不查前缀，只把 `实体.<单据或分录>` 记进写入目标。
     */
    public static void assertEntityPart(String key) {
        requireIsv();
        assertConfirmedUnder("单据头或分录", owner, key);
    }

    /**
     * 苍穹平台自己的服务云（09-28 真机 71 朵云里挑出来的）：系统、开发、开放、流程、集成、数据、AI、RPA、区块链、无代码。
     * 接口登记（openapi_apilist，开放服务云）、流程（wf_*，流程服务云）、调度作业（sch_job，系统服务云）、
     * 应用登记（bos_devportal_*，开发服务云）都在这里面。基础服务云（BAMP）不算：人员、组织、物料、客户是业务主数据。
     * 平台没有「这朵云是平台服务」的标记（bos_devportal_bizcloud 只有原厂 / 扩展），只能列编码。
     */
    static final java.util.Set<String> PLATFORM_CLOUDS = new java.util.HashSet<String>(java.util.Arrays.asList(
            "SYS", "DEV", "OSC", "WFS", "EIP", "DATA", "AI", "RPAC", "BSC", "NOCODE"));

    /** 表单所属的云：{编码, 名称}；查不到（没有表单元数据、应用没挂云）返回 null，不拦。 */
    static String[] cloudOf(String number) {
        try {
            kd.bos.dataentity.entity.DynamicObject meta = kd.bos.servicehelper.QueryServiceHelper.queryOne(
                    "bos_formmeta", "bizappid", new kd.bos.orm.query.QFilter[]{
                            new kd.bos.orm.query.QFilter("number", "=", nz(number))});
            if (meta == null || nz(meta.getString("bizappid")).isEmpty()) {
                return null;
            }
            kd.bos.dataentity.entity.DynamicObject app = kd.bos.servicehelper.QueryServiceHelper.queryOne(
                    "bos_devportal_bizapp", "bizcloud.number,bizcloud.name", new kd.bos.orm.query.QFilter[]{
                            new kd.bos.orm.query.QFilter("id", "=", meta.getString("bizappid"))});
            if (app == null || nz(app.getString("bizcloud.number")).isEmpty()) {
                return null;
            }
            return new String[]{app.getString("bizcloud.number"), nz(app.getString("bizcloud.name"))};
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static void deny(String why) {
        System.out.println("[PROBE] !! 拒绝：" + why);
        blocked();
        System.out.println("[PROBE] !! 绝对禁止修改/删除原厂元数据。要动请走开发平台的扩展流程。");
        //不写「拒绝写入」：只读入口也调这里（四个打印探针），说成写入会让人以为探针要落库
        throw new IllegalStateException("IsvGuard 拒绝：" + why);
    }

    /**
     * 这一次是**在写入之前**被拦下的：共享环境一个字节都没动。
     *
     * 回执要分得清这个和「写到一半失败」：后者可能已经落了一部分库，读回执的人必须去核对
     * 现场；前者去核对现场是白跑一趟，而且会让人以为共享环境被动过。IsvGuard 的三道检查
     * 全部排在各探针调 save/write 之前，所以这行话在这里永远是真的。
     *
     * 只在 APPLY=1 时说：只读入口也会走到 deny（四个打印探针），那时提「落库」只会让人
     * 以为这个探针本来要写东西。
     */
    private static void blocked() {
        if (applying()) {
            System.out.println("[PROBE] 未落库：这次在写入之前就被拦下（IsvGuard），共享环境没有任何改动");
        }
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static String q(String s) {
        return s == null || s.isEmpty() ? "(空)" : "「" + s + "」";
    }
}
