import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.OperateOption;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.botp.ConvertRuleElement;
import kd.bos.entity.botp.LinkEntityPolicy;
import kd.bos.entity.botp.PlugInPolicy;
import kd.bos.entity.botp.runtime.ConvertOperationResult;
import kd.bos.entity.botp.runtime.PushArgs;
import kd.bos.entity.datamodel.ListSelectedRow;
import kd.bos.metadata.botp.ConvertRuleMetadata;
import kd.bos.metadata.botp.ConvertRuleReader;
import kd.bos.orm.query.QCP;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.botp.ConvertServiceHelper;
import kd.bos.servicehelper.operation.OperationServiceHelper;

/**
 * 按一条 BOTP 转换规则下推并保存，重新从数据库读取目标单后断言（run push）。
 *
 * <pre>
 * PUSH_RULE    转换规则 id（必填）；源单、目标单都从规则里读
 * PUSH_PK      源单内码；写成 billno:编号 就按单据编号查（必填）
 * PUSH_EXPECT  断言，`;` 分隔：success=true|false、message=片段、bills=张数；
 *              其余是目标单上的字段路径，[n].字段 指第 n+1 张目标单
 * PUSH_SHOW    目标单字段路径，`;` 分隔：只打值、不断言
 * OP_PKGS      本工程的包前缀，逗号分隔（run push 会替你填）：标出规则上哪些转换插件是本工程的
 * </pre>
 *
 * <p>几条规矩：
 * <ul>
 * <li><b>目标单必须保存后回读</b>：下推后明确执行目标单的 save 操作，保存及反写插件照常执行。
 * 用保存操作成功的主键重新 loadSingle，不用转换缓存里的对象断言。失败后先读日志及数据库，不能直接重推。</li>
 * <li>走平台的 {@link ConvertServiceHelper#push}，和界面上点下推同一个入口（真机 2026-09-29：常驻进程里调得通）。
 * {@code setHasRight(true)}：探针里没有权限上下文，不给会被权限挡掉。</li>
 * <li>规则的源分录不是主实体时，整张源单的分录行全部选中：只给单据 id 推不出东西。</li>
 * <li>目标单用 {@link BusinessDataServiceHelper#loadRefence} 补引用数据。给空实现时基础资料字段读回来是 null
 * （真机 2026-09-29：插件按客户名填了供应商，客户字段本身却读成 null）。</li>
 * <li>规则上没有启用的本工程转换插件时照跑，先打一行说明：这时全过只证明规则的字段映射，证明不了插件。</li>
 * <li>规则、源单查不到是<b>输入不成立</b>，不留记录（见 {@link ProbeAssert#inputInvalid}）。</li>
 * </ul>
 */
public class PushSim {

    public static void run() throws Exception {
        String ruleId = env("PUSH_RULE");
        String rawPk = env("PUSH_PK");
        String spec = env("PUSH_EXPECT");
        String show = env("PUSH_SHOW");
        try {
            ExpectSpec.pairs(spec);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("push-expect", spec, e.getMessage());
            finish();
            return;
        }

        ConvertRuleMetadata meta = null;
        try {
            meta = new ConvertRuleReader().loadMeta(ruleId, false);
        } catch (Exception e) {
            meta = null;
        }
        if (meta == null || meta.getRuleElement() == null) {
            ProbeAssert.inputInvalid("push-rule", ruleId, "查不到这条转换规则；规则 id 用 cosmic_meta botp list 查");
            finish();
            return;
        }
        ConvertRuleElement el = meta.getRuleElement();
        String src = el.getSourceEntityNumber();
        String tgt = el.getTargetEntityNumber();
        IsvGuard.assertDataTarget(tgt);
        System.out.println("[PROBE] 规则 " + el.getName() + "  id=" + ruleId + "  " + src + " -> " + tgt);
        List<String> enabledPlugins = plugins(el);

        String pk;
        try {
            pk = MetaResolve.pkOf(src, rawPk);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("push-pk", src + " " + rawPk, e.getMessage());
            finish();
            return;
        }
        Object pkValue = pk.matches("\\d+") ? (Object) Long.valueOf(pk) : pk;
        LinkEntityPolicy link = el.getLinkEntityPolicy();
        String entry = link == null ? "" : str(link.getSourceEntryKey());
        MainEntityType srcType = MetaResolve.type(src);
        boolean byEntry = !entry.isEmpty() && !entry.equals(srcType.getName());
        DynamicObjectCollection found = QueryServiceHelper.query(src, byEntry ? "id," + entry + ".id" : "id",
                new QFilter[]{new QFilter("id", QCP.equals, pkValue)});
        if (found.isEmpty()) {
            ProbeAssert.inputInvalid("push-pk", src + " pk=" + pk, "源单 " + src + " 里查不到这张单（pk 写错，或者是别的单据的 pk）");
            finish();
            return;
        }
        List<ListSelectedRow> selected = new ArrayList<ListSelectedRow>();
        if (!byEntry) {
            selected.add(new ListSelectedRow(pkValue));
        } else {
            for (DynamicObject row : found) {
                Object entryId = row.get(entry + ".id");
                if (entryId == null || "0".equals(String.valueOf(entryId))) {
                    continue;
                }
                ListSelectedRow one = new ListSelectedRow(pkValue);
                one.setEntryEntityKey(entry);
                one.setEntryPrimaryKeyValue(entryId);
                selected.add(one);
            }
            if (selected.isEmpty()) {
                ProbeAssert.inputInvalid("push-pk", src + " pk=" + pk,
                        "规则按分录 " + entry + " 下推，这张源单的 " + entry + " 一行都没有，推不出东西；换一张有分录行的单");
                finish();
                return;
            }
            System.out.println("[PROBE] 规则按分录 " + entry + " 下推，选中这张单的全部 " + selected.size() + " 行");
        }

        PushArgs args = new PushArgs(src, tgt, selected);
        Set<String> ruleIds = new HashSet<String>();
        ruleIds.add(ruleId);
        args.setRuleIds(ruleIds);
        // 自动保存还受规则配置控制；统一走目标实体的 save 操作，不把开关当成保存证据。
        args.setAutoSave(false);
        args.setHasRight(true);
        System.out.println("[PROBE] --- 下推并保存（真提交；断言数据库重新读取的目标单）---");
        long started = System.currentTimeMillis();
        ConvertOperationResult result;
        try {
            result = ConvertServiceHelper.push(args);
        } catch (Throwable t) {
            String why = brief(t);
            System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - started) + "ms  下推抛了异常：" + why);
            ExpectSpec.converted(false, why, null, spec);
            finish();
            return;
        }
        boolean success = result.isSuccess();
        String message = ConvertMessage.of(result);
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - started) + "ms  success=" + success
                + (message == null || message.isEmpty() ? "" : "  message=" + HeadlessUiSupport.oneLine(message)));
        List<DynamicObject> bills = Collections.emptyList();
        if (success) {
            List<DynamicObject> generated = result.loadTargetDataObjects(BusinessDataServiceHelper::loadRefence, MetaResolve.type(tgt));
            if (generated.isEmpty()) {
                ProbeAssert.unresolved("push-save", tgt, "保存目标单", "下推未生成目标单，不能保存确认");
                finish();
                return;
            }
            System.out.println("[PROBE] 执行目标单保存操作 save，目标 " + generated.size() + " 张");
            OperationResult saved = OperationServiceHelper.executeOperate("save", tgt,
                    generated.toArray(new DynamicObject[0]), OperateOption.create());
            if (saved == null || !saved.isSuccess() || saved.getSuccessPkIds().size() != generated.size()) {
                if (saved != null) {
                    for (IOperateInfo info : saved.getAllErrorOrValidateInfo()) {
                        System.out.println("[PROBE] 保存未成功：" + HeadlessUiSupport.oneLine(info.getMessage()));
                    }
                    System.out.println("[PROBE] 保存成功的主键=" + saved.getSuccessPkIds());
                }
                ProbeAssert.unresolved("push-save", tgt, "全部目标单保存成功", "保存未全部成功；先查日志和已成功的目标单，不要直接重推");
                finish();
                return;
            }
            bills = new ArrayList<DynamicObject>();
            List<String> ids = new ArrayList<String>();
            // 保持稳定下标；不拿转换缓存物化过的基础资料对象作落库证据。
            List<Object> ordered = new ArrayList<Object>(saved.getSuccessPkIds());
            Collections.sort(ordered, (a, b) -> String.valueOf(a).compareTo(String.valueOf(b)));
            for (Object savedId : ordered) {
                DynamicObject bill = BusinessDataServiceHelper.loadSingle(savedId, MetaResolve.type(tgt));
                if (bill == null) {
                    ProbeAssert.unresolved("push-readback", tgt + " pk=" + savedId, "保存后存在目标单",
                            "数据库回读不到目标单；保存结果未知，先核对日志和数据库，不要直接重推");
                    finish();
                    return;
                }
                bills.add(bill);
                ids.add(String.valueOf(savedId));
                System.out.println("[PROBE] 数据库回读 " + tgt + " pk=" + savedId);
            }
            ProbeJson.emit("push-readback", "rule", ruleId, "entity", tgt, "ids", ids, "plugins", enabledPlugins);
            MainEntityType tgtType = MetaResolve.type(tgt, false);
            String noField = MetaResolve.billNoField(tgtType);
            boolean hasStatus = tgtType.findProperty("billstatus") != null;
            for (DynamicObject bill : bills) {
                RunFacts.committed(tgt, bill.getPkValue(), noField == null ? null : bill.get(noField),
                        hasStatus ? bill.get("billstatus") : null, "下推", Boolean.TRUE);
            }
            RunFacts.plugins(tgt, "push " + ruleId, enabledPlugins);
            RunFacts.plugins(tgt, "op save", RunFacts.opPlugins(tgt, "save"));
            System.out.println("[PROBE] 保存后从数据库重新读取目标单 " + bills.size() + " 张");
        }
        show(bills, show);
        ExpectSpec.converted(success, message, bills, spec);
        finish();
    }

    /** 规则上挂的转换插件，标出启停和是不是本工程的；一个启用的本工程插件都没有时明说 PASS 证明不了什么。 */
    private static List<String> plugins(ConvertRuleElement el) {
        List<String> enabledPlugins = new ArrayList<String>();
        PlugInPolicy policy = el.getPlugInPolicy();
        List<?> list = policy == null ? null : policy.getPlugins();
        String[] own = ownPkgs();
        int ownEnabled = 0;
        StringBuilder sb = new StringBuilder();
        if (list != null) {
            for (Object p : list) {
                String cls = str(call(p, "getClassName"));
                boolean enabled = "true".equals(str(call(p, "isEnabled")));
                if (enabled) enabledPlugins.add(cls);
                boolean mine = false;
                for (String prefix : own) {
                    mine |= cls.startsWith(prefix);
                }
                if (mine && enabled) {
                    ownEnabled++;
                }
                sb.append(sb.length() == 0 ? "" : "，").append(cls).append(enabled ? "（启用" : "（停用")
                        .append(mine ? "，本工程）" : "）");
            }
        }
        System.out.println("[PROBE] 转换插件 " + (list == null ? 0 : list.size()) + " 个"
                + (sb.length() == 0 ? "" : "：" + sb));
        if (own.length > 0 && ownEnabled == 0) {
            System.out.println("[PROBE] ⚠ 这条规则上没有启用的本工程转换插件：断言全过只证明规则的字段映射，证明不了插件改动生效");
        }
        return enabledPlugins;
    }

    /** --show：逐张目标单打值，不断言。 */
    private static void show(List<DynamicObject> bills, String spec) {
        if (spec.isEmpty()) {
            return;
        }
        for (int i = 0; i < bills.size(); i++) {
            for (String one : spec.split(";")) {
                String path = one.trim();
                if (path.isEmpty()) {
                    continue;
                }
                String value;
                try {
                    value = ExpectSpec.showValue(bills.get(i), ExpectSpec.Pos.parse(path));
                } catch (Throwable t) {
                    value = "(取不到：" + brief(t) + ")";
                }
                System.out.println("[PROBE]   [" + i + "]." + path + " = " + value);
            }
        }
    }

    private static String[] ownPkgs() {
        List<String> out = new ArrayList<String>();
        for (String one : env("OP_PKGS").split(",")) {
            String v = one.trim();
            if (!v.isEmpty()) {
                out.add(v.endsWith(".") ? v : v + ".");
            }
        }
        return out.toArray(new String[0]);
    }

    /** 插件条目的类在各版本 SDK 里名字不一，按方法名取。 */
    private static Object call(Object o, String method) {
        if (o == null) {
            return null;
        }
        try {
            Method m = o.getClass().getMethod(method);
            return m.invoke(o);
        } catch (Exception e) {
            return null;
        }
    }

    private static String brief(Throwable t) {
        Throwable root = t;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        return root.getClass().getSimpleName() + ": " + HeadlessUiSupport.oneLine(root.getMessage());
    }

    private static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    private static void finish() {
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败");
        }
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null ? "" : value.trim();
    }
}
