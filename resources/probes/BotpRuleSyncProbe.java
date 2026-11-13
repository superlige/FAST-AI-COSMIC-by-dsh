import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.algo.DataSet;
import kd.bos.algo.Row;
import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.utils.Uuid8;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.botp.BizRulePolicy;
import kd.bos.entity.botp.CRBizRuleElement;
import kd.bos.entity.botp.CRCondition;
import kd.bos.entity.botp.CRFormula;
import kd.bos.entity.botp.ConvertRuleElement;
import kd.bos.entity.botp.FieldMapItem;
import kd.bos.entity.botp.FieldMapPolicy;
import kd.bos.metadata.botp.ConvertRuleMetadata;
import kd.bos.metadata.botp.ConvertRuleReader;
import kd.bos.metadata.botp.ConvertRuleWriter;

/**
 * 写探针：把一条 BOTP 转换规则上的**业务规则**复制到另一批规则，并把指定的**字段映射**
 * 统一改成公式取值。默认 dry-run，必须 APPLY=1 才落库。
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
 *   SYNC_FIELDMAP=目标字段=公式;…    把该目标字段的映射改成 ConvertType=Formula，取值为公式
 *                                   例：demo_hjlb=demo_combofield7;demo_zdkd_ls=demo_mulbasedatafield
 *   SYNC_ON_EXIST=skip|replace      目标规则已有业务规则时怎么办，默认 skip
 *
 * 安全：
 *   SYNC_BACKUP=目录                APPLY 前把每条目标规则的 XML 原文存进去，APPLY=1 时必给
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
        Map<String, String> fieldMap = parseFieldMap(env("SYNC_FIELDMAP", ""));
        String onExist = env("SYNC_ON_EXIST", "skip");
        String backupDir = env("SYNC_BACKUP", "");

        if (srcId.isEmpty() && fieldMap.isEmpty()) {
            System.out.println("[PROBE] SYNC_SRC 和 SYNC_FIELDMAP 都没给，无事可做");
            return;
        }
        if (apply && backupDir.isEmpty()) {
            System.out.println("[PROBE] !! APPLY=1 必须同时给 SYNC_BACKUP=<目录>，中止");
            return;
        }

        System.out.println("[PROBE] 模式=" + (apply ? "APPLY 真写" : "dry-run 只演算")
                + "  业务规则来源=" + (srcId.isEmpty() ? "(不复制)" : srcId)
                + "  字段映射改动 " + fieldMap.size() + " 项");

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

        //公式的 ExprTran 是「字段名 (标识)」，字段名要从源单实体上取 —— 硬编码会和设计器不一致
        Map<String, String> exprTran = new LinkedHashMap<String, String>();
        if (!fieldMap.isEmpty()) {
            MainEntityType st = MetaResolve.type(targets.get(0).source);
            for (Map.Entry<String, String> e : fieldMap.entrySet()) {
                exprTran.put(e.getKey(), tran(st, e.getValue()));
                System.out.println("[PROBE] 映射 " + e.getKey() + " <= 公式 " + e.getValue()
                        + "  【" + exprTran.get(e.getKey()) + "】");
            }
        }

        ConvertRuleReader reader = new ConvertRuleReader();
        List<String> changed = new ArrayList<String>();
        for (Head h : targets) {
            ConvertRuleMetadata meta = reader.loadMeta(h.id, false);
            if (meta == null || meta.getRuleElement() == null) {
                System.out.println("[PROBE] !! " + h.name + " 规则内容为空，跳过");
                continue;
            }
            ConvertRuleElement el = meta.getRuleElement();
            List<String> notes = new ArrayList<String>();

            if (!srcActions.isEmpty()) {
                notes.addAll(applyBizRules(el, srcActions, onExist));
            }
            for (Map.Entry<String, String> e : fieldMap.entrySet()) {
                notes.add(applyFieldMap(el, e.getKey(), e.getValue(), exprTran.get(e.getKey())));
            }

            System.out.println("[PROBE] ---- " + h.name + "  id=" + h.id);
            for (String n : notes) {
                System.out.println("[PROBE]      " + n);
            }

            if (!apply) {
                continue;
            }
            //备份必须在 save 之前，且是从库里读的原文（不是内存里已改过的对象）
            String before = reader.buildXml(h.id, false, false);
            writeFile(new File(backupDir, h.id + ".xml"), before);

            Map<?, ?> r = ConvertRuleWriter.save(meta);
            System.out.println("[PROBE]      save -> " + r);
            if (!Boolean.TRUE.equals(r.get("success"))) {
                System.out.println("[PROBE] !! 保存失败，中止后续规则");
                return;
            }
            changed.add(h.id);
        }

        if (!apply) {
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，什么都没写。确认无误后加 APPLY=1 和 SYNC_BACKUP=<目录>");
            return;
        }
        ConvertRuleWriter.clearCache(changed.toArray(new String[0]));
        System.out.println("[PROBE] 已写入 " + changed.size() + " 条并清缓存；备份在 " + backupDir);
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

    private static String applyFieldMap(ConvertRuleElement el, String targetKey, String expr,
            String tran) {
        FieldMapPolicy fmp = el.getFieldMapPolicy();
        if (fmp == null) {
            return "!! 没有 FieldMapPolicy，" + targetKey + " 改不了";
        }
        List<FieldMapItem> maps = fmp.getFieldMaps();
        if (maps == null) {
            maps = new ArrayList<FieldMapItem>();
            fmp.setFieldMaps(maps);
        }
        FieldMapItem item = null;
        for (FieldMapItem fm : maps) {
            if (targetKey.equals(fm.getTargetFieldKey())) {
                item = fm;
                break;
            }
        }
        String was;
        if (item == null) {
            item = new FieldMapItem();
            item.setTargetFieldKey(targetKey);
            item.setSumType("First");
            maps.add(item);
            was = "(原本没有这条映射)";
        } else {
            was = describe(item);
            if ("Formula".equals(item.getConvertType()) && item.getFormula() != null
                    && expr.equals(item.getFormula().getExpression())) {
                return targetKey + " 已经是 公式 " + expr + "，不动";
            }
        }
        CRFormula f = new CRFormula();
        f.setExpression(expr);
        f.setExprTran(tran);
        item.setConvertType("Formula");
        //ConvertType2 是设计器界面回显用的「类型,取值」串，不同步改的话界面上看着还是老样子
        item.setConvertType2("Formula," + expr);
        item.setFormula(f);
        item.setSourceFieldKey("");
        return targetKey + "：" + was + "  ->  公式 " + expr;
    }

    private static String describe(FieldMapItem fm) {
        String ct = fm.getConvertType();
        if ("Formula".equals(ct)) {
            return "公式 " + (fm.getFormula() == null ? "?" : fm.getFormula().getExpression());
        }
        if ("Constant".equals(ct)) {
            return "常量";
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
        IDataEntityProperty p = t.findProperty(key);
        if (p == null) {
            return expr;
        }
        if (tail == null) {
            return p.getDisplayName() + " (" + key + ")";
        }
        return p.getDisplayName() + "." + tail + " (" + expr + ")";
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

    private static Map<String, String> parseFieldMap(String s) {
        Map<String, String> m = new LinkedHashMap<String, String>();
        for (String pair : s.split(";")) {
            if (pair.trim().isEmpty()) {
                continue;
            }
            String[] kv = pair.split("=", 2);
            if (kv.length == 2) {
                m.put(kv[0].trim(), kv[1].trim());
            }
        }
        return m;
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
