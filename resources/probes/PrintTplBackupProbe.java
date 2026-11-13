import java.io.BufferedInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.DigestInputStream;
import java.security.MessageDigest;
import java.text.SimpleDateFormat;
import java.util.Collections;
import java.util.Date;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.business.metedata.service.migrate.PrintTplImpExp;
import kd.bos.print.core.service.PrtAttach;
import kd.bos.print.service.BosPrintServiceHelper;

/**
 * 只读数据库、写本地文件：用官方导出链完整备份一个本 ISV 的新打印模板。
 *
 * TPL_NUMBER=模板编码（必填）
 * BACKUP_DIR=目录（可选，默认 outputs/print-template-backups）
 */
public class PrintTplBackupProbe {
    public static void run() throws Exception {
        String number = env("TPL_NUMBER");
        if (number == null) throw new IllegalArgumentException("必须给 TPL_NUMBER");

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (blank(tplId)) throw new IllegalArgumentException("模板不存在: " + number);
        DesignMetadata dm = (DesignMetadata) new PrintTplService().getDesignMeta(tplId);
        if (dm == null) throw new IllegalStateException("读不到模板本体: id=" + tplId);
        IsvGuard.assertOwnPrintTplSelf(number, dm.getNumber(), dm.getIsv());

        String exported = new PrintTplImpExp().doExport(Collections.singletonList(tplId), 0);
        String dirValue = env("BACKUP_DIR");
        Path dir = Paths.get(dirValue == null ? "outputs/print-template-backups" : dirValue)
                .toAbsolutePath().normalize();
        Files.createDirectories(dir);
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS").format(new Date());
        Path target = dir.resolve(safe(number) + "-before-" + stamp + ".zip");
        String taskId = queryParam(exported, "taskId");
        String attachId = queryParam(exported, "attachId");
        if (blank(taskId) || blank(attachId)) {
            throw new IllegalStateException("官方导出返回值缺少 taskId/attachId: " + exported);
        }
        PrtAttach attach = BosPrintServiceHelper.getPrtAttach(taskId, attachId);
        if (attach == null || attach.getAttachDetail().isEmpty()) {
            throw new IllegalStateException("无法解析官方导出附件: " + exported);
        }
        String filePath = attach.getAttachDetail().get(0).getFilePath();
        String diskType = attach.getDiskType();
        try (InputStream in = BosPrintServiceHelper.getFileInputStream(filePath, diskType)) {
            if (in == null) throw new IllegalStateException("读取官方导出附件失败: " + exported);
            Files.copy(in, target); //不覆盖同名备份
        }

        int prt = 0, prtx = 0, resources = 0, entries = 0;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(Files.newInputStream(target)))) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                if (entry.isDirectory()) continue;
                entries++;
                String name = entry.getName().toLowerCase();
                if (name.endsWith(".prt")) prt++;
                else if (name.endsWith(".prtx")) prtx++;
                else resources++;
            }
        }
        if (prt < 1) throw new IllegalStateException("备份 ZIP 缺少 .prt: " + target);
        System.out.println("[PROBE] template=" + number + " id=" + tplId + " isv=" + dm.getIsv()
                + " modifyVersion=" + dm.getModifyVersion());
        System.out.println("[PROBE] backup=" + target + " bytes=" + Files.size(target)
                + " sha256=" + sha256(target));
        System.out.println("[PROBE] zipEntries=" + entries + " prt=" + prt + " prtx=" + prtx
                + " otherResources=" + resources);
        System.out.println("[PROBE] 数据库未修改；该探针只调用 doExport 并复制本地 ZIP");
    }

    private static String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new DigestInputStream(Files.newInputStream(path), digest)) {
            byte[] buffer = new byte[8192];
            while (in.read(buffer) >= 0) { /* consume */ }
        }
        StringBuilder out = new StringBuilder();
        for (byte b : digest.digest()) out.append(String.format("%02x", b & 0xff));
        return out.toString();
    }
    private static String safe(String value) { return value.replaceAll("[^A-Za-z0-9._-]", "_"); }
    private static String queryParam(String url, String key) {
        if (url == null) return null;
        String marker = key + "=";
        int start = url.indexOf(marker);
        if (start < 0) return null;
        start += marker.length();
        int end = url.indexOf('&', start);
        return end < 0 ? url.substring(start) : url.substring(start, end);
    }
    private static boolean blank(String value) { return value == null || value.trim().isEmpty(); }
    private static String env(String key) { String v = System.getenv(key); return blank(v) ? null : v.trim(); }
}
