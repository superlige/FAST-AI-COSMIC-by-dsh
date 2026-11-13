import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.utils.Uuid8;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.AbstractDesignMeta;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataWriter;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.entity.rule.BizRuleAction;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.form.rule.FieldId;
import kd.bos.metadata.form.rule.FormRule;
import kd.bos.metadata.form.rule.HideFieldAction;
import kd.bos.metadata.form.rule.ShowFieldAction;
import kd.bos.metadata.form.rule.LockFieldAction;
import kd.bos.metadata.form.rule.UnlockFieldAction;
import kd.bos.metadata.form.rule.ShowControlAction;
import kd.bos.metadata.form.rule.HideControlAction;

/**
 * 界面规则（显示/隐藏、锁定/解锁字段）的读 + 新增 + 修改条件 + 往既有规则里追加字段 + 回滚。
 *
 * 入参一行一个（cosmic_probe 的 env 里值原样给，不用再套一层引号）。
 * 这一段每行开头的 NAME= 会原样进模型看到的用法卡片，所以每个入参都要有自己的一行、例子写全：
 * 真机 S20 批 5 模型读了卡片还是去缓存里翻了这份源码，因为卡片里只有例子、没有「分号分组、竖线分三列」
 * 那句语法，也没有 RULE_FORM / RULE_TAG 这两个最基本的入参。
 *
 *   RULE_FORM=demo_nbjgjl_ls   布局或单据标识，必填。只给它就是读模式：列出布局上全部 Ap 的界面规则，FieldId 解析回真实控件，解析不到的标 !!悬空；落库后拿它独立复核
 *   RULE_TAG=试样形状显示控制-   新增和回滚用的描述前缀：新增的每条规则描述 = 前缀 + 组名
 *   RULE_GROUPS=组名|条件表达式|字段1,字段2;组名|条件表达式|字段3   新增规则的语法：分号分组、竖线分三列，每组生成一条规则，条件为真执行正动作、为假执行反动作；条件里不能出现 ; 和 |（它们是分隔符）
 *   RULE_GROUPS=宽度类|demo_syxz1 = "2" or demo_syxz1 = "3"|demo_wzkd1,demo_wzkd2   例：下拉字段比存储值，一组管多个字段
 *   RULE_GROUPS=n值4-6%|MulBasedataInclude(demo_jcxm_dx.number, 'JCXM-01')|demo_nz1;r值8-12%|MulBasedataInclude(demo_jcxm_dx.number, 'JCXM-02')|demo_rz1   例：多选基础资料按编码判断，两组各管一个字段（按多选基础资料编码判断）
 *   RULE_HOST=<Ap key>   规则挂到哪个 Ap 上，不给挂 rootAp；分录字段的规则通常挂在分录自己的 key 上，照读模式里既有规则的宿主给（见下）
 *   RULE_ACT=show|lock|control   show(默认)=真显示假隐藏字段；lock=真解锁假锁定；control=真显示假隐藏容器控件（面板/字段组），容器必须用它，ShowFieldAction 对容器不生效
 *   RULE_REMOVE_IDS=id1,id2   要摘掉的既有规则 id，逗号隔开，新增和回滚都用：描述前缀撞上既有规则时探针列出撞上的几条并中止，点名之后才动（前缀证明不了规则是谁建的）
 *   RULE_ALLOW_OVERLAP=1   新增时允许一个字段被第二条规则管（默认拒绝，见下第 2 条）
 *   RULE_UPDATE_ID=<规则 id>   修改既有规则的条件，和下面两个一起给：按 id 精确定位、用原条件做 compare-and-set，只改 PreCondition/PreDescription，动作、seq、描述不动
 *   RULE_BATCH=update|规则id|原条件|新条件;delete|规则id|原条件   同一布局多条修改或删除合成一份清单，只保存和重建一次；逐条核对原条件，任一条不符整批拒绝。条件不能含分号和竖线；同一 id 只能出现一次；可用 RULE_HOST 限定宿主。删除精确按 id，不用 RULE_TAG 或 ROLLBACK
 *   RULE_EXPECT_CONDITION=<读模式看到的原条件>   RULE_UPDATE_CONDITION=<新条件>
 *   RULE_APPEND=规则id|锚点字段|新字段1,新字段2;规则id|锚点字段|新字段3   往既有规则里追加字段、让新字段跟着锚点显隐/锁定：分号分组、竖线分三列；锚点是这条规则已经管着的字段，这条规则里凡是含锚点的动作（真动作、假动作都算），新字段都插在锚点后面；条件、动作类型、规则条数一概不动
 *   RULE_APPEND=5Z3E6C2NPCNS|zlgd_klqd_ls|zlgd_klqd_ls_ysjl;GEN-RULE-0013|zlgd_qfqd_ls|zlgd_qfqd_ls_ysjl   例：两条既有规则各追加一个字段；新字段要先用 FormLayoutWriteProbe 的 add field 落库、在布局上已存在；锚点还被没点名的规则管着时整批拒绝，要把那几条也写进来
 *   RULE_SET=zlgd_wtlx=炉前成分;分录.字段=值   预演时的字段值，写法同 run rule --set；预演会把内存里的候选规则按 run rule 同一套算一遍，打改动规则的条件和它管的控件终态，不给就按新单默认值算
 *   RULE_SHOW=控件1,控件2   预演试算时另外要看的控件
 *   ROLLBACK=1   回滚：摘掉描述以 RULE_TAG 开头、且被 RULE_REMOVE_IDS 逐条点名的规则
 *   APPLY=1   真写。不给就是 dry-run
 *
 * 新增、单条修改条件、追加字段、回滚、批量清单五种写模式互斥；同一布局多条改条件或删除使用 RULE_BATCH。
 *
 * ⚠️ 规则不是只挂 rootAp。FormAp（表头）和各 EntryAp（分录）都各有一份 getRules()，
 *    分录字段的显隐规则通常挂在**它所属的 EntryAp** 上。所以：
 *      · 读要遍历全部 Ap，只看 rootAp 会漏掉分录那批；
 *      · 写要用 RULE_HOST 挂到和既有规则同一个 Ap 上，挂错宿主界面上不生效。
 *    先跑一次读模式，看清楚既有规则挂在哪个宿主，再照着给 RULE_HOST。
 *
 * ⚠️ 另外三条硬约束，配 RULE_GROUPS 之前先看：
 *   1. 条件里的下拉字段比的是**存储值**（"1"/"2"），不是显示名（"圆形"）。
 *   2. 规则按 seq 顺序执行，后面的反动作会盖掉前面的正动作。所以**按「显示条件集合」
 *      分组，别按「值」分组** —— 保证一个字段只出现在一条规则里，顺序就无关了。
 *      注意跨宿主也算：字段已经被某条形状规则管着，就不能再进第二条规则。
 *      新增时探针会默认拒绝这种重叠；确认确需多规则协作才显式给 RULE_ALLOW_OVERLAP=1。
 *   3. 写继承布局时只 save(fm)，产出的是 diff，父单据的规则不受影响。
 *
 * 默认 dry-run：完整走 convertToDesignMeta 校验 + 自检，只是不落库。APPLY=1 才写。
 */
public class FormRuleProbe {

    public static void run() throws Exception {
        String form = env("RULE_FORM", null);
        if (form == null) {
            System.out.println("[PROBE] !! 必须给 RULE_FORM=<布局或单据标识>");
            return;
        }
        String tag = env("RULE_TAG", null);
        String groupsSpec = env("RULE_GROUPS", null);
        String act = env("RULE_ACT", "show");
        String hostKey = env("RULE_HOST", null);
        String updateId = env("RULE_UPDATE_ID", null);
        String expectedCondition = env("RULE_EXPECT_CONDITION", null);
        String updateCondition = env("RULE_UPDATE_CONDITION", null);
        boolean allowOverlap = "1".equals(System.getenv("RULE_ALLOW_OVERLAP"));
        boolean apply = "1".equals(System.getenv("APPLY"));
        boolean rollback = "1".equals(System.getenv("ROLLBACK"));
        String appendSpec = env("RULE_APPEND", null);
        String batchSpec = env("RULE_BATCH", null);
        boolean update = updateId != null || expectedCondition != null || updateCondition != null;
        boolean add = groupsSpec != null;
        boolean append = appendSpec != null;
        boolean write = rollback || add || update || append || batchSpec != null;

        int modes = (rollback ? 1 : 0) + (add ? 1 : 0) + (update ? 1 : 0) + (append ? 1 : 0) + (batchSpec != null ? 1 : 0);
        if (modes > 1) {
            fail("ROLLBACK、RULE_GROUPS、RULE_UPDATE_*、RULE_APPEND、RULE_BATCH 是互斥写模式，一次只能给一种");
        }

        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (formId == null) {
            System.out.println("[PROBE] !! 找不到布局/单据 " + form);
            return;
        }
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        FormAp root = fm.getRootAp();

        //标识 -> Ap id / Ap 名称；Ap id -> Ap（界面规则引用的是表单侧控件 id，不是字段 id）
        Map<String, String> apIdByKey = new LinkedHashMap<>();
        Map<String, ControlAp<?>> apById = new HashMap<>();
        for (ControlAp<?> ap : fm.getItems()) {
            if (ap.getKey() != null) apIdByKey.put(ap.getKey(), ap.getId());
            apById.put(String.valueOf(ap.getId()), ap);
        }
        System.out.println("[PROBE] " + form + " formId=" + formId
                + " modelType=" + fm.getModelType()
                + " Ap数=" + fm.getItems().size());

        if (!write) {
            //规则挂在 ControlAp 上，FormAp / 各 EntryAp 都各有一份 —— 只看 rootAp 会漏掉分录那批
            int total = 0;
            int broken = 0;
            boolean hostFound = hostKey == null;
            boolean unreadable = false;
            String entityKey = entityKeyOf(fm);
            MainEntityType met = FormulaCheck.entityType(entityKey);
            if (met == null) System.out.println("[PROBE] ? 拿不到 " + entityKey + " 的运行态元数据：下面的条件只核了语法和函数，字段没核");
            for (ControlAp<?> ap : hostAps(fm)) {
                if (hostKey != null && !hostKey.equals(ap.getKey())) continue;
                hostFound = true;
                List<FormRule> rs = rulesOf(ap);
                if (rs == null) {
                    if (supportsRules(ap)) unreadable = true;
                    else if (hostKey != null) throw new IllegalArgumentException("指定控件不支持界面规则：RULE_HOST=" + hostKey);
                    continue;
                }
                if (rs.isEmpty()) continue;
                System.out.println("[PROBE] === 宿主 Ap " + ap.getClass().getSimpleName()
                        + "  key=" + ap.getKey() + "  name=" + ap.getName()
                        + "  id=" + ap.getId() + "  规则 " + rs.size() + " 条"
                        + "   （写这个宿主用 RULE_HOST=" + ap.getKey() + "）");
                for (FormRule r : rs) {
                    dumpRule(r, apById);
                    if (!checkExisting(r, met, entityKey)) broken++;
                }
                total += rs.size();
            }
            if (!hostFound) throw new IllegalArgumentException("找不到指定规则宿主，请核对 RULE_HOST=" + hostKey);
            System.out.println("[PROBE] " + (hostKey == null ? "全布局" : "指定宿主") + "界面规则合计 " + total + " 条");
            if (unreadable) System.out.println("[PROBE] !! 部分规则宿主无法读取，合计只含已读取部分，不能断言其余宿主没有规则");
            if (broken > 0) System.out.println("[PROBE] !! 其中 " + broken + " 条生效条件没过平台核对（上面 ✗ 行）：引用了当前环境里找不到的函数或字段");
            System.out.println("[PROBE] 只读模式结束。新增给 RULE_TAG + RULE_GROUPS；改条件给"
                    + " RULE_UPDATE_ID + RULE_EXPECT_CONDITION + RULE_UPDATE_CONDITION；多条修改或删除给 RULE_BATCH；"
                    + "往既有规则里追加字段给 RULE_APPEND=规则id|锚点字段|新字段");
            return;
        }

        if (batchSpec != null) {
            batchRules(fm, form, formId, batchSpec, hostKey, apById, apply);
            return;
        }
        if (update && (updateId == null || expectedCondition == null || updateCondition == null)) {
            fail("修改条件必须同时给 RULE_UPDATE_ID、RULE_EXPECT_CONDITION、RULE_UPDATE_CONDITION");
        }
        if (append) {
            appendFields(fm, form, formId, appendSpec, hostKey, apIdByKey, apById, apply);
            return;
        }
        if (!update && tag == null) {
            System.out.println("[PROBE] !! 写模式必须给 RULE_TAG（规则描述前缀，用于幂等和回滚）");
            return;
        }

        //新增/回滚沿用 rootAp；修改按 id 遍历全部宿主，避免要求调用方先猜 RULE_HOST。
        ControlAp<?> hostAp = update ? null : root;
        FormRule updateRule = null;
        if (update) {
            int matches = 0;
            for (ControlAp<?> ap : hostAps(fm)) {
                if (hostKey != null && !hostKey.equals(ap.getKey())) continue;
                List<FormRule> rs = rulesOf(ap);
                if (rs == null) continue;
                for (FormRule r : rs) {
                    if (!updateId.equals(r.getId())) continue;
                    matches++;
                    hostAp = ap;
                    updateRule = r;
                }
            }
            if (matches != 1) {
                fail("规则 id=" + updateId + " 命中 " + matches + " 条（必须恰好 1 条）"
                        + (hostKey == null ? "" : "，限定宿主 " + hostKey));
            }
        } else if (hostKey != null) {
            hostAp = null;
            for (ControlAp<?> ap : hostAps(fm)) {
                if (hostKey.equals(ap.getKey())) { hostAp = ap; break; }
            }
            if (hostAp == null) {
                System.out.println("[PROBE] !! 布局上找不到 key=" + hostKey + " 的 Ap，中止。"
                        + "先跑读模式看既有规则挂在哪个宿主");
                return;
            }
            if (rulesOf(hostAp) == null) {
                System.out.println("[PROBE] !! " + hostKey + " 是 "
                        + hostAp.getClass().getSimpleName() + "，没有 getRules()，挂不了规则，中止");
                return;
            }
        }
        List<FormRule> rules = rulesOf(hostAp);
        System.out.println("[PROBE] 宿主 Ap " + hostAp.getClass().getSimpleName()
                + "  key=" + hostAp.getKey() + "  id=" + hostAp.getId()
                + "  现有规则 " + rules.size() + " 条");

        //红线：只准动本 ISV 自己的元数据
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
        //写入目标不在这里打：这一行只知道布局，而 APPLY 时 IsvGuard 还要逐个字段比对。
        //照着一个不全的清单去授权，APPLY 当场被拦、整份授权作废（2026-09-14 真机实测）。
        //完整清单由 IsvGuard 一路记下来，dry-run 结束前一次打全（IsvGuard.reportTargets）。
        System.out.println("[PROBE] 所属单据 " + em.getKey() + "，布局 " + form
                + "（完整的授权目标清单在 dry-run 最后一行）");
        IsvGuard.assertOwnEntity(em.getKey(), em);
        IsvGuard.assertOwnLayout(em.getKey(), form);
        MainEntityType met = FormulaCheck.entityType(em.getKey());
        List<String> badExprs = new ArrayList<>();

        List<FormRule> changedRules = new ArrayList<>();
        if (update) {
            String actual = updateRule.getPreCondition();
            if (!expectedCondition.equals(actual)) {
                fail("规则 " + updateId + " 原条件已变化，拒绝覆盖"
                        + "\n[PROBE]   期望=" + expectedCondition
                        + "\n[PROBE]   实际=" + actual);
            }
            checkNew("RULE_UPDATE_CONDITION", updateCondition, met, em.getKey(), badExprs);
            updateRule.setPreCondition(updateCondition);
            updateRule.setPreDescription(updateCondition);
            changedRules.add(updateRule);
            System.out.println("[PROBE] ~= 规则 " + updateRule.getId() + " 仅修改条件"
                    + "\n[PROBE]      原条件 " + actual
                    + "\n[PROBE]      新条件 " + updateCondition);
        } else {
            //同 TAG 的既有规则：一条都不许**默认**摘掉，要摘就逐条点名（见 removable）
            List<FormRule> hits = new ArrayList<>();
            for (FormRule r : rules) {
                if (describeOf(r).startsWith(tag)) hits.add(r);
            }
            List<String> removeIds = removable(tag, hits, rollback);
            int removed = 0;
            for (Iterator<FormRule> it = rules.iterator(); it.hasNext(); ) {
                FormRule r = it.next();
                if (!removeIds.contains(String.valueOf(r.getId()))) continue;
                System.out.println("[PROBE] 摘掉旧规则 " + r.getId() + " | " + describeOf(r));
                it.remove();
                removed++;
            }
            System.out.println("[PROBE] 摘掉 " + removed + " 条点名的旧规则，剩 " + rules.size() + " 条");
        }

        List<String> allKeys = new ArrayList<>();
        if (add) {
            int seq = 0;
            for (FormRule r : rules) seq = Math.max(seq, r.getSeq());

            for (String g : groupsSpec.split(";")) {
                if (g.trim().isEmpty()) continue;
                String[] col = g.split("\\|");
                if (col.length != 3) {
                    System.out.println("[PROBE] !! 分组格式错（要 组名|条件|字段）：" + g);
                    return;
                }
                String gname = col[0].trim(), cond = col[1].trim();
                String[] keys = col[2].trim().split(",");
                checkNew("RULE_GROUPS 组 " + gname, cond, met, em.getKey(), badExprs);

                List<FieldId> fids = new ArrayList<>();
                StringBuilder fdesc = new StringBuilder();
                for (String k0 : keys) {
                    String k = k0.trim();
                    IsvGuard.assertOwnField(k);
                    String apId = apIdByKey.get(k);
                    if (apId == null) {
                        System.out.println("[PROBE] !! 布局上找不到字段 " + k + "，中止（别写半截规则）");
                        return;
                    }
                    fids.add(new FieldId(apId));
                    allKeys.add(k);
                    if (fdesc.length() > 0) fdesc.append('、');
                    fdesc.append(apById.get(apId).getName()).append('(').append(k).append(')');

                    List<String> refs = ruleRefs(fm, apId);
                    if (!refs.isEmpty() && !allowOverlap) {
                        fail("目标控件 " + k + " 已被既有规则管理：" + join(refs)
                                + "。优先用 RULE_UPDATE_ID 合并条件；确需多规则协作才给 RULE_ALLOW_OVERLAP=1");
                    }
                    if (!refs.isEmpty()) {
                        System.out.println("[PROBE] !! RULE_ALLOW_OVERLAP=1：" + k
                                + " 仍由这些规则管理：" + join(refs));
                    }
                }

                FormRule r = new FormRule();
                r.setId(Uuid8.generateShortUuid());
                r.setRuleType("FormRule");
                r.setEnabled(true);
                r.setSeq(++seq);
                r.setIsv(IsvGuard.ISV);
                r.setDescription(new LocaleString(tag + gname));
                r.setPreDescription(cond);
                r.setPreCondition(cond);
                r.setTriggerField("");

                //BizRule 只有 setTrueActions，没有 setFalseActions —— 反动作要往
                //getFalseActions() 返回的 list 里塞
                List<BizRuleAction> ta = new ArrayList<>();
                ta.add(action(act, true, fids));
                r.setTrueActions(ta);
                r.getFalseActions().add(action(act, false, new ArrayList<>(fids)));

                rules.add(r);
                changedRules.add(r);
                System.out.println("[PROBE] += seq=" + r.getSeq() + " " + r.getDescription()
                        + "\n[PROBE]      条件 " + cond
                        + "\n[PROBE]      字段 " + fids.size() + " 个：" + fdesc);
            }
        }
        System.out.println("[PROBE] 规则总数 " + rules.size() + " 条");
        FormulaCheck.stopOnBad(badExprs);
        for (FormRule r : changedRules) {
            System.out.println("[PROBE] 本次实际规则结构：");
            dumpRule(r, apById);
        }

        //不落库的完整校验：序列化 + 跑元数据插件校验
        MetadataWriter w = new MetadataWriter(fm.getModelType());
        List<AbstractDesignMeta> dms = w.convertToDesignMeta(fm);
        System.out.println("[PROBE] convertToDesignMeta(fm) 产出 " + dms.size() + " 份设计态");
        for (AbstractDesignMeta d : dms) {
            String x = d.getDataXml();
            if (x == null) continue;
            String cls = d.getClass().getSimpleName();
            int n = 0, i = -1;
            while ((i = x.indexOf("<FormRule>", i + 1)) >= 0) n++;
            System.out.println("[PROBE]   " + cls + " 长度=" + x.length() + " FormRule " + n + " 条");
            if (n == 0) continue;
            String out = env("OUT", null);
            if (out != null) {
                java.io.Writer wr = new java.io.OutputStreamWriter(
                        new java.io.FileOutputStream(out + "/" + form + "-" + cls + ".xml"), "UTF-8");
                wr.write(x);
                wr.close();
                System.out.println("[PROBE]   写出 " + out + "/" + form + "-" + cls + ".xml");
            }
            //自检：每个字段的 Ap id 都得真出现在 XML 里，缺一个就是半截规则
            for (String k : allKeys) {
                String apId = apIdByKey.get(k);
                if (!x.contains("<Id>" + apId + "</Id>")) {
                    System.out.println("[PROBE] !! XML 里缺 " + k + " 的 Ap id " + apId + "，中止");
                    return;
                }
            }
            if (!allKeys.isEmpty()) {
                System.out.println("[PROBE]   自检通过：全部 " + allKeys.size() + " 个字段 id 都在 XML 里");
            }
        }

        if (!apply) {
            tryCandidate(form, fm, changedRules);
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，未写入。确认无误后加 APPLY=1");
            return;
        }
        //继承布局：只 save(fm)。save(em, fm) 会连父实体一起重写。
        Map<String, Object> r = w.save(fm);
        System.out.println("[PROBE] save -> " + r);
        MetadataDao.rebuildRuntimeMetaById(formId);
        System.out.println("[PROBE] rebuildRuntimeMetaById(" + formId + ") 完成");
    }

    /**
     * 候选试算（S36 批 5）：预演时把内存里改好、还没落库的布局交给 RuleSim，按落库后 run rule 同一套求值算一遍，
     * 打这次改动的规则的条件和它们管的控件的终态。字段值用 RULE_SET（写法同 run rule --set），不给就是新单默认值。
     * 改动的规则算不出来（例如函数参数个数不对，平台求值时才报）就停在写入之前：落库了运行时也是整条跳过。
     */
    private static void batchRules(FormMetadata fm, String form, String formId, String spec,
            String hostKey, Map<String, ControlAp<?>> apById, boolean apply) throws Exception {
        if (env("RULE_REMOVE_IDS", null) != null || env("RULE_TAG", null) != null) {
            fail("RULE_BATCH 不接受 RULE_TAG 或 RULE_REMOVE_IDS，删除请写 delete|规则id|原条件");
        }
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
        IsvGuard.assertOwnEntity(em.getKey(), em);
        IsvGuard.assertOwnLayout(em.getKey(), form);
        MainEntityType met = FormulaCheck.entityType(em.getKey());
        List<String> bad = new ArrayList<>();
        Map<String, String[]> items = new LinkedHashMap<>();
        Map<String, FormRule> found = new LinkedHashMap<>();
        Map<String, List<FormRule>> owners = new HashMap<>();
        // 先把整份清单核完，再改内存中的元数据，避免后半份失败留下半份候选。
        for (String row : spec.split(";", -1)) {
            String[] col = row.split("\\|", -1);
            if (col.length < 3 || !("update".equals(col[0]) && col.length == 4
                    || "delete".equals(col[0]) && col.length == 3)) {
                fail("RULE_BATCH 每项应为 update|规则id|原条件|新条件 或 delete|规则id|原条件");
            }
            String id = col[1].trim();
            if (id.isEmpty() || items.containsKey(id)) fail("RULE_BATCH 规则 id 为空或重复：" + id);
            items.put(id, col);
            int matches = 0;
            for (ControlAp<?> ap : hostAps(fm)) {
                if (hostKey != null && !hostKey.equals(ap.getKey())) continue;
                List<FormRule> rules = rulesOf(ap);
                if (rules == null) continue;
                for (FormRule rule : rules) {
                    if (!id.equals(rule.getId())) continue;
                    matches++;
                    found.put(id, rule);
                    owners.put(id, rules);
                }
            }
            if (matches != 1) fail("规则 id=" + id + " 命中 " + matches + " 条（必须恰好 1 条）");
            if (!col[2].equals(found.get(id).getPreCondition())) fail("规则 " + id + " 原条件已变化，整批拒绝覆盖");
            if ("update".equals(col[0])) {
                if (col[3].trim().isEmpty()) fail("规则 " + id + " 新条件不能为空");
                checkNew("RULE_BATCH " + id, col[3], met, em.getKey(), bad);
            }
        }
        FormulaCheck.stopOnBad(bad);
        List<FormRule> changedRules = new ArrayList<>();
        for (Map.Entry<String, String[]> item : items.entrySet()) {
            FormRule rule = found.get(item.getKey());
            String[] col = item.getValue();
            System.out.println("[PROBE] " + col[0] + " 规则 " + item.getKey() + " 原条件=" + col[2]);
            dumpRule(rule, apById);
            if ("delete".equals(col[0])) owners.get(item.getKey()).remove(rule);
            else {
                rule.setPreCondition(col[3]);
                rule.setPreDescription(col[3]);
                changedRules.add(rule);
                System.out.println("[PROBE] 新条件=" + col[3]);
            }
        }
        MetadataWriter writer = new MetadataWriter(fm.getModelType());
        writer.convertToDesignMeta(fm);
        if (!apply) {
            tryCandidate(form, fm, changedRules);
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，未写入。确认整份清单后加 APPLY=1");
            return;
        }
        System.out.println("[PROBE] save -> " + writer.save(fm));
        MetadataDao.rebuildRuntimeMetaById(formId);
        System.out.println("[PROBE] rebuildRuntimeMetaById(" + formId + ") 完成");
    }

    private static void tryCandidate(String form, FormMetadata fm, List<FormRule> changed) throws Exception {
        if (changed.isEmpty()) return;
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (FormRule r : changed) ids.add(String.valueOf(r.getId()));
        List<String> failed = RuleSim.tryForm(form, fm, ids);
        for (String f : failed) System.out.println("[PROBE]   ✗ 候选试算：" + f);
        FormulaCheck.stopOnBad(failed);
    }

    /** RULE_APPEND 的一组：往哪条规则、跟着哪个锚点、加哪几个字段。 */
    private static final class AppendItem {
        String where;
        String ruleId;
        String anchor;
        List<String> keys = new ArrayList<>();
        FormRule rule;
        ControlAp<?> host;
        /** 锚点确实被这条规则管着；不是的话后面两道拦截不查它，免得报一串跟错锚点带出来的连带问题。 */
        boolean anchorOk;
    }

    /**
     * 往既有规则里追加字段（RULE_APPEND）。
     *
     * 为什么要有这一模式（2026-09-15 真机复盘）：需求是「新加的原始记录值跟着结果值显隐，在已有的
     * 界面规则里追加字段」，而本探针原来只会三件事——整条新增、只改条件、回滚。新增一条会让同一个
     * 条件出现两份、以后改一处漏一处；改条件的分支连动作都不碰。复盘照着「RULE_UPDATE_ID 追加」
     * 写了恢复步骤，走到那一步才会发现根本没有这条路。
     *
     * 为什么按「锚点」而不是按「动作下标」给：规则的真动作、假动作各是一个字段列表，设计器建的规则
     * 两边列的是同一批字段。调用方要表达的正是「跟着 X」，给出 X 之后含 X 的动作由探针自己找，
     * 真假两边一次都补上——只补一边的话，条件为假时新字段不隐藏，界面上看起来是好的，要等条件
     * 翻转才露馅。
     *
     * 四道拦截，任何一条不过整批中止、一次列全：
     *   1. 规则 id 必须恰好命中 1 条；
     *   2. 锚点必须真被这条规则管着（没管就列出它管的是哪些，免得跟错字段）；
     *   3. 新字段必须已在布局上，且没被别的规则管着（两条规则管同一个字段，结果取决于执行顺序）；
     *   4. 锚点如果还被没点名的规则管着，新字段就只跟了一半——列出那几条、给出能照抄的写法。
     * 已经跟上的字段跳过不报错，好让同一份入参 APPLY 之后再 dry-run 一次能看出「无事可做」。
     */
    @SuppressWarnings("unchecked")
    private static void appendFields(FormMetadata fm, String form, String formId, String spec, String hostKey,
            Map<String, String> apIdByKey, Map<String, ControlAp<?>> apById, boolean apply) throws Exception {
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
        System.out.println("[PROBE] 所属单据 " + em.getKey() + "，布局 " + form
                + "（完整的授权目标清单在 dry-run 最后一行）");
        IsvGuard.assertOwnEntity(em.getKey(), em);
        IsvGuard.assertOwnLayout(em.getKey(), form);

        List<String> problems = new ArrayList<>();
        List<AppendItem> items = new ArrayList<>();
        int index = 0;
        for (String g : spec.split(";")) {
            if (g.trim().isEmpty()) continue;
            index++;
            AppendItem it = new AppendItem();
            it.where = "RULE_APPEND 第 " + index + " 组";
            String[] col = g.split("\\|");
            if (col.length != 3 || col[0].trim().isEmpty() || col[1].trim().isEmpty() || col[2].trim().isEmpty()) {
                problems.add(it.where + " 格式不对（要 规则id|锚点字段|新字段1,新字段2）：" + g.trim());
                continue;
            }
            it.ruleId = col[0].trim();
            it.anchor = col[1].trim();
            for (String k0 : col[2].split(",")) {
                String k = k0.trim();
                if (!k.isEmpty() && !it.keys.contains(k)) it.keys.add(k);
            }
            items.add(it);
        }
        if (items.isEmpty() && problems.isEmpty()) problems.add("RULE_APPEND 里一组都没有");

        //同一个新字段只能跟一个锚点：跟两个锚点等于被两套条件管
        Map<String, String> anchorOfKey = new HashMap<>();
        for (AppendItem it : items) {
            for (ControlAp<?> ap : hostAps(fm)) {
                if (hostKey != null && !hostKey.equals(ap.getKey())) continue;
                List<FormRule> rs = rulesOf(ap);
                if (rs == null) continue;
                for (FormRule r : rs) {
                    if (!it.ruleId.equals(r.getId())) continue;
                    if (it.rule != null) {
                        problems.add(it.where + "：规则 id=" + it.ruleId + " 命中不止 1 条"
                                + (hostKey == null ? "，用 RULE_HOST 限定宿主" : ""));
                    }
                    it.rule = r;
                    it.host = ap;
                }
            }
            if (it.rule == null) {
                problems.add(it.where + "：找不到规则 id=" + it.ruleId
                        + (hostKey == null ? "" : "（限定宿主 " + hostKey + "）") + "，先跑读模式看 id");
                continue;
            }
            String anchorApId = apIdByKey.get(it.anchor);
            if (anchorApId == null) {
                problems.add(it.where + "：布局上找不到锚点字段 " + it.anchor);
                continue;
            }
            it.anchorOk = !actionsWith(it.rule, anchorApId).isEmpty();
            if (!it.anchorOk) {
                problems.add(it.where + "：规则 " + it.ruleId + "（" + describeOf(it.rule) + "）没有管 "
                        + it.anchor + "，它管的是：" + fieldKeysOf(it.rule, apById));
            }
            for (String k : it.keys) {
                IsvGuard.assertOwnField(k);
                if (k.equals(it.anchor)) {
                    problems.add(it.where + "：新字段 " + k + " 就是锚点本身");
                    continue;
                }
                if (apIdByKey.get(k) == null) {
                    problems.add(it.where + "：布局上找不到新字段 " + k
                            + "（要先用 FormLayoutWriteProbe 的 add field 把字段落库，布局上有了它才能进规则）");
                }
                String before = anchorOfKey.put(k, it.anchor);
                if (before != null && !before.equals(it.anchor)) {
                    problems.add(it.where + "：新字段 " + k + " 同时跟了 " + before + " 和 " + it.anchor
                            + " 两个锚点，一个字段只能被一套条件管");
                }
            }
        }
        //这里不先中止：下面两道拦截对「规则、锚点、字段都找得到」的那几组照样能查，
        //一次列全，免得改完前一批问题再撞下一批。

        //锚点 → 本批点名了哪些规则
        Map<String, List<String>> namedByAnchor = new LinkedHashMap<>();
        for (AppendItem it : items) {
            List<String> ids = namedByAnchor.get(it.anchor);
            if (ids == null) namedByAnchor.put(it.anchor, ids = new ArrayList<>());
            if (!ids.contains(it.ruleId)) ids.add(it.ruleId);
        }
        for (AppendItem it : items) {
            if (!it.anchorOk) continue;
            List<String> named = namedByAnchor.get(it.anchor);
            //拦截 4：锚点还被没点名的规则管着
            for (Map.Entry<String, String> ref : rulesReferencing(fm, apIdByKey.get(it.anchor)).entrySet()) {
                if (named.contains(ref.getKey())) continue;
                problems.add(it.where + "：锚点 " + it.anchor + " 还被没点名的规则管着：" + ref.getValue()
                        + "。只追加到一部分规则，新字段就只跟了锚点的一半；把它也写进来："
                        + ref.getKey() + "|" + it.anchor + "|" + csv(it.keys));
                named.add(ref.getKey());
            }
            //拦截 3：新字段已被别的规则管着（本批点名的、跟同一锚点的规则除外——那是重跑）
            for (String k : it.keys) {
                if (apIdByKey.get(k) == null) continue;
                for (Map.Entry<String, String> ref : rulesReferencing(fm, apIdByKey.get(k)).entrySet()) {
                    if (named.contains(ref.getKey())) continue;
                    problems.add(it.where + "：新字段 " + k + " 已被规则管着：" + ref.getValue()
                            + "。两条规则管同一个字段，结果取决于执行顺序；先弄清那条规则是干什么的");
                }
            }
        }
        if (!problems.isEmpty()) failAll(problems);

        //改之前先序列化一次，改完再比：新字段的 id 在 XML 里多出来的次数必须正好等于追加的次数
        MetadataWriter w = new MetadataWriter(fm.getModelType());
        Map<String, Integer> before = idCounts(w.convertToDesignMeta(fm), apIdByKey, anchorOfKey.keySet());

        Map<String, Integer> appended = new LinkedHashMap<>();
        List<FormRule> changedRules = new ArrayList<>();
        for (AppendItem it : items) {
            String anchorApId = apIdByKey.get(it.anchor);
            for (BizRuleAction a : actionsWith(it.rule, anchorApId)) {
                List<FieldId> old = (List<FieldId>) get(a, "getFields");
                List<String> present = new ArrayList<>();
                for (FieldId f : old) present.add(f.getId());
                List<FieldId> next = new ArrayList<>();
                List<String> added = new ArrayList<>();
                for (FieldId f : old) {
                    next.add(f);
                    if (!anchorApId.equals(f.getId())) continue;
                    for (String k : it.keys) {
                        String apId = apIdByKey.get(k);
                        if (present.contains(apId) || added.contains(k)) continue;
                        FieldId nf = new FieldId(apId);
                        //和锚点那一项一致：设计器建的 FieldId 带不带 isv，新加的就跟着带不带
                        if (f.getIsv() != null && !f.getIsv().isEmpty()) nf.setIsv(IsvGuard.ISV);
                        next.add(nf);
                        added.add(k);
                    }
                }
                if (added.isEmpty()) {
                    System.out.println("[PROBE] = 规则 " + it.ruleId + " 的" + a.getClass().getSimpleName()
                            + " 已经含 " + csv(it.keys) + "，跳过");
                    continue;
                }
                call(a, "setFields", next);
                for (String k : added) appended.put(k, (appended.containsKey(k) ? appended.get(k) : 0) + 1);
                if (!changedRules.contains(it.rule)) changedRules.add(it.rule);
                System.out.println("[PROBE] ~+ 规则 " + it.ruleId + "（" + describeOf(it.rule) + "，宿主 "
                        + it.host.getKey() + "）的 " + a.getClass().getSimpleName() + " 在 " + it.anchor
                        + " 后面追加 " + csv(added));
            }
        }
        if (appended.isEmpty()) {
            //不打 dry-run 结束行：那一行会被记成一条待确认修改，而这里没有任何修改
            System.out.println("[PROBE] 无事可做：RULE_APPEND 里的字段都已经跟着锚点了，没有要写的");
            return;
        }
        for (FormRule r : changedRules) {
            System.out.println("[PROBE] 追加后的规则结构：");
            dumpRule(r, apById);
        }

        List<AbstractDesignMeta> dms = w.convertToDesignMeta(fm);
        System.out.println("[PROBE] convertToDesignMeta(fm) 产出 " + dms.size() + " 份设计态");
        Map<String, Integer> after = idCounts(dms, apIdByKey, anchorOfKey.keySet());
        for (Map.Entry<String, Integer> e : appended.entrySet()) {
            String k = e.getKey();
            int delta = after.get(k) - before.get(k);
            if (delta != e.getValue()) {
                problems.add("自检：" + k + " 追加了 " + e.getValue() + " 处，设计态 XML 里却多出 " + delta
                        + " 处——序列化结果和内存里改的对不上，不能落库");
            }
        }
        if (!problems.isEmpty()) failAll(problems);
        System.out.println("[PROBE]   自检通过：" + appended.size() + " 个字段在设计态 XML 里多出的次数与追加次数一致");

        if (!apply) {
            tryCandidate(form, fm, changedRules);
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，未写入。确认无误后加 APPLY=1");
            return;
        }
        //继承布局：只 save(fm)。save(em, fm) 会连父实体一起重写。
        Map<String, Object> r = w.save(fm);
        System.out.println("[PROBE] save -> " + r);
        MetadataDao.rebuildRuntimeMetaById(formId);
        System.out.println("[PROBE] rebuildRuntimeMetaById(" + formId + ") 完成");
    }

    /** 规则里字段列表含 apId 的那几个动作（真动作在前）。 */
    @SuppressWarnings("unchecked")
    private static List<BizRuleAction> actionsWith(FormRule r, String apId) {
        List<BizRuleAction> out = new ArrayList<>();
        for (int p = 0; p < 2; p++) {
            List<BizRuleAction> as = p == 0 ? r.getTrueActions() : r.getFalseActions();
            if (as == null) continue;
            for (BizRuleAction a : as) {
                Object fields = get(a, "getFields");
                if (!(fields instanceof List)) continue;
                for (FieldId f : (List<FieldId>) fields) {
                    if (apId.equals(f.getId())) { out.add(a); break; }
                }
            }
        }
        return out;
    }

    /** 这条规则管着哪些控件，给「锚点没被它管」那句报错用。 */
    @SuppressWarnings("unchecked")
    private static String fieldKeysOf(FormRule r, Map<String, ControlAp<?>> apById) {
        List<String> keys = new ArrayList<>();
        for (int p = 0; p < 2; p++) {
            List<BizRuleAction> as = p == 0 ? r.getTrueActions() : r.getFalseActions();
            if (as == null) continue;
            for (BizRuleAction a : as) {
                Object fields = get(a, "getFields");
                if (!(fields instanceof List)) continue;
                for (FieldId f : (List<FieldId>) fields) {
                    ControlAp<?> ap = apById.get(f.getId());
                    String k = ap == null ? "!!悬空(" + f.getId() + ")" : String.valueOf(ap.getKey());
                    if (!keys.contains(k)) keys.add(k);
                }
            }
        }
        return keys.isEmpty() ? "（一个字段都没有）" : csv(keys);
    }

    /** 引用了 apId 的规则：id → 一行可读说明。遍历全部宿主。 */
    private static Map<String, String> rulesReferencing(FormMetadata fm, String apId) {
        Map<String, String> out = new LinkedHashMap<>();
        for (ControlAp<?> host : hostAps(fm)) {
            List<FormRule> rs = rulesOf(host);
            if (rs == null) continue;
            for (FormRule r : rs) {
                if (actionsWith(r, apId).isEmpty()) continue;
                out.put(String.valueOf(r.getId()), "host=" + host.getKey() + " seq=" + r.getSeq()
                        + " id=" + r.getId() + " " + r.getDescription());
            }
        }
        return out;
    }

    /** 设计态 XML 里每个字段的 Ap id 以 `<Id>…</Id>` 出现了几次。 */
    private static Map<String, Integer> idCounts(List<AbstractDesignMeta> dms, Map<String, String> apIdByKey,
            Iterable<String> keys) {
        Map<String, Integer> out = new HashMap<>();
        for (String k : keys) {
            String needle = "<Id>" + apIdByKey.get(k) + "</Id>";
            int n = 0;
            for (AbstractDesignMeta d : dms) {
                String x = d.getDataXml();
                if (x == null) continue;
                for (int i = x.indexOf(needle); i >= 0; i = x.indexOf(needle, i + 1)) n++;
            }
            out.put(k, n);
        }
        return out;
    }

    private static void failAll(List<String> problems) {
        StringBuilder sb = new StringBuilder("这一批有 ").append(problems.size()).append(" 处问题，一个字都没写：");
        for (String p : problems) sb.append("\n  - ").append(p);
        fail(sb.toString());
    }

    private static String describeOf(FormRule r) {
        return r.getDescription() == null ? "" : r.getDescription().toString();
    }

    /**
     * 同 TAG 的既有规则里，这次准许摘掉哪几条 —— 只认 `RULE_REMOVE_IDS` 点过名的。
     *
     * 为什么不能按描述前缀自动摘（2026-09-14 真机实测，差一步就删掉 5 条别人的规则）：
     * 幂等原本写成「先摘掉本探针以前用同一个 TAG 建过的」，但**描述前缀证明不了是谁建的**。
     * 那次 `RULE_TAG=参数显隐-` 撞上布局里 5 条设计器建的同前缀规则（屈服负荷、最大负荷…），
     * dry-run 直接把它们列进「摘掉」清单，是人读了输出才拦下来的，没有任何自动保护。
     * 换个 TAG 也不算解法：任何与既有描述同前缀的 TAG 都会命中，而探针当时一个字都不提醒。
     *
     * 也不给「允许删别人的」这种布尔开关：开关一旦存在，第一次被拒就会被顺手填上。点名要写
     * 出具体 id，这几个 id 就会跟着入参进 dry-run 记录、进给用户确认的那份报告——删什么是
     * 被人看过的，不是被一个 1 放行的。
     */
    private static List<String> removable(String tag, List<FormRule> hits, boolean rollback) {
        List<String> named = new ArrayList<>();
        for (String one : env("RULE_REMOVE_IDS", "").split(",")) {
            String id = one.trim();
            if (!id.isEmpty() && !named.contains(id)) named.add(id);
        }
        List<String> hitIds = new ArrayList<>();
        for (FormRule r : hits) hitIds.add(String.valueOf(r.getId()));
        for (String id : named) {
            if (!hitIds.contains(id)) {
                fail("RULE_REMOVE_IDS 里的 " + id + " 不在 RULE_TAG「" + tag + "」命中的规则里"
                        + (hitIds.isEmpty() ? "（这个 TAG 一条都没命中）" : "；命中的是 " + csv(hitIds)));
            }
        }
        if (hits.size() == named.size()) return named;

        System.out.println("[PROBE] !! RULE_TAG「" + tag + "」命中 " + hits.size()
                + " 条已经存在的规则，其中 " + (hits.size() - named.size()) + " 条没有被点名：");
        for (FormRule r : hits) {
            if (named.contains(String.valueOf(r.getId()))) continue;
            System.out.println("[PROBE] !!     " + r.getId() + " | " + describeOf(r)
                    + "  seq=" + r.getSeq() + " isv=" + r.getIsv());
        }
        System.out.println("[PROBE] !! 描述前缀证明不了这些规则是谁建的：设计器建的规则同样可能是这个前缀。");
        if (!rollback) {
            System.out.println("[PROBE] !! 只是想新增：换一个不撞的 RULE_TAG，既有规则一条都不动。");
        }
        System.out.println("[PROBE] !! 确实要用新规则替换掉它们（或回滚它们）：逐条点名 RULE_REMOVE_IDS="
                + csv(hitIds));
        fail("同 TAG 的既有规则没有逐条点名，一条都没动（见上面几行）");
        return named;
    }

    /** 所有可能挂规则的 Ap：rootAp + fm.getItems()（rootAp 不一定在 items 里，去重） */
    private static List<ControlAp<?>> hostAps(FormMetadata fm) {
        List<ControlAp<?>> all = new ArrayList<>();
        FormAp root = fm.getRootAp();
        if (root != null) all.add(root);
        for (ControlAp<?> ap : fm.getItems()) {
            if (root != null && ap.getId() != null && ap.getId().equals(root.getId())) continue;
            all.add(ap);
        }
        return all;
    }

    /** 普通控件没有规则接口，不应算作规则读取失败。 */
    private static boolean supportsRules(ControlAp<?> ap) {
        try { ap.getClass().getMethod("getRules"); return true; }
        catch (NoSuchMethodException e) { return false; }
    }

    /** 取 Ap 上的规则列表（活列表，可直接 add/remove）；不支持或读取失败时返回 null。 */
    @SuppressWarnings("unchecked")
    private static List<FormRule> rulesOf(ControlAp<?> ap) {
        try {
            Object v = ap.getClass().getMethod("getRules").invoke(ap);
            return v instanceof List ? (List<FormRule>) v : null;
        } catch (Exception e) {
            return null;
        }
    }

    /** 正/反动作。RET=251 是设计器生成的固定值。 */
    private static BizRuleAction action(String act, boolean positive, List<FieldId> fids) {
        BizRuleAction a;
        String type, desc;
        if ("lock".equals(act)) {
            a = positive ? new UnlockFieldAction() : new LockFieldAction();
            type = positive ? "UnlockFieldAction" : "LockFieldAction";
            desc = positive ? "解锁字段" : "锁定字段";
        } else if ("control".equals(act)) {
            //容器控件（FlexPanelAp / EntryFieldGroupAp 等）走 ControlAction，
            //既有设计器生成的面板显隐规则也是这一对
            a = positive ? new ShowControlAction() : new HideControlAction();
            type = positive ? "ShowControlAction" : "HideControlAction";
            desc = positive ? "显示控件" : "隐藏控件";
        } else {
            a = positive ? new ShowFieldAction() : new HideFieldAction();
            type = positive ? "ShowFieldAction" : "HideFieldAction";
            desc = positive ? "显示字段" : "隐藏字段";
        }
        a.setId(Uuid8.generateShortUuid());
        a.setActionType(type);
        a.setDescription(desc);
        a.setRET(251);
        a.setSeq(0);
        a.setIsv(IsvGuard.ISV);
        call(a, "setFields", fids);
        return a;
    }

    /**
     * 新写进去的条件先过平台核对（S36 3.2，见 FormulaCheck）：规则写入本身不看表达式，写错照样落库、运行时整条跳过。
     * 一条不过就记下，全部核完一起报，好让一次 dry-run 看到所有错处。
     */
    private static void checkNew(String where, String expr, MainEntityType met, String entityKey, List<String> bad) {
        FormulaCheck.Result r = FormulaCheck.rule(expr, met);
        if (!FormulaCheck.report("form", where, entityKey, r, true)) bad.add(where);
    }

    /** 读模式：既有规则的生效条件也核一遍，只在没过时多打几行，不发错误记录（这不是本次的输入）。 */
    private static boolean checkExisting(FormRule r, MainEntityType met, String entityKey) {
        String cond = r.getPreCondition();
        if (cond == null || cond.trim().isEmpty()) return true;
        FormulaCheck.Result result = FormulaCheck.rule(cond, met);
        return FormulaCheck.report("form", "规则 " + r.getId() + " 的生效条件", entityKey, result, false);
    }

    private static String entityKeyOf(FormMetadata fm) {
        try {
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
            return em == null ? null : em.getKey();
        } catch (Throwable e) {
            return null;
        }
    }

    private static void dumpRule(FormRule r, Map<String, ControlAp<?>> apById) {
        System.out.println("[PROBE]  [" + r.getSeq() + "] " + r.getDescription()
                + "  enabled=" + r.isEnabled() + "  isv=" + r.getIsv() + "  id=" + r.getId());
        //生效的 PreCondition 和只给人看的 PreDescription 以前并排打在一行、都叫「条件」，
        //两句不一样时极易被读成「同一个条件的两种写法」，实测代价是一次人工往返加一次
        //「你读的是缓存吧」的信任折扣（2026-09-14 真机）。现在各占一行、各有各的名字。
        //
        //**不给「不一致」报警**：真机上 18 条设计器建的规则条条不一致——PreCondition 写字段
        //标识、PreDescription 写中文字段名，那是平台自己的常态。一个条条都响的 !! 只会教人
        //忽略 !!。判定用哪一句说清楚就够了。
        String cond = String.valueOf(r.getPreCondition());
        String desc = String.valueOf(r.getPreDescription());
        System.out.println("[PROBE]        生效条件 " + cond);
        if (!cond.equals(desc)) {
            System.out.println("[PROBE]        设计器描述 " + desc
                    + "   （只给人看，不参与判定；平台不保证它跟上面那句同步）");
        }
        for (int p = 0; p < 2; p++) {
            List<BizRuleAction> as = p == 0 ? r.getTrueActions() : r.getFalseActions();
            if (as == null) continue;
            for (BizRuleAction a : as) {
                Object f = get(a, "getFields");
                StringBuilder sb = new StringBuilder();
                int miss = 0;
                if (f instanceof List) {
                    for (FieldId fid : (List<FieldId>) f) {
                        ControlAp<?> ap = apById.get(fid.getId());
                        if (sb.length() > 0) sb.append('、');
                        if (ap == null) { sb.append("!!悬空(").append(fid.getId()).append(')'); miss++; }
                        else sb.append(ap.getName()).append('(').append(ap.getKey()).append(')');
                    }
                }
                System.out.println("[PROBE]        " + (p == 0 ? "真-" : "假-")
                        + a.getClass().getSimpleName()
                        + (miss > 0 ? "  !! 悬空引用 " + miss + " 个" : "") + "  " + sb);
            }
        }
    }

    private static void call(Object o, String m, Object arg) {
        try {
            for (Method mm : o.getClass().getMethods()) {
                if (mm.getName().equals(m) && mm.getParameterTypes().length == 1) {
                    mm.invoke(o, arg);
                    return;
                }
            }
            throw new NoSuchMethodException(m);
        } catch (Exception e) {
            throw new RuntimeException(o.getClass().getSimpleName() + "." + m + " 失败", e);
        }
    }

    private static Object get(Object o, String m) {
        try { return o.getClass().getMethod(m).invoke(o); } catch (Exception e) { return null; }
    }

    /** 目标 Ap id 已经出现在哪些规则动作中；遍历全部宿主，避免跨宿主重复控制。 */
    @SuppressWarnings("unchecked")
    private static List<String> ruleRefs(FormMetadata fm, String apId) {
        List<String> out = new ArrayList<>();
        for (ControlAp<?> host : hostAps(fm)) {
            List<FormRule> rs = rulesOf(host);
            if (rs == null) continue;
            for (FormRule r : rs) {
                boolean hit = false;
                for (int p = 0; p < 2 && !hit; p++) {
                    List<BizRuleAction> actions = p == 0 ? r.getTrueActions() : r.getFalseActions();
                    if (actions == null) continue;
                    for (BizRuleAction action : actions) {
                        Object fields = get(action, "getFields");
                        if (!(fields instanceof List)) continue;
                        for (FieldId field : (List<FieldId>) fields) {
                            if (apId.equals(field.getId())) { hit = true; break; }
                        }
                        if (hit) break;
                    }
                }
                if (hit) out.add("host=" + host.getKey() + " seq=" + r.getSeq()
                        + " id=" + r.getId() + " " + r.getDescription());
            }
        }
        return out;
    }

    /** 逗号连接：`RULE_REMOVE_IDS=` 后面那一段要能整段复制粘贴。 */
    private static String csv(List<String> xs) {
        StringBuilder out = new StringBuilder();
        for (String x : xs) {
            if (out.length() > 0) out.append(',');
            out.append(x);
        }
        return out.toString();
    }

    private static String join(List<String> xs) {
        StringBuilder out = new StringBuilder();
        for (String x : xs) {
            if (out.length() > 0) out.append("；");
            out.append(x);
        }
        return out.toString();
    }

    private static void fail(String message) {
        throw new IllegalArgumentException(message);
    }

    private static String env(String k, String d) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? d : v;
    }
}
