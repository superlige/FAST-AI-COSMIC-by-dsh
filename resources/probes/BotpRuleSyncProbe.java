import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.algo.DataSet;
import kd.bos.algo.Row;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.metadata.dynamicobject.DynamicProperty;
import kd.bos.dataentity.utils.Uuid8;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.entity.EntityType;
import kd.bos.entity.EntryType;
import kd.bos.entity.LinkEntryType;
import kd.bos.entity.LinkSetElement;
import kd.bos.entity.LinkSetItemElement;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.SubEntryType;
import kd.bos.entity.botp.BizRulePolicy;
import kd.bos.entity.botp.CRBizRuleElement;
import kd.bos.entity.botp.CRCondition;
import kd.bos.entity.botp.CRFormula;
import kd.bos.entity.botp.CheckMessage;
import kd.bos.entity.botp.CheckPoint;
import kd.bos.entity.botp.CheckResult;
import kd.bos.entity.botp.ConvertRuleElement;
import kd.bos.entity.botp.FieldMapItem;
import kd.bos.entity.botp.FieldMapPolicy;
import kd.bos.entity.botp.FilterPolicy;
import kd.bos.entity.botp.LinkEntityPolicy;
import kd.bos.entity.botp.PlugInPolicy;
import kd.bos.entity.botp.extcontrol.ExtControlElement;
import kd.bos.entity.formula.RowDataModel;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.FieldProp;
import kd.bos.entity.property.LinkEntryProp;
import kd.bos.entity.property.MulBasedataProp;
import kd.bos.metadata.botp.ConvertRuleMetadata;
import kd.bos.metadata.botp.ConvertRuleReader;
import kd.bos.metadata.botp.ConvertRuleWriter;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.botp.ConvertMetaServiceHelper;

/**
 * 写探针：把一条 BOTP 转换规则上的**业务规则**复制到另一批规则，并改一批规则的**字段映射**
 * （取源单字段、公式、基础资料常量、清掉映射）。默认 dry-run，必须 APPLY=1 才落库。
 * SYNC_RESTORE 先校验目录内全部规则的归属并报告目标清单；APPLY 时全部通过授权检查后才写回。
 *
 * 为什么需要它：转换规则不在 MetaCategory 里，MetadataDao 那套完全用不上；设计器里
 * 一条条点是 O(规则数 × 业务规则数)。读写通道实测过：
 *   读 new ConvertRuleReader().loadMeta(id,false) -> ConvertRuleMetadata（完整设计态）
 *   写 ConvertRuleWriter.save(meta) + ConvertRuleWriter.clearCache(ids)
 *   save() 已实测**无损往返**（不改内容 save 一次，buildXml 前后逐字符一致）
 *   T_BOTP_ConvertRule.FDATA 与 buildXml() 的输出**完全相同**，所以回滚可以直接写回 FDATA
 *
 * 目标规则选择（二选一）：
 *   SYNC_TARGETS=id1,id2,...        显式给 id
 *   SYNC_SOURCE_ENTITY / SYNC_TARGET_ENTITY / SYNC_NAME_LIKE / SYNC_ENABLED=0|1|*
 *                                   按源单/目标单/名称/启用状态筛（名称走 like %x%）
 *   两者都给时以 SYNC_TARGETS 为准。SYNC_SRC 自己会被自动排除。
 *
 * 动作（可以只做一样）：
 *   SYNC_SRC=规则id                 业务规则的来源；不给就不复制业务规则
 *   SYNC_FIELDMAP=目标字段=取值;…    改目标字段的映射，目标规则里没有这条映射就新建。取值四种写法：
 *                                     src:源字段      取源单字段；基础资料的属性写 字段.属性（demo_customer.name）
 *                                     const:id或编码  基础资料常量（单选基础资料字段才有常量；
 *                                                     文本、下拉的固定值用公式 '值'）
 *                                     clear           清掉映射（目标字段下推时不取值）
 *                                     公式            不带前缀就是公式，表达式按源单字段算
 *                                   例：demo_org=src:org;demo_djlx=const:DJLX01;demo_hjlb=demo_combofield7;demo_bz=clear
 *                                   每条改完都过平台自己的映射校验（目标字段在不在、源字段在不在、
 *                                   公式能不能解析、必录字段不能清空），有一处不过就整批不写
 *   SYNC_ON_EXIST=skip|replace      目标规则已有业务规则时怎么办，默认 skip
 *   SYNC_LINK=源单实体->目标单实体   改建行层级（规则的 LinkEntityPolicy）：下推时按源单这个实体的每一行，
 *                                   在目标单那个实体上建一行。表头写单据标识，分录、子分录写它的标识。
 *                                   例：SYNC_LINK=entryentity->entryentity
 *                                   预演逐条报改前改后、上下游关联记在哪、改后每条有取值的映射落在哪一层；
 *                                   实体不在、是关联子实体、改完不再记原来记的上下游关联、整条规则过不了
 *                                   平台校验（只算这次新增的问题），有一处就整批不写。APPLY 后重新读回核对
 *   SYNC_FILTER=公式|clear          改源单过滤（哪些源单、哪些行能下推）：整个换成这一条公式（条件行清掉），
 *                                   clear 是不再过滤。公式按源单字段写，例：billstatus = 'C' and (org.number = '0101' or org.number = '0301')
 *   SYNC_RUN_CONDITION=公式|clear   改执行条件（源单满足才走这条规则），写法同上
 *                                   两项预演都逐条打改前平台实际生效的那一条（条件行和公式拼好的），照着改；
 *                                   规则用的是高级条件（多组）的不改，公式核不过、整条规则过不了平台校验（只算这次新增的）
 *                                   都整批不写。APPLY 后重新读回核对
 *
 * 安全：
 *   SYNC_BACKUP=目录                APPLY 前把每条目标规则的 XML 原文存进去；APPLY=1、SYNC_BACKUP_ONLY=1 时工具自动给（.cosmic-ai/evidence/backups/ 下），不用写
 *   SYNC_BACKUP_ONLY=1              只导不改：按同样的筛选条件把每条规则的 XML 存进 SYNC_BACKUP，
 *                                   一行库都不写（所以不需要 APPLY=1）
 *   SYNC_RESTORE=目录               回滚模式：把该目录下的 <id>.xml 写回 FDATA + 清缓存
 *   APPLY=1                         真落库（默认复用常驻进程，显式 cold 才强制冷进程）
 */
public class BotpRuleSyncProbe {

    public static void run() throws Exception {
        boolean apply = "1".equals(System.getenv("APPLY"));
        String restoreDir = env("SYNC_RESTORE", "");
        if (!restoreDir.isEmpty()) {
            restore(restoreDir, apply);
            return;
        }

        if ("1".equals(env("SYNC_BACKUP_ONLY", ""))) {
            backupOnly(env("SYNC_BACKUP", ""));
            return;
        }

        String srcId = env("SYNC_SRC", "");
        List<Mapping> fieldMap = parseFieldMap(env("SYNC_FIELDMAP", ""));
        Link link = Link.parse(env("SYNC_LINK", ""));
        List<Cond> conds = new ArrayList<Cond>();
        Cond filter = Cond.parse(Cond.FILTER, env("SYNC_FILTER", ""));
        Cond runCond = Cond.parse(Cond.RUN, env("SYNC_RUN_CONDITION", ""));
        if (filter != null) {
            conds.add(filter);
        }
        if (runCond != null) {
            conds.add(runCond);
        }
        String onExist = env("SYNC_ON_EXIST", "skip");
        String backupDir = env("SYNC_BACKUP", "");

        if (srcId.isEmpty() && fieldMap.isEmpty() && link == null && conds.isEmpty()) {
            System.out.println("[PROBE] SYNC_SRC、SYNC_FIELDMAP、SYNC_LINK、SYNC_FILTER、SYNC_RUN_CONDITION 都没给，无事可做");
            return;
        }
        if (apply && backupDir.isEmpty()) {
            System.out.println("[PROBE] !! APPLY=1 必须同时给 SYNC_BACKUP=<目录>，中止");
            return;
        }

        System.out.println("[PROBE] 模式=" + (apply ? "APPLY 真写" : "dry-run 只演算")
                + "  业务规则来源=" + (srcId.isEmpty() ? "(不复制)" : srcId)
                + "  字段映射改动 " + fieldMap.size() + " 项"
                + "  建行层级=" + (link == null ? "(不改)" : link.source + " -> " + link.target)
                + "  源单过滤=" + (filter == null ? "(不改)" : filter.label())
                + "  执行条件=" + (runCond == null ? "(不改)" : runCond.label()));

        List<Head> targets = selectTargets(srcId);
        if (targets.isEmpty()) {
            System.out.println("[PROBE] 没选中任何目标规则，中止");
            return;
        }
        System.out.println("[PROBE] 选中目标规则 " + targets.size() + " 条");

        //红线先过一遍全部目标，别改了一半才发现有条不该动的
        for (Head h : targets) {
            IsvGuard.assertOwnBotpRule(h.id, h.isv, h.source, h.target);
        }

        List<CRBizRuleElement> srcActions = new ArrayList<CRBizRuleElement>();
        if (!srcId.isEmpty()) {
            srcActions = loadActions(srcId);
            System.out.println("[PROBE] 源规则 " + srcId + " 的业务规则 " + srcActions.size() + " 条");
            for (CRBizRuleElement a : srcActions) {
                System.out.println("[PROBE]   seq=" + a.getSeq() + " 「" + a.getDescription()
                        + "」 " + a.getParameters()
                        + "  前置=" + (a.getPreCondition() == null ? "-"
                                : a.getPreCondition().getExpression()));
            }
            if (srcActions.isEmpty()) {
                System.out.println("[PROBE] !! 源规则一条业务规则都没有，中止");
                return;
            }
        }

        for (Mapping m : fieldMap) {
            System.out.println("[PROBE] 映射 " + m.target + " <= " + m.label());
        }

        //先把每条规则都改好、过完平台校验，再写第一条：校验不过的规则夹在中间时，
        //边改边存会留下一半新一半旧的一批规则
        ConvertRuleReader reader = new ConvertRuleReader();
        Map<Head, ConvertRuleMetadata> ready = new LinkedHashMap<Head, ConvertRuleMetadata>();
        Map<String, MainEntityType> types = new HashMap<String, MainEntityType>();
        int failed = 0;
        for (Head h : targets) {
            ConvertRuleMetadata meta = reader.loadMeta(h.id, false);
            if (meta == null || meta.getRuleElement() == null) {
                System.out.println("[PROBE] !! " + h.name + " 规则内容为空，跳过");
                continue;
            }
            ConvertRuleElement el = meta.getRuleElement();
            List<String> notes = new ArrayList<String>();
            List<String> errors = new ArrayList<String>();
            List<String> linkErrors = new ArrayList<String>();
            List<String> condErrors = new ArrayList<String>();
            //整条规则的平台校验在改之前先跑一遍：规则原本就有的问题不算这次的账，只拦新增的
            boolean wholeCheck = link != null || !conds.isEmpty();
            List<String> checkedBefore = wholeCheck ? platformCheck(el) : null;

            if (!srcActions.isEmpty()) {
                notes.addAll(applyBizRules(el, srcActions, onExist));
            }
            //源字段、公式按这条规则自己的源单解析；一批规则的源单可以不同
            boolean typed = !fieldMap.isEmpty() || wholeCheck;
            MainEntityType st = typed ? typeOf(types, h.source) : null;
            MainEntityType tt = typed ? typeOf(types, h.target) : null;
            for (Mapping m : fieldMap) {
                notes.add(applyFieldMap(el, m, st, tt, errors));
            }
            //建行层级放在字段映射之后：落层报的是这次改完的映射
            if (link != null) {
                notes.addAll(applyLink(h, el, link, st, tt, linkErrors));
            }
            for (Cond c : conds) {
                notes.addAll(applyCondition(h, el, c, st, condErrors));
            }
            if (wholeCheck) {
                for (String msg : platformCheck(el)) {
                    if (!checkedBefore.contains(msg)) {
                        (link != null ? linkErrors : condErrors).add("改完整条规则过不了平台校验：" + msg);
                    }
                }
            }

            System.out.println("[PROBE] ---- " + h.name + "  id=" + h.id);
            for (String n : notes) {
                System.out.println("[PROBE]      " + n);
            }
            for (String e : errors) {
                System.out.println("[PROBE]      !! 平台映射校验：" + e);
            }
            for (String e : linkErrors) {
                System.out.println("[PROBE]      !! 建行层级：" + e);
            }
            for (String e : condErrors) {
                System.out.println("[PROBE]      !! 条件：" + e);
            }
            failed += errors.size() + linkErrors.size() + condErrors.size();
            ready.put(h, meta);
        }

        if (failed > 0) {
            System.out.println("[PROBE] !! 校验不通过 " + failed + " 处，整批没写，中止");
            return;
        }
        if (!apply) {
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，什么都没写。确认无误后加 APPLY=1");
            return;
        }

        List<String> changed = new ArrayList<String>();
        for (Map.Entry<Head, ConvertRuleMetadata> e : ready.entrySet()) {
            Head h = e.getKey();
            //备份必须在 save 之前，且是从库里读的原文（不是内存里已改过的对象）
            String before = reader.buildXml(h.id, false, false);
            writeFile(new File(backupDir, h.id + ".xml"), before);

            Map<?, ?> r = ConvertRuleWriter.save(e.getValue());
            System.out.println("[PROBE] " + h.name + "  id=" + h.id + "  save -> " + r);
            if (!Boolean.TRUE.equals(r.get("success"))) {
                System.out.println("[PROBE] !! 保存失败，中止后续规则；已写入 " + changed.size()
                        + " 条，用 SYNC_RESTORE=" + backupDir + " 回滚");
                ConvertRuleWriter.clearCache(changed.toArray(new String[0]));
                return;
            }
            changed.add(h.id);
        }
        ConvertRuleWriter.clearCache(changed.toArray(new String[0]));
        if (link != null) {
            readBackLink(changed, link);
        }
        if (!conds.isEmpty()) {
            readBackConditions(changed, conds);
        }
        System.out.println("[PROBE] 已写入 " + changed.size() + " 条并清缓存；备份在 " + backupDir);
    }

    // ---------- 源单过滤、执行条件 ----------

    /**
     * SYNC_FILTER / SYNC_RUN_CONDITION：规则上的一处条件整个换成一条公式，或者清掉。
     *
     * 为什么是「整个换成公式」，不是改某一行条件：平台把一处条件存成两半——条件行（设计器里一行一行配的，
     * 下推时转成查库的过滤）和公式（逐张源单算），两半用「并且」拼成生效的那一条（CRCondition.buildFullFormula；
     * 下推编译 CRConditionCompiler 两半都认）。只追加公式只能收窄、放不宽；按行改又要逐个比较符各写一套。
     * 换成一条公式，改前改后都是平台自己拼出来的那一条，确认单上一眼对得上。
     */
    static final class Cond {
        static final String FILTER = "SYNC_FILTER";
        static final String RUN = "SYNC_RUN_CONDITION";

        final String key;
        /** 空串是清掉。 */
        final String expr;

        Cond(String key, String expr) {
            this.key = key;
            this.expr = expr;
        }

        /** 空串是不改；clear（不分大小写）是清掉。 */
        static Cond parse(String key, String raw) {
            String s = raw.trim();
            if (s.isEmpty()) {
                return null;
            }
            return new Cond(key, "clear".equalsIgnoreCase(s) ? "" : s);
        }

        String part() {
            return FILTER.equals(key) ? "源单过滤" : "执行条件";
        }

        String label() {
            return expr.isEmpty() ? "清掉" : "改成 " + expr;
        }
    }

    private static List<String> applyCondition(Head h, ConvertRuleElement el, Cond c, MainEntityType st,
            List<String> errors) {
        List<String> notes = new ArrayList<String>();
        FilterPolicy fp = null;
        CRCondition old;
        if (Cond.FILTER.equals(c.key)) {
            fp = el.getFilterPolicy();
            //高级条件开着时下推按 getConditionList() 一组组走，不读 getCondition()（ConvertRuleCompiler.compileFilterPolicy）
            if (fp != null && Boolean.TRUE.equals(fp.getAdvCondition())) {
                errors.add("源单过滤用的是高级条件（多组条件，下推按组走、不读这一处），" + c.key + " 改不了它；要在设计器里改");
                return notes;
            }
            old = fp == null ? null : fp.getCondition();
        } else {
            old = el.getRunCondition();
        }
        String before = fullFormula(old, st);
        if (c.expr.isEmpty() && before.isEmpty()) {
            notes.add(c.part() + "：原本就没有，不动");
            return notes;
        }
        //公式按源单字段核：下推时这两处条件都在源单上算
        if (!c.expr.isEmpty() && !FormulaCheck.report("botp", "规则 " + h.id + " 的" + c.part(), h.source,
                FormulaCheck.rule(c.expr, st), true)) {
            errors.add(c.part() + "的公式没过平台核对（见上面 ✗ 那几行）");
        }
        CRCondition now = new CRCondition();
        now.setId(old == null || str(old.getId()).isEmpty() ? Uuid8.generateShortUuid() : old.getId());
        now.setSeq(old == null ? 0 : old.getSeq());
        now.setEnabled(true);
        now.setIsv(old == null || str(old.getIsv()).isEmpty() ? IsvGuard.ISV : old.getIsv());
        String after = "";
        if (!c.expr.isEmpty()) {
            now.setExpression(c.expr);
            now.setExprTran(c.expr);
            try {
                after = str(now.buildFullFormula(st)).trim();
            } catch (RuntimeException e) {
                errors.add(c.part() + "改完平台拼不出生效的条件：" + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }
        if (Cond.FILTER.equals(c.key)) {
            if (fp == null) {
                fp = new FilterPolicy();
                el.setFilterPolicy(fp);
            }
            fp.setCondition(now);
        } else {
            el.setRunCondition(now);
        }
        notes.add(c.part() + "：" + (before.isEmpty() ? "(原本没有)" : before) + "  ->  "
                + (c.expr.isEmpty() ? "(清掉，不再限制)" : after) + (before.equals(after) ? "（已经是这样）" : ""));
        if (old != null && !old.isEnabled()) {
            notes.add(c.part() + "改前是停用的，改后启用");
        }
        ProbeJson.emit("botp-condition", "rule", h.id, "name", h.name, "part", c.part(),
                "before", before, "after", after);
        return notes;
    }

    /** 平台自己把条件行和公式拼成的那一条（下推时生效的就是它）；没有条件是空串。 */
    private static String fullFormula(CRCondition c, MainEntityType st) {
        if (c == null) {
            return "";
        }
        try {
            return str(c.buildFullFormula(st)).trim();
        } catch (RuntimeException e) {
            return "(平台拼不出：" + e.getClass().getSimpleName() + ": " + e.getMessage() + "；条件行原文 "
                    + c.getFilterString() + "，公式 " + str(c.getExpression()) + ")";
        }
    }

    /** 写完清缓存后从库里重新读每条规则改过的条件，和这次要写的对一遍：公式一样、条件行是空的才算一致。 */
    private static void readBackConditions(List<String> ids, List<Cond> conds) throws Exception {
        ConvertRuleReader reader = new ConvertRuleReader();
        int bad = 0;
        int all = 0;
        for (String id : ids) {
            ConvertRuleMetadata back = reader.loadMeta(id, false);
            ConvertRuleElement el = back == null ? null : back.getRuleElement();
            for (Cond c : conds) {
                CRCondition cond = null;
                if (el != null) {
                    cond = Cond.FILTER.equals(c.key)
                            ? (el.getFilterPolicy() == null ? null : el.getFilterPolicy().getCondition())
                            : el.getRunCondition();
                }
                String expr = cond == null ? "" : str(cond.getExpression()).trim();
                boolean noRows = cond == null || cond.getFilterCondition() == null
                        || cond.getFilterCondition().getFilterRow() == null
                        || cond.getFilterCondition().getFilterRow().isEmpty();
                boolean ok = expr.equals(c.expr) && noRows;
                all++;
                bad += ok ? 0 : 1;
                System.out.println("[PROBE] 回读 id=" + id + "  " + c.part() + " 公式=" + (expr.isEmpty() ? "(空)" : expr)
                        + "  条件行=" + (noRows ? "无" : "还有") + (ok ? "  和要写的一致" : "  !! 和要写的不一致"));
            }
        }
        System.out.println("[PROBE] 回读条件：一致 " + (all - bad) + " 处，不一致 " + bad + " 处");
    }

    // ---------- 建行层级 ----------

    /** SYNC_LINK：源单、目标单各一个建行实体。 */
    static final class Link {
        final String source;
        final String target;

        Link(String source, String target) {
            this.source = source;
            this.target = target;
        }

        /** 空串是不改；写不成「标识->标识」的在读库之前拒掉。 */
        static Link parse(String s) {
            String raw = s.trim();
            if (raw.isEmpty()) {
                return null;
            }
            int at = raw.indexOf("->");
            String a = at < 0 ? "" : raw.substring(0, at).trim();
            String b = at < 0 ? "" : raw.substring(at + 2).trim();
            if (!a.matches("[A-Za-z0-9_]+") || !b.matches("[A-Za-z0-9_]+")) {
                throw new IllegalArgumentException("SYNC_LINK 要写成 源单实体->目标单实体（表头写单据标识，分录写分录标识），收到「"
                        + raw + "」");
            }
            return new Link(a, b);
        }
    }

    /**
     * 改 LinkEntityPolicy 的源、目标建行实体。下推引擎（ConvertRuleCompiler）按
     * {@code getAllEntities().get(key)} 找这两个实体，找不到就整次下推报错；目标单的关联配置
     * （ConvertMetaServiceHelper.loadLinkSet）里没有目标建行实体的那一项时，**不报错、静默不记**上下游关联。
     * 平台的保存和 LinkEntityPolicy.check 都不查这两件事，所以在这里查。
     */
    private static List<String> applyLink(Head h, ConvertRuleElement el, Link link, MainEntityType st,
            MainEntityType tt, List<String> errors) {
        List<String> notes = new ArrayList<String>();
        LinkEntityPolicy lep = el.getLinkEntityPolicy();
        if (lep == null) {
            lep = new LinkEntityPolicy();
            el.setLinkEntityPolicy(lep);
        }
        String srcWas = str(lep.getSourceEntryKey());
        String tgtWas = str(lep.getTargetEntryKey());
        EntityType se = rowEntity(st, link.source, "源单", errors);
        EntityType te = rowEntity(tt, link.target, "目标单", errors);
        if (se == null || te == null) {
            return notes;
        }
        //子分录键是建行实体之外单独的一项；建行实体换了、它还挂在旧实体下面，引擎会拿错层
        subEntryStillFits(st, "源单", str(lep.getSourceSubEntryKey()), se, errors);
        subEntryStillFits(tt, "目标单", str(lep.getTargetSubEntryKey()), te, errors);

        String linkedWas = linkEntity(tt, tgtWas);
        String linkedNow = linkEntity(tt, te.getName());
        boolean same = se.getName().equalsIgnoreCase(srcWas) && te.getName().equalsIgnoreCase(tgtWas);
        lep.setSourceEntryKey(se.getName());
        lep.setTargetEntryKey(te.getName());

        notes.add("建行层级：源单 " + where(st, srcWas) + " -> " + where(st, se.getName())
                + "；目标单 " + where(tt, tgtWas) + " -> " + where(tt, te.getName())
                + (same ? "（已经是这样，不动）" : ""));
        notes.add("上下游关联：改前" + (linkedWas == null ? "不记" : "记在 " + linkedWas)
                + "，改后" + (linkedNow == null ? "不记" : "记在 " + linkedNow)
                + "  记录方式=" + (lep.getLinkRecordType() == null ? "-" : lep.getLinkRecordType().name()));
        if (linkedWas != null && linkedNow == null) {
            errors.add("目标单 " + tt.getName() + " 的关联配置里没有 " + te.getName()
                    + " 的关联子实体，改完下推不再记上下游关联（改前记在 " + linkedWas + "）");
        }

        List<String> rows = new ArrayList<String>();
        List<String> others = new ArrayList<String>();
        int head = placeMappings(el, st, tt, se, te, rows, others);
        notes.add("改后有取值的映射 " + (rows.size() + head + others.size()) + " 条：目标单建行实体上 "
                + rows.size() + " 条，表头 " + head + " 条，其他位置 " + others.size() + " 条");
        for (String r : rows) {
            notes.add("  逐行  " + r);
        }
        for (String o : others) {
            notes.add("  其他  " + o);
        }
        ProbeJson.emit("botp-link", "rule", h.id, "name", h.name,
                "sourceBefore", where(st, srcWas), "sourceAfter", where(st, se.getName()),
                "targetBefore", where(tt, tgtWas), "targetAfter", where(tt, te.getName()),
                "linkBefore", linkedWas == null ? "" : linkedWas, "linkAfter", linkedNow == null ? "" : linkedNow,
                "rows", rows, "head", head, "others", others, "plugins", enabledPlugins(el));
        return notes;
    }

    /** 能建行的实体：单据本身（表头）、分录、子分录。关联子实体（*_lk）、多选基础资料的子表不算。 */
    private static EntityType rowEntity(MainEntityType type, String key, String side, List<String> errors) {
        EntityType e = null;
        for (Map.Entry<String, EntityType> one : type.getAllEntities().entrySet()) {
            if (one.getKey().equalsIgnoreCase(key)) {
                e = one.getValue();
                break;
            }
        }
        boolean rowLevel = e != null
                && (e == type || e.getName().equalsIgnoreCase(type.getName())
                        || (e instanceof EntryType && !(e instanceof LinkEntryType)));
        if (rowLevel) {
            return e;
        }
        StringBuilder can = new StringBuilder();
        for (EntityType one : type.getAllEntities().values()) {
            if (one.getName().equalsIgnoreCase(type.getName())
                    || (one instanceof EntryType && !(one instanceof LinkEntryType))) {
                can.append(can.length() == 0 ? "" : "、").append(where(type, one.getName()));
            }
        }
        errors.add(side + " " + type.getName() + (e == null ? " 上没有实体 " + key : " 的 " + key + " 不是表头、分录或子分录")
                + "；可选：" + can);
        return null;
    }

    private static void subEntryStillFits(MainEntityType type, String side, String sub, EntityType now,
            List<String> errors) {
        if (sub.isEmpty()) {
            return;
        }
        EntityType s = type.getAllEntities().get(sub);
        Object parent = s == null ? null : s.getParent();
        if (parent instanceof EntityType && ((EntityType) parent).getName().equalsIgnoreCase(now.getName())) {
            return;
        }
        errors.add(side + "的建行子分录 " + sub + " 不在 " + now.getName() + " 下面；这条规则的子分录要在设计器里改");
    }

    /**
     * 目标单关联配置里挂在这个实体下面的关联子实体（如 entryentity_lk）；没有就是 null，下推不记上下游关联。
     * 判断和 ConvertRuleCompiler.findLinkEntryProp 同一套：项的父实体对上、关联子实体和表名都有、
     * 实体上真有这个关联属性。
     */
    private static String linkEntity(MainEntityType tt, String entityKey) {
        if (entityKey.isEmpty()) {
            return null;
        }
        LinkSetElement set = ConvertMetaServiceHelper.loadLinkSet(tt.getName());
        List<LinkSetItemElement> items = set == null ? null : set.getItems();
        if (items == null) {
            return null;
        }
        EntityType entity = tt.getAllEntities().get(entityKey);
        for (LinkSetItemElement item : items) {
            if (!entityKey.equalsIgnoreCase(item.getParentEntityKey()) || str(item.getLinkEntityKey()).isEmpty()
                    || str(item.getTableName()).isEmpty()) {
                continue;
            }
            if (entity != null && entity.findProperty(item.getLinkEntityKey()) instanceof LinkEntryProp) {
                return entityKey + "." + item.getLinkEntityKey();
            }
        }
        return null;
    }

    /**
     * 按目标字段所在实体把有取值的映射分三类：目标建行实体上（逐行取值）、表头、其他位置。
     * 取源字段的，再报源字段在哪；源字段不在源单建行实体及其上级上（别的分录）时标出来。
     * 返回表头那类的条数，逐行和其他两类逐条放进 rows、others。
     */
    private static int placeMappings(ConvertRuleElement el, MainEntityType st, MainEntityType tt, EntityType se,
            EntityType te, List<String> rows, List<String> others) {
        FieldMapPolicy fmp = el.getFieldMapPolicy();
        List<FieldMapItem> maps = fmp == null ? null : fmp.getFieldMaps();
        if (maps == null) {
            return 0;
        }
        int head = 0;
        for (FieldMapItem fm : maps) {
            String value = describe(fm);
            if ("未映射".equals(value)) {
                continue;
            }
            String key = str(fm.getTargetFieldKey());
            String at = entityOf(tt, key);
            String line = key + " <= " + value;
            if ("SourceField".equals(fm.getConvertType()) || fm.getConvertType() == null) {
                String src = str(fm.getSourceFieldKey());
                int dot = src.indexOf('.');
                String from = entityOf(st, dot > 0 ? src.substring(0, dot) : src);
                line += "（源字段在 " + where(st, from) + (onPath(st, from, se) ? "" : "，不在源单建行实体及其上级上") + "）";
            }
            if (at.equalsIgnoreCase(te.getName())) {
                rows.add(line);
            } else if (at.equalsIgnoreCase(tt.getName())) {
                head++;
            } else {
                others.add(line + "（目标字段在 " + where(tt, at) + "）");
            }
        }
        return head;
    }

    /** 字段所在实体的标识；找不到字段返回空串。 */
    private static String entityOf(MainEntityType type, String field) {
        DynamicProperty p = RowDataModel.findProperty(type, field);
        Object parent = p == null ? null : p.getParent();
        return parent instanceof EntityType ? ((EntityType) parent).getName() : "";
    }

    /** from 是 row 自己或它的上级（表头是所有分录的上级）。 */
    private static boolean onPath(MainEntityType type, String from, EntityType row) {
        if (from.isEmpty() || from.equalsIgnoreCase(type.getName())) {
            return true;
        }
        Object cur = row;
        while (cur instanceof EntityType) {
            if (((EntityType) cur).getName().equalsIgnoreCase(from)) {
                return true;
            }
            cur = ((EntityType) cur).getParent();
        }
        return false;
    }

    /** 「表头 demo_bill」「分录 entryentity（明细）」这种说法。 */
    private static String where(MainEntityType type, String key) {
        if (key.isEmpty()) {
            return "(空)";
        }
        if (key.equalsIgnoreCase(type.getName())) {
            return "表头 " + key;
        }
        EntityType e = type.getAllEntities().get(key);
        String kind = e instanceof SubEntryType ? "子分录 " : e instanceof EntryType ? "分录 " : "实体 ";
        String name = e == null || e.getDisplayName() == null ? "" : e.getDisplayName().toString();
        return kind + key + (name.isEmpty() ? "" : "（" + name + "）");
    }

    /** 规则上启用的转换插件类名。插件条目的类在各版本 SDK 里名字不一，按方法名取（同 BotpRuleProbe）。 */
    private static List<String> enabledPlugins(ConvertRuleElement el) {
        List<String> out = new ArrayList<String>();
        PlugInPolicy pp = el.getPlugInPolicy();
        Object list = pp == null ? null : call(pp, "getPlugins");
        if (!(list instanceof List)) {
            return out;
        }
        for (Object p : (List<?>) list) {
            if ("true".equals(str(call(p, "isEnabled")))) {
                out.add(str(call(p, "getClassName")));
            }
        }
        return out;
    }

    private static Object call(Object o, String method) {
        try {
            return o.getClass().getMethod(method).invoke(o);
        } catch (Exception e) {
            return null;
        }
    }

    /** 整条规则的平台校验（ConvertRuleElement.check：各项配置加必录字段），返回每条消息的原文。 */
    private static List<String> platformCheck(ConvertRuleElement el) {
        List<String> out = new ArrayList<String>();
        CheckResult result = new CheckResult();
        try {
            //根校验点用 (null, 名称) 造，理由见 applyFieldMap
            el.check(new CheckPoint(null, str(el.getName())), result, new HashMap<Integer, ExtControlElement>());
        } catch (RuntimeException e) {
            out.add("校验本身抛了异常 " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return out;
        }
        for (CheckMessage msg : result.getMessages()) {
            out.add(msg.getMessage());
        }
        return out;
    }

    /** 写完清缓存后从库里重新读每条规则的建行层级，和这次要写的对一遍。 */
    private static void readBackLink(List<String> ids, Link link) throws Exception {
        ConvertRuleReader reader = new ConvertRuleReader();
        int bad = 0;
        for (String id : ids) {
            ConvertRuleMetadata back = reader.loadMeta(id, false);
            LinkEntityPolicy lep = back == null || back.getRuleElement() == null ? null
                    : back.getRuleElement().getLinkEntityPolicy();
            String s = lep == null ? "" : str(lep.getSourceEntryKey());
            String t = lep == null ? "" : str(lep.getTargetEntryKey());
            boolean ok = s.equalsIgnoreCase(link.source) && t.equalsIgnoreCase(link.target);
            bad += ok ? 0 : 1;
            System.out.println("[PROBE] 回读 id=" + id + "  建行层级 源=" + (s.isEmpty() ? "(空)" : s)
                    + " 目标=" + (t.isEmpty() ? "(空)" : t) + (ok ? "  和要写的一致" : "  !! 和要写的不一致"));
        }
        System.out.println("[PROBE] 回读建行层级：一致 " + (ids.size() - bad) + " 条，不一致 " + bad + " 条");
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    // ---------- 业务规则 ----------

    private static List<String> applyBizRules(ConvertRuleElement el,
            List<CRBizRuleElement> srcActions, String onExist) {
        List<String> notes = new ArrayList<String>();
        BizRulePolicy brp = el.getBizRulePolicy();
        if (brp == null) {
            brp = new BizRulePolicy();
            el.setBizRulePolicy(brp);
            notes.add("BizRulePolicy 原本为空，已新建");
        }
        List<CRBizRuleElement> exist = brp.getActions();
        if (exist == null) {
            exist = new ArrayList<CRBizRuleElement>();
            brp.setActions(exist);
        }
        if (!exist.isEmpty()) {
            if (!"replace".equalsIgnoreCase(onExist)) {
                notes.add("已有业务规则 " + exist.size() + " 条，SYNC_ON_EXIST=skip，不动");
                return notes;
            }
            notes.add("已有业务规则 " + exist.size() + " 条，按 replace 清空重建");
            exist.clear();
        }
        for (CRBizRuleElement s : srcActions) {
            exist.add(copy(s));
        }
        notes.add("业务规则 += " + srcActions.size() + " 条（id 全部重新发放）");
        return notes;
    }

    /**
     * 逐字段抄一份新的。**Id 必须重发**：设计态元素 id 在苍穹里是标识用的，
     * 把源规则的 5Z740UH1M104 原样复制到 28 条规则上，出问题时没法区分是哪条。
     */
    private static CRBizRuleElement copy(CRBizRuleElement s) {
        CRBizRuleElement t = new CRBizRuleElement();
        t.setId(Uuid8.generateShortUuid());
        t.setActionId(s.getActionId());
        t.setRunActionClass(s.getRunActionClass());
        t.setParameters(s.getParameters());
        t.setSeq(s.getSeq());
        t.setEnabled(s.isEnabled());
        t.setIsv(s.getIsv());
        t.setDescription(s.getDescription() == null ? null
                : new LocaleString(s.getDescription().toString()));
        CRCondition sc = s.getPreCondition();
        if (sc != null) {
            CRCondition tc = new CRCondition();
            tc.setId(Uuid8.generateShortUuid());
            tc.setEnabled(sc.isEnabled());
            tc.setSeq(sc.getSeq());
            tc.setIsv(sc.getIsv());
            //前置条件有两种存法：Expression（公式，本例用的这种）和 FilterString（条件行）。
            //只抄一边会把条件抄丢，两边都要。
            tc.setExpression(sc.getExpression());
            tc.setExprTran(sc.getExprTran());
            tc.setFilterString(sc.getFilterString());
            t.setPreCondition(tc);
        }
        return t;
    }

    // ---------- 字段映射 ----------

    /** SYNC_FIELDMAP 里的一项：目标字段 + 取值方式。 */
    static final class Mapping {
        static final String SRC = "src";
        static final String CONST = "const";
        static final String CLEAR = "clear";
        static final String FORMULA = "formula";

        final String target;
        final String kind;
        final String value;

        Mapping(String target, String kind, String value) {
            this.target = target;
            this.kind = kind;
            this.value = value;
        }

        String label() {
            if (SRC.equals(kind)) {
                return "源字段 " + value;
            }
            if (CONST.equals(kind)) {
                return "常量 " + value;
            }
            if (CLEAR.equals(kind)) {
                return "清掉映射";
            }
            return "公式 " + value;
        }
    }

    /**
     * 改一条映射，改完过平台自己的 {@link FieldMapItem#check}。平台的保存接口
     * （ConvertRuleWriter.save）不调这个校验，所以写错的源字段、解析不了的公式不过这一道就会原样落库，
     * 下推时才报错。目标字段不存在时 check 直接返回、不报错，所以那一条在这里先查。
     */
    private static String applyFieldMap(ConvertRuleElement el, Mapping m, MainEntityType st,
            MainEntityType tt, List<String> errors) {
        DynamicProperty target = RowDataModel.findProperty(tt, m.target);
        if (target == null) {
            errors.add("目标单 " + tt.getName() + " 上没有字段 " + m.target);
            return m.target + "：目标字段不存在";
        }
        FieldMapPolicy fmp = el.getFieldMapPolicy();
        if (fmp == null) {
            fmp = new FieldMapPolicy();
            el.setFieldMapPolicy(fmp);
        }
        List<FieldMapItem> maps = fmp.getFieldMaps();
        if (maps == null) {
            maps = new ArrayList<FieldMapItem>();
            fmp.setFieldMaps(maps);
        }
        FieldMapItem item = null;
        for (FieldMapItem fm : maps) {
            if (m.target.equals(fm.getTargetFieldKey())) {
                item = fm;
                break;
            }
        }
        String was;
        if (item == null) {
            if (Mapping.CLEAR.equals(m.kind)) {
                return m.target + " 原本就没有映射，不动";
            }
            item = new FieldMapItem();
            item.setTargetFieldKey(m.target);
            item.setSumType("First");
            maps.add(item);
            was = "(原本没有这条映射)";
        } else {
            was = describe(item);
        }

        CRFormula constant = null;
        if (Mapping.CONST.equals(m.kind)) {
            constant = constantOf(target, m, errors);
            if (constant == null) {
                return m.target + "：" + was + "  ->  " + m.label() + "（不能用）";
            }
        }
        String now;
        if (Mapping.SRC.equals(m.kind)) {
            now = "源字段 " + m.value;
            if (now.equals(was)) {
                return m.target + " 已经是 " + now + "，不动";
            }
            reset(item, "SourceField");
            item.setSourceFieldKey(m.value);
        } else if (Mapping.CLEAR.equals(m.kind)) {
            now = "未映射";
            if (now.equals(was)) {
                return m.target + " 原本就没有映射，不动";
            }
            reset(item, "SourceField");
        } else if (Mapping.CONST.equals(m.kind)) {
            now = "常量 " + constant.getExpression() + "【" + constant.getExprTran() + "】";
            if (now.equals(was)) {
                return m.target + " 已经是 " + now + "，不动";
            }
            reset(item, "CONSTANT");
            item.setConstant(constant);
        } else {
            now = "公式 " + m.value;
            if (now.equals(was)) {
                return m.target + " 已经是 " + now + "，不动";
            }
            CRFormula f = new CRFormula();
            f.setExpression(m.value);
            f.setExprTran(tran(st, m.value));
            reset(item, "Formula");
            item.setFormula(f);
        }

        //必录的目标字段在 check 里按「取值不能为空」查；这张表只放这一个字段
        Map<String, Boolean> mustInput = new HashMap<String, Boolean>();
        mustInput.put(m.target, mustInput(target));
        CheckResult result = new CheckResult();
        //校验点必须用 (null, 名称) 造根：check 里会 new CheckPoint(parent, ...)，子节点构造时读
        //parent.getSeqArray().length；无参构造的 seqArray 是 null，直接空指针（平台自己
        //ConvertRuleElement.check 也是 new CheckPoint(null, 规则名) 起头）
        CheckPoint root = new CheckPoint(null, m.target);
        try {
            item.check(st, tt, el, root, result, mustInput);
        } catch (RuntimeException e) {
            //平台校验自己出错时带上是哪条规则、哪个字段、哪一步，原异常挂在 cause 上
            throw new IllegalStateException("规则 " + el.getId() + " 的字段 " + m.target + "（" + m.label()
                    + "）在平台映射校验 FieldMapItem.check 里出错：" + e, e);
        }
        for (CheckMessage msg : result.getMessages()) {
            errors.add(m.target + "：" + msg.getMessage());
        }
        return m.target + "：" + was + "  ->  " + now;
    }

    /** 换取值方式前把四种取值都清空，只留新的一种；设计器回显的 ConvertType2 由这几项推出来。 */
    private static void reset(FieldMapItem item, String convertType) {
        item.setConvertType(convertType);
        item.setSourceFieldKey("");
        item.setFormula(null);
        item.setConstant(null);
        item.setValByConditions(null);
        item.setValByCondiionsString(null);
    }

    /**
     * 常量只给单选基础资料：设计器的常量取值是选一条基础资料，存的是它的 id，回显是它的名称。
     * 值可以写 id 或编码，查不到就报错，不存一个指向不存在数据的 id。
     */
    private static CRFormula constantOf(DynamicProperty target, Mapping m, List<String> errors) {
        if (target instanceof MulBasedataProp || !(target instanceof BasedataProp)) {
            errors.add(m.target + " 不是单选基础资料字段，没有常量取值；固定的文本、下拉值写公式 '" + m.value + "'");
            return null;
        }
        String base = ((BasedataProp) target).getBaseEntityId();
        DynamicObject row = null;
        if (m.value.matches("\\d{1,18}")) {
            row = QueryServiceHelper.queryOne(base, "id",
                    new QFilter[] { new QFilter("id", "=", Long.valueOf(m.value)) });
        }
        if (row == null) {
            row = QueryServiceHelper.queryOne(base, "id",
                    new QFilter[] { new QFilter("number", "=", m.value) });
        }
        if (row == null) {
            errors.add(m.target + "：基础资料 " + base + " 里找不到 id 或编码「" + m.value + "」");
            return null;
        }
        Object id = row.get("id");
        String name = String.valueOf(id);
        try {
            DynamicObject named = QueryServiceHelper.queryOne(base, "name",
                    new QFilter[] { new QFilter("id", "=", id) });
            if (named != null && named.getString("name") != null) {
                name = named.getString("name");
            }
        } catch (RuntimeException e) {
            //没有 name 属性的基础资料，回显退回 id
        }
        CRFormula f = new CRFormula();
        f.setExpression(String.valueOf(id));
        f.setExprTran(name);
        return f;
    }

    private static boolean mustInput(DynamicProperty p) {
        if (p instanceof FieldProp) {
            return ((FieldProp) p).isMustInput();
        }
        if (p instanceof BasedataProp) {
            return ((BasedataProp) p).isMustInput();
        }
        if (p instanceof MulBasedataProp) {
            return ((MulBasedataProp) p).isMustInput();
        }
        return false;
    }

    private static String describe(FieldMapItem fm) {
        String ct = fm.getConvertType();
        if ("Formula".equals(ct)) {
            return "公式 " + (fm.getFormula() == null ? "?" : fm.getFormula().getExpression());
        }
        if ("CONSTANT".equals(ct)) {
            CRFormula c = fm.getConstant();
            return c == null ? "常量 ?" : "常量 " + c.getExpression() + "【" + c.getExprTran() + "】";
        }
        if ("ByCondition".equals(ct)) {
            return "按条件取值";
        }
        String src = fm.getSourceFieldKey();
        return src == null || src.isEmpty() ? "未映射" : "源字段 " + src;
    }

    /** 「类别 (demo_combofield7)」这种回显串。取不到字段名就退回标识本身。 */
    private static String tran(MainEntityType t, String expr) {
        String key = expr;
        int dot = key.indexOf('.');
        String tail = dot < 0 ? null : key.substring(dot + 1);
        if (dot > 0) {
            key = key.substring(0, dot);
        }
        DynamicProperty p = RowDataModel.findProperty(t, key);
        if (p == null) {
            return expr;
        }
        if (tail == null) {
            return p.getDisplayName() + " (" + key + ")";
        }
        return p.getDisplayName() + "." + tail + " (" + expr + ")";
    }

    private static MainEntityType typeOf(Map<String, MainEntityType> cache, String entity) {
        MainEntityType t = cache.get(entity);
        if (t == null) {
            t = MetaResolve.type(entity);
            cache.put(entity, t);
        }
        return t;
    }

    // ---------- 目标规则选择 ----------

    private static List<Head> selectTargets(String srcId) {
        String ids = env("SYNC_TARGETS", "");
        StringBuilder sql = new StringBuilder(
                "select r.FID, l.FName, r.FSourceEntityNumber, r.FTargetEntityNumber,"
                        + " r.FEnabled, r.FISV from T_BOTP_ConvertRule r"
                        + " left join T_BOTP_ConvertRule_L l on l.FID = r.FID"
                        + " and l.FLocaleId = 'zh_CN' where 1 = 1");
        List<Object> params = new ArrayList<Object>();
        if (!ids.isEmpty()) {
            StringBuilder in = new StringBuilder();
            for (String s : ids.split(",")) {
                if (s.trim().isEmpty()) {
                    continue;
                }
                in.append(in.length() == 0 ? "" : ",").append('?');
                params.add(s.trim());
            }
            sql.append(" and r.FID in (").append(in).append(')');
        } else {
            String se = env("SYNC_SOURCE_ENTITY", "");
            String te = env("SYNC_TARGET_ENTITY", "");
            String like = env("SYNC_NAME_LIKE", "");
            String en = env("SYNC_ENABLED", "*");
            if (!se.isEmpty()) {
                sql.append(" and r.FSourceEntityNumber = ?");
                params.add(se);
            }
            if (!te.isEmpty()) {
                sql.append(" and r.FTargetEntityNumber = ?");
                params.add(te);
            }
            if (!like.isEmpty()) {
                sql.append(" and l.FName like ?");
                params.add("%" + like + "%");
            }
            if (!"*".equals(en)) {
                sql.append(" and r.FEnabled = ?");
                params.add(en);
            }
        }
        sql.append(" order by l.FName");

        List<Head> heads = new ArrayList<Head>();
        DataSet ds = DB.queryDataSet("BotpRuleSyncProbe", DBRoute.meta, sql.toString(),
                params.toArray());
        try {
            for (Row r : ds) {
                Head h = new Head();
                h.id = r.getString("FID");
                h.name = r.getString("FName");
                h.source = r.getString("FSourceEntityNumber");
                h.target = r.getString("FTargetEntityNumber");
                h.enabled = String.valueOf(r.get("FEnabled"));
                h.isv = r.getString("FISV");
                //源规则自己永远排除，否则等于拿自己覆盖自己
                if (!h.id.equals(srcId)) {
                    heads.add(h);
                }
            }
        } finally {
            ds.close();
        }
        return heads;
    }

    private static List<CRBizRuleElement> loadActions(String ruleId) throws Exception {
        ConvertRuleMetadata meta = new ConvertRuleReader().loadMeta(ruleId, false);
        if (meta == null || meta.getRuleElement() == null) {
            return new ArrayList<CRBizRuleElement>();
        }
        BizRulePolicy brp = meta.getRuleElement().getBizRulePolicy();
        List<CRBizRuleElement> l = brp == null ? null : brp.getActions();
        return l == null ? new ArrayList<CRBizRuleElement>() : l;
    }

    // ---------- 回滚 ----------

    /**
     * FDATA 与 buildXml() 的输出实测**完全相同**，所以把备份 XML 原样写回 FDATA 即还原。
     * 走不了 ConvertRuleWriter —— 它只吃 ConvertRuleMetadata 对象，没有 XML 反序列化入口。
     */
    /**
     * 只导不改：按同一套筛选条件把每条规则的设计态 XML 存成 &lt;id&gt;.xml。
     *
     * 单独一个模式，是因为同步流程里的备份挂在 APPLY 分支上（备份必须是「save 之前那一刻」
     * 的原文）。想先存个档再动手时那条路走不了 —— 不给动作它会说「无事可做」。
     * 这里不需要 APPLY=1：它一行库都不写。
     */
    private static void backupOnly(String dir) throws Exception {
        if (dir.isEmpty()) {
            System.out.println("[PROBE] SYNC_BACKUP_ONLY=1 必须同时给 SYNC_BACKUP=<目录>");
            return;
        }
        List<Head> targets = selectTargets("");
        if (targets.isEmpty()) {
            System.out.println("[PROBE] 没选中任何规则，什么都没写");
            return;
        }
        ConvertRuleReader reader = new ConvertRuleReader();
        int ok = 0;
        for (Head h : targets) {
            String xml = reader.buildXml(h.id, false, false);
            if (xml == null || xml.isEmpty()) {
                System.out.println("[PROBE] 跳过（内容为空）: " + h.name + "  id=" + h.id);
                continue;
            }
            writeFile(new File(dir, h.id + ".xml"), xml);
            System.out.println("[PROBE] " + h.name + "  id=" + h.id + "  " + xml.length() + " chars");
            ok++;
        }
        System.out.println("[PROBE] 已备份 " + ok + " 条到 " + new File(dir).getAbsolutePath()
                + "；一行库都没写");
        System.out.println("[PROBE] 改完再导一份到别的目录，然后 meta botp diff <A> <B>");
    }

    private static void restore(String dir, boolean apply) throws Exception {
        File[] files = new File(dir).listFiles();
        if (files == null) {
            System.out.println("[PROBE] 目录不存在 " + dir);
            return;
        }
        List<String> ids = new ArrayList<String>();
        Map<String, String> candidates = new LinkedHashMap<String, String>();
        for (File f : files) {
            String n = f.getName();
            if (!n.endsWith(".xml") || n.contains(".before.") || n.contains(".after.")) {
                continue;
            }
            String id = n.substring(0, n.length() - 4);
            String xml = readFile(f);
            DataSet ds = DB.queryDataSet("BotpRestoreGuard", DBRoute.meta,
                    "select FISV, FSourceEntityNumber, FTargetEntityNumber from T_BOTP_ConvertRule where FID = ?",
                    new Object[] { id });
            boolean found = false;
            try {
                for (Row row : ds) {
                    found = true;
                    IsvGuard.assertOwnBotpRule(id, row.getString("FISV"),
                            row.getString("FSourceEntityNumber"), row.getString("FTargetEntityNumber"));
                }
            } finally {
                ds.close();
            }
            if (!found) throw new IllegalArgumentException("转换规则不存在：" + id);
            candidates.put(id, xml);
            System.out.println("[PROBE] 还原 " + id + "  XML 长度=" + xml.length());
        }
        if (candidates.isEmpty()) throw new IllegalArgumentException("没有可还原的规则 XML：" + dir);
        if (!apply) {
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run：没有写回。要真还原加 APPLY=1");
            return;
        }
        // 全部目标通过归属和授权范围检查之后，才允许第一笔写入。
        for (Map.Entry<String, String> candidate : candidates.entrySet()) {
            String id = candidate.getKey();
            String xml = candidate.getValue();
            int n2 = DB.update(DBRoute.meta,
                    "update T_BOTP_ConvertRule set FDATA = ? where FID = ?",
                    new Object[] { xml, id });
            System.out.println("[PROBE]   update 影响 " + n2 + " 行");
            ids.add(id);
        }
        ConvertRuleWriter.clearCache(ids.toArray(new String[0]));
        System.out.println("[PROBE] 已还原 " + ids.size() + " 条并清缓存");
    }

    // ---------- 小工具 ----------

    /**
     * `目标字段=取值;…`。写不成「标识=取值」的一项、空取值、同一个目标字段给两次，都在读库之前拒掉：
     * 静默丢掉一项，确认单上列的和真写进去的就对不上了。
     */
    static List<Mapping> parseFieldMap(String s) {
        List<Mapping> out = new ArrayList<Mapping>();
        Map<String, Boolean> seen = new HashMap<String, Boolean>();
        for (String pair : s.split(";")) {
            if (pair.trim().isEmpty()) {
                continue;
            }
            int eq = pair.indexOf('=');
            String target = eq < 0 ? "" : pair.substring(0, eq).trim();
            String raw = eq < 0 ? "" : pair.substring(eq + 1).trim();
            if (target.isEmpty() || !target.matches("[A-Za-z0-9_]+")) {
                throw new IllegalArgumentException("SYNC_FIELDMAP 的「" + pair.trim()
                        + "」要写成 目标字段=取值（取值：src:源字段 / const:基础资料id或编码 / clear / 公式）");
            }
            if (seen.put(target.toLowerCase(), Boolean.TRUE) != null) {
                throw new IllegalArgumentException("SYNC_FIELDMAP 里目标字段 " + target + " 给了两次");
            }
            String kind;
            String value;
            if (Mapping.CLEAR.equalsIgnoreCase(raw)) {
                kind = Mapping.CLEAR;
                value = "";
            } else if (raw.startsWith(Mapping.SRC + ":")) {
                kind = Mapping.SRC;
                value = raw.substring(Mapping.SRC.length() + 1).trim();
            } else if (raw.startsWith(Mapping.CONST + ":")) {
                kind = Mapping.CONST;
                value = raw.substring(Mapping.CONST.length() + 1).trim();
            } else if (raw.startsWith(Mapping.FORMULA + ":")) {
                kind = Mapping.FORMULA;
                value = raw.substring(Mapping.FORMULA.length() + 1).trim();
            } else {
                kind = Mapping.FORMULA;
                value = raw;
            }
            if (value.isEmpty() && !Mapping.CLEAR.equals(kind)) {
                throw new IllegalArgumentException("SYNC_FIELDMAP 里 " + target + " 的取值是空的；要清掉映射写 "
                        + target + "=clear");
            }
            out.add(new Mapping(target, kind, value));
        }
        return out;
    }

    private static void writeFile(File f, String s) throws Exception {
        if (f.getParentFile() != null) {
            f.getParentFile().mkdirs();
        }
        Writer w = new OutputStreamWriter(new FileOutputStream(f), "UTF-8");
        try {
            w.write(s);
        } finally {
            w.close();
        }
    }

    private static String readFile(File f) throws Exception {
        Reader r = new InputStreamReader(new FileInputStream(f), "UTF-8");
        try {
            StringBuilder sb = new StringBuilder();
            char[] buf = new char[8192];
            int n;
            while ((n = r.read(buf)) > 0) {
                sb.append(buf, 0, n);
            }
            return sb.toString();
        } finally {
            r.close();
        }
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }

    private static class Head {
        String id;
        String name;
        String source;
        String target;
        String enabled;
        String isv;
    }
}
