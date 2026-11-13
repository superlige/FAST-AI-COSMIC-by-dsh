import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.data.BusinessDataReader;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.dataentity.metadata.dynamicobject.DynamicObjectType;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.datamodel.AbstractFormDataModel;
import kd.bos.entity.datamodel.RowDataEntity;
import kd.bos.entity.formula.BOSExpression;
import kd.bos.entity.formula.BOSExpressionContext;
import kd.bos.entity.formula.CalcExprParser;
import kd.bos.entity.formula.RowDataModel;
import kd.bos.entity.function.FunctionManage;
import kd.bos.entity.rule.BR;
import kd.bos.entity.rule.BRAction;
import kd.bos.entity.rule.BRExecuteContext;
import kd.bos.entity.rule.RuleExecuteContext;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.Entity;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.entity.rule.BizRule;
import kd.bos.metadata.entity.rule.BizRuleAction;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.form.rule.FieldId;
import kd.bos.metadata.form.rule.FormRule;

/**
 * 规则求值仿真器：**不建 FormView、不装插件、不落库**，只算「元数据里的规则」这一层。
 * 由 driver.mjs run rule 翻译成 RULE_* 环境变量。
 *
 * <pre>
 *   RULE_KIND    form=界面规则（显隐/锁定） | biz=业务规则（目标字段被算成什么值）
 *   RULE_TARGET  form 给布局标识，biz 给实体标识 —— 布局 != 实体，两边不能互换
 *   RULE_SET     字段=值;分录.字段=值   值的写法见 {@link ExpectSpec#convert}（下拉填存储值，
 *                基础资料给 id 或 number）。**子分录路径明确拒绝**：这里的宿主只有表头和分录两层
 *   RULE_HOST    biz 专用：只跑这一个宿主（主实体或分录），默认全部
 *   RULE_ROW     分录行号，默认 0
 *   RULE_EXPECT  断言，走 ExpectSpec
 *   RULE_SHOW    只打值、不断言：form 给控件标识（字段、面板、分录都行），打它的可见/可编辑终态和归因；
 *                biz 给字段路径，打它此刻的值。分号或逗号分隔。没有断言的运行不留候选用例 ——
 *                「改前看一眼」用它，不要为了看值写 RULE_EXPECT
 * </pre>
 *
 * **它和 `run form --show` 的分工**：`--show` 打的是运行态终值，是「插件 + 界面规则 +
 * 业务规则」三者合力的结果；本探针只算规则那一层。值不对的时候两个一起跑，就能定位到
 * 是插件写的还是规则写的 —— 这是它独立存在的全部理由。
 */
public class RuleSim {

    /**
     * `AbstractFormDataModel` 自己没有抽象方法，只差 `IRefrencedataProvider` 那一个和三个
     * 引用装载方法（父类实现直接抛 `not implements!!!`）。补上这四个就得到一个
     * **不带 View、不带 PageCache、不装插件**的真 IDataModel —— 规则求值要的正是这个。
     */
    static class PlainModel extends AbstractFormDataModel {
        PlainModel(MainEntityType met) {
            super(met);
        }

        public void fillReferenceData(Object[] objects, IDataEntityType type) {
            BusinessDataReader.loadRefence(objects, type);
        }

        public DynamicObject loadReferenceData(DynamicObjectType type, Object pk) {
            Map<Object, DynamicObject> m = BusinessDataReader.loadFromCache(new Object[]{pk}, type);
            return m == null ? null : m.get(pk);
        }

        @SuppressWarnings("rawtypes")
        public Map loadReferenceDataBatch(DynamicObjectType type, List pks) {
            return BusinessDataReader.loadFromCache(pks == null ? new Object[0] : pks.toArray(), type);
        }

        @SuppressWarnings("rawtypes")
        public Map loadReferenceDataBatch(DynamicObjectType type, Object[] pks) {
            return BusinessDataReader.loadFromCache(pks == null ? new Object[0] : pks, type);
        }
    }

    /**
     * 一个控件的显隐/锁定状态。分两层：
     *   self*  —— 这个控件自己的状态：先取布局静态配置（invisible / hidden / visible 场景），
     *             再被命中的界面规则按 seq 覆盖
     *   eff*   —— 叠加父链传播之后的终态：祖先容器不可见，自己再"可见"也看不见
     */
    static class State {
        ControlAp<?> ap;
        boolean selfVisible = true;
        boolean selfEnabled = true;
        String visibleBy = "默认";
        String enabledBy = "默认";
        boolean effVisible = true;
        boolean effEnabled = true;
        /** 终态归因：自己的 visibleBy，或"容器 xxx 隐藏" */
        String effBy = "默认";
        String effEnabledBy = "默认";
        /** 被界面规则动过（用来区分"规则改的"和"布局本来就这样"） */
        boolean touchedByRule = false;
        /** hide-wins 语义的闩：被规则隐藏过之后，后面的 Show 不再改回来 */
        boolean hiddenByRule = false;
    }

    /** visible 掩码的全集。RULE_SCENE=all 时要求六项全开才算显示 */
    static final List<String> ALL_SCENES = Collections.unmodifiableList(
            java.util.Arrays.asList("init", "new", "edit", "view", "submit", "audit"));

    static MainEntityType MET;
    static int ROW;
    /** 第二遍求值（另一种分支语义）只用来比对，不重复打逐条求值的日志 */
    static boolean VERBOSE = true;
    /** hide-wins：规则一旦把某控件隐藏，后续规则的 Show 不再把它显示回来 */
    static boolean HIDE_WINS = false;
    /** 候选试算时只说这几条规则（规则 id）；null = 正常 run rule，全说 */
    static Set<String> FOCUS = null;
    /** 候选试算里，改动的规则算不出来的地方（条件求值、编译、动作执行） */
    static final List<String> FOCUS_FAILED = new ArrayList<String>();
    /** 最近一次条件求值或动作执行失败的原因；没执行（见 UNSAFE_FUNCS）时为 null */
    static String LAST_ERROR = null;
    /**
     * 候选试算时不执行的规则函数：实现类不在平台 JAR 里（本工程编出来的类，可能比源码旧）。
     * 写入探针走的是不看过期类的那条道，试算就不能去执行这种类。null = 不在试算里，全执行。
     */
    static Set<String> UNSAFE_FUNCS = null;
    /** 候选试算里因为上面那条没执行的地方；界面规则要按两种分支语义各算一遍，同一处只记一次 */
    static final Set<String> SKIPPED = new LinkedHashSet<String>();

    public static void run() throws Exception {
        String kind = env("RULE_KIND", "form");
        String target = env("RULE_TARGET", "");
        if (target.isEmpty()) {
            throw new IllegalArgumentException("RULE_TARGET 必填：form 给布局标识，biz 给实体标识");
        }
        ROW = Integer.parseInt(env("RULE_ROW", "0"));
        if ("biz".equals(kind)) {
            biz(target);
        } else {
            form(target);
        }
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败：" + target);
        }
    }

    // ==================== 界面规则 ====================

    static void form(String layout) throws Exception {
        String formId = MetadataDao.getIdByNumber(layout, MetaCategory.Form);
        if (formId == null) {
            throw new IllegalArgumentException("布局不存在：" + layout + "（布局不等于实体，别把实体标识填进来）");
        }
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        Map<String, ControlAp<?>> apById = controls(fm);
        String scene = scene();
        String rootId = fm.getRootAp() == null ? null : String.valueOf(fm.getRootAp().getId());
        Map<String, List<String>> childrenOf = childrenOf(apById, rootId);
        List<Object[]> rules = sortedRules(apById);
        System.out.println("[PROBE] 界面规则 " + layout + " Ap=" + apById.size() + " 规则=" + rules.size());
        if (rules.isEmpty()) {
            System.out.println("[PROBE]   这张布局没挂界面规则");
        }

        //**只解析一次。** MetaResolve.entityNumber() 拿布局标识去 getDataEntityType() 先失败一次
        //才走布局分支，那一次失败在大单据上要 5 秒；再调一次 type() 就是又付一遍。
        MET = MetaResolve.type(layout);
        String entity = MET.getName();
        PlainModel model = newModel(MET);
        applySets(model, env("RULE_SET", ""));

        Map<String, RowDataModel> layers = new LinkedHashMap<String, RowDataModel>();
        String branch = branch();

        //**分支语义有三种，平台没有明面契约，所以主结论算一种、对照算一种，差集显式打出来：**
        //  hide-wins  真假分支都执行，但规则一旦把某控件隐藏，后面的 Show 不再把它显示回来（默认）
        //  both       条件真走真分支、条件假走假分支，纯按 seq 后盖前
        //  true-only  只执行条件为真的规则的真分支，假分支一律不动
        //默认取 hide-wins 的依据：2026-09-01 zlgd_sys_xbl 金相场景，both 算出可见的 8 个字段
        //（单位/上下限/检验结果值/探伤级别/铸锭块号/剥落腐蚀/晶间腐蚀）线上实际看不到，
        //而 true-only 又会把力学/硬度那批本该隐藏的字段放出来 —— 只有 hide-wins 两头都对得上。
        //**这仍是从一次实证反推的，不是平台契约**：结论落到分歧字段上时，去界面上看一眼。
        String alt = "both".equals(branch) ? "hide-wins" : "both";
        System.out.println("[PROBE] --- 逐条求值（主算法 branch=" + branch + "，对照 " + alt + "）---");
        Map<String, State> states = evaluate(rules, apById, childrenOf, rootId, scene,
                branch, model, entity, layers, true);
        VERBOSE = false;
        Map<String, State> other = evaluate(rules, apById, childrenOf, rootId, scene,
                alt, model, entity, layers, false);
        VERBOSE = true;
        HIDE_WINS = false;

        //**打印按字段粒度**：只有 FieldAp / EntryFieldAp 是"最小控件"，容器只在归因里出现。
        System.out.println("[PROBE] --- 字段终态（场景=" + scene + "："
                + ("all".equals(scene) ? "visible 六项全开才算显示" : "visible 覆盖 " + scene + " 即算显示")
                + "）---");
        System.out.println("[PROBE]     判据：布局 invisible/hidden/visible + 父容器传播 + 界面规则，按 seq 后盖前");
        //**facts 收全部控件，不只字段** —— 容器的 visible 也要能断（分录字段组展没展开是常见验收点），
        //但下面的统计和打印只按字段粒度走，容器只作为归因出现。
        Map<String, String> facts = new LinkedHashMap<String, String>();
        List<State> fields = new ArrayList<State>();
        for (State s : states.values()) {
            facts.put(s.ap.getKey() + ".visible", String.valueOf(s.effVisible));
            facts.put(s.ap.getKey() + ".enabled", String.valueOf(s.effEnabled));
            if (s.ap instanceof kd.bos.metadata.form.control.FieldAp) {
                fields.add(s);
            }
        }
        int shown = 0;
        Map<String, int[]> why = new LinkedHashMap<String, int[]>();
        for (State s : fields) {
            if (s.effVisible) {
                shown++;
            } else {
                bump(why, reasonOf(s));
            }
        }
        System.out.println("[PROBE] 字段控件 " + fields.size() + " 个：显示 " + shown
                + "，隐藏 " + (fields.size() - shown));
        StringBuilder wb = new StringBuilder();
        for (Map.Entry<String, int[]> e : why.entrySet()) {
            if (wb.length() > 0) {
                wb.append(" | ");
            }
            wb.append(e.getKey()).append(' ').append(e.getValue()[0]);
        }
        if (wb.length() > 0) {
            System.out.println("[PROBE]   隐藏归因  " + wb);
        }

        //被规则动过的字段：这是"规则那一层"的产出，永远打
        List<State> touched = new ArrayList<State>();
        for (State s : fields) {
            if (s.touchedByRule) {
                touched.add(s);
            }
        }
        System.out.println("[PROBE] --- 被界面规则改过的字段 " + touched.size() + " 个 ---");
        for (State s : touched) {
            System.out.println("[PROBE]   " + pad(s.ap.getKey(), 30)
                    + " 可见=" + yn(s.effVisible) + "(" + s.effBy + ")"
                    + "  可编辑=" + yn(s.effEnabled) + "(" + s.effEnabledBy + ")");
        }
        //被规则直接动过的容器（面板、分组、分录）也是「规则那一层」的产出。以前只在字段归因里
        //露面：容器自己是显示还是隐藏，只能写 --expect 去问，而断言全过又会落候选用例 ——
        //「改前看一眼」就这样变成了一条改后必然失败的候选。
        List<State> touchedContainers = new ArrayList<State>();
        for (State s : states.values()) {
            if (s.touchedByRule && !(s.ap instanceof kd.bos.metadata.form.control.FieldAp)) {
                touchedContainers.add(s);
            }
        }
        if (!touchedContainers.isEmpty()) {
            System.out.println("[PROBE] --- 被界面规则改过的容器 " + touchedContainers.size() + " 个 ---");
            for (State s : touchedContainers) {
                System.out.println("[PROBE]   " + pad(s.ap.getKey(), 30)
                        + " 可见=" + yn(s.effVisible) + "(" + s.effBy + ")"
                        + "  可编辑=" + yn(s.effEnabled) + "(" + s.effEnabledBy + ")"
                        + "   " + nameOf(s.ap));
            }
        }

        //造成连带隐藏的容器：一行顶几十行子字段，定位"为什么这批字段没了"最快
        Map<String, int[]> byContainer = new LinkedHashMap<String, int[]>();
        for (State s : fields) {
            if (!s.effVisible && s.effBy != null && s.effBy.startsWith("容器 ")) {
                bump(byContainer, s.effBy);
            }
        }
        if (!byContainer.isEmpty()) {
            System.out.println("[PROBE] --- 造成连带隐藏的容器 ---");
            List<Map.Entry<String, int[]>> cs =
                    new ArrayList<Map.Entry<String, int[]>>(byContainer.entrySet());
            Collections.sort(cs, new Comparator<Map.Entry<String, int[]>>() {
                public int compare(Map.Entry<String, int[]> a, Map.Entry<String, int[]> b) {
                    return b.getValue()[0] - a.getValue()[0];
                }
            });
            for (Map.Entry<String, int[]> e : cs) {
                System.out.println("[PROBE]   " + pad(e.getKey(), 46) + " 连带 " + e.getValue()[0] + " 个字段");
            }
        }

        //**分支语义分歧**：两种算法结论不同的字段，就是这次结论最不该被当成定论的部分。
        //苍穹前端到底在打开单据时全量执行真假分支、还是只执行条件为真的规则，平台没有明面契约；
        //实测有过反例（zlgd_sys_xbl 金相场景：both 算出可见的 8 个字段，线上看不到，
        //true-only 与线上一致）。分歧字段要么去界面上看一眼，要么用 run form --show 交叉验。
        List<State> diff = new ArrayList<State>();
        for (State s : fields) {
            State o = other.get(String.valueOf(s.ap.getId()));
            if (o != null && o.effVisible != s.effVisible) {
                diff.add(s);
            }
        }
        String otherName = alt;
        if (diff.isEmpty()) {
            System.out.println("[PROBE] 分支语义分歧 0 个字段 —— both 和 true-only 结论一致，"
                    + "这次的显隐结论不依赖那个未定的契约");
        } else {
            System.out.println("[PROBE] --- 分支语义分歧 " + diff.size() + " 个字段（"
                    + branch + " vs " + otherName + "）---");
            System.out.println("[PROBE]     这几个字段的结论取决于「假分支执不执行」，平台没有明面契约。"
                    + "拿不准就去界面上看一眼，或 run form --show 交叉验");
            for (State s : diff) {
                State o = other.get(String.valueOf(s.ap.getId()));
                System.out.println("[PROBE]   " + pad(s.ap.getKey(), 30)
                        + " " + branch + "=" + (s.effVisible ? "显示" : "隐藏")
                        + "  " + otherName + "=" + (o.effVisible ? "显示" : "隐藏")
                        + "   " + nameOf(s.ap));
                ProbeJson.emit("rule-branch-diff", "field", s.ap.getKey(),
                        "primary", Boolean.valueOf(s.effVisible), "alt", Boolean.valueOf(o.effVisible));
            }
        }

        //全量清单：默认不打（一张大布局一千多个字段会把结论淹掉），要看给 RULE_LIST
        String list = env("RULE_LIST", "");
        if ("visible".equals(list) || "hidden".equals(list) || "all".equals(list)) {
            boolean wantVisible = !"hidden".equals(list);
            boolean wantHidden = !"visible".equals(list);
            System.out.println("[PROBE] --- 全量字段清单（RULE_LIST=" + list + "）---");
            for (State s : fields) {
                if (s.effVisible ? !wantVisible : !wantHidden) {
                    continue;
                }
                System.out.println("[PROBE]   " + (s.effVisible ? "显示 " : "隐藏 ")
                        + pad(s.ap.getKey(), 30) + " " + pad(nameOf(s.ap), 24) + " " + s.effBy);
            }
        }

        //--show：点名打任意控件的终态，不断言、不落候选。按 key 取值的口径跟 facts 一样
        //（同 key 出现多次时后一个为准），所以这里打出来的就是同一个 key 写 --expect 会比的那个值。
        String show = env("RULE_SHOW", "");
        if (!show.isEmpty()) {
            Map<String, State> byKey = new LinkedHashMap<String, State>();
            for (State s : states.values()) {
                byKey.put(s.ap.getKey(), s);
            }
            System.out.println("[PROBE] --- 点名查看（--show，只打值不断言）---");
            for (String raw : show.split("[;,]")) {
                String key = raw.trim();
                if (key.endsWith(".visible") || key.endsWith(".enabled")) {
                    key = key.substring(0, key.lastIndexOf('.'));
                }
                if (key.isEmpty()) {
                    continue;
                }
                State s = byKey.get(key);
                if (s == null) {
                    System.out.println("[PROBE]   " + pad(key, 30) + " ✗ 布局 " + layout + " 上没有这个控件");
                    ProbeJson.emit("rule-show", "field", key, "found", Boolean.FALSE);
                    continue;
                }
                System.out.println("[PROBE]   " + pad(key, 30)
                        + " 可见=" + yn(s.effVisible) + "(" + s.effBy + ")"
                        + "  可编辑=" + yn(s.effEnabled) + "(" + s.effEnabledBy + ")"
                        + "   " + s.ap.getClass().getSimpleName() + " " + nameOf(s.ap));
                ProbeJson.emit("rule-show", "field", key, "found", Boolean.TRUE,
                        "visible", Boolean.valueOf(s.effVisible), "enabled", Boolean.valueOf(s.effEnabled),
                        "visibleBy", s.effBy, "enabledBy", s.effEnabledBy);
            }
        }

        //**rule-state 只发两种：被界面规则碰过的、被 --expect 点过名的。** 其余汇总成一条 rule-state-rest。
        //以前是布局上每个字段一条，不管问没问：真机 2026-09-14 一张 1,352 个字段的布局一次发 1,352 条、
        //20 万字符，规则碰过的只有 60 条，剩下 1,290 条几乎全是「布局里本来就藏着」。
        //这些记录 TypeScript 侧一条都不读，断言走的是上面的 facts（全部控件），不看这里 ——
        //所以少发不影响任何判定，只影响模型要读多少。
        //  --show 点名的不在这里重复：rule-show 已经是同一份内容（外加容器）。
        //  --expect 点名的连通过的也发：断言记录只有真/假，没有「为什么」，挂了的时候缺的正是 visibleBy。
        //  全名单要看给 RULE_LIST，那是文字通道，超预算会落盘。
        Set<String> expectNamed = new LinkedHashSet<String>();
        try {
            for (String[] kv : ExpectSpec.pairs(env("RULE_EXPECT", ""))) {
                String key = kv[0];
                if (key.endsWith(".visible") || key.endsWith(".enabled")) {
                    key = key.substring(0, key.lastIndexOf('.'));
                }
                expectNamed.add(key);
            }
        } catch (IllegalArgumentException malformed) {
            //形状不对由下面 ExpectSpec.facts 照原样报，这里不抢先抛、不改原来的报错位置
        }
        int restVisible = 0;
        int restHidden = 0;
        Map<String, int[]> restHiddenBy = new LinkedHashMap<String, int[]>();
        for (State s : fields) {
            if (s.touchedByRule || expectNamed.contains(s.ap.getKey())) {
                ProbeJson.emit("rule-state", "field", s.ap.getKey(),
                        "visible", Boolean.valueOf(s.effVisible), "enabled", Boolean.valueOf(s.effEnabled),
                        "visibleBy", s.effBy, "enabledBy", s.effEnabledBy,
                        "byRule", Boolean.valueOf(s.touchedByRule));
            } else if (s.effVisible) {
                restVisible++;
            } else {
                restHidden++;
                bump(restHiddenBy, s.effBy == null ? "?" : s.effBy);
            }
        }
        if (restVisible + restHidden > 0) {
            ProbeJson.emit("rule-state-rest", "count", Integer.valueOf(restVisible + restHidden),
                    "visible", Integer.valueOf(restVisible), "hidden", Integer.valueOf(restHidden),
                    "hiddenBy", topReasons(restHiddenBy, 10),
                    "list", "要逐个字段看：--show 点名，或 --list hidden|visible|all");
        }
        ProbeJson.emit("scenario", "adapter", "run rule form", "layout", layout, "entity", entity,
                "scene", scene, "rules", Integer.valueOf(rules.size()),
                "fields", Integer.valueOf(fields.size()), "visibleFields", Integer.valueOf(shown));
        ExpectSpec.facts(facts, new LinkedHashMap<String, List<String>>(), "rule-form",
                env("RULE_EXPECT", ""));
    }

    /**
     * 跑一遍完整求值：静态初值 → 逐条规则覆盖 → 父链传播。
     * trueOnly=true 时条件为假的规则整条跳过（假分支不执行）。
     */
    static Map<String, State> evaluate(List<Object[]> rules, Map<String, ControlAp<?>> apById,
            Map<String, List<String>> childrenOf, String rootId, String scene, String mode,
            PlainModel model, String entity, Map<String, RowDataModel> layers, boolean verbose) {
        boolean trueOnly = "true-only".equals(mode);
        HIDE_WINS = "hide-wins".equals(mode);
        //**每个控件都要有状态，初值取布局静态配置，不是一律 true。**
        //只给"规则碰过的字段"建状态会漏掉一大类：布局里 invisible=true 的字段规则根本不提它，
        //却是界面上真正看不见的那批（实测某布局 1782 个控件里有 430 个）。
        Map<String, State> states = new LinkedHashMap<String, State>();
        for (Map.Entry<String, ControlAp<?>> e : apById.entrySet()) {
            ControlAp<?> ap = e.getValue();
            State s = new State();
            s.ap = ap;
            s.visibleBy = staticVisibleBy(ap, scene);
            s.selfVisible = s.visibleBy == null;
            if (s.selfVisible) {
                s.visibleBy = "默认";
            }
            //终态留空，等父链传播来填；传播走不到的（挂在树外的）由下面按自身状态收尾。
            //State 的初值是「默认」，不清掉的话收尾那一步永远不触发，树外控件被规则隐藏了也报可见
            s.effBy = null;
            s.effEnabledBy = null;
            states.put(e.getKey(), s);
        }

        for (Object[] p : rules) {
            ControlAp<?> host = (ControlAp<?>) p[0];
            FormRule r = (FormRule) p[1];
            String label = "seq=" + r.getSeq() + " host=" + host.getKey();
            //候选试算只说这次改动的规则；别的规则照样求值（它们也管着同一批控件），只是不打
            boolean say = verbose && (FOCUS == null || FOCUS.contains(String.valueOf(r.getId())));
            if (!r.isEnabled()) {
                if (say) {
                    System.out.println("[PROBE]   " + label + " 已禁用，跳过");
                }
                continue;
            }
            Boolean hit = condition(r.getPreCondition(), layer(layers, model, entity, host.getKey()), label, say);
            if (hit == null) {
                if (say && FOCUS != null && LAST_ERROR != null) {
                    FOCUS_FAILED.add(label + " 的条件：" + LAST_ERROR);
                }
                continue;
            }
            if (trueOnly && !hit.booleanValue()) {
                continue;
            }
            @SuppressWarnings("unchecked")
            List<BizRuleAction> acts = (List<BizRuleAction>) (hit.booleanValue()
                    ? r.getTrueActions() : r.getFalseActions());
            apply(acts, apById, states, "seq=" + r.getSeq() + (hit.booleanValue() ? "真" : "假"));
        }

        //**父链传播**：容器隐藏了，里面的字段再"可见"也看不见。自顶向下走一遍，
        //每个节点的终态 = 自己的状态 && 父亲的终态。
        propagate(rootId, null, states, childrenOf);
        //挂在树外的控件（parentId 指向不存在的节点）不能丢，按自身状态收尾
        for (State s : states.values()) {
            if (s.effBy == null) {
                s.effVisible = s.selfVisible;
                s.effBy = s.visibleBy;
                s.effEnabled = s.selfEnabled;
                s.effEnabledBy = s.enabledBy;
            }
        }
        return states;
    }

    /**
     * 静态可见性判据。返回 null 表示"静态可见"，否则返回不可见的原因。
     * 三个属性各管各的，缺一个就会把隐藏字段判成显示：
     *   invisible —— 设计器里的「隐藏元素」，实测一张布局 1782 个控件里 430 个是它
     *   hidden    —— 另一路隐藏标记
     *   visible   —— 场景掩码，值形如 init,new,edit,view,submit,audit
     */
    static String staticVisibleBy(ControlAp<?> ap, String scene) {
        Object inv = HeadlessUiSupport.call(ap, "isInvisible");
        if (Boolean.TRUE.equals(inv)) {
            return "布局invisible";
        }
        Object hid = HeadlessUiSupport.call(ap, "isHidden");
        if (Boolean.TRUE.equals(hid)) {
            return "布局hidden";
        }
        Object v = HeadlessUiSupport.call(ap, "getVisible");
        String vs = v == null ? "" : String.valueOf(v).trim();
        if (vs.isEmpty() || "null".equals(vs)) {
            return "visible为空";
        }
        Set<String> got = new LinkedHashSet<String>();
        for (String part : vs.split(",")) {
            String t = part.trim();
            if (!t.isEmpty()) {
                got.add(t);
            }
        }
        if ("all".equals(scene)) {
            List<String> miss = new ArrayList<String>();
            for (String need : ALL_SCENES) {
                if (!got.contains(need)) {
                    miss.add(need);
                }
            }
            return miss.isEmpty() ? null : "visible缺" + join(miss);
        }
        return got.contains(scene) ? null : "visible不含" + scene;
    }

    /** 自顶向下：终态 = 自己的状态 && 父亲的终态；父亲关掉的，归因记成"容器 X" */
    static void propagate(String id, State parent, Map<String, State> states,
            Map<String, List<String>> childrenOf) {
        if (id == null) {
            return;
        }
        State s = states.get(id);
        if (s != null) {
            boolean parentVisible = parent == null || parent.effVisible;
            boolean parentEnabled = parent == null || parent.effEnabled;
            s.effVisible = s.selfVisible && parentVisible;
            s.effEnabled = s.selfEnabled && parentEnabled;
            if (!s.selfVisible) {
                s.effBy = s.visibleBy;
            } else if (!parentVisible) {
                //归到"最上面那个真正被关掉的容器"，不是直接父亲 —— 否则一层层报中间容器，看不出根因
                s.effBy = parent.effBy != null && parent.effBy.startsWith("容器 ")
                        ? parent.effBy
                        : "容器 " + parent.ap.getKey() + "(" + nameOf(parent.ap) + ") " + parent.effBy;
            } else {
                s.effBy = s.visibleBy;
            }
            if (!s.selfEnabled) {
                s.effEnabledBy = s.enabledBy;
            } else if (!parentEnabled) {
                s.effEnabledBy = parent.effEnabledBy != null && parent.effEnabledBy.startsWith("容器 ")
                        ? parent.effEnabledBy
                        : "容器 " + parent.ap.getKey() + " " + parent.effEnabledBy;
            } else {
                s.effEnabledBy = s.enabledBy;
            }
        }
        List<String> kids = childrenOf.get(id);
        if (kids == null) {
            return;
        }
        for (String k : kids) {
            if (!k.equals(id)) {
                propagate(k, s, states, childrenOf);
            }
        }
    }

    static String reasonOf(State s) {
        String by = s.effBy == null ? "?" : s.effBy;
        if (by.startsWith("容器 ")) {
            return "容器连带";
        }
        if (by.startsWith("布局")) {
            return by;
        }
        if (by.startsWith("visible")) {
            return "visible不覆盖场景";
        }
        return "界面规则";
    }

    /**
     * 隐藏原因按个数从多到少取前 limit 种，其余并成一项。原因里带着容器名，
     * 一张大布局能有上百种，不封顶的话这条汇总自己又会长成原来那一千多条的样子。
     */
    static List<Map<String, Object>> topReasons(Map<String, int[]> counts, int limit) {
        List<Map.Entry<String, int[]>> es = new ArrayList<Map.Entry<String, int[]>>(counts.entrySet());
        Collections.sort(es, new Comparator<Map.Entry<String, int[]>>() {
            public int compare(Map.Entry<String, int[]> a, Map.Entry<String, int[]> b) {
                return b.getValue()[0] - a.getValue()[0];
            }
        });
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        int otherKinds = 0;
        int otherFields = 0;
        for (Map.Entry<String, int[]> e : es) {
            if (out.size() < limit) {
                Map<String, Object> one = new LinkedHashMap<String, Object>();
                one.put("by", e.getKey());
                one.put("count", Integer.valueOf(e.getValue()[0]));
                out.add(one);
            } else {
                otherKinds++;
                otherFields += e.getValue()[0];
            }
        }
        if (otherKinds > 0) {
            Map<String, Object> rest = new LinkedHashMap<String, Object>();
            rest.put("by", "其余 " + otherKinds + " 种原因");
            rest.put("count", Integer.valueOf(otherFields));
            out.add(rest);
        }
        return out;
    }

    static void bump(Map<String, int[]> m, String k) {
        int[] c = m.get(k);
        if (c == null) {
            m.put(k, new int[]{1});
        } else {
            c[0]++;
        }
    }

    static String nameOf(ControlAp<?> ap) {
        Object n = ap.getName();
        return n == null ? "" : String.valueOf(n);
    }

    static String join(List<String> xs) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < xs.size(); i++) {
            if (i > 0) {
                b.append(',');
            }
            b.append(xs.get(i));
        }
        return b.toString();
    }

    /**
     * 规则动作按**控件 id** 落到 states 上 —— 不能按 key，同一个 key 在一张布局里可能出现多次
     * （rootAp 在 getItems() 里再出现一次是常态），按 key 写会串到别的控件上。
     * 动作作用于容器时也照写：容器的状态在 propagate() 里会传给它下面的所有字段。
     */
    static void apply(List<BizRuleAction> acts, Map<String, ControlAp<?>> apById,
            Map<String, State> states, String by) {
        if (acts == null) {
            return;
        }
        for (BizRuleAction a : acts) {
            String[] ax = axis(a);
            List<String> ids = fieldIds(a);
            List<String> keys = new ArrayList<String>();
            for (String id : ids) {
                ControlAp<?> ap = apById.get(id);
                keys.add(ap == null ? "!!悬空(" + id + ")" : ap.getKey());
            }
            if (VERBOSE) {
                System.out.println("[PROBE]     动作 " + a.getClass().getSimpleName() + " -> " + keys
                        + (ax == null ? "（不影响显隐/锁定）" : ""));
            }
            if (ax == null) {
                continue;
            }
            for (String id : ids) {
                State s = states.get(id);
                if (s == null) {
                    continue;   //悬空引用：布局里没有这个控件，没什么可算的
                }
                s.touchedByRule = true;
                if ("visible".equals(ax[0])) {
                    boolean want = "true".equals(ax[1]);
                    //hide-wins：已经被规则关掉的，后面的 Show 不生效 —— 归因保留最早关掉它的那条
                    if (HIDE_WINS && s.hiddenByRule && want) {
                        continue;
                    }
                    s.selfVisible = want;
                    s.visibleBy = by;
                    if (!want) {
                        s.hiddenByRule = true;
                    }
                } else {
                    s.selfEnabled = "true".equals(ax[1]);
                    s.enabledBy = by;
                }
            }
        }
    }

    /**
     * 动作语义读**动作类的简单类名前缀**：`Show*`/`Hide*` 管可见，`Unlock*`/`Lock*` 管可编辑。
     * `SetFieldFmt` / `SetRowFmt` / `SetRowStyle` 不影响显隐锁定，返回 null。
     */
    static String[] axis(BizRuleAction a) {
        String t = a.getClass().getSimpleName();
        if (t.startsWith("Show")) {
            return new String[]{"visible", "true"};
        }
        if (t.startsWith("Hide")) {
            return new String[]{"visible", "false"};
        }
        if (t.startsWith("Unlock")) {
            return new String[]{"enabled", "true"};
        }
        if (t.startsWith("Lock")) {
            return new String[]{"enabled", "false"};
        }
        return null;
    }

    /** 动作里存的是设计期 item id，原样返回；解析回控件由调用方做 */
    static List<String> fieldIds(BizRuleAction a) {
        List<String> out = new ArrayList<String>();
        Object f = HeadlessUiSupport.call(a, "getFields");
        if (!(f instanceof List)) {
            return out;
        }
        for (Object o : (List<?>) f) {
            out.add(o instanceof FieldId ? ((FieldId) o).getId() : String.valueOf(o));
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static List<FormRule> formRules(ControlAp<?> ap) {
        Object v = HeadlessUiSupport.call(ap, "getRules");
        return v instanceof List ? (List<FormRule>) v : null;
    }

    /** 布局上的全部控件，按 id。**rootAp 不在 getItems() 里**，漏了它整棵树就断在第一层，所有字段都判成"没有父容器"。 */
    static Map<String, ControlAp<?>> controls(FormMetadata fm) {
        Map<String, ControlAp<?>> apById = new LinkedHashMap<String, ControlAp<?>>();
        if (fm.getRootAp() != null) {
            apById.put(String.valueOf(fm.getRootAp().getId()), fm.getRootAp());
        }
        for (ControlAp<?> ap : fm.getItems()) {
            apById.put(String.valueOf(ap.getId()), ap);
        }
        return apById;
    }

    /**
     * 父 id → 子控件 id。**父 id 为空的（根自己除外）挂到根下。** 库里读出的运行态布局，顶层容器的
     * parentId 指向根；写入探针手里的候选布局（扩展的设计态转来的）顶层容器 parentId 是空的——
     * 按原样建树，从根往下一个都走不到，候选试算里全部控件的终态都停在初值「默认」
     * （真机 2026-09-28：候选规则假分支隐藏 zlgd_bz，试算却报可见）。
     */
    static Map<String, List<String>> childrenOf(Map<String, ControlAp<?>> apById, String rootId) {
        Map<String, List<String>> childrenOf = new LinkedHashMap<String, List<String>>();
        for (Map.Entry<String, ControlAp<?>> e : apById.entrySet()) {
            ControlAp<?> ap = e.getValue();
            Object parent = ap.getParentId();
            String pid = String.valueOf(parent);
            if (rootId != null && !rootId.equals(e.getKey())
                    && (parent == null || pid.trim().isEmpty())) {
                pid = rootId;
            }
            List<String> cs = childrenOf.get(pid);
            if (cs == null) {
                cs = new ArrayList<String>();
                childrenOf.put(pid, cs);
            }
            cs.add(String.valueOf(ap.getId()));
        }
        return childrenOf;
    }

    /** 挂在各个控件上的界面规则，按 seq 排好：{宿主控件, 规则}。 */
    static List<Object[]> sortedRules(Map<String, ControlAp<?>> apById) {
        List<Object[]> rules = new ArrayList<Object[]>();
        for (ControlAp<?> ap : apById.values()) {
            List<FormRule> rs = formRules(ap);
            if (rs == null) {
                continue;
            }
            for (FormRule r : rs) {
                rules.add(new Object[]{ap, r});
            }
        }
        Collections.sort(rules, new Comparator<Object[]>() {
            public int compare(Object[] a, Object[] b) {
                return ((FormRule) a[1]).getSeq() - ((FormRule) b[1]).getSeq();
            }
        });
        return rules;
    }

    static String scene() {
        String scene = env("RULE_SCENE", "all");
        if (!"all".equals(scene) && !ALL_SCENES.contains(scene)) {
            throw new IllegalArgumentException("RULE_SCENE 只能是 all 或 " + ALL_SCENES + "，收到：" + scene);
        }
        return scene;
    }

    static String branch() {
        String branch = env("RULE_BRANCH", "hide-wins");
        if (!"both".equals(branch) && !"true-only".equals(branch) && !"hide-wins".equals(branch)) {
            throw new IllegalArgumentException(
                    "RULE_BRANCH 只能是 hide-wins | both | true-only，收到：" + branch);
        }
        return branch;
    }

    // ==================== 候选试算（写入探针预演时调用） ====================

    /**
     * 界面规则的候选试算（S36 批 5）：写入探针预演时，拿**内存里改好、还没落库**的布局，
     * 按落库后 `run rule` 同一套求值算一遍——同一个模型、同样的分支语义、同样的 RULE_SET 写法。
     * `run rule` 读的是库里那份；规则写进去之前它看不到候选，想看效果只能先授权落库、再跑、改了再落。
     *
     * 只打这次改动的规则的条件，和它们管的控件（加上 RULE_SHOW 点名的）的终态；
     * 别的规则照样参与求值（同一个控件可能被几条规则管着），只是不打。不断言、不留用例。
     *
     * @return 改动的规则里算不出来的地方；空 = 都算出来了
     */
    public static List<String> tryForm(String layout, FormMetadata fm, Set<String> ruleIds) throws Exception {
        rejectExpect();
        //常驻进程里静态量会留着上一次 run rule 的值，试算自己设
        ROW = Integer.parseInt(env("RULE_ROW", "0"));
        FOCUS = ruleIds;
        FOCUS_FAILED.clear();
        SKIPPED.clear();
        UNSAFE_FUNCS = unsafeFunctions();
        try {
            Map<String, ControlAp<?>> apById = controls(fm);
            List<Object[]> rules = sortedRules(apById);
            //管着的控件：改动的规则真假两边动作里的全部控件，按出现顺序。
            //按控件 id 记、不按 key：同一个 key 在一张布局里可能有几个控件（apply 也是按 id 落的），
            //按 key 取状态会取到没被规则碰过的那一个，显示成「默认」
            Map<String, String> shown = new LinkedHashMap<String, String>();
            for (Object[] p : rules) {
                FormRule r = (FormRule) p[1];
                if (!ruleIds.contains(String.valueOf(r.getId()))) {
                    continue;
                }
                for (List<?> acts : new List<?>[]{r.getTrueActions(), r.getFalseActions()}) {
                    if (acts == null) {
                        continue;
                    }
                    for (Object a : acts) {
                        for (String id : fieldIds((BizRuleAction) a)) {
                            ControlAp<?> ap = apById.get(id);
                            if (ap != null && ap.getKey() != null) {
                                shown.put(id, ap.getKey());
                            }
                        }
                    }
                }
            }
            for (String raw : env("RULE_SHOW", "").split("[;,]")) {
                String key = raw.trim();
                if (key.isEmpty()) {
                    continue;
                }
                boolean found = false;
                for (Map.Entry<String, ControlAp<?>> e : apById.entrySet()) {
                    if (key.equals(e.getValue().getKey())) {
                        shown.put(e.getKey(), key);
                        found = true;
                    }
                }
                if (!found) {
                    shown.put("?" + key, key);
                }
            }

            String set = env("RULE_SET", "");
            System.out.println("[PROBE] --- 候选试算：内存里的候选规则，按 run rule 同一套求值（未落库；字段值："
                    + (set.isEmpty() ? "新单默认值，没给 RULE_SET" : set) + "）---");
            MET = MetaResolve.type(layout);
            String entity = MET.getName();
            PlainModel model = newModel(MET);
            applySets(model, set);
            String scene = scene();
            String branch = branch();
            String alt = "both".equals(branch) ? "hide-wins" : "both";
            String rootId = fm.getRootAp() == null ? null : String.valueOf(fm.getRootAp().getId());
            Map<String, List<String>> childrenOf = childrenOf(apById, rootId);
            Map<String, RowDataModel> layers = new LinkedHashMap<String, RowDataModel>();
            VERBOSE = false;
            Map<String, State> states = evaluate(rules, apById, childrenOf, rootId, scene,
                    branch, model, entity, layers, true);
            Map<String, State> other = evaluate(rules, apById, childrenOf, rootId, scene,
                    alt, model, entity, layers, false);
            HIDE_WINS = false;

            for (Map.Entry<String, String> e : shown.entrySet()) {
                String key = e.getValue();
                State s = states.get(e.getKey());
                if (s == null) {
                    System.out.println("[PROBE]   " + pad(key, 30) + " ✗ 布局 " + layout + " 上没有这个控件");
                    continue;
                }
                State o = other.get(e.getKey());
                String split = o == null || o.effVisible == s.effVisible ? ""
                        : "  ⚠ " + alt + " 语义下是" + (o.effVisible ? "显示" : "隐藏") + "（假分支执不执行平台没有明面契约）";
                System.out.println("[PROBE]   " + pad(key, 30)
                        + " 可见=" + yn(s.effVisible) + "(" + s.effBy + ")"
                        + "  可编辑=" + yn(s.effEnabled) + "(" + s.effEnabledBy + ")"
                        + "   " + nameOf(s.ap) + split);
            }
            reportSkipped();
            System.out.println("[PROBE] 候选试算只算规则这一层：插件、改字段时的触发和界面实际效果，落库后用 run form --show 或在界面上核");
            return new ArrayList<String>(FOCUS_FAILED);
        } finally {
            FOCUS = null;
            UNSAFE_FUNCS = null;
            VERBOSE = true;
        }
    }

    /**
     * 业务规则的候选试算：同上，拿内存里加好新规则的实体元数据，按 `run rule biz` 同一套执行，
     * 打这次改动的规则的条件、动作和它写的字段此刻的值（加上 RULE_SHOW 点名的）。
     */
    public static List<String> tryBiz(String entity, EntityMetadata em, Set<String> ruleIds) throws Exception {
        rejectExpect();
        ROW = Integer.parseInt(env("RULE_ROW", "0"));
        FOCUS = ruleIds;
        FOCUS_FAILED.clear();
        SKIPPED.clear();
        UNSAFE_FUNCS = unsafeFunctions();
        try {
            //全部宿主都跑，跟 run rule biz 的默认一样：表头规则写的值，分录规则可能正要用
            List<Entity> hosts = new ArrayList<Entity>(em.getEntitys());
            String set = env("RULE_SET", "");
            System.out.println("[PROBE] --- 候选试算：内存里的候选规则，按 run rule 同一套执行（未落库；字段值："
                    + (set.isEmpty() ? "新单默认值，没给 RULE_SET" : set) + "）---");
            MET = MetaResolve.type(entity);
            PlainModel model = newModel(MET);
            applySets(model, set);
            Set<String> targets = new LinkedHashSet<String>();
            bizRules(hosts, model, entity, targets);
            for (String raw : env("RULE_SHOW", "").split("[;,]")) {
                if (!raw.trim().isEmpty()) {
                    targets.add(raw.trim());
                }
            }
            for (String path : targets) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(path);
                Object v;
                try {
                    v = pos.sub != null ? "（子分录路径，run rule 不支持）"
                            : pos.entry == null ? model.getValue(pos.field) : model.getValue(pos.field, ROW);
                } catch (Throwable t) {
                    v = "取不到：" + HeadlessUiSupport.brief(t);
                }
                System.out.println("[PROBE]   " + pad(path, 30) + " = " + show(v));
            }
            reportSkipped();
            System.out.println("[PROBE] 候选试算只算规则这一层：插件、保存时的执行时机和别的操作带来的值，落库后用 run op 或 run form --show 核");
            return new ArrayList<String>(FOCUS_FAILED);
        } finally {
            FOCUS = null;
            UNSAFE_FUNCS = null;
        }
    }

    /** 登记表里实现类不在平台 JAR 里的函数名。读不到登记表时为空：那时条件本来也算不出来，会照实报。 */
    static Set<String> unsafeFunctions() {
        Set<String> out = new LinkedHashSet<String>();
        try {
            for (Map.Entry<String, ?> e : FunctionManage.get().getFuncMap().entrySet()) {
                if (e.getValue() != null && !fromJar(e.getValue().getClass())) {
                    out.add(e.getKey());
                }
            }
        } catch (Throwable t) {
            //见上
        }
        return out;
    }

    /** 类是不是从 JAR 里装进来的；本工程编出来的类在 classes 目录里。判不出来按不是算。 */
    static boolean fromJar(Class<?> c) {
        try {
            java.security.CodeSource cs = c.getProtectionDomain().getCodeSource();
            return cs != null && cs.getLocation() != null
                    && cs.getLocation().getPath().toLowerCase().endsWith(".jar");
        } catch (Throwable t) {
            return false;
        }
    }

    /** 表达式里用到的、试算不执行的函数；不在试算里或没用到时为空。 */
    static List<String> unsafeIn(String expr) {
        List<String> out = new ArrayList<String>();
        if (UNSAFE_FUNCS == null || UNSAFE_FUNCS.isEmpty() || expr == null || expr.trim().isEmpty()) {
            return out;
        }
        try {
            for (Object f : new BOSExpression(expr).getFuncs()) {
                if (UNSAFE_FUNCS.contains(String.valueOf(f))) {
                    out.add(String.valueOf(f));
                }
            }
        } catch (Throwable t) {
            //解析不了的表达式留给求值那一步照实报错
        }
        return out;
    }

    /** 试算里没执行的那几处，一行说完；没有就不打。 */
    static final String NOT_PLATFORM = "（实现类不在平台 JAR 里，本工程的类可能比源码旧）";

    /** 运行态动作是不是公式动作（class=kd.bos.entity.rule.FormulaAction）。 */
    static boolean isFormula(Object runtime) {
        return runtime instanceof Map
                && "kd.bos.entity.rule.FormulaAction".equals(String.valueOf(((Map<?, ?>) runtime).get("class")));
    }

    static void reportSkipped() {
        if (!SKIPPED.isEmpty()) {
            System.out.println("[PROBE]   ? 试算没执行 " + SKIPPED.size() + " 处，结论不含它们：" + SKIPPED);
        }
    }

    /** 预演里的试算只看、不断言：候选还没落库，断言过了也不能当验收。 */
    static void rejectExpect() {
        if (!env("RULE_EXPECT", "").isEmpty()) {
            throw new IllegalArgumentException("预演里的候选试算不接受 RULE_EXPECT：候选还没落库，断言过了也不算验收。"
                    + "要看某个控件或字段就给 RULE_SHOW；落库后用 run rule --expect 断言");
        }
    }

    // ==================== 业务规则 ====================

    static void biz(String entity) throws Exception {
        String metaId = MetadataDao.getIdByNumber(entity, MetaCategory.Entity);
        if (metaId == null) {
            throw new IllegalArgumentException("实体不存在：" + entity + "（业务规则挂在实体上，不是布局）");
        }
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(metaId, MetaCategory.Entity);
        String only = env("RULE_HOST", "");

        List<Entity> hosts = new ArrayList<Entity>();
        for (Entity e : em.getEntitys()) {
            if (only.isEmpty() || only.equals(e.getKey())) {
                hosts.add(e);
            }
        }
        if (hosts.isEmpty()) {
            StringBuilder all = new StringBuilder();
            for (Entity e : em.getEntitys()) {
                all.append(all.length() > 0 ? " / " : "").append(e.getKey());
            }
            throw new IllegalArgumentException("找不到宿主 " + only + "，可选：" + all);
        }

        MET = MetaResolve.type(entity);
        PlainModel model = newModel(MET);
        applySets(model, env("RULE_SET", ""));

        Set<String> targets = new LinkedHashSet<String>();
        int[] counts = bizRules(hosts, model, entity, targets);
        int total = counts[0];
        int fired = counts[1];

        System.out.println("[PROBE] --- 目标字段（只列规则动作碰过的）---");
        for (String path : targets) {
            ExpectSpec.Pos pos = ExpectSpec.Pos.parse(path);
            Object v;
            try {
                //子分录：PlainModel 只有「表头 / 分录某一行」两层宿主，没有第三层。
                //按两层读会读到父分录上的同名字段——错得看不出来，所以宁可不读。
                v = pos.sub != null ? "（子分录路径，run rule 不支持）"
                        : pos.entry == null ? model.getValue(pos.field) : model.getValue(pos.field, ROW);
            } catch (Throwable t) {
                v = "取不到：" + HeadlessUiSupport.brief(t);
            }
            System.out.println("[PROBE]   " + pad(path, 30) + " = " + show(v));
            ProbeJson.emit("rule-value", "field", path, "value", show(v));
        }
        //--show：点名打任意字段此刻的值（规则没碰过的也行），不断言、不落候选
        String wanted = env("RULE_SHOW", "");
        if (!wanted.isEmpty()) {
            System.out.println("[PROBE] --- 点名查看（--show，只打值不断言）---");
            for (String raw : wanted.split("[;,]")) {
                String path = raw.trim();
                if (path.isEmpty()) {
                    continue;
                }
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(path);
                Object v;
                try {
                    v = pos.sub != null ? "（子分录路径，run rule 不支持）"
                            : pos.entry == null ? model.getValue(pos.field) : model.getValue(pos.field, ROW);
                } catch (Throwable t) {
                    v = "取不到：" + HeadlessUiSupport.brief(t);
                }
                System.out.println("[PROBE]   " + pad(path, 30) + " = " + show(v));
                ProbeJson.emit("rule-show", "field", path, "value", show(v));
            }
        }
        ProbeJson.emit("scenario", "adapter", "run rule biz", "entity", entity,
                "rules", Integer.valueOf(total), "fired", Integer.valueOf(fired),
                "targets", Integer.valueOf(targets.size()));
        ExpectSpec.model(model, env("RULE_EXPECT", ""));
    }

    /**
     * 动作求值入口：`buildEntityRule()` 产出的 `BR` 里装的是**运行态 Map 不是动作对象**，
     * Map 的 `class=` 才是执行者。反射建实例 → `setParameter(map)` → `execute(ctx)`，
     * 公式计算、携带属性、单位换算全部由平台自己的动作类完成，这里不重算任何语义。
     *
     * @return 该动作写的目标字段 key，动作不写字段时返回 null
     */
    @SuppressWarnings({"rawtypes", "unchecked"})
    static String execAction(Object runtime, PlainModel model, String host, String entity, boolean say) {
        if (!(runtime instanceof Map)) {
            LAST_ERROR = "动作不是运行态 Map，是 " + runtime.getClass().getName();
            if (say) {
                System.out.println("[PROBE]     " + LAST_ERROR);
            }
            return null;
        }
        Map m = (Map) runtime;
        String cls = String.valueOf(m.get("class"));
        String key = m.get("fieldkey") == null ? null : String.valueOf(m.get("fieldkey"));
        if (UNSAFE_FUNCS != null) {
            List<String> unsafe = unsafeIn(m.get("formula") == null ? null : String.valueOf(m.get("formula")));
            unsafe.addAll(unsafeIn(m.get("expression") == null ? null : String.valueOf(m.get("expression"))));
            try {
                if (!fromJar(Class.forName(cls))) {
                    unsafe.add(simple(cls));
                }
            } catch (Throwable t) {
                unsafe.add(simple(cls) + "（类加载不了）");
            }
            if (!unsafe.isEmpty()) {
                SKIPPED.add(simple(cls) + " 用到 " + unsafe + NOT_PLATFORM);
                return null;
            }
        }
        try {
            BRAction act = (BRAction) Class.forName(cls).newInstance();
            act.setParameter(m);
            act.execute(context(model, host, entity));
            if (say) {
                System.out.println("[PROBE]     " + simple(cls) + " -> " + key);
            }
        } catch (Throwable t) {
            LAST_ERROR = simple(cls) + " 执行失败：" + HeadlessUiSupport.brief(t);
            if (say) {
                System.out.println("[PROBE]     " + LAST_ERROR + " @ " + HeadlessUiSupport.top(t, 3));
            }
            return null;
        }
        return key;
    }

    /**
     * 按 seq 跑一遍业务规则：条件求值 → 真/假动作交给平台动作类执行。`run rule biz` 和候选试算共用。
     * FOCUS 不为空时（候选试算）只打这次改动的规则，别的规则照样执行、不打——它们可能也写同一个字段。
     *
     * @return {规则总数, 命中且有动作的条数}
     */
    static int[] bizRules(List<Entity> hosts, PlainModel model, String entity, Set<String> targets) {
        int total = 0;
        int fired = 0;
        Map<String, RowDataModel> layers = new LinkedHashMap<String, RowDataModel>();
        for (Entity host : hosts) {
            List<BizRule> rules = host.getRules();
            if (rules == null || rules.isEmpty()) {
                continue;
            }
            if (FOCUS == null) {
                System.out.println("[PROBE] 业务规则宿主 " + host.getKey() + " 规则=" + rules.size());
            }
            for (BizRule r : rules) {
                total++;
                boolean focus = FOCUS != null && FOCUS.contains(String.valueOf(r.getId()));
                boolean say = FOCUS == null || focus;
                String label = "seq=" + r.getSeq() + " " + safe(r.getDescription());
                if (!r.isEnabled()) {
                    if (say) {
                        System.out.println("[PROBE]   " + label + " 已禁用，跳过");
                    }
                    continue;
                }
                BR br;
                try {
                    br = r.buildEntityRule(host.getKey());
                } catch (Throwable t) {
                    if (say) {
                        System.out.println("[PROBE]   " + label + " 编译失败：" + HeadlessUiSupport.brief(t));
                    }
                    if (focus) {
                        FOCUS_FAILED.add(label + " 编译：" + HeadlessUiSupport.brief(t));
                    }
                    continue;
                }
                Boolean hit = condition(r.getPreCondition(),
                        layer(layers, model, entity, host.getKey()), label, say);
                if (hit == null) {
                    if (focus && LAST_ERROR != null) {
                        FOCUS_FAILED.add(label + " 的条件：" + LAST_ERROR);
                    }
                    continue;
                }
                List<?> acts = hit.booleanValue() ? br.getTrueActions() : br.getFalseActions();
                if (acts == null || acts.isEmpty()) {
                    continue;
                }
                fired++;
                for (Object one : acts) {
                    LAST_ERROR = null;
                    String key = execAction(one, model, host.getKey(), entity, say);
                    if (key == null && focus && LAST_ERROR != null) {
                        //只有公式动作的失败算公式写错、拦写入。别的动作（携带、赋值……）执行不了多半是
                        //仿真这层的限制：平台动作类拿到的参数和真运行时不完全一样（真机 2026-09-28：
                        //既有的携带/赋值规则在 run rule biz 里都报 TakeValueId 转不成 Map），拦了就是误拦
                        if (isFormula(one)) {
                            FOCUS_FAILED.add(label + " 的动作：" + LAST_ERROR);
                        } else {
                            SKIPPED.add(label + " 的动作（" + LAST_ERROR + "；试算这层执行不了这类动作）");
                        }
                    }
                    if (key != null && (FOCUS == null || focus)) {
                        targets.add(host.getKey().equals(entity) ? key : host.getKey() + "." + key);
                    }
                }
            }
        }
        return new int[]{total, fired};
    }

    /**
     * **坑：`new BRExecuteContext(model)` 的 `_dataEntities` 是 null，动作会「执行成功」但一个值都不写。**
     * 没有异常、没有返回值，只有目标字段还是空 —— 看着像规则条件没命中。
     * 那个字段是包内可见的，只能反射塞；塞进去的必须是 `RowDataEntity` 不是 `DynamicObject`。
     */
    static BRExecuteContext context(PlainModel model, String host, String entity) throws Exception {
        BRExecuteContext ctx = new BRExecuteContext(model);
        List<RowDataEntity> rows = new ArrayList<RowDataEntity>();
        DynamicObject head = model.getDataEntity();
        if (host == null || host.equals(entity) || !MET.getProperties().containsKey(host)) {
            rows.add(new RowDataEntity(0, head));
        } else {
            DynamicObjectCollection coll = head.getDynamicObjectCollection(host);
            if (coll.isEmpty()) {
                coll.addNew();
            }
            int i = Math.min(ROW, coll.size() - 1);
            rows.add(new RowDataEntity(i, coll.get(i)));
        }
        Field f = RuleExecuteContext.class.getDeclaredField("_dataEntities");
        f.setAccessible(true);
        f.set(ctx, rows);
        return ctx;
    }

    // ==================== 共用 ====================

    static PlainModel newModel(MainEntityType met) {
        PlainModel model = new PlainModel(met);
        model.createNewData();
        return model;
    }

    /** `--set`：表头写字段标识，分录写 `分录标识.字段`；基础资料给 id 或 number 都认 */
    static void applySets(PlainModel model, String spec) {
        for (String[] kv : ExpectSpec.pairs(spec)) {
            ExpectSpec.Pos pos = ExpectSpec.Pos.parse(kv[0]);
            if (pos.sub != null) {
                //宁可拒绝也不要静默写错宿主：按两层处理会把叶子字段写到父分录行上，
                //父分录恰好有同名字段时就是一次「成功」的错误赋值
                System.out.println("[PROBE] set " + pos + " ⚠ 跳过：run rule 不支持子分录路径"
                        + "（规则求值的宿主只有表头和分录两层）");
                continue;
            }
            try {
                Object v = coerce(pos, kv[1]);
                if (pos.entry == null) {
                    model.setValue(pos.field, v);
                } else {
                    DynamicObjectCollection coll = model.getEntryEntity(pos.entry);
                    while (coll.size() <= pos.row) {
                        model.createNewEntryRow(pos.entry);
                    }
                    model.setValue(pos.field, v, pos.row);
                }
                System.out.println("[PROBE] set " + pos + " = " + kv[1]);
            } catch (Throwable t) {
                System.out.println("[PROBE] set " + pos + " = " + kv[1]
                        + "  ⚠ 失败：" + HeadlessUiSupport.brief(t));
            }
        }
    }

    /**
     * 值转换走共用契约 {@link ExpectSpec#convert}。
     *
     * 此前这里只在 **MET 顶层属性**里找基础资料 —— 分录上的基础资料字段一律落空，
     * 被当成普通字段把编码字符串原样写了进去，而规则条件按 id 比，于是条件恒不成立：
     * 表现是「这条规则没触发」，看着像规则配错，其实是赋值错。
     */
    static Object coerce(ExpectSpec.Pos pos, String val) {
        return ExpectSpec.convert(MET, pos, val);
    }

    /**
     * 规则挂在哪一层，条件就在哪一层求值：表头规则用单据本身，分录规则用分录的某一行。
     * 分录一行都没有时补一行空行，否则 activeRow 为 null，表达式一律算不出来。
     */
    static RowDataModel layer(Map<String, RowDataModel> cache, PlainModel model,
            String entity, String hostKey) {
        String key = MET.getProperties().containsKey(hostKey) ? hostKey : entity;
        RowDataModel m = cache.get(key);
        if (m != null) {
            return m;
        }
        m = new RowDataModel(key, MET);
        DynamicObject head = model.getDataEntity();
        if (key.equals(entity)) {
            m.setRowContext(head);
        } else {
            DynamicObjectCollection coll = head.getDynamicObjectCollection(key);
            if (coll.isEmpty()) {
                coll.addNew();
            }
            m.setRowContext(coll.get(Math.min(ROW, coll.size() - 1)));
        }
        cache.put(key, m);
        return m;
    }

    /**
     * 空条件视为真；求值失败返回 null（既不算真也不算假，整条规则跳过并打出原因），原因留在 LAST_ERROR。
     * say=false 时只求值不打：对照求值那一遍、候选试算里没改动的规则都不重复打。
     */
    static Boolean condition(String expr, RowDataModel rdm, String label, boolean say) {
        LAST_ERROR = null;
        List<String> unsafe = unsafeIn(expr);
        if (!unsafe.isEmpty()) {
            SKIPPED.add(label + " 的条件用到 " + unsafe + NOT_PLATFORM);
            return null;
        }
        if (expr == null || expr.trim().isEmpty()) {
            if (say) {
                System.out.println("[PROBE]   " + label + " 条件为空 -> 真");
            }
            return Boolean.TRUE;
        }
        Object v;
        try {
            v = CalcExprParser.getExpressionValue(expr, new BOSExpressionContext(rdm), FunctionManage.get());
        } catch (Throwable t) {
            LAST_ERROR = HeadlessUiSupport.brief(t);
            if (say) {
                System.out.println("[PROBE]   " + label + " 条件求值失败：" + LAST_ERROR);
            }
            return null;
        }
        Boolean hit = truthy(v);
        if (say) {
            System.out.println("[PROBE]   " + label + " 条件 -> " + yn(hit.booleanValue())
                    + "  [" + safe(expr) + " = " + v + "]");
        }
        return hit;
    }

    static Boolean truthy(Object v) {
        if (v == null) {
            return Boolean.FALSE;
        }
        if (v instanceof Boolean) {
            return (Boolean) v;
        }
        if (v instanceof Number) {
            return Boolean.valueOf(((Number) v).doubleValue() != 0d);
        }
        return Boolean.valueOf("true".equalsIgnoreCase(String.valueOf(v).trim()));
    }

    static String show(Object v) {
        if (v == null) {
            return "(null)";
        }
        if (v instanceof DynamicObject) {
            DynamicObject o = (DynamicObject) v;
            kd.bos.dataentity.metadata.clr.DataEntityPropertyCollection props =
                    o.getDataEntityType().getProperties();
            String number = props.containsKey("number") ? o.getString("number") : String.valueOf(o.getPkValue());
            String name = props.containsKey("name") ? o.getString("name") : "";
            return name.isEmpty() ? number : number + "(" + name + ")";
        }
        return String.valueOf(v);
    }

    static String simple(String cls) {
        int dot = cls.lastIndexOf('.');
        return dot < 0 ? cls : cls.substring(dot + 1);
    }

    static String safe(Object v) {
        return v == null ? "" : String.valueOf(v).replace('\n', ' ').replace('\r', ' ');
    }

    static String yn(boolean b) {
        return b ? "是" : "否";
    }

    static String pad(String s, int n) {
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() < n) {
            sb.append(' ');
        }
        return sb.toString();
    }

    static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? d : v;
    }
}
