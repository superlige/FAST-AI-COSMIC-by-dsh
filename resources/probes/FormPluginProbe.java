import java.util.ArrayList;
import java.util.List;

import kd.bos.metadata.Plugin;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.form.BillFormAp;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.report.ReportListAp;

/**
 * 界面插件绑定探针：一张单据（或表单、报表）在设计态登记的界面插件，每一处各列一段，带启用状态。
 *
 * 查的是这几处：单据（表单）布局、单据带的列表布局、移动端布局、移动端列表布局，报表表单另查报表列表控件上的查询插件（取数插件）。
 * 这张单据没有的布局在末尾点名。操作插件登记在操作上，用 OpMetaProbe 查。
 *
 *   META_FORM=布局标识              要查的布局或实体（必填）
 *   META_PLUGIN_FILTER=类名关键字   可选，不区分大小写
 */
public class FormPluginProbe {

    public static void run() {
        String formNumber = req("META_FORM", "要查的布局或实体标识");
        String filter = env("META_PLUGIN_FILTER", "");
        String formId = MetadataDao.getIdByNumber(formNumber, MetaCategory.Form);
        if (formId == null || formId.isEmpty()) {
            throw new IllegalArgumentException("表单布局不存在: " + formNumber);
        }

        FormMetadata form = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        if (!filter.isEmpty()) {
            System.out.println("[PROBE] 过滤关键字: " + filter);
        }
        int matched = section("布局 " + formNumber + "  id=" + formId, rootPlugins(form), filter);

        // 列表、移动端、移动端列表各是嵌在单据里的另一份布局，插件各记各的：只看单据布局会把挂在它们上面的说成「没挂」
        List<String> absent = new ArrayList<String>();
        if (form.getRootAp() instanceof BillFormAp) {
            BillFormAp bill = (BillFormAp) form.getRootAp();
            matched += nested("列表布局", bill.getListMeta(), filter, absent);
            matched += nested("移动端布局", bill.getMobMeta(), filter, absent);
            matched += nested("移动端列表布局", bill.getMobListMeta(), filter, absent);
        }
        if (form.getItems() != null) {
            for (ControlAp<?> item : form.getItems()) {
                if (!(item instanceof ReportListAp)) continue;
                matched += section("报表列表 " + item.getKey() + " 的查询插件（取数插件）",
                        ((ReportListAp) item).getReportQueryPlugin(), filter);
            }
        }
        if (!absent.isEmpty()) {
            System.out.println("[PROBE] 这张单据没有：" + String.join("、", absent));
        }
        System.out.println("[PROBE] 命中插件 " + matched + " 个");
    }

    private static List<Plugin> rootPlugins(FormMetadata meta) {
        return meta == null || meta.getRootAp() == null ? null : meta.getRootAp().getPlugins();
    }

    private static int nested(String title, FormMetadata meta, String filter, List<String> absent) {
        if (meta == null || meta.getRootAp() == null) {
            absent.add(title);
            return 0;
        }
        return section(title, rootPlugins(meta), filter);
    }

    /** 一处登记位置打一段：标题行带这一处的插件总数，下面是对得上过滤关键字的那些。返回打了几个。 */
    private static int section(String title, List<Plugin> plugins, String filter) {
        System.out.println("[PROBE] " + title + "  插件数=" + (plugins == null ? 0 : plugins.size()));
        int matched = 0;
        if (plugins == null) return 0;
        for (Plugin plugin : plugins) {
            String className = plugin.getClassName();
            if (!filter.isEmpty() && (className == null
                    || !className.toLowerCase().contains(filter.toLowerCase()))) {
                continue;
            }
            System.out.println("[PROBE]   rowKey=" + plugin.getRowKey()
                    + " enabled=" + plugin.isEnabled()
                    + " inherit=" + plugin.isInherit()
                    + " class=" + className
                    + sourceDetail(plugin));
            matched++;
        }
        return matched;
    }

    private static String sourceDetail(Plugin plugin) {
        String source = plugin.getSourceNumber();
        return source == null || source.isEmpty() ? "" : " source=" + source;
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
        System.out.println("[PROBE] 用法: META_FORM=<布局或实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe FormPluginProbe");
        System.out.println("[PROBE] 不知道填什么：本工程的标识一律 <isv>_ 开头，isv 见 driver.mjs doctor");
        throw new IllegalArgumentException(k + " 未设置");
    }

    private static String env(String key, String defaultValue) {
        String value = System.getenv(key);
        return value == null || value.isEmpty() ? defaultValue : value;
    }
}
