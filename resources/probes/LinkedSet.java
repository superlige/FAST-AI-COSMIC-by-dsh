import java.math.BigDecimal;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.botp.BFTrackerServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;

/**
 * run op 的 `--set @上游.<单据标识>.<字段>=值`（`@下游.` 同理）：跑操作之前把这张单连着的那类单上的字段改成给的值，
 * 跑完、断言判完，照原值改回。不是探针，OpSandbox 每个场景调一次。
 *
 * 为什么要它：验「上游是某个样子时这张单该被拦 / 该放行」，原来每个场景要先用 DataUpdateProbe 改上游、
 * 跑一次、再改回，三次调用（真机 2026-10-07 一次验证 9 轮，4 轮在改上游和改回）。连着的是哪几张单、原值是什么，
 * 探针自己查得到，改回不该靠调用方记。
 *
 * 规矩：
 *   - 连着的单按转换路线记录查（BFTrackerServiceHelper，和 DataQueryProbe 的 @上游 列同一处），所以要配 --pk / --billno：
 *     新建的单还没有连着的单；
 *   - 那类单连着几张就改几张，超过 {@link #MAX_BILLS} 张不跑；
 *   - 直接存库（SaveServiceHelper，不走那类单的校验器和插件，已审核的单也改得了），存完回读，不是新值就不跑；
 *   - 分录字段只改已有的行，不补行：补出来的行改回时删不干净；
 *   - 改回：重新读一遍，字段还是这里设的值才照原值改回；跑的时候被别的改成了别的值（比如提交时插件反写上游），
 *     不覆盖，照实说原值——改回去会抹掉操作自己的结果；
 *   - 改回放在调用方的 finally 里：操作抛异常、断言失败、输入不成立都改回；改回失败打出原值和照原值改回的写法。
 *
 * 字段路径和值的写法同 --set：{@link OpSandbox#wrongPaths} 核路径，{@link ExpectSpec#convert} 转值。
 */
final class LinkedSet {

    /** 一个场景最多改几张连着的单。再多多半是写错了单据类型，或者这张单连着整批单。 */
    static final int MAX_BILLS = 10;

    private static final String UP = "@上游.";
    private static final String DOWN = "@下游.";

    /** 一张连着的单：改哪些字段、原值、改上之后库里的值。 */
    static final class Bill {
        String dir;
        String entity;
        MainEntityType met;
        Long pk;
        String label;
        List<String[]> pairs;
        final List<String> raw = new ArrayList<String>();
        final List<String> shown = new ArrayList<String>();
        final List<String> before = new ArrayList<String>();
        final List<String> set = new ArrayList<String>();
        boolean saved;
    }

    private LinkedSet() {
    }

    /** 拆成两份：[0] 这张单自己的赋值，[1] `@上游.` / `@下游.` 开头的。书写顺序不变。 */
    static String[] split(String spec) {
        StringBuilder own = new StringBuilder();
        StringBuilder linked = new StringBuilder();
        for (String one : (spec == null ? "" : spec).split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            StringBuilder to = s.startsWith("@") ? linked : own;
            if (to.length() > 0) {
                to.append(';');
            }
            to.append(s);
        }
        return new String[]{own.toString(), linked.toString()};
    }

    /**
     * 核写法、找连着的单、记原值、改上、回读。任何一处不成立：已经改上的先改回，逐条记「输入不成立」并抛出，这个场景不跑。
     *
     * @param entity 被验的单据
     * @param pk     被验单据的 pk；空串表示新建的单
     * @param spec   {@link #split} 拆出来的第二份
     */
    static List<Bill> apply(String entity, String pk, String spec) {
        List<Bill> bills = new ArrayList<Bill>();
        if (spec.isEmpty()) {
            return bills;
        }
        List<String[]> problems = new ArrayList<String[]>();
        //按「方向 + 单据」分组：同一类单上的几个字段一次改、一次存
        Map<String, StringBuilder> groups = new LinkedHashMap<String, StringBuilder>();
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            String key = eq > 0 ? s.substring(0, eq).trim() : s;
            boolean known = key.startsWith(UP) || key.startsWith(DOWN);
            String rest = known ? key.substring(UP.length()) : "";
            int dot = rest.indexOf('.');
            if (eq <= 0 || !known || dot <= 0 || dot == rest.length() - 1) {
                problems.add(new String[]{key, "写成 @上游.单据标识.字段=值（分录字段 @上游.单据标识.分录[行].字段=值）"});
                continue;
            }
            String group = key.substring(0, UP.length()) + rest.substring(0, dot);
            StringBuilder fields = groups.get(group);
            if (fields == null) {
                fields = new StringBuilder();
                groups.put(group, fields);
            }
            fields.append(fields.length() == 0 ? "" : ";").append(rest.substring(dot + 1)).append('=')
                    .append(s.substring(eq + 1));
        }
        Long id = null;
        if (problems.isEmpty()) {
            try {
                id = Long.valueOf(pk);
            } catch (NumberFormatException e) {
                problems.add(new String[]{spec, pk.isEmpty()
                        ? "要配 --pk 或 --billno：新建的单还没有连着的单据"
                        : "pk=" + pk + " 不是数字，查不了转换路线记录"});
            }
        }
        if (!problems.isEmpty()) {
            fail(problems);
        }

        for (Map.Entry<String, StringBuilder> g : groups.entrySet()) {
            boolean up = g.getKey().startsWith(UP);
            String dir = up ? "上游" : "下游";
            String linked = g.getKey().substring(UP.length());
            String fields = g.getValue().toString();
            MainEntityType met;
            try {
                met = EntityMetadataCache.getDataEntityType(linked);
            } catch (RuntimeException e) {
                met = null;
            }
            if (met == null) {
                problems.add(new String[]{g.getKey(), "没有单据 " + linked + "（@" + dir + " 后面接连着的那类单的标识）"});
                continue;
            }
            for (String[] w : OpSandbox.wrongPaths(met, fields)) {
                problems.add(new String[]{g.getKey() + "." + w[0], w[1]});
            }
            Map<String, HashSet<Long>> found;
            try {
                found = up ? BFTrackerServiceHelper.findSourceBills(entity, new Long[]{id})
                        : BFTrackerServiceHelper.findTargetBills(entity, new Long[]{id});
            } catch (RuntimeException e) {
                problems.add(new String[]{g.getKey(), "查不出这张单连着的单据：" + OpSandbox.brief(e)});
                continue;
            }
            Set<Long> ids = found == null ? null : found.get(linked);
            if (ids == null || ids.isEmpty()) {
                problems.add(new String[]{g.getKey(), "这张单没有 " + linked + " 的" + dir + "单；" + others(found, dir)});
                continue;
            }
            if (ids.size() > MAX_BILLS) {
                problems.add(new String[]{g.getKey(), "这张单连着 " + ids.size() + " 张 " + linked + "，超过 " + MAX_BILLS
                        + " 张不改；换一张连着的单少的"});
                continue;
            }
            for (Long one : ids) {
                Bill b = new Bill();
                b.dir = dir;
                b.entity = linked;
                b.met = met;
                b.pk = one;
                b.pairs = ExpectSpec.pairs(fields);
                bills.add(b);
            }
        }
        if (!problems.isEmpty()) {
            fail(problems);
        }

        //记原值：分录行要已经有，值要转得过去
        for (Bill b : bills) {
            DynamicObject obj = BusinessDataServiceHelper.loadSingle(b.pk, b.entity);
            String no = DataUpdateProbe.numberOf(obj);
            b.label = no == null ? "pk=" + b.pk : no;
            for (String[] pair : b.pairs) {
                ExpectSpec.Pos pos = ExpectSpec.Pos.parse(pair[0]);
                String where = b.dir + " " + b.entity + " " + b.label + " " + pair[0];
                Object v = DataUpdateProbe.read(obj, pos);
                if (v == DataUpdateProbe.NO_ROW) {
                    problems.add(new String[]{where, "这张单的分录没有这一行；@" + b.dir + " 只改已有的行"});
                    continue;
                }
                try {
                    ExpectSpec.convert(ExpectSpec.propAt(b.met, pos), pair[1]);
                } catch (Throwable t) {
                    problems.add(new String[]{where, "值「" + pair[1].trim() + "」转不过去：" + OpSandbox.brief(t)});
                    continue;
                }
                b.raw.add(rawOf(v));
                b.shown.add(DataUpdateProbe.shown(obj, pos, null));
                b.before.add(same(v));
            }
        }
        if (!problems.isEmpty()) {
            fail(problems);
        }

        //改上、存库、回读。哪一张不成立，已经改上的全部改回
        for (Bill b : bills) {
            String where = b.dir + " " + b.entity + " " + b.label;
            try {
                DynamicObject obj = BusinessDataServiceHelper.loadSingle(b.pk, b.entity);
                System.out.println("[PROBE] 跑之前改" + where + "（直接存库，不走它的校验器和插件；这个场景跑完改回）：");
                List<String> unresolved = new ArrayList<String>();
                for (String[] pair : b.pairs) {
                    OpSandbox.setOne(b.met, obj, pair[0], pair[1].trim(), unresolved);
                }
                if (!unresolved.isEmpty()) {
                    problems.add(new String[]{where, "基础资料没取到：" + String.join("、", unresolved)});
                    break;
                }
                SaveServiceHelper.save(new DynamicObject[]{obj});
                b.saved = true;
                DynamicObject fresh = BusinessDataServiceHelper.loadSingle(b.pk, b.entity);
                for (String[] pair : b.pairs) {
                    ExpectSpec.Pos pos = ExpectSpec.Pos.parse(pair[0]);
                    String got = same(DataUpdateProbe.read(fresh, pos));
                    b.set.add(got);
                    if (!got.equals(same(DataUpdateProbe.read(obj, pos)))) {
                        problems.add(new String[]{where + " " + pair[0], "存完回读是 " + DataUpdateProbe.shown(fresh, pos, null)
                                + "，不是要改成的值"});
                    }
                }
            } catch (Throwable t) {
                problems.add(new String[]{where, "改不上：" + OpSandbox.brief(t)});
            }
            if (!problems.isEmpty()) {
                break;
            }
        }
        if (!problems.isEmpty()) {
            restore(bills);
            fail(problems);
        }
        return bills;
    }

    /** 照原值改回。不抛：改回不成的打出原值和改回的写法，交给调用方的人。 */
    static void restore(List<Bill> bills) {
        for (Bill b : bills) {
            if (!b.saved) {
                continue;
            }
            String where = b.dir + " " + b.entity + " " + b.label;
            List<Integer> back = new ArrayList<Integer>();
            try {
                DynamicObject fresh = BusinessDataServiceHelper.loadSingle(b.pk, b.entity);
                List<String> kept = new ArrayList<String>();
                for (int i = 0; i < b.set.size(); i++) {
                    ExpectSpec.Pos pos = ExpectSpec.Pos.parse(b.pairs.get(i)[0]);
                    String now = same(DataUpdateProbe.read(fresh, pos));
                    if (now.equals(b.before.get(i))) {
                        continue;
                    }
                    if (!now.equals(b.set.get(i))) {
                        kept.add(b.pairs.get(i)[0] + " 现在是 " + DataUpdateProbe.shown(fresh, pos, null) + "（原值 "
                                + b.shown.get(i) + "）");
                        continue;
                    }
                    back.add(i);
                }
                if (!kept.isEmpty()) {
                    System.out.println("[PROBE] ⚠ " + where + " 跑的时候被改过，没改回，免得抹掉操作的结果：" + String.join("；", kept));
                }
                if (back.isEmpty()) {
                    //跑之前说过「跑完改回」，这里要有个交代：设的值本来就和原值一样时，跑完还是原值
                    if (kept.isEmpty()) {
                        System.out.println("[PROBE] " + where + " 跑完都是原值，不用改回");
                    }
                    continue;
                }
                System.out.println("[PROBE] 改回" + where + "：");
                List<String> unresolved = new ArrayList<String>();
                for (int i : back) {
                    OpSandbox.setOne(b.met, fresh, b.pairs.get(i)[0], b.raw.get(i), unresolved);
                }
                SaveServiceHelper.save(new DynamicObject[]{fresh});
                DynamicObject check = BusinessDataServiceHelper.loadSingle(b.pk, b.entity);
                List<String> wrong = new ArrayList<String>();
                for (int i : back) {
                    ExpectSpec.Pos pos = ExpectSpec.Pos.parse(b.pairs.get(i)[0]);
                    if (!same(DataUpdateProbe.read(check, pos)).equals(b.before.get(i))) {
                        wrong.add(b.pairs.get(i)[0] + " 是 " + DataUpdateProbe.shown(check, pos, null) + "（原值 " + b.shown.get(i) + "）");
                    }
                }
                if (wrong.isEmpty()) {
                    System.out.println("[PROBE] 已改回" + where + "，回读都是原值");
                } else {
                    System.out.println("[PROBE] !! " + where + " 改回后回读不是原值：" + String.join("；", wrong) + "。" + manual(b, back));
                }
            } catch (Throwable t) {
                System.out.println("[PROBE] !! " + where + " 没改回（" + OpSandbox.brief(t) + "）。" + manual(b, back));
            }
        }
    }

    /** 改回不成时给的话：原值和照原值改的那条改数写法。 */
    private static String manual(Bill b, List<Integer> back) {
        List<String> sets = new ArrayList<String>();
        List<String> shown = new ArrayList<String>();
        for (int i = 0; i < b.set.size(); i++) {
            if (!back.isEmpty() && !back.contains(i)) {
                continue;
            }
            sets.add(b.pairs.get(i)[0] + "=" + b.raw.get(i));
            shown.add(b.pairs.get(i)[0] + " " + b.shown.get(i));
        }
        return "原值：" + String.join("；", shown) + "；照原值改：DataUpdateProbe UPD_ENTITY=" + b.entity + " UPD_PKS=" + b.pk
                + " UPD_OP=direct UPD_SET=" + String.join(";", sets);
    }

    /** 这张单连着的别的那类单，给「没有这类单」做对照。 */
    private static String others(Map<String, HashSet<Long>> found, String dir) {
        List<String> parts = new ArrayList<String>();
        if (found != null) {
            for (Map.Entry<String, HashSet<Long>> e : found.entrySet()) {
                if (e.getValue() != null && !e.getValue().isEmpty()) {
                    parts.add(e.getKey() + "（" + e.getValue().size() + " 张）");
                }
            }
        }
        return parts.isEmpty() ? "它没有连着任何" + dir + "单（不是下推出来的，或者转换路线记录被删了）"
                : "它连着的" + dir + "单：" + String.join("、", parts);
    }

    /**
     * 原值写回去用的写法，交给 {@link OpSandbox#setOne}，和 --set 走同一套值转换：
     * 基础资料写 pk（纯数字先按 id 查），多选写逗号分隔的 pk，日期写到秒，空写 null。
     */
    static String rawOf(Object v) {
        if (v == null) {
            return "null";
        }
        if (v instanceof DynamicObjectCollection) {
            List<String> ids = new ArrayList<String>();
            for (Object one : (DynamicObjectCollection) v) {
                DynamicObject row = (DynamicObject) one;
                ids.add(String.valueOf(row.getDataEntityType().getProperties().containsKey("fbasedataid")
                        ? row.get("fbasedataid_id") : row.getPkValue()));
            }
            return ids.isEmpty() ? "null" : String.join(",", ids);
        }
        if (v instanceof DynamicObject) {
            return String.valueOf(((DynamicObject) v).getPkValue());
        }
        if (v instanceof Date) {
            return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format((Date) v);
        }
        if (v instanceof BigDecimal) {
            return ((BigDecimal) v).toPlainString();
        }
        String s = String.valueOf(v);
        return s.trim().isEmpty() ? "null" : s;
    }

    /** 比「是不是同一个值」：同 DataUpdateProbe 的比法，日期只比到秒（写回去的写法只到秒）。 */
    private static String same(Object v) {
        if (v instanceof Date) {
            return String.valueOf(((Date) v).getTime() / 1000);
        }
        return DataUpdateProbe.stable(v);
    }

    private static void fail(List<String[]> problems) {
        for (String[] p : problems) {
            ProbeAssert.inputInvalid("op-set", p[0], p[1]);
        }
        throw new ProbeAssert.InputInvalid("--set @上游 / @下游 有 " + problems.size() + " 处不成立，这个场景没跑");
    }
}
