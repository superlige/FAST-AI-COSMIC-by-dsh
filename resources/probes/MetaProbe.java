import java.util.ArrayList;
import java.util.List;

import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.ValueMapItem;
import kd.bos.entity.property.AmountProp;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.ComboProp;
import kd.bos.entity.property.DateTimeProp;
import kd.bos.entity.property.DecimalProp;
import kd.bos.entity.property.MulBasedataProp;
import kd.bos.entity.property.TimeProp;

/**
 * 元数据探针：打印实体的字段标识、名称、类型、精度、基础资料指向。
 *
 *   META_ENTITY=实体标识   要查的实体（必填）
 *   META_FILTER=关键字     只打印标识或名称含该关键字的字段（字段动辄几百个）；几个关键字用逗号隔开，含任一个就打印
 *
 * 每个打印出来的字段另走 JSON 旁路一行（t=field：key、level=header/entry/subentry、entry、parentEntry、
 * textFormat=打印认的字段类型），
 * 给 meta ptpl edit 核「这张单上有没有这个字段、在哪一层」用：运行态类型带着继承来的原厂字段
 * （billno、creator、auditor……），代码关系表只收设计里的、代码点过名的，查不到不能当「没有」。
 */
public class MetaProbe {

    public static void run() {
        String entity = req("META_ENTITY", "要查的实体或布局标识");
        String filter = env("META_FILTER", "");

        //入参可能是布局标识而不是实体标识，交给 MetaResolve 换算，别直接 getDataEntityType
        MainEntityType t = MetaResolve.type(entity);
        entity = t.getName();
        System.out.println("[PROBE] 实体 " + entity + "  名称=" + t.getDisplayName()
                + "  表=" + t.getAlias() + "  类=" + t.getClass().getSimpleName());
        if (!filter.isEmpty()) {
            System.out.println("[PROBE] 过滤关键字: " + filter);
        }
        int n = dump(t, filter, "  ", new ArrayList<String>());
        System.out.println("[PROBE] 命中字段 " + n + " 个");
        if (n == 0 && !filter.isEmpty()) {
            //0 命中不说清楚是「这张单没有这个字段」还是「关键字写法不对」，就得再跑一轮
            System.out.println("[PROBE] 这张单（含分录）一共 " + dump(t, "", null, new ArrayList<String>()) + " 个字段，"
                    + "关键字一个都没匹配上。META_FILTER 按标识和名称做「包含」匹配、不分大小写，逗号隔开的含任一个就算；"
                    + "不确定就去掉 META_FILTER 看全量");
        }
    }

    /**
     * 标识或名称含任一个关键字就算，不分大小写（中文没有大小写，英文名称按原文比会漏：Number ≠ number）。
     * 关键字按逗号拆开：别的探针字段清单都是逗号隔开的，照那个写法写成「bz,bglx」时整串去比，一个也命中不了，
     * 模型就当字段不存在（真机 2026-10-07 S48 最后复测，多花 3 次调用）。
     */
    static boolean matches(String filter, String name, String disp) {
        if (filter.trim().isEmpty()) {
            return true;
        }
        for (String k : filter.split("[,，]")) {
            String key = k.trim().toLowerCase();
            if (!key.isEmpty() && (name.toLowerCase().contains(key) || disp.toLowerCase().contains(key))) {
                return true;
            }
        }
        return false;
    }

    /**
     * indent 为 null 时只数不打印（0 命中后报总数用，不再刷一屏字段）。
     * entries 是从表头往下走过的分录标识，空就是表头。
     */
    private static int dump(IDataEntityType t, String filter, String indent, List<String> entries) {
        int n = 0;
        for (IDataEntityProperty p : t.getProperties()) {
            // 多选基础资料在运行态继承 DynamicCollectionProperty，所以也实现 ICollectionProperty。
            // 必须先识别它；否则会被下面的通用集合分支误标成【分录】，并只打印中间映射表。
            if (p instanceof MulBasedataProp) {
                String name = p.getName();
                String disp = String.valueOf(p.getDisplayName());
                if (!matches(filter, name, disp)) {
                    continue;
                }
                if (indent != null) {
                    System.out.println("[PROBE]" + indent + name + "  " + disp
                            + "  " + p.getClass().getSimpleName() + detail(p));
                    emitField(name, entries, p);
                }
                n++;
                continue;
            }
            //分录/子分录是集合属性，往里递归一层
            if (p instanceof ICollectionProperty) {
                IDataEntityType item = ((ICollectionProperty) p).getItemType();
                if (indent != null) {
                    System.out.println("[PROBE]" + indent + "【分录】" + p.getName()
                            + "  " + p.getDisplayName() + "  表=" + item.getAlias());
                }
                List<String> inner = new ArrayList<String>(entries);
                inner.add(p.getName());
                n += dump(item, filter, indent == null ? null : indent + "  ", inner);
                continue;
            }
            String name = p.getName();
            String disp = String.valueOf(p.getDisplayName());
            if (!matches(filter, name, disp)) {
                continue;
            }
            if (indent != null) {
                System.out.println("[PROBE]" + indent + name + "  " + disp
                        + "  " + p.getClass().getSimpleName() + detail(p));
                emitField(name, entries, p);
            }
            n++;
        }
        return n;
    }

    private static void emitField(String key, List<String> entries, IDataEntityProperty p) {
        int depth = entries.size();
        ProbeJson.emit("field", "key", key,
                "level", depth == 0 ? "header" : depth == 1 ? "entry" : "subentry",
                "entry", depth == 0 ? "" : entries.get(depth - 1),
                "parentEntry", depth >= 2 ? entries.get(depth - 2) : "",
                "textFormat", printFormat(p));
    }

    /**
     * 打印认的字段类型，和打印设计器拖字段时给的一样（`FormDsBuilder`：日期、日期时间 → Date，时间 → Time，
     * 金额、单价 → Amount，其余小数 → Number，别的都是 Text）。打印公式的校验和取数按它换值。
     */
    private static String printFormat(IDataEntityProperty p) {
        if (p instanceof DateTimeProp) return "Date";
        if (p instanceof TimeProp) return "Time";
        if (p instanceof AmountProp) return "Amount";
        if (p instanceof DecimalProp) return "Number";
        return "Text";
    }

    private static String detail(IDataEntityProperty p) {
        if (p instanceof DecimalProp) {
            DecimalProp d = (DecimalProp) p;
            return "  precision=" + d.getPrecision() + " scale=" + d.getScale();
        }
        if (p instanceof BasedataProp) {
            BasedataProp base = (BasedataProp) p;
            return "  -> " + base.getBaseEntityId() + "  外键="
                    + (base.getRefIdProp() == null ? "(未取得)" : base.getRefIdProp().getName())
                    + "（落库读此外键；跳过复制时对象和外键一起检查）";
        }
        if (p instanceof MulBasedataProp) {
            MulBasedataProp m = (MulBasedataProp) p;
            return "  -> " + m.getBaseEntityId() + "  映射表=" + m.getTableNameProp()
                    + "（多选存集合行；跳过复制时检查集合行）";
        }
        if (p instanceof ComboProp) {
            StringBuilder sb = new StringBuilder("  下拉项:");
            List<ValueMapItem> items = ((ComboProp) p).getComboItems();
            if (items == null || items.isEmpty()) {
                return sb.append("(无)").toString();
            }
            for (ValueMapItem v : items) {
                sb.append(' ').append(v.getValue()).append('=').append(v.getName());
            }
            return sb.toString();
        }
        return "";
    }

    /**
     * 必填的环境变量。没给就打用法后中止 —— 与其塞一个默认标识让人跑出「元数据不存在」
     * （那跟标识拼错、跟账套选错长得一模一样），不如直接说清楚该填什么。
     * 抛异常而不是 System.exit()：后者会带走常驻探针 JVM。
     */
    private static String req(String k, String what) {
        String v = System.getenv(k);
        if (v != null && !v.trim().isEmpty()) {
            return v.trim();
        }
        System.out.println("[PROBE] 缺必填参数 " + k + " —— " + what);
        System.out.println("[PROBE] 用法: META_ENTITY=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe MetaProbe");
        System.out.println("[PROBE] 不知道填什么：本工程的标识一律 <isv>_ 开头，isv 见 driver.mjs doctor");
        throw new IllegalArgumentException(k + " 未设置");
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
