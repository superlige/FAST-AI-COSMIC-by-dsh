import java.beans.Introspector;
import java.beans.PropertyDescriptor;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import com.fasterxml.jackson.databind.ObjectMapper;

import kd.bos.designer.property.setting.MetaPropertyService;
import kd.bos.designer.property.setting.PropertySchema;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataSerializer;
import kd.bos.metadata.dao.EntityMetadataUtil;
import kd.bos.metadata.domainmodel.DomainModelType;
import kd.bos.metadata.domainmodel.ElementType;
import kd.bos.metadata.domainmodel.Property;
import kd.bos.metadata.entity.EntityItem;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.form.AbstractStyle;
import kd.bos.metadata.form.BillFormAp;
import kd.bos.metadata.form.Border;
import kd.bos.metadata.form.ContainerAp;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.form.Margin;
import kd.bos.metadata.form.Padding;
import kd.bos.metadata.form.Style;
import kd.bos.metadata.form.control.ButtonAp;
import kd.bos.metadata.form.control.EntryAp;
import kd.bos.metadata.form.control.FieldAp;

/**
 * 只读：单据布局（界面上的面板、页签、控件怎么摆、长什么样）按需读。
 *
 *   LAYOUT_FORM=demo_sys_bgjl        单据或布局标识，必填。只给它：列布局目录，一行一个容器或附件面板这类控件，字段和按钮只报个数；分录里的字段组不展开
 *   LAYOUT_NODE=fs_baseinfo,advconap  列这几个容器下面的全部控件（缩进表示层级），每个控件带类型、名称和设计器里改过的属性
 *   LAYOUT_FIND=审核                  按标识或名称找控件和字段（不分大小写），打出它从最外层到自己的整条位置
 *   LAYOUT_PROPS=fs_baseinfo,auditor  列这几个元素在设计器属性面板上能改的属性：当前值、默认值、可选值、上下限；标 [挡住] [只读] [改不了] 的 set 改不了
 *   LAYOUT_ONLY_PROPS=Lock,Invisible  只看这几项属性：和 LAYOUT_PROPS 一起，每个元素只答这几项；和 LAYOUT_NODE 一起，
 *                                    容器和它下面的每个控件逐个答「能设」带当前值、可选值，或「设不了」带原因
 *   LAYOUT_PART=list                  NODE、PROPS 在哪份布局上找：list 电脑端列表，mobile 单据带的移动端布局，mobilelist 移动端列表，不给是单据电脑端布局。
 *                                    几份布局的控件标识会重名（billno、tbmain）；FIND 不用它，几份都找，结果标着在哪份上
 *   LAYOUT_FILTER_FIELDS=1             列平台可用于过滤的字段配置，供列表常用过滤和快捷搜索选字段；不写元数据
 *   LAYOUT_LIST_FIELDS=1               列可显示的完整字段路径、名称和电脑端列类型；加列表列用路径，定位已有列用列控件标识
 *
 * NODE、FIND、PROPS 可以一起给，一次跑完。
 * 「能不能设」和写探针 FormLayoutWriteProbe 的 set 用同一个方法判：这里说能设的，试算不会因为这项属性本身被拒。
 * 「改过的属性」取自平台存库用的序列化：没列出来的属性就是默认值。
 * 属性清单是平台属性面板的定义，按设计器的隐藏条件去掉了对这个元素不显示的属性（例如文本字段不列图片裁剪）。
 */
public class FormLayoutProbe {

    /**
     * 不能按属性改的，写探针 FormLayoutWriteProbe 用同一份：
     * 标识、数据库列名、分录表名——改了代码、规则、打印模板都对不上，列和表找不到；
     * 元素类型——平台认不出的类型悄悄换成通用容器；所在容器、序号——位置用 move 改，那里核对目标和分录边界。
     */
    static final Set<String> BLOCKED = new HashSet<String>(Arrays.asList(
            "key", "fieldname", "tablename", "containertype", "parentid", "index"));
    /** 每个控件都有、单独列出来的：不进「改过的属性」。 */
    static final Set<String> BOOKKEEPING = new HashSet<String>(Arrays.asList(
            "ParentId", "_Type_", "Id", "IsvFlag", "Key", "Name", "Index", "Inherit", "FieldId", "EntryId"));
    static final ObjectMapper OM = new ObjectMapper();

    public static void run() throws Exception {
        String form = req("LAYOUT_FORM", "单据或布局标识");
        entity = null;
        entityById = null;
        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (formId == null || formId.isEmpty()) {
            throw new IllegalArgumentException("布局不存在: " + form);
        }
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        Tree tree = new Tree(fm, new MetadataSerializer(fm.getModelType()).serializeToMap(fm));
        Tree list = listTree(fm);
        Tree mob = nestedTree(fm, "mobile");
        Tree mobList = nestedTree(fm, "mobilelist");
        entity(fm);
        if ("1".equals(env("LAYOUT_LIST_FIELDS", ""))) {
            p("可用列表字段（Id 是字段路径，布局目录里的控件标识用于定位已有列）：");
            for (Map<String, Object> node : columnNodes(EntityMetadataUtil.getlistFieldTree(entity(fm), 3, false, true))) {
                p("Id=" + node.get("Id") + "  Name=" + node.get("Name") + "  Type=" + node.get("Type"));
            }
            return;
        }
        if ("1".equals(env("LAYOUT_FILTER_FIELDS", ""))) {
            p("可用过滤字段（Id 是字段路径，类型和选项由平台提供）：");
            filterFields(EntityMetadataUtil.getlistFieldTree(entity(fm), 3, false, true));
            return;
        }
        String partName = env("LAYOUT_PART", "").trim().toLowerCase();
        part = null;
        if (!partName.isEmpty() && !"bill".equals(partName)) {
            if (!"list".equals(partName) && !"mobile".equals(partName) && !"mobilelist".equals(partName)) {
                throw new IllegalArgumentException("LAYOUT_PART 只能是 list、mobile、mobilelist 或 bill，给的是 " + partName);
            }
            part = "list".equals(partName) ? list : "mobile".equals(partName) ? mob : mobList;
            if (part == null) {
                p("布局 " + form + " 没有" + ("list".equals(partName) ? "电脑端列表" : "mobile".equals(partName) ? "移动端布局" : "移动端列表"));
                return;
            }
        }

        List<String> nodes = list(env("LAYOUT_NODE", ""));
        String find = env("LAYOUT_FIND", "");
        List<String> props = list(env("LAYOUT_PROPS", ""));
        List<String> only = list(env("LAYOUT_ONLY_PROPS", ""));
        p("布局 " + form + "  控件 " + (tree.byId.size() - 1) + " 个" + (list == null ? "" : "，列表布局另有 " + (list.byId.size() - 1) + " 个")
                + (mob == null ? "" : "，移动端布局 " + (mob.byId.size() - 1) + " 个") + (mobList == null ? "" : "，移动端列表 " + (mobList.byId.size() - 1) + " 个"));
        if (nodes.isEmpty() && find.isEmpty() && props.isEmpty()) {
            if (part == null || part == list) {
                if (part == null) {
                    p("布局目录（「n 控件」是这一层直接装的字段和按钮数）：");
                    outline(tree, tree.root, 0, false);
                }
                if (list != null) {
                    p("列表布局（跟着单据布局一起存；看控件和属性给 LAYOUT_PART=list）：");
                    outline(list, list.root, 0, true);
                }
            }
            if (mob != null && (part == null || part == mob)) {
                p("移动端布局（跟着单据布局一起存；看控件和属性给 LAYOUT_PART=mobile）：");
                outline(mob, mob.root, 0, false);
            }
            if (mobList != null && (part == null || part == mobList)) {
                p("移动端列表（跟着单据布局一起存；看控件和属性给 LAYOUT_PART=mobilelist）：");
                outline(mobList, mobList.root, 0, true);
            }
        }
        for (String key : nodes) {
            Tree in = part != null ? (part.byKey.containsKey(key.toLowerCase()) ? part : null) : treeOf(tree, list, key);
            ControlAp<?> node = in == null ? null : in.byKey.get(key.toLowerCase());
            if (node == null) {
                p("没有控件 " + key + "；用 LAYOUT_FIND 按名称找");
                continue;
            }
            if (only.isEmpty()) {
                p("── " + key + " 下的控件");
                subtree(in, node, 0);
            } else {
                p("── " + key + " 和它下面的控件，只看 " + String.join("、", only));
                askTree(form, fm, tree, list, in, node, 0, only, new HashMap<String, String>());
            }
        }
        if (!find.isEmpty()) {
            List<Tree> all = new ArrayList<Tree>(Arrays.asList(tree));
            for (Tree t : new Tree[] {list, mob, mobList}) {
                if (t != null) all.add(t);
            }
            find(tree, fm, find, all);
        }
        for (String key : props) {
            if (only.isEmpty()) props(form, fm, tree, key, list);
            else ask(form, fm, tree, list, key, only);
        }
    }

    static List<Map<String, Object>> columnNodes(Map<String, Object> tree) {
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        collectColumns(tree, out);
        return out;
    }

    @SuppressWarnings("unchecked")
    static void collectColumns(Map<String, Object> node, List<Map<String, Object>> out) {
        if (node == null) return;
        if (String.valueOf(node.get("Type")).endsWith("ColumnAp")) out.add(node);
        Object items = node.get("Items");
        if (items instanceof List) for (Object item : (List<?>) items) {
            if (item instanceof Map) collectColumns((Map<String, Object>) item, out);
        }
    }

    @SuppressWarnings("unchecked")
    static void filterFields(Map<String, Object> node) throws Exception {
        if (node == null) return;
        if (node.containsKey("FilterApType") || node.containsKey("CommonFilterApType")) {
            Map<String, Object> field = new LinkedHashMap<String, Object>(node);
            field.remove("Items");
            p(OM.writeValueAsString(field));
        }
        Object children = node.get("Items");
        if (children instanceof List) for (Object child : (List<?>) children) {
            if (child instanceof Map) filterFields((Map<String, Object>) child);
        }
    }

    /**
     * 单据的列表布局：塞在单据布局（BillFormAp）里的另一份布局，跟着单据布局一起存，开发平台在同一个设计器里改它。
     * 列表工具栏的按钮、列表列都在这里；平台的属性清单服务不认它的元素（S42 §16.8）。没有就是 null。
     */
    static Tree listTree(FormMetadata fm) {
        if (!(fm.getRootAp() instanceof BillFormAp)) return null;
        FormMetadata list = ((BillFormAp) fm.getRootAp()).getListMeta();
        if (list == null || list.getRootAp() == null) return null;
        Tree t = new Tree(list, new MetadataSerializer(list.getModelType()).serializeToMap(list));
        t.title = "列表布局 ";
        return t;
    }

    /**
     * 单据里塞着的移动端布局（MobMeta）、移动端列表布局（MobListMeta）：跟着单据布局一起存，开发平台在移动端设计器里改。
     * 独立的移动单据也是 BillFormAp 的子类，它自己就是移动端布局，不再往里找。没有是 null。
     */
    static Tree nestedTree(FormMetadata fm, String name) {
        if (!(fm.getRootAp() instanceof BillFormAp) || fm.getRootAp().getClass().getSimpleName().startsWith("Mobile")) return null;
        BillFormAp root = (BillFormAp) fm.getRootAp();
        FormMetadata m = "mobile".equals(name) ? root.getMobMeta() : root.getMobListMeta();
        if (m == null || m.getRootAp() == null) return null;
        Tree t = new Tree(m, new MetadataSerializer(m.getModelType()).serializeToMap(m));
        t.title = "mobile".equals(name) ? "移动端布局 " : "移动端列表 ";
        return t;
    }

    /** LAYOUT_PART 给了时 NODE、PROPS 只在这一份上找；没给是 null。 */
    static Tree part;

    /** 标识在哪份布局上：先单据布局，再列表布局。都没有是 null。 */
    static Tree treeOf(Tree bill, Tree list, String key) {
        String k = key.toLowerCase();
        if (bill.byKey.containsKey(k)) return bill;
        return list != null && list.byKey.containsKey(k) ? list : null;
    }

    // ---------- 布局树 ----------

    static final class Tree {
        final FormMetadata fm;
        final ControlAp<?> root;
        final Map<String, ControlAp<?>> byId = new HashMap<String, ControlAp<?>>();
        final Map<String, ControlAp<?>> byKey = new HashMap<String, ControlAp<?>>();
        final Map<String, List<ControlAp<?>>> children = new HashMap<String, List<ControlAp<?>>>();
        final Map<String, Map<String, Object>> saved = new HashMap<String, Map<String, Object>>();
        /** 输出里标在哪份布局上：电脑端是空串。 */
        String title = "";

        @SuppressWarnings("unchecked")
        Tree(FormMetadata fm, Map<String, Object> serialized) {
            this.fm = fm;
            root = fm.getRootAp();
            for (ControlAp<?> c : fm.getItems()) {
                byId.put(c.getId(), c);
                if (c.getKey() != null) byKey.put(c.getKey().toLowerCase(), c);
            }
            // 父节点没记（平台保存时才补）或指向不存在的，都挂在最外层
            for (ControlAp<?> c : fm.getItems()) {
                if (c == root) continue;
                String parent = c.getParentId();
                if (parent == null || !byId.containsKey(parent)) parent = root.getId();
                List<ControlAp<?>> kids = children.get(parent);
                if (kids == null) children.put(parent, kids = new ArrayList<ControlAp<?>>());
                kids.add(c);
            }
            for (List<ControlAp<?>> kids : children.values()) {
                Collections.sort(kids, (a, b) -> Integer.compare(a.getIndex(), b.getIndex()));
            }
            Object items = serialized.get("Items");
            if (items instanceof List) {
                for (Object o : (List<Object>) items) {
                    if (o instanceof Map && ((Map<String, Object>) o).get("Id") != null) {
                        saved.put(String.valueOf(((Map<String, Object>) o).get("Id")), (Map<String, Object>) o);
                    }
                }
            }
        }

        List<ControlAp<?>> kids(ControlAp<?> c) {
            List<ControlAp<?>> k = children.get(c.getId());
            return k == null ? Collections.<ControlAp<?>>emptyList() : k;
        }

        ControlAp<?> parent(ControlAp<?> c) {
            if (c == root) return null;
            ControlAp<?> p = byId.get(c.getParentId());
            return p == null ? root : p;
        }
    }

    /**
     * 字段和按钮只报个数（字段归 MetaProbe 列，按钮在工具栏容器里）；附件面板、图标、标签这类单个控件照容器一样一行一个，
     * 不然「内容区 1 控件」看不出那一个就是附件面板，会再加一个重复的。
     */
    /** leavesOnly：列表布局的过滤列、列表列、按钮都只报个数，只列容器。 */
    static void outline(Tree t, ControlAp<?> c, int depth, boolean leavesOnly) {
        int leaves = 0;
        int groups = 0;
        int total = count(t, c);
        List<ControlAp<?>> listed = new ArrayList<ControlAp<?>>();
        for (ControlAp<?> k : t.kids(c)) {
            if (isContainer(t, k)) groups++;
            else if (leavesOnly || k instanceof FieldAp || k instanceof ButtonAp) {
                leaves++;
                continue;
            }
            listed.add(k);
        }
        // 分录里的字段组不展开：分录内部用 LAYOUT_NODE 看
        boolean entry = c instanceof EntryAp;
        p(indent(depth) + c.getKey() + "  " + type(c) + "  " + name(c)
                + (leaves > 0 ? "  " + leaves + " 控件" : "") + (entry && groups > 0 ? "  " + groups + " 组" : "")
                + (total > leaves ? "  （共 " + total + "）" : ""));
        if (entry) return;
        for (ControlAp<?> k : listed) {
            if (isContainer(t, k)) outline(t, k, depth + 1, leavesOnly);
            else p(indent(depth + 1) + k.getKey() + "  " + type(k) + "  " + name(k));
        }
    }

    static void subtree(Tree t, ControlAp<?> c, int depth) {
        p(indent(depth) + line(t, c));
        for (ControlAp<?> k : t.kids(c)) subtree(t, k, depth + 1);
    }

    static int count(Tree t, ControlAp<?> c) {
        int n = 0;
        for (ControlAp<?> k : t.kids(c)) n += 1 + count(t, k);
        return n;
    }

    static boolean isContainer(Tree t, ControlAp<?> c) {
        return c instanceof ContainerAp || !t.kids(c).isEmpty();
    }

    static String line(Tree t, ControlAp<?> c) {
        StringBuilder sb = new StringBuilder();
        sb.append(c.getKey()).append("  ").append(type(c));
        String ft = fieldType(t, c);
        if (ft != null) sb.append("(").append(ft).append(")");
        sb.append("  ").append(name(c));
        String set = setProps(t.saved.get(c.getId()));
        if (!set.isEmpty()) sb.append("  ").append(set);
        return sb.toString();
    }

    /** 设计器里改过的属性：序列化只写非默认值，去掉每个控件都有的几项和空串。 */
    static String setProps(Map<String, Object> saved) {
        if (saved == null) return "";
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, Object> e : saved.entrySet()) {
            Object v = e.getValue();
            if (BOOKKEEPING.contains(e.getKey()) || v == null || "".equals(v)) continue;
            if (sb.length() > 0) sb.append(" ");
            sb.append(e.getKey()).append("=").append(clip(v instanceof String ? (String) v : json(v), 120));
        }
        return sb.toString();
    }

    // ---------- 找位置 ----------

    static void find(Tree t, FormMetadata fm, String word, List<Tree> trees) throws Exception {
        String w = word.toLowerCase();
        int hits = 0;
        p("── 找「" + word + "」");
        for (Tree in : trees) {
            for (ControlAp<?> c : in.fm.getItems()) {
                if (c == in.root && in != t) continue;
                if (!contains(c.getKey(), w) && !contains(name(c), w)) continue;
                hits++;
                // 最外层省掉；上面各层只写标识，直接上级带名称
                StringBuilder path = new StringBuilder(in.title.isEmpty() ? "" : in.title + "> ");
                int at = path.length();
                ControlAp<?> up = in.parent(c);
                for (ControlAp<?> x = up; x != null && x != in.root; x = in.parent(x)) {
                    path.insert(at, x.getKey() + (x == up ? "(" + name(x) + ")" : "") + " > ");
                }
                p("  " + path + line(in, c));
            }
        }
        EntityMetadata em = entity(fm);
        if (em != null) {
            for (EntityItem<?> it : em.getItems()) {
                if (!contains(it.getKey(), w) && !contains(str(it.getName()), w)) continue;
                if (t.byKey.containsKey(String.valueOf(it.getKey()).toLowerCase())) continue;
                hits++;
                p("  字段 " + it.getKey() + "  " + it.getClass().getSimpleName() + "  " + str(it.getName()) + "  （这张布局上没有控件）");
            }
        }
        p("  命中 " + hits);
    }

    // ---------- 属性清单 ----------

    static void props(String form, FormMetadata fm, Tree bill, String key, Tree list) throws Exception {
        Elem e = elem(form, fm, bill, list, key);
        if (e.schema.isEmpty()) {
            p("── " + key + " 没有属性清单：标识不在这张布局上，用 LAYOUT_FIND 找");
            return;
        }
        List<String> absent = new ArrayList<String>();
        Map<String, List<PropertySchema>> groups = new LinkedHashMap<String, List<PropertySchema>>();
        for (PropertySchema s : e.schema) {
            if ("_Type_".equals(s.getPropertyName())) continue;
            if (e.hidden(s.getPropertyName())) {
                absent.add(s.getPropertyName());
                continue;
            }
            String g = s.getGroupName() == null ? "" : s.getGroupName();
            if (!groups.containsKey(g)) groups.put(g, new ArrayList<PropertySchema>());
            groups.get(g).add(s);
        }
        p(head(e, bill) + "  属性 " + (e.schema.size() - absent.size()) + " 项"
                + (absent.isEmpty() ? "" : "（另有 " + absent.size() + " 项设计器对这类元素不显示，不列）"));
        for (Map.Entry<String, List<PropertySchema>> g : groups.entrySet()) {
            p("  [" + g.getKey() + "]");
            for (PropertySchema s : g.getValue()) {
                p("    " + s.getPropertyName() + "「" + s.getDisplayName() + "」 " + s.getEditorType() + tag(target(e, s)) + values(s, e.saved));
            }
        }
    }

    static String head(Elem e, Tree bill) {
        return "── " + e.tree.title + e.key + (e.ap == null ? "" : "  " + e.apType + "  " + name(e.ap))
                + (e.fieldType == null ? "" : "  字段类型 " + e.fieldType);
    }

    /** 属性行后面的标记：set 改不了的标出来，原因用 LAYOUT_ONLY_PROPS 查，和试算被拒时说的同一句。 */
    static String tag(Target t) {
        if (t.why == null) return "";
        if (BLOCKED.contains(t.prop.toLowerCase())) return " [挡住]";
        if (!t.editable) return " [只读]";
        return t.template ? " [模板字段不能改]" : " [改不了]";
    }

    // ---------- 只看几项属性 ----------

    /** LAYOUT_PROPS 和 LAYOUT_ONLY_PROPS 一起给：这个元素只答这几项。 */
    static void ask(String form, FormMetadata fm, Tree bill, Tree list, String key, List<String> only) throws Exception {
        Elem e = elem(form, fm, bill, list, key);
        if (e.schema.isEmpty()) {
            p("── " + key + " 没有属性清单：标识不在这张布局上，用 LAYOUT_FIND 找");
            return;
        }
        p(head(e, bill));
        for (String prop : only) p("    " + answer(e, prop, null));
    }

    /** LAYOUT_NODE 和 LAYOUT_ONLY_PROPS 一起给：容器和它下面的控件逐个答。lastOptions 记每项属性上一次列的可选值，相同的写「可选同上」。 */
    static void askTree(String form, FormMetadata fm, Tree bill, Tree list, Tree in, ControlAp<?> c, int depth, List<String> only,
            Map<String, String> lastOptions) throws Exception {
        Elem e = elem(form, fm, bill, list, c.getKey());
        String ft = fieldType(in, c);
        String head = indent(depth) + c.getKey() + "  " + type(c) + (ft == null ? "" : "(" + ft + ")") + "  " + name(c);
        if (e.schema.isEmpty() || e.ap != c) {
            p(head + "  没有属性清单");
        } else if (only.size() == 1) {
            p(head + "  " + answer(e, only.get(0), lastOptions));
        } else {
            p(head);
            for (String prop : only) p(indent(depth + 1) + answer(e, prop, lastOptions));
        }
        for (ControlAp<?> k : in.kids(c)) askTree(form, fm, bill, list, in, k, depth + 1, only, lastOptions);
    }

    /** 一项属性：能设带当前值、默认值、可选值、上下限；设不了带原因，和试算被拒时说的同一句。 */
    static String answer(Elem e, String prop, Map<String, String> lastOptions) throws Exception {
        PropertySchema s = null;
        for (PropertySchema x : e.schema) {
            if (x.getPropertyName().equalsIgnoreCase(prop)) s = x;
        }
        if (s == null) return prop + "：设不了，属性清单里没有这一项";
        Target t = target(e, s);
        if (t.why != null) return s.getPropertyName() + "：设不了，" + t.why;
        String detail = values(s, e.saved);
        String opts = options(s);
        if (lastOptions != null && !opts.isEmpty()) {
            String k = s.getPropertyName().toLowerCase();
            if (opts.equals(lastOptions.get(k))) detail = detail.replace(" 可选=" + opts, " 可选同上");
            else lastOptions.put(k, opts);
        }
        return s.getPropertyName() + "「" + s.getDisplayName() + "」：能设" + detail;
    }

    /** saved 是这个元素存库的那份（只写非默认值）：现算的属性清单不带当前值，从这里补。 */
    static String values(PropertySchema s, Map<String, Object> saved) {
        StringBuilder sb = new StringBuilder();
        Object cur = s.getCurrentValue();
        if (blank(cur) && saved != null) cur = saved.get(s.getPropertyName());
        Object def = s.getDefaultValue();
        if ("style".equalsIgnoreCase(s.getPropertyName())) {
            //边框样式整份给全，写法和 set 收的一样：只改一条边时要看得到别的边是什么
            String now = styleText(cur);
            String was = styleText(def);
            if (!now.isEmpty()) sb.append(" 当前=").append(now);
            if (!was.isEmpty() && !was.equals(now)) sb.append(" 默认=").append(was);
            return sb.toString();
        }
        if (!blank(cur)) sb.append(" 当前=").append(clip(show(cur), 80));
        if (!blank(def) && !String.valueOf(def).equals(String.valueOf(cur))) sb.append(" 默认=").append(clip(show(def), 40));
        String opts = options(s);
        if (!opts.isEmpty()) sb.append(" 可选=").append(opts);
        Map<String, Object> c = s.getConstraints();
        if (c != null && !c.isEmpty()) sb.append(" 限制=").append(clip(json(c), 120));
        return sb.toString();
    }

    static String options(PropertySchema s) {
        List<Map<String, Object>> options = s.getOptions();
        if (options == null || options.isEmpty()) return "";
        List<String> o = new ArrayList<String>();
        for (Map<String, Object> m : options) {
            Object v = m.get("id");
            Object label = m.get("name");
            o.add(label == null || String.valueOf(label).equals(String.valueOf(v)) ? String.valueOf(v) : v + ":" + label);
        }
        return clip(String.join("|", o), 200);
    }

    // ---------- 能不能设：写探针同一套 ----------

    /** 一个元素：属性清单，和判断「能不能设」要用的控件、字段、类型。没有属性清单时 schema 为空。 */
    static final class Elem {
        String key;
        Tree tree;
        ControlAp<?> ap;
        /** 同标识的字段（实体上的）；列表布局上的元素没有。 */
        Object field;
        String apType;
        String fieldType;
        String parentType;
        List<PropertySchema> schema = Collections.emptyList();
        Map<String, Map<String, Object>> hides = Collections.emptyMap();
        Map<String, Object> saved;

        boolean hidden(String prop) {
            return FormLayoutProbe.hidden(hides.get(prop.toLowerCase()), apType, fieldType, parentType);
        }
    }

    static Elem elem(String form, FormMetadata fm, Tree bill, Tree list, String key) throws Exception {
        if (part != null) return elemIn(part, key);
        Elem e = new Elem();
        e.key = key;
        e.tree = bill;
        List<PropertySchema> schema = MetaPropertyService.getPropertySchema(form, key);
        if ((schema == null || schema.isEmpty()) && list != null && treeOf(bill, list, key) == list) {
            e.tree = list;
            schema = schemaOf(list.byKey.get(key.toLowerCase()), null, list.fm.getModelType());
        }
        if (schema == null || schema.isEmpty()) return e;
        e.schema = schema;
        e.ap = e.tree.byKey.get(key.toLowerCase());
        e.apType = e.ap == null ? null : type(e.ap);
        e.fieldType = e.ap == null ? null : fieldType(e.tree, e.ap);
        if (e.tree == bill) e.field = entityItem(fm, key);
        if (e.fieldType == null && e.field != null) e.fieldType = e.field.getClass().getSimpleName();
        ControlAp<?> parent = e.ap == null ? null : e.tree.parent(e.ap);
        e.parentType = parent == null ? null : type(parent);
        e.hides = hides(e.tree.fm, e.apType, e.fieldType);
        e.saved = e.ap == null ? null : e.tree.saved.get(e.ap.getId());
        return e;
    }

    /**
     * 移动端那两份上的元素：平台的属性清单服务按标识在电脑端布局上找，同名控件会答成电脑端那个，按这份上的控件现算。
     * 字段控件和设计器一样：字段类型的属性加控件类型的属性，字段本身的属性落在字段上（和写探针 set 同一套）。
     */
    static Elem elemIn(Tree t, String key) throws Exception {
        Elem e = new Elem();
        e.key = key;
        e.tree = t;
        ControlAp<?> ap = t.byKey.get(key.toLowerCase());
        if (ap == null) return e;
        EntityItem<?> field = null;
        if (ap instanceof FieldAp && entity != null) {
            String fid = ((FieldAp) ap).getFieldId();
            for (EntityItem<?> it : entity.getItems()) {
                if (it.getId().equals(fid)) field = it;
            }
        }
        List<PropertySchema> schema = field != null ? schemaOf(field, ap, t.fm.getModelType()) : schemaOf(ap, null, t.fm.getModelType());
        if (schema == null || schema.isEmpty()) return e;
        e.schema = schema;
        e.ap = ap;
        e.field = field;
        e.apType = type(ap);
        e.fieldType = field == null ? null : field.getClass().getSimpleName();
        ControlAp<?> parent = t.parent(ap);
        e.parentType = parent == null ? null : type(parent);
        e.hides = hides(t.fm, e.apType, e.fieldType);
        e.saved = t.saved.get(ap.getId());
        return e;
    }

    static Target target(Elem e, PropertySchema s) throws Exception {
        return target(e.key, s, e.hidden(s.getPropertyName()), e.field, e.ap);
    }

    /** set 落到哪个对象的哪个属性上；why 不为空就是改不了，写的是原因。 */
    static final class Target {
        String prop;
        boolean editable = true;
        boolean template;
        String why;
        Object bean;
        PropertyDescriptor pd;
    }

    /**
     * 这项属性用 set 改不改得了。写探针 FormLayoutWriteProbe 的 set 调的就是这个方法，这里查到的和试算拒的是同一套判法、同一个顺序。
     * field 是同标识的字段（实体上的），ap 是布局控件：和设计器一样，先落在字段上，字段上没有可写的同名属性再落在控件上。
     */
    static Target target(String key, PropertySchema s, boolean hidden, Object field, ControlAp<?> ap) throws Exception {
        Target t = new Target();
        String name = s.getPropertyName();
        String n = name.toLowerCase();
        t.prop = name;
        if (ap instanceof kd.bos.metadata.filter.FilterColumnAp && (n.equals("type") || n.equals("custom"))) {
            t.why = name + " 由过滤字段类型决定，不能单独改；换字段用 remove 撤下筛选控件，再用 show filter 添加";
            return t;
        }
        //多选基础资料的表名空着时可以填：还没有关系表，也就没有存下的值会对不上（平台保存时也要求它非空）
        boolean fillTable = n.equals("tablename") && field instanceof kd.bos.metadata.entity.businessfield.MulBasedataField
                && blank(((kd.bos.metadata.entity.businessfield.MulBasedataField) field).getTableName());
        if (BLOCKED.contains(n) && !fillTable) {
            t.why = name + (n.equals("parentid") || n.equals("index") ? " 是位置，用 move 改"
                    : n.equals("containertype") ? " 是元素类型，不能改"
                    : " 是标识、数据库列名或表名，改了代码、规则、打印模板都对不上，不能改");
            return t;
        }
        if (!s.isEditable()) {
            t.editable = false;
            t.why = name + " 在设计器里是只读的";
            return t;
        }
        if (hidden) {
            t.why = "设计器对 " + key + " 这类元素不显示 " + name + "，改了不生效";
            return t;
        }
        for (Object candidate : new Object[] {field, ap}) {
            PropertyDescriptor d = candidate == null ? null : descriptor(candidate, name);
            if (d != null && d.getWriteMethod() != null) {
                t.bean = candidate;
                t.pd = d;
                break;
            }
        }
        if (t.bean == null) {
            t.why = "属性清单里有 " + name + "，但 " + key + " 的字段和控件对象上都没有可写的同名属性，这个入口改不了";
        } else if (!(t.bean instanceof ControlAp) && !key.toLowerCase().startsWith(IsvGuard.PREFIX)) {
            t.template = true;
            t.why = name + " 是字段本身的属性，" + key + " 没有 " + IsvGuard.PREFIX
                    + " 前缀，是模板或标准产品带来的字段，字段本身不能改";
        }
        return t;
    }

    static PropertyDescriptor descriptor(Object o, String name) throws Exception {
        for (PropertyDescriptor pd : Introspector.getBeanInfo(o.getClass(), Object.class).getPropertyDescriptors()) {
            if (pd.getName().equalsIgnoreCase(name)) return pd;
        }
        return null;
    }

    /**
     * 属性清单服务找不到的元素（新加的控件、字段，列表布局上的元素），按它的类型现算属性清单。
     * 平台对控件走两步：按控件类型取设计器属性面板的定义，再补上类里带注解的属性；对字段是字段类型的定义加上
     * 它的控件类型（表头 FieldAp、分录 EntryFieldAp）的定义（读平台代码确认）。这里照走同样几步。
     */
    static List<PropertySchema> schemaOf(Object el, ControlAp<?> fieldAp, String modelType) throws Exception {
        List<PropertySchema> out = new ArrayList<PropertySchema>();
        DomainModelType dmt = DomainModelType.getDomainModelType(modelType, true);
        if (dmt == null || el == null) return out;
        Method groups = MetaPropertyService.class.getDeclaredMethod("buildGroupNameMap", DomainModelType.class);
        Method collect = MetaPropertyService.class.getDeclaredMethod("collectPropertiesFromElementType",
                DomainModelType.class, String.class, Map.class, Map.class, List.class);
        Method annotated = MetaPropertyService.class.getDeclaredMethod("supplementPropertiesFromAnnotation", Object.class, Map.class, List.class);
        groups.setAccessible(true);
        collect.setAccessible(true);
        annotated.setAccessible(true);
        Map<String, Object> current = new TreeMap<String, Object>(String.CASE_INSENSITIVE_ORDER);
        Object names = groups.invoke(null, dmt);
        collect.invoke(null, dmt, el.getClass().getSimpleName(), names, current, out);
        if (fieldAp != null) collect.invoke(null, dmt, fieldAp.getClass().getSimpleName(), names, current, out);
        else annotated.invoke(null, el, current, out);
        return out;
    }

    // ---------- 小工具 ----------

    /** 一次运行内读一次：FIND 和每个 PROPS 都要用。 */
    static EntityMetadata entity;

    static EntityMetadata entity(FormMetadata fm) {
        String id = fm.getEntityId();
        if (entity == null && id != null && !id.isEmpty()) {
            entity = (EntityMetadata) MetadataDao.readMeta(id, MetaCategory.Entity);
        }
        return entity;
    }

    /** 字段控件绑的字段类型。readMeta 读出来的布局不挂字段对象，按控件记的字段 id 去实体里查。 */
    static String fieldType(Tree t, ControlAp<?> c) {
        if (!(c instanceof FieldAp)) return null;
        FieldAp f = (FieldAp) c;
        if (f.getField() != null) return f.getField().getClass().getSimpleName();
        EntityMetadata em = entity(t.fm);
        if (em == null) return null;
        if (entityById == null) {
            entityById = new HashMap<String, EntityItem<?>>();
            for (EntityItem<?> it : em.getItems()) entityById.put(it.getId(), it);
        }
        EntityItem<?> it = entityById.get(f.getFieldId() == null ? c.getId() : f.getFieldId());
        return it == null ? null : it.getClass().getSimpleName();
    }

    static Map<String, EntityItem<?>> entityById;

    static EntityItem<?> entityItem(FormMetadata fm, String key) {
        EntityMetadata em = entity(fm);
        if (em == null) return null;
        for (EntityItem<?> it : em.getItems()) {
            if (key.equalsIgnoreCase(it.getKey())) return it;
        }
        return null;
    }

    /** 属性面板定义里每项属性的隐藏条件，控件类型和字段类型两份定义合起来。 */
    static Map<String, Map<String, Object>> hides(FormMetadata fm, String... elementTypes) {
        Map<String, Map<String, Object>> out = new HashMap<String, Map<String, Object>>();
        DomainModelType dm = DomainModelType.getDomainModelType(fm.getModelType(), true);
        for (String et : elementTypes) {
            ElementType t = et == null ? null : dm.getElementType(et);
            if (t == null) continue;
            for (Property pr : t.getProperties()) {
                if (pr.getHide() != null && !pr.getHide().isEmpty()) out.put(pr.getPropertyName().toLowerCase(), pr.getHide());
            }
        }
        return out;
    }

    /**
     * 设计器属性面板的隐藏条件（平台 AI 服务只处理了无条件隐藏）：
     *   {hide=true}                               一律不显示
     *   {types, fieldTypes}（hide 缺省或 true）    控件类型在 types 里、字段类型在 fieldTypes 里时不显示
     *   {types, fieldTypes, hide=false}           控件类型在 types 里时，只有字段类型在 fieldTypes 里才显示
     *   {parentTypes}                             父容器类型在里面时不显示
     * 控件类型不在 types 里，这条条件不管它，照常显示。
     */
    static boolean hidden(Map<String, Object> hide, String apType, String fieldType, String parentType) {
        if (hide == null) return false;
        boolean hideFlag = !Boolean.FALSE.equals(hide.get("hide"));
        Object types = hide.get("types");
        Object fieldTypes = hide.get("fieldTypes");
        Object parentTypes = hide.get("parentTypes");
        if (types == null && fieldTypes == null && parentTypes == null) return hideFlag;
        if (parentTypes != null && in(parentTypes, parentType)) return true;
        if (fieldTypes == null) return false;
        if (types != null && !in(types, apType)) return false;
        return in(fieldTypes, fieldType) == hideFlag;
    }

    static boolean in(Object list, String s) {
        if (s == null || !(list instanceof List)) return false;
        for (Object o : (List<?>) list) {
            if (s.equals(String.valueOf(o))) return true;
        }
        return false;
    }

    static String type(ControlAp<?> c) {
        return c.getClass().getSimpleName();
    }

    static String name(ControlAp<?> c) {
        return str(c.getName());
    }

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    static boolean contains(String s, String lowerWord) {
        return s != null && s.toLowerCase().contains(lowerWord);
    }

    static boolean blank(Object o) {
        return o == null || "".equals(String.valueOf(o));
    }

    static String show(Object o) {
        if (o instanceof Style) return styleText(o);
        return o instanceof String || o instanceof Number || o instanceof Boolean ? String.valueOf(o) : json(o);
    }

    // ---------- 边框样式 ----------

    /** 边框样式（Style）管三样：边框、外边距、内边距，每样四条边，每条边一个文字值。读和写都按这个顺序。 */
    static final List<String> STYLE_PARTS = Arrays.asList("border", "margin", "padding");
    static final List<String> STYLE_SIDES = Arrays.asList("top", "right", "bottom", "left");
    /** 边距：长度，可以是负数、不带单位（存库里有 "12" 这样的）。 */
    static final String STYLE_LENGTH = "-?\\d+(\\.\\d+)?(px|%|rem|em|vw|vh)?";
    /** 边框：宽度_线型_颜色，和设计器存的一样（存库里是 1px_solid_#e5e5e5、0.5px_solid_#cccccc 这样）。 */
    static final String STYLE_BORDER = "\\d+(\\.\\d+)?px_(solid|dashed|dotted|double|none)_(#[0-9a-fA-F]{3,8}|rgba?\\([0-9.,\\s%]+\\)|[a-zA-Z]+)";
    static final String STYLE_HOW = "写法如 {\"border\":\"1px_solid_#e5e5e5\",\"margin\":{\"top\":\"10px\"}}：border 边框、margin 外边距、padding 内边距，"
            + "给一个值是四条边一样，分边写 top、right、bottom、left；只改写到的边，别的边留着，写空串清掉那条边，整项写空清掉全部";

    /**
     * 边框样式摊成「部位 → 边 → 值」，空的边不列。三种样子都认：Style 对象、属性清单给的当前值（键全小写）、
     * 存库那份（键首字母大写，带 _Type_）。
     */
    @SuppressWarnings("unchecked")
    static Map<String, Map<String, String>> styleSides(Object v) {
        Map<String, Map<String, String>> out = new LinkedHashMap<String, Map<String, String>>();
        if (v instanceof String && ((String) v).trim().startsWith("{")) {
            try {
                v = OM.readValue((String) v, Map.class);
            } catch (Exception e) {
                return out;
            }
        }
        if (v instanceof Style) {
            Style st = (Style) v;
            sides(out, "border", st.getBorder());
            sides(out, "margin", st.getMargin());
            sides(out, "padding", st.getPadding());
            return out;
        }
        if (!(v instanceof Map)) return out;
        for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
            String part = String.valueOf(e.getKey()).toLowerCase();
            if (!STYLE_PARTS.contains(part) || !(e.getValue() instanceof Map)) continue;
            for (Map.Entry<String, Object> s : ((Map<String, Object>) e.getValue()).entrySet()) {
                String side = String.valueOf(s.getKey()).toLowerCase();
                if (STYLE_SIDES.contains(side) && !blank(s.getValue())) side(out, part).put(side, String.valueOf(s.getValue()));
            }
        }
        return out;
    }

    static void sides(Map<String, Map<String, String>> out, String part, AbstractStyle a) {
        if (a == null) return;
        String[] got = {a.getTop(), a.getRight(), a.getBottom(), a.getLeft()};
        for (int i = 0; i < got.length; i++) {
            if (!blank(got[i])) side(out, part).put(STYLE_SIDES.get(i), got[i]);
        }
    }

    static Map<String, String> side(Map<String, Map<String, String>> out, String part) {
        Map<String, String> m = out.get(part);
        if (m == null) {
            m = new LinkedHashMap<String, String>();
            out.put(part, m);
        }
        return m;
    }

    /** 边框样式写成 set 收的那种写法；四条边一样的合成一个值。没有设的是空串。 */
    static String styleText(Object v) {
        Map<String, Map<String, String>> sides = styleSides(v);
        StringBuilder sb = new StringBuilder();
        for (String part : STYLE_PARTS) {
            Map<String, String> m = sides.get(part);
            if (m == null || m.isEmpty()) continue;
            sb.append(sb.length() == 0 ? "{" : ",").append('"').append(part).append("\":");
            if (m.size() == 4 && new HashSet<String>(m.values()).size() == 1) {
                sb.append('"').append(m.values().iterator().next()).append('"');
                continue;
            }
            sb.append('{');
            boolean first = true;
            for (String side : STYLE_SIDES) {
                if (!m.containsKey(side)) continue;
                sb.append(first ? "" : ",").append('"').append(side).append("\":\"").append(m.get(side)).append('"');
                first = false;
            }
            sb.append('}');
        }
        return sb.length() == 0 ? "" : sb.append('}').toString();
    }

    /**
     * set 写边框样式：在 old（现在的样式）上改，只动写到的边。写法见 STYLE_HOW；不对就抛 IllegalArgumentException，
     * 消息接在属性名后面。全清掉返回 null，和没设过一样。
     */
    @SuppressWarnings("unchecked")
    static Style styleMerge(Object old, String value) {
        if (value.trim().isEmpty()) return null;
        Object parsed;
        try {
            parsed = OM.readValue(value, Object.class);
        } catch (Exception e) {
            parsed = null;
        }
        if (!(parsed instanceof Map)) throw new IllegalArgumentException("要写成 JSON 对象，给的是「" + value + "」；" + STYLE_HOW);
        Map<String, Map<String, String>> sides = styleSides(old);
        for (Map.Entry<String, Object> e : ((Map<String, Object>) parsed).entrySet()) {
            String part = e.getKey().toLowerCase();
            if (!STYLE_PARTS.contains(part)) {
                throw new IllegalArgumentException("只认 border（边框）、margin（外边距）、padding（内边距），「" + e.getKey() + "」不认；" + STYLE_HOW);
            }
            Map<String, Object> given = new LinkedHashMap<String, Object>();
            boolean whole = !(e.getValue() instanceof Map);
            if (!whole) given.putAll((Map<String, Object>) e.getValue());
            else if (e.getValue() instanceof String || e.getValue() instanceof Number) {
                for (String s : STYLE_SIDES) given.put(s, e.getValue());
            } else throw new IllegalArgumentException("的 " + part + " 要给一个值或按边写；" + STYLE_HOW);
            Map<String, String> m = side(sides, part);
            for (Map.Entry<String, Object> s : given.entrySet()) {
                String side = s.getKey().toLowerCase();
                if (!STYLE_SIDES.contains(side)) {
                    throw new IllegalArgumentException("的 " + part + " 只有 top、right、bottom、left 四条边，「" + s.getKey() + "」不认");
                }
                String x = s.getValue() == null ? "" : String.valueOf(s.getValue()).trim();
                if (x.isEmpty()) {
                    m.remove(side);
                    continue;
                }
                boolean border = "border".equals(part);
                if (!x.matches(border ? STYLE_BORDER : STYLE_LENGTH)) {
                    throw new IllegalArgumentException("的 " + part + (whole ? "" : " " + side) + "「" + x + "」格式不对，"
                            + (border ? "边框写成 宽度_线型_颜色，例如 1px_solid_#e5e5e5，线型是 solid、dashed、dotted、double、none"
                                    : "边距写成长度，例如 10px、-22px、0.5rem"));
                }
                m.put(side, x);
            }
        }
        Style st = new Style();
        Border b = fill(new Border(), sides.get("border"));
        Margin mg = fill(new Margin(), sides.get("margin"));
        Padding pd = fill(new Padding(), sides.get("padding"));
        if (b == null && mg == null && pd == null) return null;
        st.setBorder(b);
        st.setMargin(mg);
        st.setPadding(pd);
        return st;
    }

    static <T extends AbstractStyle> T fill(T a, Map<String, String> m) {
        if (m == null || m.isEmpty()) return null;
        if (m.containsKey("top")) a.setTop(m.get("top"));
        if (m.containsKey("right")) a.setRight(m.get("right"));
        if (m.containsKey("bottom")) a.setBottom(m.get("bottom"));
        if (m.containsKey("left")) a.setLeft(m.get("left"));
        return a;
    }

    static String json(Object o) {
        try {
            return OM.writeValueAsString(o);
        } catch (Exception e) {
            return String.valueOf(o);
        }
    }

    static String clip(String s, int n) {
        String one = s.replace("\r", "").replace("\n", " ");
        return one.length() <= n ? one : one.substring(0, n) + "…";
    }

    static String indent(int depth) {
        StringBuilder sb = new StringBuilder("  ");
        for (int i = 0; i < depth; i++) sb.append("  ");
        return sb.toString();
    }

    static List<String> list(String csv) {
        List<String> out = new ArrayList<String>();
        for (String s : csv.split(",")) {
            if (!s.trim().isEmpty()) out.add(s.trim());
        }
        return out;
    }

    static void p(String s) {
        System.out.println("[PROBE] " + s);
    }

    /** 抛异常而不是 System.exit()：后者会带走常驻探针 JVM。 */
    static String req(String k, String what) {
        String v = System.getenv(k);
        if (v != null && !v.trim().isEmpty()) return v.trim();
        p("缺必填参数 " + k + " —— " + what);
        throw new IllegalArgumentException(k + " 未设置");
    }

    static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.isEmpty() ? def : v;
    }
}
