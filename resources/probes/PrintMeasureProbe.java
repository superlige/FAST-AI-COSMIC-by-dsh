import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import javax.imageio.ImageIO;

import org.apache.pdfbox.contentstream.PDFStreamEngine;
import org.apache.pdfbox.contentstream.operator.Operator;
import org.apache.pdfbox.contentstream.operator.state.Concatenate;
import org.apache.pdfbox.contentstream.operator.state.Restore;
import org.apache.pdfbox.contentstream.operator.state.Save;
import org.apache.pdfbox.contentstream.operator.state.SetGraphicsStateParameters;
import org.apache.pdfbox.cos.COSBase;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.graphics.PDXObject;
import org.apache.pdfbox.pdmodel.graphics.form.PDFormXObject;
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject;
import org.apache.pdfbox.rendering.PDFRenderer;
import org.apache.pdfbox.text.PDFTextStripper;
import org.apache.pdfbox.text.TextPosition;
import org.apache.pdfbox.util.Matrix;

import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.orm.query.QFilter;
import kd.bos.print.api.PrintTask;
import kd.bos.print.api.PrintWork;
import kd.bos.print.core.ExecuteContext;
import kd.bos.print.core.ExecuteService;
import kd.bos.print.core.service.PrtAttach;
import kd.bos.print.service.BosPrintServiceHelper;
import kd.bos.print.service.BosPrintServiceImpl;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.svc.util.print.PrtTaskResult;
import kd.bos.svc.util.print.PrtTaskResultServiceHelper;

/**
 * 打印排版实测：在探针进程里出 PDF，把每张图片在页面上的位置量成数字打印出来。
 *
 * <p>为什么要它：排版问题（图片没居中、跑到别的列、尺寸不对）只有渲染出来才知道，
 * 但把 PNG 读进上下文肉眼看一次要几万 token。真正需要的只是几个坐标 ——
 * 这里直接从 PDF 内容流里读图片的变换矩阵（CTM），一行一个数字，几十 token 解决。
 * 只有最后确认整页观感时才用 PNG_OUT 出一张图看。
 *
 * <p>它绕开了 execPrint 的微服务分发（探针进程里跑不了），直调 BosPrintServiceImpl.doPrint。
 * 走的是<b>预览</b>（和平台「打印预览」同一个开关）：普通走法每出一次在共享环境的打印结果表
 * t_svc_printresult 留一条永久记录（S24 批 0.2 真机实测）；预览只进缓存和临时文件，3 小时内自己过期。
 *
 * <pre>
 * TPL_NUMBER   模板编码，必填，如 demo_sys_test_bill_prtpl_58
 * BILL_ID      单据主键，必填，多个用逗号分隔
 * FORM_ID      单据标识，不填则从 bos_manageprinttpl.billformid 自动查
 * PAGES        只测这几页，逗号分隔，1 起；留空=全部；-1=最后一页
 * TEXT=1       连文字一起量（图片居中 ≠ 图片下面那行字也居中，两者是不同的格子）
 * TEXT_LIKE    只打印含这个子串的文本段，整页文字多时用它过滤
 * PDF_OUT      顺带把 pdf 存一份，给文件名（可选，工具放进本会话的导出目录）
 * PNG_OUT      顺带把测的页渲染成 PNG，给文件名前缀，存成 &lt;前缀&gt;_p&lt;页码&gt;.png（可选，肉眼复核用，同上）
 * PLANT_FROM   渲染前造占位图，值形如 实体标识:图片字段路径[,字段路径...]，
 *              从 BILL_ID 这几张单据里把路径查出来，如
 *              demo_sys_test_bill:demo_entryentity_jxsy.demo_subentryentity_jx.demo_picture
 * PLANT_PATHS  同上，但路径手工给，逗号或换行分隔，也可以填一个文本文件的路径
 * </pre>
 *
 * <p>PLANT_* 是给"图片文件在本机文件存储里不存在、渲染出来一片空白"准备的（连的是公司环境的库，
 * 图片实体文件却在本机没有）。**优先用 PLANT_FROM** —— 路径直接来自单据字段，不用去日志里捞，
 * 日志里那条下载失败并不打印路径。只对不存在的文件造图，不会覆盖真实图片。
 * 路径拼在 LightFileStorage 根目录（{@code ${user.dir}/filestorage}）下 ——
 * 注意有的路径带前导 /、有的不带，直接拼会拼出 filestorageierp\...，这里已经处理。
 */
public class PrintMeasureProbe {

    /** 单图行的中轴与参考中轴差多少 pt 之内算居中 */
    private static final double CENTER_TOLERANCE = 1.0d;

    public static void run() throws Exception {
        String number = require("TPL_NUMBER");
        String billIds = require("BILL_ID");
        String formId = env("FORM_ID");
        if (formId == null) {
            formId = queryFormId(number);
        }
        List<String> plantPaths = new ArrayList<String>();
        collectSpecPaths(env("PLANT_PATHS"), plantPaths);
        collectFieldPaths(env("PLANT_FROM"), billIds, plantPaths);
        plantMissingImages(plantPaths);

        byte[] pdf = render(number, formId, billIds);
        if (pdf == null) {
            return;
        }
        String pdfOut = env("PDF_OUT");
        if (pdfOut != null) {
            write(new File(pdfOut), pdf);
            System.out.println("[PROBE] pdf 已写出 " + new File(pdfOut).getAbsolutePath());
        }
        measure(pdf, env("PAGES"), env("PNG_OUT"));
    }

    // ---------------- 出 PDF ----------------

    private static byte[] render(String number, String formId, String billIds) throws Exception {
        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        System.out.println("[PROBE] 模板 " + number + " tplId=" + tplId + " formId=" + formId);
        if (tplId == null) {
            System.out.println("[PROBE] 模板编码查不到，先用 PrintTplProbe 确认编码");
            return null;
        }
        List<Object> pkIds = new ArrayList<Object>();
        for (String id : billIds.split(",")) {
            if (!id.trim().isEmpty()) {
                pkIds.add(id.trim());
            }
        }
        PrintTask task = new PrintTask();
        task.setTplId(tplId);
        task.setFormId(formId);
        task.setPkIds(pkIds);
        task.setPageId("probe-" + System.currentTimeMillis());

        PrintWork work = new PrintWork();
        work.setExpType("pdf");
        work.setPrintLang("zh_CN");
        work.setPageId(task.getPageId());
        work.setTaskList(Collections.singletonList(task));

        //taskId 后面要被 parse 成数字，传 "probeTaskXxx" 这种会 NumberFormatException
        String taskId = String.valueOf(System.currentTimeMillis());
        ExecuteContext.get().setPreview(true);
        String resultId = new BosPrintServiceImpl().doPrint(taskId, work);

        PrtAttach attach = ExecuteService.getAttachService().getPrtAttach(resultId);
        if (attach == null || attach.getAttachDetail().isEmpty()) {
            System.out.println("[PROBE] 没产出附件，多半是单据 id 不对或模板与单据不匹配");
            return null;
        }
        String filePath = attach.getAttachDetail().get(0).getFilePath();
        String diskType = attach.getDiskType();
        if (filePath != null && filePath.contains("tempAttach=true")) {
            //预览的附件路径是下载链接；真正的文件路径记在另一条临时任务结果里（只在缓存里）
            String tempTask = urlParam(filePath, "taskId");
            String attachId = urlParam(filePath, "attachId");
            PrtTaskResult temp = PrtTaskResultServiceHelper.getPrtResult(tempTask);
            if (temp == null) {
                System.out.println("[PROBE] 预览结果在缓存里取不到（taskId=" + tempTask + "）");
                return null;
            }
            for (PrtTaskResult.Attach one : temp.getAttach()) {
                if (attachId != null && attachId.equals(one.getAttachId())) {
                    filePath = one.getFilePath();
                }
            }
            diskType = "2";
        }
        InputStream in = BosPrintServiceHelper.getFileInputStream(filePath, diskType);
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        try {
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
            }
        } finally {
            in.close();
        }
        byte[] pdf = bos.toByteArray();
        System.out.println("[PROBE] pdf " + pdf.length + " 字节");
        return pdf;
    }

    private static String urlParam(String url, String name) {
        for (String part : url.substring(url.indexOf('?') + 1).split("&")) {
            if (part.startsWith(name + "=")) {
                return part.substring(name.length() + 1);
            }
        }
        return null;
    }

    private static String queryFormId(String number) {
        DynamicObjectCollection rows = QueryServiceHelper.query("bos_manageprinttpl", "billformid",
                new QFilter[]{new QFilter("number", "=", number)});
        if (rows.isEmpty()) {
            throw new IllegalStateException("模板 " + number + " 在 bos_manageprinttpl 里查不到，FORM_ID 请手工传");
        }
        return rows.get(0).getString("billformid");
    }

    // ---------------- 量坐标 ----------------

    private static void measure(byte[] pdf, String pages, String pngOut) throws IOException {
        PDDocument doc = PDDocument.load(pdf);
        try {
            int total = doc.getNumberOfPages();
            System.out.println("[PROBE] 共 " + total + " 页；坐标单位 pt（1pt=1/72 英寸），原点已换算到左上角");
            PDFRenderer renderer = pngOut == null ? null : new PDFRenderer(doc);
            int[] wanted = wantedPages(pages, total);
            //先把要测的页全扫一遍：参考中轴取全文档的多图行，单图页才有基准可比
            List<List<List<Img>>> pageRows = new ArrayList<List<List<Img>>>();
            for (int page : wanted) {
                PDPage pdPage = doc.getPage(page - 1);
                ImageCollector collector = new ImageCollector(pdPage.getMediaBox().getHeight());
                collector.processPage(pdPage);
                pageRows.add(groupRows(collector.images));
            }
            double globalAxis = 0;
            int globalMulti = 0;
            for (List<List<Img>> rows : pageRows) {
                for (List<Img> row : rows) {
                    if (row.size() >= 2) {
                        globalAxis += axis(row);
                        globalMulti++;
                    }
                }
            }
            globalAxis = globalMulti > 0 ? globalAxis / globalMulti : -1;
            for (int i = 0; i < wanted.length; i++) {
                int page = wanted[i];
                PDPage pdPage = doc.getPage(page - 1);
                PDRectangle box = pdPage.getMediaBox();
                List<List<Img>> rows = pageRows.get(i);
                int count = 0;
                for (List<Img> row : rows) {
                    count += row.size();
                }
                System.out.println("[PROBE] === 第 " + page + " 页  "
                        + fmt(box.getWidth()) + " x " + fmt(box.getHeight()) + "pt  图片 "
                        + count + " 张 ===");
                report(rows, box.getWidth(), globalAxis, globalMulti);
                if (env("TEXT") != null) {
                    reportText(doc, page, globalMulti > 0 ? globalAxis : box.getWidth() / 2, env("TEXT_LIKE"));
                }
                if (renderer != null) {
                    BufferedImage image = renderer.renderImageWithDPI(page - 1, 96f);
                    File file = new File(pngOut + "_p" + page + ".png");
                    ImageIO.write(image, "png", file);
                    System.out.println("[PROBE] png 已写出 " + file.getAbsolutePath()
                            + " " + image.getWidth() + "x" + image.getHeight() + "（96dpi，pt×1.333）");
                }
            }
        } finally {
            doc.close();
        }
    }

    /**
     * 把图片按 y 坐标分行，报出每行的中轴，再拿"多图行的中轴"当参考中轴去判单图行有没有居中。
     * 用多图行而不是页宽中心当基准：表格未必占满页宽，页宽中心不是行中心。
     */
    private static void report(List<List<Img>> rows, float pageWidth, double globalAxis, int globalMulti) {
        if (rows.isEmpty()) {
            System.out.println("[PROBE] 这页没有图片。若本该有图，多半是图片文件在本机文件存储里不存在，"
                    + "用 PLANT_FROM 造占位图后重跑");
            return;
        }
        double reference;
        boolean trustworthy = globalMulti > 0;
        if (trustworthy) {
            reference = globalAxis;
            System.out.println("[PROBE] 参考中轴 " + fmt(reference) + "（取自全文档 " + globalMulti + " 个多图行）");
        } else {
            reference = pageWidth / 2;
            System.out.println("[PROBE] 参考中轴 " + fmt(reference)
                    + "（全文档没有多图行，退回页宽中心；表格未必占满页宽，Δ 仅供参考）");
        }
        int single = 0;
        int centered = 0;
        for (int i = 0; i < rows.size(); i++) {
            List<Img> row = rows.get(i);
            double axis = axis(row);
            double delta = axis - reference;
            StringBuilder sb = new StringBuilder();
            sb.append("[PROBE]  行").append(i + 1)
                    .append("  ").append(row.size()).append(" 张  y=").append(fmt(row.get(0).top))
                    .append("  cx=");
            for (int j = 0; j < row.size(); j++) {
                sb.append(j == 0 ? "" : ",").append(fmt(row.get(j).centerX()));
            }
            sb.append("  中轴=").append(fmt(axis))
                    .append("  Δ=").append(delta >= 0 ? "+" : "").append(fmt(delta))
                    .append("  尺寸=").append(fmt(row.get(0).width)).append("x").append(fmt(row.get(0).height));
            if (row.size() == 1) {
                single++;
                boolean ok = Math.abs(delta) <= CENTER_TOLERANCE;
                if (ok) {
                    centered++;
                }
                sb.append(ok ? "  [单图·居中]" : trustworthy ? "  [单图·未居中]" : "  [单图·基准存疑]");
            }
            System.out.println(sb.toString());
        }
        System.out.println("[PROBE] 小计：" + rows.size() + " 行，单图行 " + single
                + " 个，其中居中 " + centered + " 个");
    }

    /** 量文字：图片居中了不等于图片下面那行字也居中，两者是不同的格子、不同的居中机制 */
    private static void reportText(PDDocument doc, int page, double reference, String like) throws IOException {
        TextCollector collector = new TextCollector();
        collector.setStartPage(page);
        collector.setEndPage(page);
        collector.getText(doc);
        List<TextRun> runs = collector.runs;
        Collections.sort(runs, new java.util.Comparator<TextRun>() {
            public int compare(TextRun a, TextRun b) {
                int c = Double.compare(a.top, b.top);
                return c != 0 ? c : Double.compare(a.left, b.left);
            }
        });
        int shown = 0;
        for (TextRun run : runs) {
            if (like != null && run.text.indexOf(like) < 0) {
                continue;
            }
            double delta = run.centerX() - reference;
            System.out.println("[PROBE]  文本 y=" + fmt(run.top) + "  x=" + fmt(run.left)
                    + "~" + fmt(run.left + run.width) + "  cx=" + fmt(run.centerX())
                    + "  Δ=" + (delta >= 0 ? "+" : "") + fmt(delta) + "  \"" + run.text + "\"");
            shown++;
        }
        System.out.println("[PROBE]  文本共 " + runs.size() + " 段，打印 " + shown
                + "（TEXT_LIKE 可过滤；Δ 是相对图片的参考中轴）");
    }

    private static class TextRun {
        String text;
        double left;
        double top;
        double width;

        double centerX() {
            return left + width / 2;
        }
    }

    private static class TextCollector extends PDFTextStripper {
        final List<TextRun> runs = new ArrayList<TextRun>();

        TextCollector() throws IOException {
            super();
        }

        @Override
        protected void writeString(String text, List<TextPosition> positions) throws IOException {
            if (text.trim().isEmpty() || positions.isEmpty()) {
                return;
            }
            double left = Double.MAX_VALUE;
            double right = -Double.MAX_VALUE;
            double top = 0;
            for (TextPosition position : positions) {
                left = Math.min(left, position.getXDirAdj());
                right = Math.max(right, position.getXDirAdj() + position.getWidthDirAdj());
                top = position.getYDirAdj();
            }
            TextRun run = new TextRun();
            run.text = text.trim();
            run.left = left;
            run.top = top;
            run.width = right - left;
            runs.add(run);
        }
    }

    private static List<List<Img>> groupRows(List<Img> images) {
        List<Img> sorted = new ArrayList<Img>(images);
        Collections.sort(sorted, new java.util.Comparator<Img>() {
            public int compare(Img a, Img b) {
                int c = Double.compare(a.top, b.top);
                return c != 0 ? c : Double.compare(a.left, b.left);
            }
        });
        List<List<Img>> rows = new ArrayList<List<Img>>();
        for (Img img : sorted) {
            List<Img> last = rows.isEmpty() ? null : rows.get(rows.size() - 1);
            //纵向重叠过半就算同一行，容忍图片不等高
            if (last != null && Math.abs(img.top - last.get(0).top) <= last.get(0).height / 2) {
                last.add(img);
            } else {
                List<Img> row = new ArrayList<Img>();
                row.add(img);
                rows.add(row);
            }
        }
        return rows;
    }

    /** 行中轴 = 本行最左图左边到最右图右边的中点 */
    private static double axis(List<Img> row) {
        double left = Double.MAX_VALUE;
        double right = -Double.MAX_VALUE;
        for (Img img : row) {
            left = Math.min(left, img.left);
            right = Math.max(right, img.left + img.width);
        }
        return (left + right) / 2;
    }

    private static int[] wantedPages(String pages, int total) {
        if (pages == null || pages.trim().isEmpty()) {
            int[] all = new int[total];
            for (int i = 0; i < total; i++) {
                all[i] = i + 1;
            }
            return all;
        }
        String[] parts = pages.split(",");
        List<Integer> list = new ArrayList<Integer>();
        for (String part : parts) {
            int page = Integer.parseInt(part.trim());
            if (page == -1) {
                page = total;
            }
            if (page >= 1 && page <= total) {
                list.add(Integer.valueOf(page));
            }
        }
        int[] result = new int[list.size()];
        for (int i = 0; i < result.length; i++) {
            result[i] = list.get(i).intValue();
        }
        return result;
    }

    /** 一张图片在页面上的位置，坐标已翻成"原点在左上角"，单位 pt */
    private static class Img {
        double left;
        double top;
        double width;
        double height;

        double centerX() {
            return left + width / 2;
        }
    }

    /**
     * 走一遍内容流，逮住每个 Do 操作符上的图片 XObject，从当前变换矩阵里读出它占的矩形。
     * 必须自己注册 q/Q/cm/gs 这几个状态操作符，否则 CTM 永远是初始矩阵，所有图片会量到同一个位置。
     */
    private static class ImageCollector extends PDFStreamEngine {
        private final float pageHeight;
        final List<Img> images = new ArrayList<Img>();

        ImageCollector(float pageHeight) {
            this.pageHeight = pageHeight;
            addOperator(new Concatenate());
            addOperator(new Save());
            addOperator(new Restore());
            addOperator(new SetGraphicsStateParameters());
        }

        //必须重写这个 protected 重载：内容流解析器直接调的是它，
        //public 的 processOperator(String,List) 是反过来调它的，重写那个收不到任何操作符
        @Override
        protected void processOperator(Operator operator, List<COSBase> operands) throws IOException {
            String operation = operator.getName();
            if ("Do".equals(operation) && !operands.isEmpty() && operands.get(0) instanceof COSName) {
                PDXObject xobject = getResources().getXObject((COSName) operands.get(0));
                if (xobject instanceof PDImageXObject) {
                    Matrix ctm = getGraphicsState().getCurrentTransformationMatrix();
                    Img img = new Img();
                    img.width = ctm.getScalingFactorX();
                    img.height = ctm.getScalingFactorY();
                    img.left = ctm.getTranslateX();
                    //PDF 的 y 从页底往上，翻成从页顶往下，跟看图时的直觉一致
                    img.top = pageHeight - ctm.getTranslateY() - img.height;
                    images.add(img);
                } else if (xobject instanceof PDFormXObject) {
                    showForm((PDFormXObject) xobject);
                }
                return;
            }
            super.processOperator(operator, operands);
        }
    }

    // ---------------- 造占位图 ----------------

    private static void collectSpecPaths(String spec, List<String> out) throws IOException {
        if (spec == null) {
            return;
        }
        File asFile = new File(spec);
        if (asFile.isFile() && spec.indexOf(',') < 0) {
            out.addAll(Files.readAllLines(Paths.get(spec), StandardCharsets.UTF_8));
        } else {
            for (String line : spec.split("[,\\r\\n]")) {
                out.add(line);
            }
        }
    }

    /** 从单据的图片字段里把路径查出来，比去日志里捞可靠：那条下载失败的日志根本不打印路径 */
    private static void collectFieldPaths(String spec, String billIds, List<String> out) {
        if (spec == null) {
            return;
        }
        int colon = spec.indexOf(':');
        if (colon < 0) {
            throw new IllegalArgumentException("PLANT_FROM 应形如 实体标识:字段路径[,字段路径]");
        }
        String entity = spec.substring(0, colon).trim();
        String[] fields = spec.substring(colon + 1).split(",");
        //主键是 long，拿字符串去 in 查会命中不了
        List<Object> ids = new ArrayList<Object>();
        for (String id : billIds.split(",")) {
            String trimmed = id.trim();
            if (trimmed.isEmpty()) {
                continue;
            }
            try {
                ids.add(Long.valueOf(trimmed));
            } catch (NumberFormatException e) {
                ids.add(trimmed);
            }
        }
        //分录里的字段必须显式取别名，否则结果集里按 f0/f1 之外的名字都取不到（不是最后一段）
        StringBuilder select = new StringBuilder("id");
        for (int i = 0; i < fields.length; i++) {
            select.append(',').append(fields[i].trim()).append(" f").append(i);
        }
        DynamicObjectCollection rows = QueryServiceHelper.query(entity, select.toString(),
                new QFilter[]{new QFilter("id", "in", ids)});
        int before = out.size();
        for (int i = 0; i < rows.size(); i++) {
            for (int j = 0; j < fields.length; j++) {
                String value = rows.get(i).getString("f" + j);
                if (value != null && !value.trim().isEmpty()) {
                    out.add(value.trim());
                }
            }
        }
        System.out.println("[PROBE] PLANT_FROM 从 " + entity + " 查到 " + (out.size() - before) + " 个图片路径");
    }

    private static void plantMissingImages(List<String> paths) throws IOException {
        if (paths.isEmpty()) {
            return;
        }
        String root = System.getProperty("user.dir") + File.separator + "filestorage";
        int planted = 0;
        int index = 0;
        for (String raw : paths) {
            String path = raw.trim();
            if (path.isEmpty()) {
                continue;
            }
            index++;
            //有的路径带前导 /、有的不带，直接拼会拼出 filestorageierp\...
            String relative = path.replace('/', File.separatorChar);
            if (!relative.startsWith(File.separator)) {
                relative = File.separator + relative;
            }
            File file = new File(root + relative);
            if (file.exists()) {
                System.out.println("[PROBE]   已存在 " + file.length() + "B  " + path);
                continue;
            }
            System.out.println("[PROBE]   造图 " + index + "  " + path);
            if (file.getParentFile() != null) {
                file.getParentFile().mkdirs();
            }
            ImageIO.write(placeholder(index), "png", file);
            planted++;
        }
        System.out.println("[PROBE] 占位图：新造 " + planted + " 张（共 " + index + " 个路径），root=" + root);
    }

    /** 带编号和红框的占位图：编号用来认出哪张图落到了哪一格，红框用来量边界 */
    private static BufferedImage placeholder(int index) {
        BufferedImage image = new BufferedImage(800, 600, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(new Color(220, 235, 255));
        g.fillRect(0, 0, 800, 600);
        g.setColor(Color.RED);
        g.setStroke(new java.awt.BasicStroke(10f));
        g.drawRect(5, 5, 790, 590);
        g.setColor(Color.BLACK);
        g.setFont(new java.awt.Font("SansSerif", java.awt.Font.BOLD, 300));
        g.drawString(String.valueOf(index), 320, 400);
        g.dispose();
        return image;
    }

    // ---------------- 杂项 ----------------

    private static void write(File file, byte[] bytes) throws IOException {
        if (file.getParentFile() != null) {
            file.getParentFile().mkdirs();
        }
        FileOutputStream fos = new FileOutputStream(file);
        try {
            fos.write(bytes);
        } finally {
            fos.close();
        }
    }

    private static String fmt(double value) {
        return String.format("%.1f", Double.valueOf(value));
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }

    private static String require(String key) {
        String value = env(key);
        if (value == null) {
            throw new IllegalArgumentException("缺少环境变量 " + key);
        }
        return value;
    }
}
