import java.io.File;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.entity.EntityType;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.ValueMapItem;
import kd.bos.entity.property.ComboProp;
import kd.bos.entity.property.DecimalProp;

/**
 * 只读：**写值之前**把字段的写入约束一次问清 —— 文本上限、小数精度、下拉合法值。
 * 这三样各自对应一个会让写操作在落库那一刻才失败的坑，而每撞一次就是一轮 30 秒往返：
 *   ① 文本超限 → Data too long for column 'xxx'（多语言字段报的是 t_xxx_l 上的列）
 *   ② 小数没配 scale → 默认 10 位不是 2 位，算出来的值悄悄多出小数位
 *   ③ Combo 写了不在 items 里的值 → 界面显示空白，不报错
 *
 *   LIMIT_ENTITY=单据标识       如 demo_canshu（自动过 MetaResolve，填布局标识也行）
 *   LIMIT_FIELD=字段过滤        可选，逗号分隔的关键字，不传则列出全部有约束的字段
 *   LIMIT_VALUES=字段=值;字段=值 可选，实际校验一组待写的值
 *   LIMIT_VALUE_FILE=文件路径    可选，每行一条「字段=值」；值里含分号时用这个
 */
public class FieldLimitProbe {

    public static void run() throws Exception {
        String entityKey = req("LIMIT_ENTITY");
        List<String> filters = split(System.getenv("LIMIT_FIELD"));
        Map<String, String> values = loadValues();

        MainEntityType type = MetaResolve.type(entityKey);
        System.out.println("[PROBE] 实体 " + type.getName() + "  " + type.getDisplayName()
                + "  表=" + type.getAlias());

        //主表 + 全部分录一起走，分录字段同样会超限
        Map<String, IDataEntityProperty> all = new LinkedHashMap<>();
        for (Map.Entry<String, EntityType> e : type.getAllEntities().entrySet()) {
            String scope = e.getKey();
            boolean printed = false;
            for (Object o : e.getValue().getProperties()) {
                IDataEntityProperty p = (IDataEntityProperty) o;
                String limit = describeLimit(p);
                if (limit == null || !matches(p.getName(), filters)) {
                    continue;
                }
                if (!printed) {
                    System.out.println("[PROBE] --- " + scope + " ---");
                    printed = true;
                }
                System.out.println("[PROBE]   " + pad(p.getName(), 24) + pad(caption(p), 18)
                        + pad(p.getClass().getSimpleName(), 20) + limit);
                all.put(p.getName(), p);
            }
        }
        if (all.isEmpty()) {
            System.out.println("[PROBE] !! 没有匹配到带写入约束的字段"
                    + (filters.isEmpty() ? "" : "（过滤条件 " + filters + "）"));
        }

        if (values.isEmpty()) {
            System.out.println("[PROBE] 未传 LIMIT_VALUES，只列约束。要校验具体值加 LIMIT_VALUES=字段=值;…");
            return;
        }
        System.out.println("[PROBE] --- 值校验 ---");
        int bad = 0;
        for (Map.Entry<String, String> v : values.entrySet()) {
            IDataEntityProperty p = all.get(v.getKey());
            if (p == null) {
                //可能是被 LIMIT_FIELD 滤掉了，也可能这字段压根没约束或不存在
                System.out.println("[PROBE]   ? " + pad(v.getKey(), 24) + "未在上面的约束清单里，跳过");
                continue;
            }
            String err = check(p, v.getValue());
            if (err == null) {
                System.out.println("[PROBE]   OK " + pad(v.getKey(), 24) + "长度 " + v.getValue().length());
            } else {
                bad++;
                System.out.println("[PROBE]   !! " + pad(v.getKey(), 24) + err);
            }
        }
        System.out.println("[PROBE] " + (bad == 0 ? "全部通过，可以写" : bad + " 个字段过不了，先改再写"));
    }

    /**
     * @return 该字段的写入约束描述；没有约束（写值时不会因它失败）返回 null
     */
    private static String describeLimit(IDataEntityProperty p) {
        if (p instanceof ComboProp) {
            List<ValueMapItem> items = ((ComboProp) p).getComboItems();
            StringBuilder sb = new StringBuilder("合法值 " + items.size() + " 个: ");
            for (int i = 0; i < items.size(); i++) {
                ValueMapItem it = items.get(i);
                sb.append(i == 0 ? "" : ", ").append(it.getValue()).append('=').append(text(it.getName()));
            }
            return sb.toString();
        }
        if (p instanceof DecimalProp) {
            DecimalProp d = (DecimalProp) p;
            //scale 没配时苍穹给的默认是 10，不是直觉里的 2
            return "precision=" + d.getPrecision() + " scale=" + d.getScale()
                    + (d.getScale() == 10 ? "   ← 10 位，确认是有意配的还是漏配走了默认" : "");
        }
        int max = maxLength(p);
        return max > 0 ? "最长 " + max : null;
    }

    /**
     * 文本类的上限。TextProp / MuliLangTextProp / LargeTextProp 各有各的继承链，
     * 直接反射拿最省事 —— 注意苍穹这个方法名少一个 g，是 getMaxLenth 不是 getMaxLength。
     */
    private static int maxLength(IDataEntityProperty p) {
        try {
            Method m = p.getClass().getMethod("getMaxLenth");
            Object v = m.invoke(p);
            return v instanceof Integer ? (Integer) v : 0;
        } catch (Exception e) {
            return 0;
        }
    }

    private static String check(IDataEntityProperty p, String value) {
        if (p instanceof ComboProp) {
            for (ValueMapItem it : ((ComboProp) p).getComboItems()) {
                if (it.getValue().equals(value)) {
                    return null;
                }
            }
            return "值「" + value + "」不在 items 里，写进去界面会是空白";
        }
        int max = maxLength(p);
        if (max > 0 && value.length() > max) {
            return "长度 " + value.length() + " > 上限 " + max + "，超 " + (value.length() - max);
        }
        return null;
    }

    private static Map<String, String> loadValues() throws Exception {
        Map<String, String> map = new LinkedHashMap<>();
        String file = System.getenv("LIMIT_VALUE_FILE");
        if (file != null && !file.trim().isEmpty()) {
            for (String line : new String(Files.readAllBytes(new File(file.trim()).toPath()),
                    StandardCharsets.UTF_8).split("\\r?\\n")) {
                put(map, line);
            }
        }
        String inline = System.getenv("LIMIT_VALUES");
        if (inline != null) {
            for (String pair : inline.split(";")) {
                put(map, pair);
            }
        }
        return map;
    }

    private static void put(Map<String, String> map, String pair) {
        int eq = pair.indexOf('=');
        if (eq > 0) {
            map.put(pair.substring(0, eq).trim(), pair.substring(eq + 1));
        }
    }

    private static boolean matches(String name, List<String> filters) {
        if (filters.isEmpty()) {
            return true;
        }
        for (String f : filters) {
            if (name.contains(f)) {
                return true;
            }
        }
        return false;
    }

    private static String caption(IDataEntityProperty p) {
        try {
            Method m = p.getClass().getMethod("getDisplayName");
            return text((LocaleString) m.invoke(p));
        } catch (Exception e) {
            return "";
        }
    }

    private static String text(LocaleString s) {
        return s == null ? "" : String.valueOf(s);
    }

    private static String pad(String s, int w) {
        StringBuilder sb = new StringBuilder(s == null ? "" : s);
        while (sb.length() < w) {
            sb.append(' ');
        }
        return sb.append(' ').toString();
    }

    private static List<String> split(String v) {
        List<String> list = new ArrayList<>();
        if (v != null) {
            for (String s : v.split(",")) {
                if (!s.trim().isEmpty()) {
                    list.add(s.trim());
                }
            }
        }
        return list;
    }

    private static String req(String k) {
        String v = System.getenv(k);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalArgumentException("缺少环境变量 " + k);
        }
        return v.trim();
    }
}
