import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.Map;

import kd.bos.print.api.metedata.DesignerMetadata;
import kd.bos.print.api.metedata.PrintMetadata;
import kd.bos.print.api.utils.SerializeUtils;
import kd.bos.print.business.metedata.PrintMetadataUtil;
import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.service.BosPrintServiceHelper;

/**
 * 只读数据库、写本地文件：把一个本 ISV 新打印模板的设计 JSON 和多语言旁路映射落到本地。
 * 文件按 JsonLayout 分行（放得下的值占一行），grep 命中的就是那一个属性或那一条映射，
 * 同一模板导出两次，普通 diff 只出真改动。
 *
 * 导出的就是设计器提交给服务端的那两份东西（`SerializeUtils` JSON 往返之后的形态），
 * 所以本地读到的结构和写探针里要改的结构逐字段一致。
 *
 * TPL_NUMBER=模板编码（必填）
 * OUT_DIR=名字（可选，工具放进本会话的导出目录，不给就按模板编码起名；同名文件直接覆盖，
 *               改前改后请用不同名字，例如 before 和 after）
 */
public class PrintTplJsonProbe {
    public static void run() throws Exception {
        String number = env("TPL_NUMBER");
        if (number == null) throw new IllegalArgumentException("必须给 TPL_NUMBER");

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (blank(tplId)) throw new IllegalArgumentException("模板不存在: " + number);
        PrintTplService service = new PrintTplService();
        DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
        if (dm == null) throw new IllegalStateException("读不到模板本体: id=" + tplId);
        IsvGuard.assertOwnPrintTplSelf(number, dm.getNumber(), dm.getIsv());

        PrintMetadata pm = service.getPrintMetadata(dm);
        String lang = first(pm.getFixedLang(), pm.getOriLang(), "zh_CN");
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
        //和写探针同一条链路：JSON 往返后的普通 Map 才是设计器提交的形态
        Map<?, ?> metadata = (Map<?, ?>) SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(designer.getMetadata()), Map.class);

        String dirValue = env("OUT_DIR");
        Path dir = Paths.get(dirValue == null ? "outputs/print-tpl-json" : dirValue)
                .toAbsolutePath().normalize();
        Files.createDirectories(dir);
        Path metaFile = dir.resolve(safe(number) + ".meta.json");
        Path localeFile = dir.resolve(safe(number) + ".locale.json");

        System.out.println("[PROBE] template=" + number + " id=" + tplId + " formId=" + dm.getFormId()
                + " isv=" + dm.getIsv() + " lang=" + lang);
        //这两个是改前改后的比对基线：modifyVersion 没推进就是没写进去
        System.out.println("[PROBE] modifyVersion=" + dm.getModifyVersion()
                + " dataChars=" + (dm.getData() == null ? 0 : dm.getData().length())
                + " dataSha256=" + sha256(dm.getData()));
        write(metaFile, JsonLayout.layout(SerializeUtils.toJsonString(metadata)));
        write(localeFile, JsonLayout.layout(SerializeUtils.toJsonString(designer.getLocaleValueMap())));
        System.out.println("[PROBE] 数据库未修改");
    }

    private static void write(Path path, String content) throws Exception {
        boolean existed = Files.exists(path);
        Files.write(path, content.getBytes(StandardCharsets.UTF_8),
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING);
        System.out.println("[PROBE] " + (existed ? "已覆盖 " : "已写出 ") + path
                + "  " + content.length() + " chars");
    }

    private static String sha256(String value) throws Exception {
        if (value == null) return "";
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest(value.getBytes(StandardCharsets.UTF_8))) {
            out.append(String.format("%02x", b & 0xff));
        }
        return out.toString();
    }

    private static String first(String... values) {
        for (String v : values) if (!blank(v)) return v;
        return null;
    }
    private static String safe(String value) { return value.replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static boolean blank(String value) { return value == null || value.trim().isEmpty(); }
    private static String env(String key) { String v = System.getenv(key); return blank(v) ? null : v.trim(); }
}
