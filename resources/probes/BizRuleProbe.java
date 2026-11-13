import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.utils.Uuid8;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.AbstractDesignMeta;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataWriter;
import kd.bos.metadata.entity.Entity;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.entity.commonfield.Field;
import kd.bos.metadata.entity.rule.BizRule;
import kd.bos.metadata.entity.rule.BizRuleAction;
import kd.bos.metadata.entity.rule.ClearValueAction;
import kd.bos.metadata.entity.rule.FillQtyAction;
import kd.bos.metadata.entity.rule.FormulaAction;
import kd.bos.metadata.entity.rule.SetEqutionAction;
import kd.bos.metadata.entity.rule.TakeBasePropertyAction;
import kd.bos.metadata.entity.rule.TakeValueId;

/**
 * 实体业务规则元数据探针。
 *
 *   BIZ_ENTITY=<实体或布局标识>   必填。
 *   BIZ_HOST=<主实体/分录 key>    可选；不设时遍历主实体和全部分录实体。
 *   RULE_SET=zlgd_wtlx=炉前成分;分录.字段=值   预演时的字段值，写法同 run rule --set；预演会把内存里的候选规则按 run rule 同一套执行一遍，打它的条件、动作和写的字段值，不给就按新单默认值算
 *   RULE_SHOW=字段1,分录.字段2   预演试算时另外要看的字段
 *
 * 默认只读：列出业务规则条件、触发字段、真假分支和动作的完整运行参数。
 * 写模式参数见 reference/metadata-business-rules.md；默认 dry-run，APPLY=1 才落库。
 */
public class BizRuleProbe {

    public static void run() throws Exception {
        String input = req("BIZ_ENTITY", "要查的实体或布局标识");
        String host = env("BIZ_HOST", "");
        String tag = env("BIZ_TAG", "");
        String trueSpec = env("BIZ_TRUE", "");
        String falseSpec = env("BIZ_FALSE", "");
        boolean rollback = "1".equals(env("ROLLBACK", "0"));
        boolean apply = "1".equals(env("APPLY", "0"));
        boolean write = rollback || !tag.isEmpty() || !trueSpec.isEmpty() || !falseSpec.isEmpty();
        String id = MetaResolve.designId(input);
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
        System.out.println("[PROBE] 业务规则实体 " + em.getKey() + " name=" + em.getName()
                + " metaId=" + id + " host=" + dash(host));

        if (write) {
            write(em, id, host, tag, trueSpec, falseSpec, rollback, apply);
            return;
        }

        int hosts = 0;
        int rules = 0;
        int broken = 0;
        MainEntityType met = FormulaCheck.entityType(em.getKey());
        if (met == null) System.out.println("[PROBE] ? 拿不到 " + em.getKey() + " 的运行态元数据：下面的条件和公式只核了语法和函数，字段没核");
        for (Entity<?, ?> entity : em.getEntitys()) {
            if (!host.isEmpty() && !host.equals(entity.getKey())) continue;
            hosts++;
            List<BizRule> list = entity.getRules();
            System.out.println("[PROBE] === 宿主 " + entity.getClass().getSimpleName()
                    + " key=" + entity.getKey() + " name=" + entity.getName()
                    + " id=" + entity.getId() + " rules=" + (list == null ? 0 : list.size())
                    + " （写这个宿主用 BIZ_HOST=" + entity.getKey() + "）");
            if (list == null) continue;
            for (BizRule rule : list) {
                dumpRule(rule);
                if (!checkExisting(rule, met, em.getKey())) broken++;
                rules++;
            }
        }
        if (!host.isEmpty() && hosts == 0) {
            System.out.println("[PROBE] !! 找不到 BIZ_HOST=" + host + "；去掉 BIZ_HOST 先列宿主");
            return;
        }
        System.out.println("[PROBE] 合计宿主=" + hosts + " 业务规则=" + rules
                + "（只读，不修改元数据）");
        if (broken > 0) System.out.println("[PROBE] !! 其中 " + broken + " 条规则的条件或计算公式没过平台核对（上面 ✗ 行）：引用了当前环境里找不到的函数或字段");
    }

    private static void write(EntityMetadata em, String metaId, String hostKey, String tag,
            String trueSpec, String falseSpec, boolean rollback, boolean apply) throws Exception {
        if (hostKey.isEmpty()) {
            System.out.println("[PROBE] !! 写模式必须显式给 BIZ_HOST；先用只读模式列出主实体/分录宿主");
            return;
        }
        if (tag.isEmpty()) {
            System.out.println("[PROBE] !! 写模式必须给 BIZ_TAG（幂等和回滚用的描述前缀）");
            return;
        }
        Entity<?, ?> host = null;
        for (Entity<?, ?> item : em.getEntitys()) {
            if (hostKey.equals(item.getKey())) {
                host = item;
                break;
            }
        }
        if (host == null) {
            System.out.println("[PROBE] !! 找不到 BIZ_HOST=" + hostKey + "；先跑只读模式列宿主");
            return;
        }

        IsvGuard.assertOwnEntity(em.getKey(), em);
        List<BizRule> rules = host.getRules();
        if (rules == null) {
            System.out.println("[PROBE] !! 宿主 " + hostKey + " 的 getRules() 返回 null，中止");
            return;
        }

        int removed = 0;
        for (Iterator<BizRule> it = rules.iterator(); it.hasNext(); ) {
            BizRule old = it.next();
            if (safe(old.getDescription()).startsWith(tag)) {
                System.out.println("[PROBE] 摘掉同 TAG 旧规则 id=" + old.getId()
                        + " name=" + safe(old.getDescription()));
                it.remove();
                removed++;
            }
        }
        System.out.println("[PROBE] 宿主=" + hostKey + " 原规则=" + (rules.size() + removed)
                + " 摘掉同 TAG=" + removed + " 剩余=" + rules.size());

        BizRule added = null;
        if (!rollback) {
            String name = env("BIZ_NAME", "");
            String condition = env("BIZ_CONDITION", "");
            if (name.isEmpty() || condition.isEmpty()) {
                System.out.println("[PROBE] !! 新增规则必须给 BIZ_NAME 和 BIZ_CONDITION");
                return;
            }
            if (trueSpec.isEmpty() && falseSpec.isEmpty()) {
                System.out.println("[PROBE] !! BIZ_TRUE / BIZ_FALSE 至少给一个动作");
                return;
            }

            int seq = 0;
            for (BizRule r : rules) seq = Math.max(seq, r.getSeq());
            added = new BizRule();
            added.setId(Uuid8.generateShortUuid());
            added.setSeq(seq + 1);
            added.setEnabled(!"0".equals(env("BIZ_ENABLED", "1")));
            added.setIsv(IsvGuard.ISV);
            added.setDescription(new LocaleString(tag + name));
            added.setPreCondition(condition);
            added.setPreDescription(env("BIZ_CONDITION_DESC", condition));
            added.setTriggerField(env("BIZ_TRIGGER", ""));
            added.setRET(intEnv("BIZ_RET", 0));
            //条件和计算公式先过平台核对（S36 3.2，见 FormulaCheck）：规则写入本身不看表达式
            MainEntityType met = FormulaCheck.entityType(em.getKey());
            List<String> bad = new ArrayList<String>();
            checkNew("BIZ_CONDITION", condition, met, em.getKey(), bad);
            added.setTrueActions(parseActions(trueSpec, em, met, "BIZ_TRUE", bad));
            added.setFalseActions(parseActions(falseSpec, em, met, "BIZ_FALSE", bad));
            FormulaCheck.stopOnBad(bad);

            try {
                added.buildEntityRule(hostKey);
            } catch (Throwable e) {
                System.out.println("[PROBE] !! 规则运行态构建失败：" + e.getClass().getSimpleName()
                        + ": " + safe(e.getMessage()));
                return;
            }
            if (!added.getErrorInfos().isEmpty()) {
                System.out.println("[PROBE] !! 规则校验错误=" + added.getErrorInfos());
                return;
            }
            rules.add(added);
            System.out.println("[PROBE] += RULE seq=" + added.getSeq() + " id=" + added.getId()
                    + " name=" + added.getDescription());
            System.out.println("[PROBE]    condition=" + condition
                    + " trueActions=" + added.getTrueActions().size()
                    + " falseActions=" + added.getFalseActions().size());
        }

        MetadataWriter writer = new MetadataWriter(em.getModelType());
        List<AbstractDesignMeta> designs = writer.convertToDesignMeta(em);
        boolean foundRule = added == null;
        for (AbstractDesignMeta design : designs) {
            String xml = design.getDataXml();
            if (xml == null) continue;
            int count = count(xml, "<BizRule>");
            boolean hit = added != null && xml.contains(added.getId());
            if (hit) foundRule = true;
            System.out.println("[PROBE]   " + design.getClass().getSimpleName()
                    + " xml=" + xml.length() + " BizRule=" + count
                    + (added == null ? "" : " containsNewId=" + hit));
        }
        if (!foundRule) {
            System.out.println("[PROBE] !! 序列化结果里找不到新增规则 id，中止");
            return;
        }
        if (!apply) {
            if (added != null) {
                //候选试算（S36 批 5）：内存里加好新规则的实体按落库后 run rule 同一套执行一遍；
                //新规则算不出来（例如函数参数个数不对，平台执行时才报）就停在写入之前
                List<String> failed = RuleSim.tryBiz(em.getKey(), em,
                        java.util.Collections.singleton(String.valueOf(added.getId())));
                for (String f : failed) System.out.println("[PROBE]   ✗ 候选试算：" + f);
                FormulaCheck.stopOnBad(failed);
            }
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，未写入。确认动作 runtime/XML 后加 APPLY=1");
            return;
        }
        System.out.println("[PROBE] save -> " + writer.save(em));
        MetadataDao.rebuildRuntimeMetaById(metaId);
        System.out.println("[PROBE] rebuildRuntimeMetaById(" + metaId + ") 完成；请另起冷读复核");
    }

    /**
     * 动作间用 ;; 分隔：
     * formula:目标 = 表达式
     * clear:字段1,字段2
     * carry:基础资料.属性->目标字段[, ...]
     * map:来源字段->目标字段[, ...]
     * qty:数量字段->基本数量字段[, ...]
     */
    private static List<BizRuleAction> parseActions(String spec, EntityMetadata em, MainEntityType met,
            String name, List<String> bad) {
        List<BizRuleAction> out = new ArrayList<BizRuleAction>();
        if (spec == null || spec.trim().isEmpty()) return out;
        int seq = 0;
        for (String raw : spec.split(";;")) {
            String one = raw.trim();
            if (one.isEmpty()) continue;
            int colon = one.indexOf(':');
            if (colon <= 0 || colon == one.length() - 1) {
                throw new IllegalArgumentException("动作格式错（要 类型:内容）：" + one);
            }
            String kind = one.substring(0, colon).trim().toLowerCase();
            String body = one.substring(colon + 1).trim();
            BizRuleAction action;
            if ("formula".equals(kind)) {
                int eq = body.indexOf('=');
                if (eq <= 0) throw new IllegalArgumentException("formula 要写 目标字段 = 表达式：" + body);
                String target = body.substring(0, eq).trim();
                requireTarget(em, target);
                checkNew(name + " formula " + target, body.substring(eq + 1).trim(), met, em.getKey(), bad);
                FormulaAction a = new FormulaAction();
                a.setExpression(body);
                action = a;
                init(action, "FormulaAction", "计算定义公式的值并填写到指定列", ++seq);
            } else if ("clear".equals(kind)) {
                List<String> fields = csv(body);
                for (String field : fields) requireTarget(em, field);
                ClearValueAction a = new ClearValueAction();
                a.setExpression(join(fields, ":"));
                action = a;
                init(action, "ClearValueAction", "清除指定字段值", ++seq);
            } else if ("carry".equals(kind) || "map".equals(kind)) {
                List<TakeValueId> pairs = mappings(body, em);
                TakeValueId flag = new TakeValueId();
                flag.setId(Uuid8.generateShortUuid());
                flag.setOnlyEmptyRow("1".equals(env("BIZ_ONLY_EMPTY", "0")));
                List<TakeValueId> flags = new ArrayList<TakeValueId>();
                flags.add(flag);
                if ("carry".equals(kind)) {
                    TakeBasePropertyAction a = new TakeBasePropertyAction();
                    a.setExpression(pairs);
                    a.setFieldName(flags);
                    action = a;
                    init(action, "TakeBaseProAction", "携带基础资料属性到指定列", ++seq);
                } else {
                    SetEqutionAction a = new SetEqutionAction();
                    a.setExpression(pairs);
                    a.setFieldName(flags);
                    action = a;
                    init(action, "SetEqutionAction", "设置当前编辑字段值到指定字段", ++seq);
                }
            } else if ("qty".equals(kind)) {
                List<String> json = new ArrayList<String>();
                for (String pair : csv(body)) {
                    String[] sides = arrow(pair);
                    requireSource(em, sides[0]);
                    requireTarget(em, sides[1]);
                    json.add("{\"distQtyField\":\"" + json(sides[1])
                            + "\",\"srcQtyField\":\"" + json(sides[0]) + "\"}");
                }
                FillQtyAction a = new FillQtyAction();
                a.setExpression("[" + join(json, ",") + "]");
                action = a;
                init(action, "FillQtyAction", "计算基本数量", ++seq);
            } else {
                throw new IllegalArgumentException("未知动作 " + kind
                        + "；只支持 formula|clear|carry|map|qty");
            }
            out.add(action);
            System.out.println("[PROBE]    action " + kind + " -> " + action.buildAction());
            if (!action.getErrorInfos().isEmpty()) {
                throw new IllegalArgumentException("动作校验失败 " + action.getErrorInfos());
            }
        }
        return out;
    }

    private static void checkNew(String where, String expr, MainEntityType met, String entityKey, List<String> bad) {
        FormulaCheck.Result r = FormulaCheck.rule(expr, met);
        if (!FormulaCheck.report("biz", where, entityKey, r, true)) bad.add(where);
    }

    /**
     * 读模式：既有规则的条件和计算公式也核一遍，只在没过时多打几行，不发错误记录（这不是本次的输入）。
     * 计算公式存的是「目标字段=表达式」，核等号右边。
     */
    private static boolean checkExisting(BizRule rule, MainEntityType met, String entityKey) {
        boolean ok = true;
        String cond = rule.getPreCondition();
        if (cond != null && !cond.trim().isEmpty())
            ok &= FormulaCheck.report("biz", "规则 " + rule.getId() + " 的条件", entityKey,
                    FormulaCheck.rule(cond, met), false);
        for (int p = 0; p < 2; p++) {
            List<BizRuleAction> actions = p == 0 ? rule.getTrueActions() : rule.getFalseActions();
            if (actions == null) continue;
            for (BizRuleAction a : actions) {
                if (!(a instanceof FormulaAction)) continue;
                Object expression = call(a, "getExpression");
                String body = expression == null ? "" : String.valueOf(expression);
                int eq = body.indexOf('=');
                if (eq <= 0) continue;
                ok &= FormulaCheck.report("biz", "规则 " + rule.getId() + " 的计算公式 " + body.substring(0, eq).trim(),
                        entityKey, FormulaCheck.rule(body.substring(eq + 1).trim(), met), false);
            }
        }
        return ok;
    }

    private static void init(BizRuleAction action, String type, String desc, int seq) {
        action.setId(Uuid8.generateShortUuid());
        action.setActionType(type);
        action.setDescription(desc);
        action.setSeq(seq);
        action.setRET(intEnv("BIZ_ACTION_RET", 253));
        action.setIsv(IsvGuard.ISV);
    }

    private static List<TakeValueId> mappings(String body, EntityMetadata em) {
        List<TakeValueId> out = new ArrayList<TakeValueId>();
        for (String pair : csv(body)) {
            String[] sides = arrow(pair);
            requireSource(em, sides[0]);
            requireTarget(em, sides[1]);
            TakeValueId value = new TakeValueId();
            value.setId(Uuid8.generateShortUuid());
            value.setSrcField(sides[0]);
            value.setSrcFieldName(fieldName(em, first(sides[0])));
            value.setTargetField(sides[1]);
            value.setTargetFieldName(fieldName(em, first(sides[1])));
            value.setOnlyEmptyRow("1".equals(env("BIZ_ONLY_EMPTY", "0")));
            out.add(value);
        }
        return out;
    }

    private static String[] arrow(String pair) {
        int at = pair.indexOf("->");
        if (at <= 0 || at >= pair.length() - 2) {
            throw new IllegalArgumentException("字段映射要写 来源->目标：" + pair);
        }
        return new String[] { pair.substring(0, at).trim(), pair.substring(at + 2).trim() };
    }

    private static void requireSource(EntityMetadata em, String path) {
        String key = first(path);
        if (em.getFieldByKey(key) == null) {
            throw new IllegalArgumentException("实体上找不到来源字段 " + key + "（来自 " + path + "）");
        }
    }

    private static void requireTarget(EntityMetadata em, String path) {
        String key = first(path);
        IsvGuard.assertOwnField(key);
        if (em.getFieldByKey(key) == null) {
            throw new IllegalArgumentException("实体上找不到目标字段 " + key + "（来自 " + path + "）");
        }
    }

    private static String fieldName(EntityMetadata em, String key) {
        Field<?> field = em.getFieldByKey(key);
        return field == null ? key : safe(field.getName());
    }

    private static String first(String path) {
        int dot = path.indexOf('.');
        return (dot < 0 ? path : path.substring(0, dot)).trim();
    }

    private static List<String> csv(String text) {
        List<String> out = new ArrayList<String>();
        for (String item : text.split(",")) {
            if (!item.trim().isEmpty()) out.add(item.trim());
        }
        if (out.isEmpty()) throw new IllegalArgumentException("字段列表为空");
        return out;
    }

    private static int count(String text, String needle) {
        int n = 0;
        int at = -1;
        while ((at = text.indexOf(needle, at + 1)) >= 0) n++;
        return n;
    }

    private static int intEnv(String key, int def) {
        String value = env(key, String.valueOf(def));
        try {
            return Integer.parseInt(value);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(key + " 必须是整数，当前=" + value);
        }
    }

    private static String join(List<String> values, String sep) {
        StringBuilder out = new StringBuilder();
        for (String value : values) {
            if (out.length() > 0) out.append(sep);
            out.append(value);
        }
        return out.toString();
    }

    private static String json(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static void dumpRule(BizRule r) {
        System.out.println("[PROBE] RULE seq=" + r.getSeq() + " id=" + r.getId()
                + " enabled=" + r.isEnabled() + " isv=" + dash(r.getIsv()));
        System.out.println("[PROBE]   name=" + safe(r.getDescription()));
        System.out.println("[PROBE]   condition=" + safe(r.getPreCondition()));
        System.out.println("[PROBE]   conditionDesc=" + safe(r.getPreDescription())
                + " trigger=" + safe(r.getTriggerField()) + " RET=" + r.getRET());
        dumpActions("TRUE", r.getTrueActions());
        dumpActions("FALSE", r.getFalseActions());
    }

    private static void dumpActions(String branch, List<BizRuleAction> actions) {
        int size = actions == null ? 0 : actions.size();
        System.out.println("[PROBE]   " + branch + " actions=" + size);
        if (actions == null) return;
        for (BizRuleAction a : actions) {
            System.out.println("[PROBE]     " + a.getClass().getSimpleName()
                    + " id=" + a.getId() + " type=" + safe(a.getActionType())
                    + " seq=" + a.getSeq() + " RET=" + a.getRET()
                    + " isv=" + dash(a.getIsv()) + " desc=" + safe(a.getDescription()));
            Object expression = call(a, "getExpression");
            Object fieldName = call(a, "getFieldName");
            if (expression != null) {
                System.out.println("[PROBE]       expression=" + format(expression));
            }
            if (fieldName != null) {
                System.out.println("[PROBE]       fieldName=" + format(fieldName));
            }
            try {
                Map<String, Object> runtime = a.buildAction();
                System.out.println("[PROBE]       runtime=" + runtime);
                if (!a.getErrorInfos().isEmpty()) {
                    System.out.println("[PROBE]       !! errors=" + a.getErrorInfos());
                }
            } catch (Throwable e) {
                System.out.println("[PROBE]       runtime 构建失败="
                        + e.getClass().getSimpleName() + ": " + safe(e.getMessage()));
            }
        }
    }

    private static String format(Object value) {
        if (!(value instanceof List)) return safe(value);
        StringBuilder out = new StringBuilder("[");
        for (Object item : (List<?>) value) {
            if (out.length() > 1) out.append(", ");
            if (item instanceof TakeValueId) {
                TakeValueId v = (TakeValueId) item;
                out.append("{").append(v.getSrcField()).append(" -> ")
                        .append(v.getTargetField()).append(", onlyEmpty=")
                        .append(v.getOnlyEmptyRow()).append(", id=").append(v.getId()).append("}");
            } else {
                out.append(safe(item));
            }
        }
        return out.append(']').toString();
    }

    private static Object call(Object target, String name) {
        try {
            Method m = target.getClass().getMethod(name);
            return m.invoke(target);
        } catch (NoSuchMethodException e) {
            return null;
        } catch (Exception e) {
            return "?" + e.getClass().getSimpleName() + ":" + safe(e.getMessage());
        }
    }

    private static String req(String key, String what) {
        String value = System.getenv(key);
        if (value != null && !value.trim().isEmpty()) return value.trim();
        System.out.println("[PROBE] 缺必填参数 " + key + " —— " + what);
        System.out.println("[PROBE] 用法: BIZ_ENTITY=<实体或布局标识> node .claude/skills/long-cosmic-dev/driver.mjs probe BizRuleProbe");
        throw new IllegalArgumentException(key + " 未设置");
    }

    private static String env(String key, String def) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? def : value.trim();
    }

    private static String dash(String value) {
        return value == null || value.isEmpty() ? "-" : value;
    }

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value).replace('\r', ' ').replace('\n', ' ');
    }
}
