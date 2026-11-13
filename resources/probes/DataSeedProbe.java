import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import kd.bos.context.RequestContext;
import kd.bos.dataentity.OperateOption;
import kd.bos.algo.DataSet;
import kd.bos.data.BusinessDataReader;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.tx.TX;
import kd.bos.db.tx.TXHandle;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.botp.CRCondition;
import kd.bos.entity.botp.ConvertRuleElement;
import kd.bos.entity.botp.FilterPolicy;
import kd.bos.entity.botp.runtime.ConvertOperationResult;
import kd.bos.entity.botp.runtime.PushArgs;
import kd.bos.entity.botp.runtime.SourceBillReport;
import kd.bos.entity.datamodel.ListSelectedRow;
import kd.bos.entity.filter.FilterBuilder;
import kd.bos.entity.filter.FilterValue;
import kd.bos.entity.filter.SimpleFilterRow;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.BooleanProp;
import kd.bos.entity.property.EntryProp;
import kd.bos.entity.property.FieldProp;
import kd.bos.entity.property.LinkEntryProp;
import kd.bos.entity.property.SubEntryProp;
import kd.bos.mvc.form.FormView;
import kd.bos.orm.ORM;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.botp.BFTrackerServiceHelper;
import kd.bos.servicehelper.botp.ConvertMetaServiceHelper;
import kd.bos.servicehelper.botp.ConvertServiceHelper;
import kd.bos.servicehelper.operation.OperationServiceHelper;

/**
 * 造测试数据：在共享环境里新建几条单据，走平台自己的保存/提交/审核操作链，默认直接落库（按平台自己的事务逐条提交），PREVIEW=1 只预演。
 *
 * 为什么要它：临时探针只准读，而有些逻辑必须先有数据才验得了——列表、报表、后台任务、别的进程、
 * 用户自己打开界面看效果，都看不见回滚事务里的数据。这个探针是模型唯一能往共享环境写业务数据的地方，
 * S27 起（用户 2026-09-19 定：连的必然是纯测试环境）加 APPLY=1 直接落库，不用确认，走常驻进程；
 * 预演（PREVIEW=1）可选，想先看操作链跑不跑得通时用。
 * 改已有数据用 DataUpdateProbe，不用它。
 *
 * 能做的边界（写死在代码里，没有开关）：
 *   - 只**新建**，不接受 pk，不改、不删已有数据；
 *   - 不限 ISV（2026-09-15 用户决定：测试环境，只写数据不改元数据），写入目标是 `data:<单据标识>`（IsvGuard.assertDataTarget）；
 *   - 走 OperationServiceHelper.executeOperate，校验器和操作插件照常跑，不用 SaveServiceHelper / 裸 SQL 绕过它们；
 *     照现成复制的单是在表单上开的，第一步在那张表单上点（view.invokeOperation），和界面上一样先过表单插件；
 *   - 一次最多 50 条；落库按平台自己的事务逐条提交（和界面上保存一样），任何一条、任何一步没跑通就停，
 *     前面已提交的留在库里、逐条列出（S37 批 8 前整批包在一个事务里，事务后再存一次的插件会重复插入）。
 *
 * 预演（PREVIEW=1）：同样的操作链在回滚事务里完整跑一遍，所以「能不能存进去、审核过不过得了」预演就知道。
 * TX 只回滚数据库：编码规则流水号、缓存、消息、外部接口不回滚（测试环境已放开，Harness 只在提醒里说一句），预演固定走冷进程。
 *
 * 落库后数据**留在共享环境**（2026-09-15 用户决定可以留），本探针不清理；造了哪几条（pk、单据编号）
 * 逐条打出来，回执里也会列出。
 *
 * SEED_ENTITY=单据标识（必填，单据或基础资料，原厂的也行）
 * SEED_SET=字段=值;字段=值  只造一条时用，写法同 cosmic_run op 的 --set（分录 `分录[0].字段`，基础资料给 id 或编码）
 * SEED_OPS=save,submit,audit  操作链，逗号分隔、按顺序执行，默认 save
 * SEED_COPY=单据编号或 pk  照同一张单据（或基础资料）上的这张现成数据复制一张再走操作链：和界面上点「复制」一样，按字段的「是否复制」带值，不复制的填默认值，下推关联不带；必填和取值都照现成的，SEED_SET 只写这次要不同的字段；第一步操作在复制出来的表单上点，表单插件照跑（编码规则在这一步给号）
 * SEED_FROM=源单标识:单据编号,单据编号  从这几张上游单按转换规则下推出来再走操作链（和界面上下推一样，带下推关系），推出几条就造几条，每条都套 SEED_SET；只写源单标识、不写编号时，按规则的源单条件挑最近一张推得出来的，推不出来跳过的逐张说原因
 * SEED_RULE=规则 id 或名称片段  指定用哪条转换规则；不给时只有一条就用它，多条时 SEED_FROM 写了编号就挑这几张源单满足条件、推得出来的那条（用的是哪条会说）
 * SEED_ROWS=造多条时用，逐行写：`[row] 标签` 起一条，下面跟 `set=…`，可选 `ops=…` 覆盖 SEED_OPS、`copy=…` 换一张照着复制的；给了它就忽略 SEED_SET
 * PREVIEW=1  只预演：回滚事务里跑一遍、不落库，要起冷进程（约 40 秒起）；不给就直接落库（测试环境，不用确认；APPLY=1 同样落库）
 *
 * 默认落库、PREVIEW=1 才预演是 S37 批 8（2026-09-28）改的：以前不带 APPLY 就是预演，模型每次先预演再落库，
 * 而预演是回滚事务，事务后才跑的插件在里面看不准、存不进去照样在落库时报出来，却每次多一个冷进程（09-28 复测 7 次预演约 6 分钟）。
 * Harness 把没给 PREVIEW 的换算成 APPLY=1。
 */
public class DataSeedProbe {

    /** 一次最多造几条。测试数据留在共享环境里，没有上限就等于没有边界。 */
    static final int MAX_ROWS = 50;

    private static final class Row {
        String label;
        String set = "";
        List<String> ops = new ArrayList<String>();
        /** 照着复制的现成数据（单据编号或 pk），空的就从空单造。 */
        String copy = "";
        DynamicObject obj;
        /** 照现成复制时开着的表单：第一步操作在它上面点。 */
        FormView view;
        /** 第一步操作生成的 pk，回读按它找。 */
        Object pk;
    }

    public static void run() throws Exception {
        boolean apply = "1".equals(System.getenv("APPLY")) && !"1".equals(System.getenv("PREVIEW"));
        String entity = req("SEED_ENTITY");
        List<String> defaultOps = ops(env("SEED_OPS", "save"));
        List<Row> rows = parseRows(defaultOps);

        System.out.println("[PROBE] 模式=" + (apply ? "APPLY 真落库" : "dry-run 回滚事务里预演，不落库"));
        System.out.println("[PROBE] 单据 " + entity + "  共 " + rows.size() + " 条");

        IsvGuard.assertDataTarget(entity);

        //先把每条的对象都造好、字段都设上，一条设不上就整批不跑：跑到一半才发现第 7 条的基础资料取不到，
        //前 6 条已经进了事务，只能整批回滚，白花一轮
        MainEntityType met = MetaResolve.type(entity);
        //确认单要的是「给人看的名字 + 设上去的值」，由探针报，不让模型转述（S23）
        ProbeJson.emit("data-entity", "entity", entity, "name", String.valueOf(met.getDisplayName()));
        //字段名写错的整批不跑，连对象都不造：设上一半再保存，败在校验器上时已经过去一两分钟
        List<String> wrong = new ArrayList<String>();
        for (Row row : rows) {
            for (String[] w : OpSandbox.wrongPaths(met, row.set)) {
                wrong.add(row.label + "：" + w[0] + " —— " + w[1]);
            }
        }
        if (!wrong.isEmpty()) {
            for (String w : wrong) {
                System.out.println("[PROBE] ✗ " + w);
            }
            throw new IllegalArgumentException("SEED_* 里有 " + wrong.size() + " 处字段写错（见上方 ✗ 行），整批没有保存");
        }
        String from = env("SEED_FROM", "").trim();
        if (!from.isEmpty()) {
            if (!env("SEED_ROWS", "").isEmpty()) {
                throw new IllegalArgumentException("SEED_FROM 和 SEED_ROWS 不能一起给：下推出几条就造几条，每条都套 SEED_SET");
            }
            if (!rows.get(0).copy.isEmpty()) {
                throw new IllegalArgumentException("SEED_FROM 和 SEED_COPY 不能一起给：下推出来的单由转换规则填值，不再照别的单复制");
            }
            rows = pushRows(entity, met, from, env("SEED_RULE", "").trim(), rows.get(0));
        }
        List<String> problems = new ArrayList<String>();
        for (Row row : rows) {
            System.out.println("[PROBE] --- 第 " + row.label + " 条：操作链 " + String.join(" → ", row.ops) + " ---");
            DynamicObject target = row.obj;
            boolean later = target == null && !row.copy.isEmpty() && row != rows.get(0);
            if (later) {
                //第二条起照现成复制的，前一条跑完才复制（见 copyNow）。这里先在一张空单上试设字段，基础资料取不到就整批不跑
                target = BusinessDataServiceHelper.newDynamicObject(entity);
            } else if (target == null && !row.copy.isEmpty()) {
                row.view = copied(entity, met, row.copy);
                row.obj = target = row.view.getModel().getDataEntity(true);
            } else if (target == null) {
                row.obj = BusinessDataServiceHelper.newDynamicObject(entity);
                defaults(met, row.obj);
                target = row.obj;
            }
            if (!row.copy.isEmpty()) {
                ProbeJson.emit("seed-copy", "label", row.label, "template", row.copy);
            }
            List<String> unresolved = later ? quietSets(met, target, row.set) : OpSandbox.applySets(met, row.obj, row.set);
            if (!unresolved.isEmpty()) {
                problems.add(row.label + "：基础资料没取到 " + String.join("、", unresolved));
            }
            for (String[] pair : ExpectSpec.pairs(row.set)) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(pair[0]);
                ProbeJson.emit("seed-field", "label", row.label, "field", pair[0],
                        "name", DataUpdateProbe.fieldName(met, pos), "value", DataUpdateProbe.shown(target, pos, pair[1]));
            }
        }
        if (!problems.isEmpty()) {
            for (String p : problems) {
                System.out.println("[PROBE] !! " + p);
            }
            throw new IllegalStateException("有 " + problems.size() + " 条数据的字段设不上，整批不跑");
        }

        String numBefore = OpSandbox.peekCodeRule(entity, rows.get(0).obj);
        int before = count(entity, null);
        System.out.println("[PROBE] 跑之前行数=" + before);

        boolean allOk;
        long t0 = System.currentTimeMillis();
        if (apply) {
            //落库走平台自己的事务，一条一条提交，和界面上保存、cosmic_run op 一样（S37 批 8，2026-09-28）。
            //以前整批包在 TX.beginNew 里：外层没提交，平台保存完不把单据标成已入库，操作插件在事务后再存一次
            //就重复插入（真机 zlgd_sys_test_bill：EntrustStatusChangeOpPlugin 按对照表改创建人后
            //用 SaveServiceHelper 再存一次，Duplicate entry … PRIMARY；界面上保存、下推后保存都是好的）。
            //代价：没跑通时前面已提交的几条留在库里，下面回读逐条列出，回执照样记
            allOk = runRows(entity, met, rows);
        } else {
            //预演：整批一个回滚事务，跑完什么都不留；事务后才跑的插件逻辑在这里看不准（见上）
            try (TXHandle tx = TX.beginNew()) {
                tx.markRollback();
                allOk = runRows(entity, met, rows);
            }
        }
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - t0) + "ms");

        String numAfter = OpSandbox.peekCodeRule(entity, rows.get(0).obj);
        if (numBefore != null && numAfter != null && !numBefore.equals(numAfter)) {
            System.out.println("[PROBE] ⚠ 编码规则流水号 " + numBefore + " → " + numAfter + "：号被消耗了，且不随事务回退");
        }

        if (!apply) {
            if (!allOk) {
                System.out.println("[PROBE] !! 预演没跑通，已回滚，库里没有留下这批数据（原因看上面每条的结果和异常）");
                throw new IllegalStateException("操作链没跑通");
            }
            int after = count(entity, null);
            System.out.println("[PROBE] 跑之后行数=" + after
                    + (after == before ? "  （无痕）" : "  ⚠ 变了！事务没兜住"));
            if (after != before) {
                throw new IllegalStateException("预演的回滚事务没兜住：行数 " + before + " → " + after);
            }
            System.out.println("[PROBE] dry-run 结束，未写入（" + rows.size() + " 条都在回滚事务里跑通了操作链）。"
                    + "要落库就去掉 PREVIEW=1 再跑（测试环境，不用确认）");
            return;
        }

        //回读：提交成功不等于库里真有。按 pk 逐条数一遍；没跑通也要读——前面已经提交的几条真在库里
        int found = 0;
        for (Row row : rows) {
            Object pk = row.pk != null ? row.pk : row.obj == null ? null : row.obj.getPkValue();
            if (pk == null || "0".equals(String.valueOf(pk))) {
                continue;
            }
            boolean there = count(entity, new QFilter[]{new QFilter("id", "=", pk)}) == 1;
            if (there) {
                found++;
            }
            String no = numberOf(row.obj);
            System.out.println("[PROBE] " + (there ? "已造 " : "没落库 ") + row.label + "：pk=" + pk
                    + (no == null ? "" : "  编号=" + no) + (there || !allOk ? "" : "  ⚠ 回读没找到")
                    + (there && !from.isEmpty() ? "  下推关系=" + BFTrackerServiceHelper.findSourceBills(entity,
                            new Long[]{Long.valueOf(String.valueOf(pk))}) : ""));
            ProbeJson.emit("seed-row", "entity", entity, "label", row.label,
                    "pk", String.valueOf(pk), "number", no, "found", there);
        }
        if (!allOk) {
            System.out.println("[PROBE] !! 操作链没跑通" + (found > 0
                    ? "，前面已提交的 " + found + " 条留在库里（见上面「已造」行），不自动清理"
                    : "，库里没有留下这批数据") + "（原因看上面每条的结果和异常）");
            throw new IllegalStateException("操作链没跑通");
        }
        if (found != rows.size()) {
            System.out.println("[PROBE] !! 提交了但回读只找到 " + found + "/" + rows.size() + " 条，按没写成处理，去库里核对");
            throw new IllegalStateException("回读条数不对：" + found + "/" + rows.size());
        }
        System.out.println("[PROBE] 测试数据已落库 " + found + " 条，回读都在库里。数据留在共享环境，不自动清理。");
    }

    /**
     * 表头简单字段填上元数据里的默认值（单据状态默认暂存这类），再由 SEED_SET 覆盖。
     *
     * newDynamicObject 不带默认值——界面上新建时默认值是表单模型填的。S37 批 8（2026-09-28）以前造出来的单
     * 单据状态是空的：删除校验只认暂存，删不掉；09-28 复测模型造完委托单又用改数据探针 direct 补单据状态（52 秒）。
     * 基础资料、分录不填：默认值写法各异，填错比不填麻烦。
     */
    static void defaults(MainEntityType met, DynamicObject obj) {
        List<String> applied = new ArrayList<String>();
        for (Object o : met.getProperties()) {
            if (!(o instanceof kd.bos.entity.property.FieldProp)
                    || o instanceof kd.bos.dataentity.metadata.IComplexProperty
                    || o instanceof kd.bos.dataentity.metadata.ICollectionProperty) {
                continue;
            }
            kd.bos.entity.property.FieldProp p = (kd.bos.entity.property.FieldProp) o;
            Object def = p.getDefValue();
            if (blank(def)) {
                continue;
            }
            Object now = obj.get(p.getName());
            if (!blank(now)) {
                continue;
            }
            try {
                obj.set(p.getName(), def);
                applied.add(p.getName() + "=" + def);
            } catch (RuntimeException e) {
                //类型对不上就不填，交给保存时的校验器说
            }
        }
        if (!applied.isEmpty()) {
            System.out.println("[PROBE]   按元数据默认值先填：" + String.join("、", applied));
        }
    }

    /**
     * 空值、空白文字都算空。多语言文本（LocaleString）在当前语言下没有值时 toString() 返回 null，
     * String.valueOf 原样交回 null，不能直接 trim（组织 bos_org 上就有这样的默认值，2026-10-19 真机）。
     */
    static boolean blank(Object v) {
        if (v == null) {
            return true;
        }
        String s = v.toString();
        return s == null || s.trim().isEmpty();
    }

    /**
     * SEED_COPY：照一张现成数据复制一张还没保存的新单，后面照常套 SEED_SET、走操作链（S48）。
     *
     * 走平台自己的复制，不自己挑字段：无头开这张单据，新增状态带上源单 pk 和 iscopy，BillController.loadData
     * 就走 BillModel.copy——按字段的「是否复制」带值（主键、系统字段、不可复制的不带，改填默认值，
     * 默认值是当前日期、当前用户这类也由数据模型算），下推关联分录不带，表单插件收到 afterCopyData。
     * 和列表上选一张单点「复制」是同一条路（kd.bos.form.operate.Copy）。
     *
     * 为什么要它：从空单造，必填（含按组织才必填的）和插件里的校验只能存一次败一次、露一个，
     * 败了再去别的单上抄取值（37 份真机会话造单 34 次、败 16 次）；现成数据已经过了这些校验，复制过来就齐了。
     */
    private static FormView copied(String entity, MainEntityType met, String template) {
        String pk = templatePk(entity, met, template);
        //前一条已经跑完（第二条起轮到才复制），它的页面缓存不用留：编码规则插件记的标记按新单 pk 记，新单 pk 都一样，留着会串到这张上
        FormSim.resetState();
        //不列插件、不报挂界面监听那几步，只报布局转没转、loadData 通没通：这里要的是复制出来的数据
        FormSim.QUIET = true;
        try {
            FormSim.resolveTarget(entity);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("照现成数据复制要开 " + entity + " 的同名表单，开不了：" + e.getMessage());
        }
        //苍穹要求会话 id，缺了开表单取会话的地方会 NPE
        RequestContext.get().setGlobalSessionId("dataseed-" + UUID.randomUUID().toString().replace("-", ""));
        FormView view = FormSim.open(FormSim.openCopy(FormSim.FORM, pk, ""), "", new ArrayList<FormView>());
        if (!FormSim.LOADED) {
            throw new IllegalStateException("照 " + template + " 复制没成功（原因见上面 loadData 那几行），整批没有保存");
        }
        DynamicObject obj = view.getModel().getDataEntity(true);
        System.out.println("[PROBE]   照 " + template + "（pk=" + pk + "）复制：" + copiedSummary(met, obj));
        //不只必录的：平台设成不复制的字段，下游转换、插件照样可能要读（真机：原始记录模板类型没带过来，下推报「未定义的模板类型:null」）
        List<Object[]> fields = compared(met);
        Long src = Long.valueOf(pk);
        List<String> lost = missing(fields, filled(fields, obj),
                Collections.singletonList(filled(met, fields, Collections.singletonList(src)).get(src)));
        if (!lost.isEmpty()) {
            System.out.println("[PROBE]   原单有值、复制出来空着的字段（平台设成不复制，要用就 SEED_SET 补上）：" + String.join("、", lost));
        }
        return view;
    }

    /** 比有没有值时不算的：主键、状态和建单、改单、审核的人和时间，都由平台填。 */
    private static final Set<String> SYS_FIELDS = new HashSet<String>(java.util.Arrays.asList("id", "seq", "billstatus",
            "creator", "modifier", "auditor", "createtime", "modifytime", "auditdate", "masterid"));

    /**
     * 比有没有值的字段，每项 {键, 名称, 分录（表头为 null）, 字段, 是不是基础资料}。键：表头写字段标识，分录写「分录.字段」。
     * 只比存在表里的单值字段：多选基础资料、勾选框（没勾也是值）、平台自己填的不比。
     */
    private static List<Object[]> compared(MainEntityType met) {
        List<Object[]> out = new ArrayList<Object[]>();
        String no = MetaResolve.billNoField(met);
        for (IDataEntityProperty p : met.getProperties()) {
            if (p instanceof EntryProp) {
                if (p instanceof LinkEntryProp || p instanceof SubEntryProp) {
                    continue;
                }
                for (IDataEntityProperty f : ((EntryProp) p).getItemType().getProperties()) {
                    if (comparable(f, null)) {
                        out.add(new Object[]{p.getName() + "." + f.getName(), label(f), p.getName(), f.getName(),
                                f instanceof BasedataProp});
                    }
                }
            } else if (comparable(p, no)) {
                out.add(new Object[]{p.getName(), label(p), null, p.getName(), p instanceof BasedataProp});
            }
        }
        return out;
    }

    private static boolean comparable(IDataEntityProperty p, String no) {
        String n = p.getName();
        return (p instanceof FieldProp || p instanceof BasedataProp) && !(p instanceof BooleanProp)
                && p.getAlias() != null && !p.getAlias().trim().isEmpty()
                && !SYS_FIELDS.contains(n) && !n.equals(no)
                && !(p instanceof FieldProp && ((FieldProp) p).isSysField())
                //基础资料的 xxx_id 跟着 xxx 走，只比 xxx
                && !(n.endsWith("_id") && p.getParent() != null && p.getParent().getProperties().containsKey(n.substring(0, n.length() - 3)));
    }

    /** 这个还没保存的对象上有值的字段（键见 compared）。分录里有一行有值就算有值。 */
    private static Set<String> filled(List<Object[]> fields, DynamicObject obj) {
        Set<String> out = new HashSet<String>();
        for (Object[] f : fields) {
            String entry = (String) f[2];
            String field = (String) f[3];
            if (entry == null) {
                if (!blank(value(obj, field), (Boolean) f[4])) {
                    out.add((String) f[0]);
                }
                continue;
            }
            if (!obj.getDataEntityType().getProperties().containsKey(entry)) {
                continue;
            }
            for (DynamicObject row : obj.getDynamicObjectCollection(entry)) {
                if (!blank(value(row, field), (Boolean) f[4])) {
                    out.add((String) f[0]);
                    break;
                }
            }
        }
        return out;
    }

    /**
     * 库里这几张单上有值的字段。只读查询，表头一次、每个分录各一次；一层查不动（个别字段不让查）就逐个字段查，查不动的跳过。
     * 不取单据对象：这个探针只新建，不按 pk 拿现成单据。
     */
    private static Map<Long, Set<String>> filled(MainEntityType met, List<Object[]> fields, List<Long> ids) {
        Map<Long, Set<String>> out = new HashMap<Long, Set<String>>();
        for (Long id : ids) {
            out.put(id, new HashSet<String>());
        }
        Map<String, List<Object[]>> levels = new LinkedHashMap<String, List<Object[]>>();
        for (Object[] f : fields) {
            String level = f[2] == null ? "" : (String) f[2];
            if (!levels.containsKey(level)) {
                levels.put(level, new ArrayList<Object[]>());
            }
            levels.get(level).add(f);
        }
        for (List<Object[]> level : levels.values()) {
            try {
                fill(met, level, ids, out);
            } catch (RuntimeException e) {
                for (Object[] f : level) {
                    try {
                        fill(met, Collections.singletonList(f), ids, out);
                    } catch (RuntimeException skipped) {
                        //这个字段查不了，不比它
                    }
                }
            }
        }
        return out;
    }

    private static void fill(MainEntityType met, List<Object[]> fields, List<Long> ids, Map<Long, Set<String>> out) {
        List<String> select = new ArrayList<String>();
        select.add("id");
        for (Object[] f : fields) {
            select.add((String) f[0]);
        }
        for (DynamicObject r : QueryServiceHelper.query(met.getName(), String.join(",", select),
                new QFilter[]{new QFilter("id", "in", ids)})) {
            Set<String> set = out.get(r.getLong("id"));
            for (Object[] f : fields) {
                if (set != null && !blank(r.get((String) f[0]), (Boolean) f[4])) {
                    set.add((String) f[0]);
                }
            }
        }
    }

    /** 参照的几张都有值、这张没有的字段，写成「名称 键」。 */
    private static List<String> missing(List<Object[]> fields, Set<String> here, List<Set<String>> refs) {
        List<String> out = new ArrayList<String>();
        if (refs.isEmpty() || here == null) {
            return out;
        }
        for (Object[] f : fields) {
            boolean all = !here.contains((String) f[0]);
            for (Set<String> r : refs) {
                all &= r != null && r.contains((String) f[0]);
            }
            if (all) {
                out.add(f[1] + " " + f[0]);
            }
        }
        return out;
    }

    private static Object value(DynamicObject obj, String name) {
        return obj.getDataEntityType().getProperties().containsKey(name) ? obj.get(name) : null;
    }

    /** 没值：null、空串、只有空格（文本字段的缺省值）、基础资料没选（对象里是 null，查出来是 0）。 */
    private static boolean blank(Object v, boolean basedata) {
        return v == null || v instanceof String && ((String) v).trim().isEmpty()
                || basedata && v instanceof Number && ((Number) v).longValue() == 0L;
    }

    private static String label(IDataEntityProperty p) {
        return p.getDisplayName() == null || p.getDisplayName().toString().trim().isEmpty() ? p.getName()
                : p.getDisplayName().toString().trim();
    }

    /** 复制出来的单：分录各几行，必录但平台不复制的表头字段现在是什么值（默认值、或者空着等编码规则给号）。 */
    private static String copiedSummary(MainEntityType met, DynamicObject obj) {
        List<String> entries = new ArrayList<String>();
        List<String> notCopied = new ArrayList<String>();
        for (Object o : met.getProperties()) {
            if (o instanceof EntryProp) {
                int n = obj.getDynamicObjectCollection(((EntryProp) o).getName()).size();
                if (n > 0) {
                    entries.add(((EntryProp) o).getName() + " " + n + " 行");
                }
                continue;
            }
            if (!(o instanceof FieldProp)) {
                continue;
            }
            FieldProp f = (FieldProp) o;
            if (f.isMustInput() && (!f.isCopyable() || f.isSysField())) {
                Object v = obj.get(f.getName());
                String shown = v instanceof DynamicObject ? String.valueOf(((DynamicObject) v).getPkValue())
                        : v instanceof java.util.Date ? new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((java.util.Date) v)
                        : v == null || String.valueOf(v).trim().isEmpty() ? "空" : String.valueOf(v);
                notCopied.add(f.getDisplayName() + " " + f.getName() + "=" + shown);
            }
        }
        return (entries.isEmpty() ? "没有分录行" : "分录 " + String.join("、", entries))
                + (notCopied.isEmpty() ? "" : "；必录、平台不复制的字段现在是（默认值，空的看保存时编码规则给不给号）：" + String.join("、", notCopied));
    }

    /** SEED_COPY 给的是单据编号（基础资料是编码）或 pk：先按编号查，查不到、又是一串数字就当 pk。 */
    private static String templatePk(String entity, MainEntityType met, String raw) {
        String noField = MetaResolve.billNoField(met);
        if (noField != null) {
            DynamicObjectCollection hit = QueryServiceHelper.query(entity, "id", new QFilter[]{new QFilter(noField, "=", raw)});
            if (hit.size() == 1) {
                return String.valueOf(hit.get(0).get("id"));
            }
            if (hit.size() > 1) {
                throw new IllegalArgumentException(entity + " 里编号 " + raw + " 有 " + hit.size() + " 张，SEED_COPY 改写 pk");
            }
        }
        if (raw.matches("[0-9]+") && count(entity, new QFilter[]{new QFilter("id", "=", Long.valueOf(raw))}) == 1) {
            return raw;
        }
        throw new IllegalArgumentException(entity + " 里没有" + (noField == null ? "" : "编号（" + noField + "）或")
                + " pk 是 " + raw + " 的数据，SEED_COPY 要给这张单上一条现成数据");
    }

    /**
     * SEED_FROM：按转换规则从上游单下推，推出来的对象就是要造的单（S37 批 8，2026-09-28 用户定）。
     *
     * 下游单挂在上游单下面（委托单下的检测单）这类样本，以前只能新建一张孤立的单，再把关联字段改成上游单号：
     * 没有下推关系，按关系找下游的代码找不到它，字段也常少了下推时才带过来的那些。这里和界面上下推一样：
     * ConvertServiceHelper.push 出对象，不在这里保存，交给后面的操作链（save 时平台记下推关系）。
     * 规则没指定时取源单到本单唯一一条启用的规则；多条时写了源单编号就按这几张源单挑（{@link #pickRule}），
     * 只写源单标识的列出来让调用方写编号或用 SEED_RULE 选。
     *
     * 不写编号时自己挑源单（S48）：规则的源单条件用平台的 FilterBuilder 转成查询条件（转换服务筛源单用的是同一个类），
     * 取最近几张满足的逐张试推，第一张推得出来的就用它；规则另有公式条件、执行条件转不成查询的，靠试推兜住。
     * 推不出来时列出规则的源单条件和源单在那几个字段上的值：平台只回一句「不符合转换规则的数据筛选条件」，
     * 看不出卡在哪个字段（09-27、09-28 两次复测都没走下推，改成造一张孤立的下游单、手填上游单号）。
     */
    private static List<Row> pushRows(String entity, MainEntityType met, String from, String ruleHint, Row template) {
        int colon = from.indexOf(':');
        String sourceKey = (colon < 0 ? from : from.substring(0, colon)).trim();
        if (sourceKey.isEmpty() || colon == from.length() - 1) {
            throw new IllegalArgumentException("SEED_FROM 写成「源单标识:单据编号,单据编号」，如 demo_order:DO-0001；"
                    + "只写源单标识就按规则的源单条件挑一张推得出来的。给的是「" + from + "」");
        }
        MainEntityType st = MetaResolve.type(sourceKey);
        String source = st.getName();
        String noField = MetaResolve.billNoField(st);
        List<String[]> heads = enabledRules(source, entity, ruleHint);
        if (heads.size() > 1 && colon < 0) {
            List<String> names = new ArrayList<String>();
            for (String[] h : heads) {
                names.add(h[0] + "「" + h[1] + "」");
            }
            throw new IllegalArgumentException(source + " → " + entity + " 有 " + heads.size()
                    + " 条启用的转换规则：写上源单编号（SEED_FROM=" + source + ":编号），按这几张源单挑满足条件、推得出来的那条；"
                    + "或用 SEED_RULE=规则id 或名称片段选一条：" + String.join("、", names));
        }

        List<DynamicObject> objs = new ArrayList<DynamicObject>();
        List<String> used = new ArrayList<String>();
        String[] rule = heads.get(0);
        if (colon < 0) {
            CRCondition filter = sourceFilter(rule[0]);
            String filterText = filterText(st, filter);
            System.out.println("[PROBE] 按转换规则 " + rule[0] + "「" + rule[1] + "」从 " + source + " 下推；"
                    + (filterText.isEmpty() ? "规则没有源单条件" : "规则的源单条件：" + filterText));
            QFilter q = queryOf(st, filter);
            //条件里有分录字段时一张单按分录出好几行，同一张只试一次
            List<Object[]> picks = new ArrayList<Object[]>();
            Set<Long> picked = new HashSet<Long>();
            for (DynamicObject r : QueryServiceHelper.query(source, "id" + (noField == null ? "" : "," + noField),
                    q == null ? new QFilter[0] : new QFilter[]{q}, "id desc", PICK * 20)) {
                if (picks.size() < PICK && picked.add(r.getLong("id"))) {
                    picks.add(new Object[]{r.getLong("id"), noField == null ? r.getString("id") : r.getString(noField)});
                }
            }
            if (picks.isEmpty()) {
                throw new IllegalStateException(source + " 里没有满足规则源单条件的单（" + filterText
                        + "）：先造一张满足条件的上游单（SEED_COPY 照现成的复制，SEED_SET 改上条件里的字段，SEED_OPS 走到要的状态），再用 SEED_FROM 写它的编号下推");
            }
            List<String> tried = new ArrayList<String>();
            List<Long> skipped = new ArrayList<Long>();
            for (Object[] pick : picks) {
                ConvertOperationResult pushed = push(source, entity, rule[0], (Long) pick[0]);
                objs = targets(pushed, met);
                if (!objs.isEmpty()) {
                    used.add(String.valueOf(pick[1]));
                    System.out.println("[PROBE] 挑了源单 " + pick[1] + "（满足源单条件的最近 " + picks.size() + " 张里"
                            + (tried.isEmpty() ? "第一张就推得出来" : "前 " + tried.size() + " 张推不出来，这张推得出来") + "）");
                    break;
                }
                tried.add(pick[1] + "：" + failText(pushed));
                skipped.add((Long) pick[0]);
            }
            //跳过的也说原因：被跳过的常是刚造的那张，不说就只能猜它卡在哪
            for (String t : tried) {
                System.out.println("[PROBE]   推不出来 " + t);
            }
            if (!skipped.isEmpty()) {
                compareWithPushed(st, noField == null ? "id" : noField, q, skipped, entity);
            }
            if (objs.isEmpty()) {
                throw new IllegalStateException("满足源单条件的最近 " + picks.size() + " 张都推不出来（每张的原因见上面），"
                        + "换 SEED_RULE，或写一张源单编号看它卡在哪个字段");
            }
        } else {
            List<String> numbers = new ArrayList<String>();
            for (String n : from.substring(colon + 1).split(",")) {
                if (!n.trim().isEmpty()) {
                    numbers.add(n.trim());
                }
            }
            String by = noField == null ? "id" : noField;
            List<Long> ids = new ArrayList<Long>();
            List<String> found = new ArrayList<String>();
            for (DynamicObject r : QueryServiceHelper.query(source, "id," + by, new QFilter[]{new QFilter(by, "in", numbers)})) {
                ids.add(r.getLong("id"));
                found.add(r.getString(by));
            }
            List<String> missing = new ArrayList<String>(numbers);
            missing.removeAll(found);
            if (!missing.isEmpty()) {
                throw new IllegalArgumentException("源单 " + source + " 里没有这些编号：" + missing);
            }
            ConvertOperationResult pushed = null;
            if (heads.size() > 1) {
                Object[] picked = pickRule(st, by, met, heads, ids, found);
                rule = (String[]) picked[0];
                pushed = (ConvertOperationResult) picked[1];
            }
            CRCondition filter = sourceFilter(rule[0]);
            String filterText = filterText(st, filter);
            System.out.println("[PROBE] 按转换规则 " + rule[0] + "「" + rule[1] + "」从 " + source + " 下推；"
                    + (filterText.isEmpty() ? "规则没有源单条件" : "规则的源单条件：" + filterText));
            System.out.println("[PROBE] 源单 " + String.join("、", found));
            if (pushed == null) {
                pushed = push(source, entity, rule[0], ids.toArray(new Long[0]));
            }
            objs = targets(pushed, met);
            if (objs.isEmpty()) {
                explain(st, by, filter, ids, entity);
                throw new IllegalStateException("下推没推出单据：" + failText(pushed));
            }
            //给了几张、只推出其中几张时平台不报错，没推出来的要说出来，不然以为都造了
            List<Long> missed = notPushed(st, filter, pushed, ids);
            for (int i = 0; i < ids.size(); i++) {
                if (!missed.contains(ids.get(i))) {
                    used.add(found.get(i));
                }
            }
            if (!missed.isEmpty()) {
                System.out.println("[PROBE] ⚠ " + missed.size() + " 张源单没推出来，下面只造推出来的 " + objs.size() + " 条"
                        + ("平台没给原因".equals(failText(pushed)) ? "" : "；平台的原因：" + failText(pushed)));
                explain(st, by, filter, missed, entity);
            }
        }
        List<Row> out = new ArrayList<Row>();
        for (int i = 0; i < objs.size(); i++) {
            Row r = new Row();
            r.label = String.valueOf(i + 1);
            r.set = template.set;
            r.ops = template.ops;
            r.obj = objs.get(i);
            out.add(r);
        }
        System.out.println("[PROBE] 推出 " + out.size() + " 条，接着套 SEED_SET、走操作链 " + String.join(" → ", template.ops));
        ProbeJson.emit("seed-from", "source", source, "name", String.valueOf(st.getDisplayName()), "bills", String.join("、", used),
                "rule", rule[1], "count", String.valueOf(out.size()));
        return out;
    }

    /** 不写编号时最多试推几张满足源单条件的源单。都推不出来多半是规则另有条件，再多试也一样。 */
    static final int PICK = 10;

    /** 源单到本单启用的转换规则 {id, 名称}（SEED_RULE 写了就只留对得上的）；一条都没有就报错。 */
    private static List<String[]> enabledRules(String source, String entity, String ruleHint) {
        List<String[]> heads = new ArrayList<String[]>();
        List<String> all = new ArrayList<String>();
        for (String[] h : rules(source, entity, ruleHint)) {
            all.add(h[0] + "「" + h[1] + "」enabled=" + h[2]);
            if ("1".equals(h[2]) || "true".equalsIgnoreCase(h[2])) {
                heads.add(h);
            }
        }
        if (heads.isEmpty()) {
            throw new IllegalArgumentException("没有 " + source + " → " + entity + " 的启用转换规则"
                    + (ruleHint.isEmpty() ? "" : "（按 SEED_RULE=" + ruleHint + " 找）")
                    + (all.isEmpty() ? "" : "；有但没启用的：" + all));
        }
        return heads;
    }

    /**
     * 源单到本单有多条启用的规则时，按给的这几张源单挑：按顺序逐条看这几张满不满足源单条件，满足就当场试推，
     * 用第一条推得出来的，返回 {规则, 推的结果}。界面上下推也是先按选中的源单筛出用得上的规则；让调用方照名字猜，
     * 真机一次猜错两条（一条只收别的组织的单，一条要已审核）。条件转不成查询的（公式条件）当满足，试推兜住。
     * 推得出来就停，后面的规则不再看：每条要读规则、转条件、查一次库，真机 36 条全看一遍要 24 秒，推和存才 3 秒。
     * 一条都满足不了，列出每条规则的条件和源单在这些字段上的值；满足的都推不出来，列出每条的原因，再按第一条比字段。
     */
    private static Object[] pickRule(MainEntityType st, String by, MainEntityType met, List<String[]> heads,
                                     List<Long> ids, List<String> found) {
        String source = st.getName();
        List<String[]> fits = new ArrayList<String[]>();
        List<String> misses = new ArrayList<String>();
        List<String> failed = new ArrayList<String>();
        List<String> fields = new ArrayList<String>();
        Set<Long> want = new HashSet<Long>(ids);
        String head = "[PROBE] " + source + " → " + met.getName() + " 有 " + heads.size() + " 条启用的转换规则，没指定哪条：源单 "
                + String.join("、", found);
        for (int i = 0; i < heads.size(); i++) {
            String[] h = heads.get(i);
            CRCondition cond = sourceFilter(h[0]);
            QFilter q = queryOf(st, cond);
            if (q != null) {
                Set<Long> pass = new HashSet<Long>();
                for (DynamicObject r : QueryServiceHelper.query(source, "id", new QFilter[]{new QFilter("id", "in", ids), q})) {
                    pass.add(r.getLong("id"));
                }
                if (!pass.containsAll(want)) {
                    misses.add(h[0] + "「" + h[1] + "」：" + filterText(st, cond));
                    addField(fields, q.getProperty());
                    for (QFilter.QFilterNest n : q.getNests(true)) {
                        addField(fields, n.getFilter().getProperty());
                    }
                    continue;
                }
            }
            fits.add(h);
            ConvertOperationResult pushed = push(source, met.getName(), h[0], ids.toArray(new Long[0]));
            if (!targets(pushed, met).isEmpty()) {
                System.out.println(head + " 按顺序逐条看，满足源单条件就试推，用第一条推得出来的");
                for (String f : failed) {
                    System.out.println("[PROBE]   推不出来 " + f);
                }
                System.out.println("[PROBE] 用规则 " + h[0] + "「" + h[1] + "」（第 " + (i + 1) + " 条；前面源单条件不满足 " + misses.size()
                        + " 条" + (failed.isEmpty() ? "" : "、满足但推不出来 " + failed.size() + " 条")
                        + (i + 1 < heads.size() ? "，后面 " + (heads.size() - i - 1) + " 条没再看" : "") + "）；要别的规则写 SEED_RULE");
                return new Object[]{h, pushed};
            }
            failed.add(h[0] + "「" + h[1] + "」：" + failText(pushed));
        }
        System.out.println(head + " 满足源单条件的 " + fits.size() + " 条" + (fits.isEmpty() ? "" : "，都推不出来"));
        if (fits.isEmpty()) {
            for (String m : misses) {
                System.out.println("[PROBE]   不满足 " + m);
            }
            printValues(st, by, fields, ids);
            throw new IllegalStateException("源单 " + String.join("、", found) + " 不满足任何一条启用规则的源单条件（每条的条件和源单的值见上面）："
                    + "把源单改到满足其中一条（SEED_SET 改字段、SEED_OPS 走到要的状态），或用 SEED_RULE 指定一条看平台怎么说");
        }
        for (String f : failed) {
            System.out.println("[PROBE]   推不出来 " + f);
        }
        explain(st, by, sourceFilter(fits.get(0)[0]), ids, met.getName());
        throw new IllegalStateException("满足源单条件的 " + fits.size() + " 条规则都推不出来（每条的原因见上面，字段对比按第一条）");
    }

    /** 源单在这几个字段上的值，一张单（分录字段一行一条）一行。 */
    private static void printValues(MainEntityType st, String by, List<String> fields, List<Long> ids) {
        if (fields.isEmpty()) {
            return;
        }
        try {
            Set<String> printed = new LinkedHashSet<String>();
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), "id," + by + "," + String.join(",", fields),
                    new QFilter[]{new QFilter("id", "in", ids)}, "id")) {
                List<String> vals = new ArrayList<String>();
                for (String f : fields) {
                    vals.add(f + "=" + r.get(f));
                }
                printed.add("[PROBE]   源单 " + r.getString(by) + "：" + String.join("、", vals));
            }
            for (String line : printed) {
                System.out.println(line);
            }
        } catch (RuntimeException e) {
            System.out.println("[PROBE]   源单条件里的字段值没查出来（" + OpSandbox.brief(e) + "）");
        }
    }

    private static ConvertOperationResult push(String source, String entity, String ruleId, Long... ids) {
        List<ListSelectedRow> selected = new ArrayList<ListSelectedRow>();
        for (Long id : ids) {
            ListSelectedRow one = new ListSelectedRow();
            one.setPrimaryKeyValue(id);
            selected.add(one);
        }
        PushArgs args = new PushArgs();
        args.setSourceEntityNumber(source);
        args.setTargetEntityNumber(entity);
        args.setRuleId(ruleId);
        args.setHasRight(true);
        args.setBuildConvReport(true);
        args.setSelectedRows(selected);
        return ConvertServiceHelper.push(args);
    }

    private static List<DynamicObject> targets(ConvertOperationResult pushed, MainEntityType met) {
        if (!pushed.isSuccess()) {
            return new ArrayList<DynamicObject>();
        }
        return pushed.loadTargetDataObjects(BusinessDataReader::loadRefence, met);
    }

    /** 平台的提示加上每张源单没推成的原因。 */
    private static String failText(ConvertOperationResult pushed) {
        List<String> out = new ArrayList<String>();
        if (pushed.getMessage() != null && !pushed.getMessage().trim().isEmpty()) {
            out.add(pushed.getMessage().trim());
        }
        if (pushed.getBillReports() != null) {
            for (SourceBillReport r : pushed.getBillReports()) {
                if (r.getFailMessages() != null && !r.getFailMessages().isEmpty()) {
                    out.add((r.getBillNo() == null ? "" : r.getBillNo() + "：") + String.join("；", r.getFailMessages()));
                }
            }
        }
        return out.isEmpty() ? "平台没给原因" : String.join("；", out);
    }

    /**
     * 规则的源单条件（设计器「源单数据筛选」那一格）。读不到当没有，下推时平台照样会筛。
     * 走平台下推自己读规则的那层缓存：直接读设计元数据每条要查八九次库，挑规则时逐条读，36 条要十几秒。
     */
    private static CRCondition sourceFilter(String ruleId) {
        try {
            ConvertRuleElement el = ConvertMetaServiceHelper.loadRule(ruleId);
            FilterPolicy fp = el == null ? null : el.getFilterPolicy();
            return fp == null ? null : fp.getCondition();
        } catch (Exception e) {
            System.out.println("[PROBE]   规则的源单条件没读出来（" + OpSandbox.brief(e) + "），挑源单时不按条件筛");
            return null;
        }
    }

    /** 条件写成「字段 比较 值 且/或 …」，平台把连下一行的逻辑符存在上一行。另有公式条件的接在后面。 */
    /**
     * 源单条件写成人看得懂的一行。比较类型在元数据里是编号（105 是勾选/下拉的等于，106 在别处又是另一种），
     * 自己对照会对错，所以优先用平台自己转出来的查询条件；转不成的才逐行照原样列。
     */
    private static String filterText(MainEntityType st, CRCondition cond) {
        if (cond == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        QFilter q = queryOf(st, cond);
        List<SimpleFilterRow> rows = cond.getFilterCondition() == null ? null : cond.getFilterCondition().getFilterRow();
        if (q != null) {
            sb.append(q.toString().replaceAll("\\s+", " ").trim());
        } else if (rows != null) {
            for (int i = 0; i < rows.size(); i++) {
                SimpleFilterRow row = rows.get(i);
                if (i > 0) {
                    sb.append("1".equals(rows.get(i - 1).getLogic()) ? " 或 " : " 且 ");
                }
                sb.append(row.getLeftBracket() == null ? "" : row.getLeftBracket()).append(row.getFieldName())
                        .append(' ').append(row.getCompareTypeDesc() == null ? row.getCompareType() : row.getCompareTypeDesc());
                List<String> values = new ArrayList<String>();
                if (row.getValue() != null) {
                    for (FilterValue v : row.getValue()) {
                        values.add(String.valueOf(v.getValue()));
                    }
                }
                if (!values.isEmpty()) {
                    sb.append(' ').append(String.join("/", values));
                }
                sb.append(row.getRightBracket() == null ? "" : row.getRightBracket());
            }
        }
        String expr = cond.getExpression();
        if (expr != null && !expr.trim().isEmpty()) {
            sb.append(sb.length() == 0 ? "" : " 且 ").append("公式「").append(expr.trim()).append("」");
        }
        return sb.toString();
    }

    /** 源单条件转成查询条件；没有条件、或转不成（公式条件、比较类型不认）返回 null，挑单时只按最近的试推。 */
    private static QFilter queryOf(MainEntityType st, CRCondition cond) {
        if (cond == null || cond.getFilterCondition() == null || cond.getFilterCondition().getFilterRow() == null
                || cond.getFilterCondition().getFilterRow().isEmpty()) {
            return null;
        }
        try {
            FilterBuilder fb = new FilterBuilder(st, cond.getFilterCondition());
            fb.buildFilter();
            return fb.getQFilter();
        } catch (Exception e) {
            System.out.println("[PROBE]   源单条件转不成查询条件（" + OpSandbox.brief(e) + "），按最近的源单逐张试推");
            return null;
        }
    }

    /**
     * 推不出来时：这几张源单满不满足源单条件，条件里那几个字段现在是什么值；满足条件还推不出来的，
     * 再和满足同样条件、已经推出过本单的几张源单比，列出它们都有值、这张空着的字段。
     */
    private static void explain(MainEntityType st, String by, CRCondition cond, List<Long> ids, String target) {
        //字段取平台转好的查询条件里的：规则里分录字段只写字段名，查询要带分录前缀
        List<String> fields = new ArrayList<String>();
        QFilter q = queryOf(st, cond);
        if (q != null) {
            addField(fields, q.getProperty());
            for (QFilter.QFilterNest n : q.getNests(true)) {
                addField(fields, n.getFilter().getProperty());
            }
        }
        List<Long> pass = new ArrayList<Long>();
        if (q != null) {
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), "id",
                    new QFilter[]{new QFilter("id", "in", ids), q})) {
                pass.add(r.getLong("id"));
            }
        }
        String select = "id," + by + (fields.isEmpty() ? "" : "," + String.join(",", fields));
        try {
            //分录字段一张单出好几行，同样的一行只打一次
            Set<String> printed = new LinkedHashSet<String>();
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), select, new QFilter[]{new QFilter("id", "in", ids)}, "id")) {
                List<String> vals = new ArrayList<String>();
                for (String f : fields) {
                    vals.add(f + "=" + r.get(f));
                }
                printed.add("[PROBE]   源单 " + r.getString(by) + (q == null ? "" : pass.contains(r.getLong("id"))
                        ? "（满足源单条件，卡在别处：看下面平台的原因）" : "（不满足源单条件）")
                        + (vals.isEmpty() ? "" : "：" + String.join("、", vals)));
            }
            for (String line : printed) {
                System.out.println(line);
            }
        } catch (RuntimeException e) {
            System.out.println("[PROBE]   源单条件里的字段值没查出来（" + OpSandbox.brief(e) + "）");
        }
        List<Long> stuck = q == null ? ids : pass;
        if (!stuck.isEmpty()) {
            compareWithPushed(st, by, q, stuck, target);
        }
    }

    /** 和这几张比：满足源单条件、已经推出过本单的源单，最多取几张。 */
    static final int REFS = 5;

    /**
     * 满足源单条件却推不出来：规则以外，转换插件还会读源单上别的字段（平台只回插件抛的那句话，比如「模板类型:null」），
     * 看不出读的是哪个。拿推出过本单的源单比一比，它们都有值、这张空着的，多半就是缺的那个。
     * 照现成复制出来的源单常这样：平台设成不复制的字段是空的（真机：原始记录模板类型，界面上点下推按钮时才补上）。
     */
    private static void compareWithPushed(MainEntityType st, String by, QFilter q, List<Long> stuck, String target) {
        try {
            List<QFilter> f = new ArrayList<QFilter>();
            f.add(new QFilter("id", "not in", stuck));
            if (q != null) {
                f.add(q);
            }
            List<Long> refIds = new ArrayList<Long>();
            Set<Long> seen = new LinkedHashSet<Long>();
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), "id", f.toArray(new QFilter[0]), "id desc", 50)) {
                seen.add(r.getLong("id"));
            }
            for (Long id : seen) {
                Map<String, HashSet<Long>> down = BFTrackerServiceHelper.findTargetBills(st.getName(), new Long[]{id});
                if (down != null && down.containsKey(target) && !down.get(target).isEmpty()) {
                    refIds.add(id);
                    if (refIds.size() >= REFS) {
                        break;
                    }
                }
            }
            if (refIds.isEmpty()) {
                System.out.println("[PROBE]   满足源单条件的最近 " + seen.size() + " 张源单都没推出过 " + target + "，没有能比的");
                return;
            }
            List<Long> all = new ArrayList<Long>(refIds);
            all.addAll(stuck);
            Map<Long, String> numbers = new HashMap<Long, String>();
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), "id," + by, new QFilter[]{new QFilter("id", "in", all)})) {
                numbers.put(r.getLong("id"), r.getString(by));
            }
            List<Object[]> fields = compared(st);
            Map<Long, Set<String>> has = filled(st, fields, all);
            List<Set<String>> refs = new ArrayList<Set<String>>();
            List<String> refNos = new ArrayList<String>();
            for (Long id : refIds) {
                refs.add(has.get(id));
                refNos.add(numbers.get(id));
            }
            //按分录字段筛出来的 id 一行分录一个，同一张单只说一次
            for (Long id : new LinkedHashSet<Long>(stuck)) {
                List<String> lost = missing(fields, has.get(id), refs);
                System.out.println("[PROBE]   源单 " + numbers.get(id) + " 和推出过 " + target + " 的 " + refs.size() + " 张源单（"
                        + String.join("、", refNos) + "）比："
                        + (lost.isEmpty() ? "没有它们都有值、这张空着的字段" : "它们都有值、这张空着的字段：" + String.join("、", lost)));
            }
        } catch (RuntimeException e) {
            System.out.println("[PROBE]   没能和推出过下游的源单比（" + OpSandbox.brief(e) + "）");
        }
    }

    /** 给了的源单里没推出来的：平台报告里失败的，加上不满足规则源单条件的。 */
    private static List<Long> notPushed(MainEntityType st, CRCondition cond, ConvertOperationResult pushed, List<Long> ids) {
        Set<Long> out = new LinkedHashSet<Long>();
        if (pushed.getBillReports() != null) {
            for (SourceBillReport r : pushed.getBillReports()) {
                if (!r.isSuccess() && r.getBillId() != null) {
                    out.add(Long.valueOf(String.valueOf(r.getBillId())));
                }
            }
        }
        QFilter q = queryOf(st, cond);
        if (q != null) {
            Set<Long> pass = new HashSet<Long>();
            for (DynamicObject r : QueryServiceHelper.query(st.getName(), "id", new QFilter[]{new QFilter("id", "in", ids), q})) {
                pass.add(r.getLong("id"));
            }
            for (Long id : ids) {
                if (!pass.contains(id)) {
                    out.add(id);
                }
            }
        }
        return new ArrayList<Long>(out);
    }

    private static void addField(List<String> fields, String f) {
        if (f != null && !f.isEmpty() && !fields.contains(f)) {
            fields.add(f);
        }
    }

    /**
     * 源单到目标单的转换规则 {id, 名称, 启用}。规则不是实体数据，存在 meta 库的 T_BOTP_ConvertRule（名称在 _L 表），
     * 和 BotpRuleProbe 查规则清单是同一条 SQL；那个探针是冻结源导出的文件，不为复用一段查询把它收成本仓自有。
     * hint 是一串数字就按规则 id 比，否则按名称包含。
     */
    private static List<String[]> rules(String source, String target, String hint) {
        StringBuilder sql = new StringBuilder("select r.FID, l.FName, r.FEnabled from T_BOTP_ConvertRule r"
                + " left join T_BOTP_ConvertRule_L l on l.FID = r.FID and l.FLocaleId = 'zh_CN'"
                + " where r.FSourceEntityNumber = ? and r.FTargetEntityNumber = ?");
        List<Object> params = new ArrayList<Object>();
        params.add(source);
        params.add(target);
        if (!hint.isEmpty()) {
            if (hint.matches("\\d{6,}")) {
                sql.append(" and r.FID = ?");
                params.add(hint);
            } else {
                sql.append(" and l.FName like ?");
                params.add("%" + hint + "%");
            }
        }
        List<String[]> out = new ArrayList<String[]>();
        DataSet ds = DB.queryDataSet("DataSeedProbe", DBRoute.meta, sql.toString(), params.toArray());
        try {
            for (kd.bos.algo.Row r : ds) {
                out.add(new String[]{r.getString("FID"), r.getString("FName"), String.valueOf(r.get("FEnabled"))});
            }
        } finally {
            ds.close();
        }
        return out;
    }

    /** 按顺序跑每条的操作链，任何一条没跑通就停（后面的不跑）。 */
    private static boolean runRows(String entity, MainEntityType met, List<Row> rows) {
        try {
            for (Row row : rows) {
                boolean ok;
                try {
                    if (row.obj == null && !copyNow(entity, met, row)) {
                        return false;
                    }
                    ok = runChain(entity, met, row);
                } finally {
                    //在复制出来的表单上保存过，平台给这张单记了「正在编辑」；界面关掉才放，这里跑完就放
                    FormSim.releaseMutex(row.view);
                }
                if (!ok) {
                    return false;
                }
            }
            return true;
        } catch (Throwable t) {
            System.out.println("[PROBE] 抛异常 " + OpSandbox.brief(t));
            OpSandbox.explain(t);
            return false;
        }
    }

    /**
     * 第二条起照现成复制的，前一条跑完才开表单，和界面上「复制一张、保存、再复制」一样。
     * 复制出来的单，表单上的编号是编码规则预读的；保存时平台照样消耗一个流水号，单据却留着表单上那个号。
     * 几张一起先开好再挨个保存，后面几张拿的都是第一张保存前读的号（2026-10-07 真机：一次复制两张委托单，
     * 都存成 01062610070006，流水号却用掉两个）。轮到才开，读到的就是前一张占掉之后的下一个号。
     */
    /** 在空单上试设字段，只要「基础资料没取到」的结果；逐字段那几行不打：原值是空单的，复制出来再设时才打真的。 */
    private static List<String> quietSets(MainEntityType met, DynamicObject obj, String set) throws Exception {
        PrintStream out = System.out;
        try {
            System.setOut(new PrintStream(new ByteArrayOutputStream(), true, "UTF-8"));
            return OpSandbox.applySets(met, obj, set);
        } finally {
            System.setOut(out);
        }
    }

    private static boolean copyNow(String entity, MainEntityType met, Row row) {
        row.view = copied(entity, met, row.copy);
        row.obj = row.view.getModel().getDataEntity(true);
        List<String> unresolved = OpSandbox.applySets(met, row.obj, row.set);
        if (!unresolved.isEmpty()) {
            System.out.println("[PROBE] !! " + row.label + "：基础资料没取到 " + String.join("、", unresolved) + "，这条和后面的不跑了");
            return false;
        }
        return true;
    }

    /**
     * 一条数据按顺序跑完它的操作链。任何一步不成功就返回 false，调用方停下（预演整批回滚，落库前面已提交的留着）。
     *
     * 第一步拿造好的对象去跑；从第二步起**按本次第一步刚生成的 pk** 调操作，由平台在服务里自己取单。
     * 不能接着传同一个对象：save 成功后它仍被当成新单，submit 会再 INSERT 一次同一行
     * （2026-09-15 真机：`save,submit` 在 zlgd_bzwz_wl 上报 Duplicate entry … for key PRIMARY；
     * 在本进程里 loadSingle 重读一遍再传对象，照样重复插入）。按 pk 调是界面上对已有单据提交、审核的走法。
     * 这里的 pk 只可能是本次刚造出来的那一行，不是已有数据。
     */
    private static boolean runChain(String entity, MainEntityType met, Row row) {
        Object pk = null;
        for (int i = 0; i < row.ops.size(); i++) {
            String op = row.ops.get(i);
            //照现成复制的单是在表单上开的：第一步就在这张表单上点，和界面上一样先过表单插件的操作前、操作后事件。
            //绕过表单直接调操作，平台编码规则的表单插件就没机会把这张单交给保存去占号：表单上显示的号只是预读的，
            //保存了也不算用掉，下一张复制出来又是同一个号（真机：委托单连着 3 张 01062610070002，提交报编号重复）
            boolean onForm = i == 0 && row.view != null;
            int notices = FormSim.NOTICES.size();
            OperationResult r;
            if (onForm) {
                Object o = row.view.invokeOperation(op);
                r = o instanceof OperationResult ? (OperationResult) o : null;
            } else {
                r = i == 0
                        ? OperationServiceHelper.executeOperate(op, entity, new DynamicObject[]{row.obj},
                                OperateOption.create())
                        : OperationServiceHelper.executeOperate(op, entity, new Object[]{pk}, OperateOption.create());
            }
            System.out.println("[PROBE] " + row.label + " 执行 " + op
                    + (onForm ? "（在复制出来的表单上点）：" : i == 0 ? "：" : "（按 pk=" + pk + "）："));
            OpSandbox.report(met, r);
            if (onForm && r != null && !r.isSuccess() && r.getAllErrorOrValidateInfo().isEmpty()) {
                //失败又没有校验信息：没走到服务端，是表单插件在操作前取消了，它弹给用户的话就是理由
                List<String> said = new ArrayList<String>(FormSim.NOTICES.subList(notices, FormSim.NOTICES.size()));
                System.out.println("[PROBE]   表单插件在 " + op + " 前取消了" + (said.isEmpty()
                        ? "，没给用户任何提示" : "，弹给用户的话：" + String.join(" / ", said)));
            }
            if (r == null || !r.isSuccess()) {
                System.out.println("[PROBE] !! " + row.label + " 的 " + op + " 没成功，后面的不跑了");
                return false;
            }
            if (i == 0) {
                if (onForm) {
                    //表单保存完拿的是表单上的那张：编号这类保存时才定的值以它为准
                    DynamicObject saved = row.view.getModel().getDataEntity(true);
                    if (saved != null) {
                        row.obj = saved;
                    }
                }
                pk = row.obj.getPkValue();
                if ((pk == null || "0".equals(String.valueOf(pk))) && !r.getSuccessPkIds().isEmpty()) {
                    pk = r.getSuccessPkIds().get(0);
                }
                row.pk = pk;
                sameNumber(entity, met, row.obj, pk);
                if (pk == null && row.ops.size() > 1) {
                    System.out.println("[PROBE] !! " + row.label + " 的 " + op + " 成功了，但拿不到 pk，后面的操作没法接着做");
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * 刚保存的单，单据编号库里是不是已经有别的单在用：编码规则的流水号落后于库里的单时，保存照样成功，
     * 到提交、审核才报编号重复，那时看不出号是哪来的。
     */
    private static void sameNumber(String entity, MainEntityType met, DynamicObject obj, Object pk) {
        String noField = MetaResolve.billNoField(met);
        String no = noField == null ? null : obj.getString(noField);
        if (no == null || no.trim().isEmpty() || pk == null) {
            return;
        }
        try {
            List<String> others = new ArrayList<String>();
            for (DynamicObject r : QueryServiceHelper.query(entity, "id", new QFilter[]{new QFilter(noField, "=", no),
                    new QFilter("id", "!=", pk)}, "id", 5)) {
                others.add(r.getString("id"));
            }
            if (!others.isEmpty()) {
                System.out.println("[PROBE]   ⚠ 保存后的单据编号 " + no + " 库里另有 " + others.size() + " 张同号的单（pk="
                        + String.join("、", others) + "）");
            }
        } catch (RuntimeException e) {
            //查不了就不报：保存已经成功，提交时平台的编号校验照样会说
        }
    }

    /** SEED_ROWS 按行解析；没给就用 SEED_SET 造一条。标签重复当场拒：回执按标签列，重名就对不上是哪条。 */
    private static List<Row> parseRows(List<String> defaultOps) {
        String spec = env("SEED_ROWS", "");
        String copy = env("SEED_COPY", "");
        List<Row> out = new ArrayList<Row>();
        if (spec.isEmpty()) {
            Row row = new Row();
            row.label = "1";
            row.set = env("SEED_SET", "");
            row.ops = defaultOps;
            row.copy = copy;
            out.add(row);
            return out;
        }
        Row cur = null;
        for (String raw : spec.split("\n")) {
            String line = raw.trim();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("[row]")) {
                cur = new Row();
                cur.label = line.substring("[row]".length()).trim();
                if (cur.label.isEmpty()) {
                    cur.label = String.valueOf(out.size() + 1);
                }
                cur.ops = defaultOps;
                cur.copy = copy;
                out.add(cur);
                continue;
            }
            int eq = line.indexOf('=');
            if (cur == null || eq <= 0) {
                throw new IllegalStateException("SEED_ROWS 看不懂这一行「" + line + "」：先写 [row] 标签，下面跟 set=… / ops=… / copy=…");
            }
            String k = line.substring(0, eq).trim();
            String v = line.substring(eq + 1).trim();
            if ("set".equals(k)) {
                cur.set = v;
            } else if ("ops".equals(k)) {
                cur.ops = ops(v);
            } else if ("copy".equals(k)) {
                cur.copy = v;
            } else {
                throw new IllegalStateException("SEED_ROWS 不认识的键「" + k + "」，只认 set / ops / copy");
            }
        }
        if (out.isEmpty()) {
            throw new IllegalStateException("SEED_ROWS 里一条 [row] 都没有");
        }
        if (out.size() > MAX_ROWS) {
            throw new IllegalStateException("一次最多造 " + MAX_ROWS + " 条，这次 " + out.size() + " 条");
        }
        List<String> seen = new ArrayList<String>();
        for (Row row : out) {
            if (seen.contains(row.label)) {
                throw new IllegalStateException("SEED_ROWS 里标签重复：" + row.label);
            }
            seen.add(row.label);
        }
        return out;
    }

    private static List<String> ops(String raw) {
        List<String> out = new ArrayList<String>();
        for (String one : raw.split(",")) {
            String op = one.trim();
            if (!op.isEmpty()) {
                out.add(op);
            }
        }
        if (out.isEmpty()) {
            throw new IllegalStateException("操作链是空的：SEED_OPS / ops= 至少写一个操作，例如 save");
        }
        return out;
    }

    /** 单据编号，基础资料是编码。都没有就不报，不猜别的字段。 */
    private static String numberOf(DynamicObject obj) {
        for (String key : new String[]{"billno", "number"}) {
            if (obj.getDataEntityType().getProperties().containsKey(key)) {
                String v = obj.getString(key);
                return v == null || v.isEmpty() ? null : v;
            }
        }
        return null;
    }

    private static int count(String entity, QFilter[] f) {
        try {
            return ORM.create().count("dataseed", entity, f);
        } catch (Throwable t) {
            System.out.println("[PROBE]   计数失败 " + OpSandbox.brief(t));
            return -1;
        }
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            System.out.println("[PROBE] 缺 " + k);
            throw new IllegalStateException("缺 " + k);
        }
        return v.trim();
    }

    private static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? dft : v.trim();
    }
}
