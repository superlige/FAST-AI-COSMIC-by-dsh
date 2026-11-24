import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import kd.bos.print.api.metedata.DesignerMetadata;
import kd.bos.print.api.metedata.PrintMetadata;
import kd.bos.print.api.utils.SerializeUtils;
import kd.bos.print.business.metedata.PrintMetadataUtil;
import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.service.BosPrintServiceHelper;

/**
 * 写探针：改打印模板。默认 dry-run，必须 APPLY=1 才落库。三种改法，给一个：
 *
 *   - **属性赋值**（`TPL_SET`）：按「控件 + 属性路径 = 值」改一两个标量属性，字号、宽度、是否显示。
 *   - **整份提交**（`TPL_FILE`）：把一份完整的设计数据交回去。加控件、加表格、改公式、改绑定
 *     都走这条——`TPL_SET` 表达不了这些（值不是标量、控件还不存在）。
 *   - **整份恢复**（`TPL_RESTORE`）：把改前备份目录里那份原样写回去。走的和整份提交同一条路，
 *     同样比差异、同样核版本——恢复也是一次写，不能因为「写的是旧内容」就少过一道关。
 *
 * 走的是设计器自己那条保存链（`getDesignMeta` → `getPrintMetadata` →
 * `toDesignerMetadata` → JSON 往返成普通 Map → `beforeSave` → `updatePrintMeta`），
 * 一步都没省。为什么不能用 `SaveServiceHelper` / `update(dm)` / `saveOrUpdate(dm)`，
 * 见 reference/print-template-write.md。
 *
 * 三条准入，都不是「注意事项」而是硬判据：
 *   1. **写通道过的是 `IsvGuard.assertOwnPrintTpl`，比只读那道多一条「挂靠单据也要是本 ISV」。**
 *      挂在原厂单上的自有模板要走开发平台的扩展流程，不走这里。
 *   2. **`TPL_SET` 只改已经存在的属性，不新建。** 属性名写错时新建一个键，平台不会报错，模板照样保存，
 *      但那个属性永远不生效 —— 症状是「改了没反应」，最难查。整份提交不受这条限制，
 *      因为它的输入是 `ptpl dump` 的原样产物，不是模型拼出来的属性名。
 *   3. **新值的类型跟旧值走。** 把 18.3 写成字符串 "18.3" 同样保存成功、同样不生效。
 *
 * 整份提交多过五道关，都在落库之前：
 *   a. **是不是同一张模板**：候选里的挂靠单据和模板编码要和库里那份对得上，否则中止。
 *   b. **差异由程序算**（`PrintTplDiff`）：改了哪些控件、哪几处是公式/绑定/属性，比出来打给用户看，
 *      不让模型转述（同 S23 改数据那条规矩）。
 *   c. **改过的公式当场试算**（`PrintTplFormulaTry`，S32 3.1）：用打印自己的校验器判对错、
 *      执行器看显示成什么，字段按类型给样例值试三档（都空 / 只有一个有值 / 都有值），哪一档算崩了照实标「算不出来」。
 *      公式写坏了照样存得进去，要等打印时才发现那一格是空的——这一关就是为它设的。
 *   d. **平台自己的解析器先过一遍**（`PrintMetadataUtil.parseMetadata`，加载模板用的就是它）
 *      再过拓扑审计（`PrintTplDesignProbe.audit`：重复 id、孤儿父子、行列格矩阵、合并区）。
 *   e. **新登记的打印插件找一遍类**：平台对加载不了的插件不报错、只是打印时不执行它，
 *      所以类名写错要在这里拦下（`checkPlugins`，只读类文件、不加载，和改单据挂插件同一个办法）。
 *
 * **落库之后再回读核对一遍**（S32 3.2）：重新读一次库里那份，和交上去的按控件 id 逐处比。
 * 「接口没报错」不等于「写进去的就是那份」——平台在保存链上做了什么归一化，只有回读看得见。
 *
 * **改前快照跨过用户确认**：dry-run 打一行 `改前快照=`，APPLY 时内核用 `-Dcosmic.baseline` 交回来，
 * 对不上就一个字都不改 —— 用户确认的是那一刻的模板，确认到执行之间别人可能在设计器里保存过。
 * 落库前后再各核一次 `modifyVersion` + `data` 哈希，防的是同一次执行里的并发。
 *
 *   TPL_NUMBER=模板编码（必填）
 *   TPL_SET=<控件>.<属性路径>=<值>[;…]   控件写 id 或 key；属性路径可以带点，如 border.width.top
 *                                       值写 null 表示置空
 *   TPL_FILE=<设计数据 json>             整份提交；文件就是 `meta ptpl dump` 出来的 *.meta.json
 *   TPL_LOCALE=<多语言 json>             整份提交时可选；不给就沿用库里那份多语言旁路
 *   TPL_RESTORE=<备份目录>               整份恢复：目录里的 <编码>.meta.json + <编码>.locale.json
 *   TPL_BACKUP=目录                      落库前把改前的 meta/locale JSON 存进去；APPLY=1 时工具自动给（.cosmic-ai/evidence/backups/ 下），不用写
 *   TPL_FORMULA_TRY=0                    关掉公式试算（默认开）。只在试算自己判错时用，并说明理由
 *   APPLY=1                              真落库（默认复用常驻进程，显式 cold 才强制冷进程）
 */
public class PrintTplWriteProbe {

    public static void run() throws Exception {
        boolean apply = "1".equals(env("APPLY", ""));
        String number = env("TPL_NUMBER", "");
        if (number.isEmpty()) throw new IllegalArgumentException("必须给 TPL_NUMBER");
        String setSpec = env("TPL_SET", "");
        String file = env("TPL_FILE", "");
        String localeFile = env("TPL_LOCALE", "");
        String restoreDir = env("TPL_RESTORE", "");
        int given = (setSpec.isEmpty() ? 0 : 1) + (file.isEmpty() ? 0 : 1) + (restoreDir.isEmpty() ? 0 : 1);
        if (given != 1) {
            throw new IllegalArgumentException("TPL_SET / TPL_FILE / TPL_RESTORE 只能给一个，而且必须给一个："
                    + "改一两个标量属性用 TPL_SET=<控件>.<属性路径>=<值>；"
                    + "加控件、加表格、改公式这类改动用 TPL_FILE=<设计数据 json>；"
                    + "把改前那份原样写回用 TPL_RESTORE=<备份目录>");
        }
        if (!restoreDir.isEmpty()) {
            //恢复的入参是一个目录，里面就是 TPL_BACKUP 落下的那两份，文件名由模板编码定
            String safe = number.replaceAll("[^A-Za-z0-9._-]", "_");
            File dir = new File(restoreDir);
            if (!dir.isDirectory()) {
                throw new IllegalArgumentException("TPL_RESTORE 指的不是目录：" + dir.getAbsolutePath());
            }
            File meta = new File(dir, safe + ".meta.json");
            if (!meta.isFile()) {
                throw new IllegalArgumentException("备份目录里没有这张模板的设计数据：" + meta.getAbsolutePath()
                        + " —— 这个目录是 ptpl apply --backup 或 ptpl dump 落下的那一个吗");
            }
            file = meta.getAbsolutePath();
            File loc = new File(dir, safe + ".locale.json");
            if (loc.isFile()) localeFile = loc.getAbsolutePath();
        }
        if (!localeFile.isEmpty() && file.isEmpty()) {
            throw new IllegalArgumentException("TPL_LOCALE 只跟 TPL_FILE 一起给");
        }
        List<Setter> setters = setSpec.isEmpty() ? new ArrayList<Setter>() : parseSets(setSpec);
        String backupDir = env("TPL_BACKUP", "");
        if (apply && backupDir.isEmpty()) {
            System.out.println("[PROBE] !! APPLY=1 必须同时给 TPL_BACKUP=<目录>，中止");
            return;
        }

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (tplId == null || tplId.trim().isEmpty()) {
            throw new IllegalArgumentException("模板不存在: " + number);
        }
        PrintTplService service = new PrintTplService();
        DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
        if (dm == null) throw new IllegalStateException("读不到模板本体: id=" + tplId);
        //写通道的门禁：比只读多一条挂靠单据
        IsvGuard.assertOwnPrintTpl(number, dm.getNumber(), dm.getIsv(), dm.getFormId());

        long baseVersion = dm.getModifyVersion();
        String baseSha = sha256(dm.getData());
        System.out.println("[PROBE] 模式=" + (apply ? "APPLY 真写" : "dry-run 只演算")
                + "  改法=" + (file.isEmpty() ? "属性赋值" : restoreDir.isEmpty() ? "整份提交" : "整份恢复")
                + "  模板=" + number + " id=" + tplId + " 挂靠=" + dm.getFormId());
        System.out.println("[PROBE] 基线 modifyVersion=" + baseVersion + " dataSha256=" + baseSha);

        //改前快照：跨过用户确认那段时间的版本基线（S32 1.5）。dry-run 打出来、内核记进计划，
        //APPLY 时用 -Dcosmic.baseline 交回来核对。落库前后那两次核对都在同一次执行里，盖不住确认窗口。
        String baseline = sha256(baseVersion + "\n" + baseSha).substring(0, 16);
        System.out.println("[PROBE] 改前快照=" + baseline + "（modifyVersion " + baseVersion + "）");
        if (apply && !confirmedBaseline(baseline)) return;

        PrintMetadata pm = service.getPrintMetadata(dm);
        String lang = first(pm.getFixedLang(), pm.getOriLang(), "zh_CN");
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
        //JSON 往返不能省：直接把设计器对象图当普通 Map 传进 updatePrintMeta，边框等控件会解析失败
        @SuppressWarnings("unchecked")
        Map<String, Object> metadata = (Map<String, Object>) SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(designer.getMetadata()), Map.class);
        Map<String, ?> localeValueMap = designer.getLocaleValueMap();

        if (apply) {
            //备份的永远是库里现在那份，不是要写进去的那份
            backup(backupDir, number, metadata, localeValueMap);
        }

        Map<String, Object> toSave = metadata;
        Map<String, ?> toSaveLocale = localeValueMap;
        //取值变了的控件（公式或绑定改了、或新加的）：预演时拿它们在真单上试
        List<String> valueChanged = new ArrayList<String>();
        if (file.isEmpty()) {
            for (Setter s : setters) {
                applyOne(metadata, localeValueMap, lang, s);
            }
        } else {
            Map<String, Object> candidate = readJsonMap(file, restoreDir.isEmpty() ? "TPL_FILE" : "TPL_RESTORE");
            assertSameTemplate(number, dm.getFormId(), metadata, candidate);
            if (!reportChanges(metadata, candidate)) return;
            if (!tryFormulas(metadata, candidate)) return;
            if (!validateCandidate(candidate, lang)) return;
            if (!checkPlugins(metadata, candidate, !restoreDir.isEmpty())) return;
            valueChanged = valueChanged(metadata, candidate);
            toSave = candidate;
            if (!localeFile.isEmpty()) toSaveLocale = readJsonMap(localeFile, "TPL_LOCALE");
        }

        Map<?, ?> check = service.beforeSave(toSave);
        System.out.println("[PROBE] beforeSave -> " + check);
        if ("false".equals(String.valueOf(check.get("success")))) {
            System.out.println("[PROBE] 未落库：平台校验不通过，一个字都没改 —— " + check.get("message"));
            return;
        }

        if (!apply) {
            tryOnBill(number, toSave, lang, valueChanged);
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，数据库未修改。"
                    + "确认无误后加 APPLY=1");
            return;
        }

        //二次核对：读到基线之后到现在，有没有别人在设计器里保存过
        DesignMetadata now = (DesignMetadata) service.getDesignMeta(tplId);
        if (now.getModifyVersion() != baseVersion || !baseSha.equals(sha256(now.getData()))) {
            System.out.println("[PROBE] 未落库：改前数据和预演时不一样了（modifyVersion " + baseVersion + " -> "
                    + now.getModifyVersion() + "），刚刚有人在设计器里保存过，一个字都没改，以免覆盖。"
                    + "重新 dry-run、重新确认");
            return;
        }
        service.updatePrintMeta(toSave, SerializeUtils.toJsonString(toSaveLocale), lang);
        DesignMetadata after = (DesignMetadata) service.getDesignMeta(tplId);
        System.out.println("[PROBE] 已落库。modifyVersion " + baseVersion + " -> "
                + after.getModifyVersion() + "，dataSha256=" + sha256(after.getData()));
        readBack(service, after, lang, toSave);
        //出 PDF 是整条链路里最贵的一步（实测 33.5 秒），所以是可选的，不做成每次都跑（S32 3.3）
        System.out.println("[PROBE] 排版复核（可选，约 30 秒）：meta ptpl measure " + number
                + " --bill <单据id> --text —— 改了排版、加了表格才值得跑；"
                + "格子里的文字对，不等于分页和排版对，只有出一次 PDF 才看得见");
    }

    // ── 落库后回读（S32 3.2） ──────────────────────────────────────────

    /**
     * 写完再读一遍，按语义比对，不只看接口没报错。
     *
     * `updatePrintMeta` 不抛异常只说明这次调用没炸，说明不了库里那份就是交上去的那份：
     * 保存链上还有 `beforeSave` 的加工和平台自己的归一化。读回来按控件 id 逐处比，
     * 一致就写一句话，不一致就把每一处列出来 —— **这时已经落库了，报的是「库里以什么为准」，
     * 不是「要不要写」**，所以它不说「未落库」，也不该被当成一次中止。
     */
    private static void readBack(PrintTplService service, DesignMetadata after, String lang,
                                 Map<String, Object> toSave) {
        try {
            PrintMetadata pm = service.getPrintMetadata(after);
            DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
            @SuppressWarnings("unchecked")
            Map<String, Object> back = (Map<String, Object>) SerializeUtils.fromJsonString(
                    SerializeUtils.toJsonString(designer.getMetadata()), Map.class);
            List<PrintTplDiff.Change> left = PrintTplDiff.diff(toSave, back);
            if (left.isEmpty()) {
                System.out.println("[PROBE] 回读核对：库里那份和交上去的一模一样（按控件 id 逐处比，不是只看接口没报错）");
                return;
            }
            System.out.println("[PROBE] !! 回读核对：库里那份和交上去的有 " + left.size()
                    + " 处对不上 —— 已经落库了，这几处以库里为准。平台在保存链上自己改的，"
                    + "看一眼是不是要紧；要紧就用 meta ptpl restore " + String.valueOf(toSave.get("key"))
                    + " <备份目录> 整份退回去");
            for (PrintTplDiff.Change c : left) {
                System.out.println("[PROBE]   " + c);
                ProbeJson.emit("tpl-readback", "owner", c.owner == null ? "" : c.owner,
                        "path", c.path, "sent", c.from, "stored", c.to);
            }
        } catch (Throwable e) {
            System.out.println("[PROBE] !! 回读核对没跑成（已经落库了）：" + e.getClass().getSimpleName()
                    + ": " + oneLine(e.getMessage()) + " —— 用 meta ptpl dump 再 meta ptpl diff 自己比一次");
        }
    }

    // ── 公式试算（S32 3.1） ────────────────────────────────────────────

    /**
     * 改过的公式当场试算一遍。返回 false 表示公式写坏了，调用方停在落库之前。
     *
     * 为什么值得为它多写一关：公式写坏了**照样存得进去**——平台解析器只看形状，
     * `beforeSave` 也不看公式内容，要等有人去打印才发现那一格是空的。
     * 试算用的是打印自己的校验器和执行器，跟着整份提交一起跑，不多一次往返（`PrintTplFormulaTry`）。
     */
    private static boolean tryFormulas(Map<String, Object> current, Map<String, Object> candidate) {
        if ("0".equals(env("TPL_FORMULA_TRY", "1"))) {
            System.out.println("[PROBE] 公式试算：按 TPL_FORMULA_TRY=0 跳过了（这次没验公式算出来是什么）");
            return true;
        }
        List<PrintTplFormulaTry.Trial> trials;
        try {
            trials = PrintTplFormulaTry.changed(current, candidate);
        } catch (Throwable e) {
            System.out.println("[PROBE] 公式试算没跑成：" + e.getClass().getSimpleName() + ": "
                    + oneLine(e.getMessage()) + " —— 这一关跳过，别的关照常");
            return true;
        }
        if (trials.isEmpty()) return true;
        List<String> broken = new ArrayList<String>();
        List<String> unsure = new ArrayList<String>();
        for (PrintTplFormulaTry.Trial trial : trials) {
            if (trial.error != null) {
                System.out.println("[PROBE]   ✗ " + trial.control + "  " + trial.text);
                System.out.println("[PROBE]     平台报错：" + trial.error
                        + (trial.missingFunction == null ? "" : FormulaCheck.nearText(trial.near)));
                System.out.println("[PROBE]     交给校验器的是：" + trial.input);
                ProbeJson.emit("formula-error", "domain", "print", "where", trial.control,
                        "kind", trial.missingFunction == null ? "print-validate" : "function",
                        "input", trial.text, "token", trial.missingFunction, "detail", trial.error,
                        "near", trial.near);
                broken.add(trial.control + "：" + trial.error);
                continue;
            }
            System.out.println("[PROBE]   " + (trial.failed.isEmpty() ? "" : "⚠ ") + trial.control + "  " + trial.text
                    + (trial.fields.isEmpty() ? "" : "  用到字段 " + join(trial.fields)));
            for (Map.Entry<String, String> shown : trial.shown.entrySet()) {
                System.out.println("[PROBE]     " + shown.getKey() + " 时显示：「"
                        + shown.getValue().replace("\n", " ⏎ ") + "」");
                ProbeJson.emit("tpl-formula", "control", trial.control, "formula", trial.text,
                        "case", shown.getKey(), "shown", shown.getValue().replace("\n", " ⏎ "));
            }
            if (!trial.failed.isEmpty()) unsure.add(trial.control);
        }
        // 执行器算崩一行只记警告、那一行打成空的；算崩可能是公式的毛病，也可能是样例值不像真数据，所以照实标出来、不拦
        String verdict = !broken.isEmpty() ? broken.size() + " 条写坏了"
                : !unsure.isEmpty() ? unsure.size() + " 条有一档算不出来（" + join(unsure)
                        + "，见上「算不出来」：打印算一行出错只记一条警告，那一行打成空的；"
                        + "是公式的毛病还是样例值不像真数据，用 --pk 在真单上看）"
                : "都过了（校验器和执行器都没报错；字段用的是样例值，这张单上显示什么看候选预览）";
        System.out.println("[PROBE] 公式试算：" + trials.size() + " 条改过的公式，" + verdict);
        if (broken.isEmpty()) return true;
        System.out.println("[PROBE] 未落库：公式试算不过，一个字都没改 —— " + join(broken)
                + "。改完重新 dry-run；确认是试算自己判错了，再用 TPL_FORMULA_TRY=0 跳过并说明理由");
        return false;
    }

    /**
     * 真单预览（S36 批 5）。公式试算把字段换成样例值，答得了「写对没有」，答不了「这张单上显示什么」；
     * 以前要先授权落库、再 run print，发现不对再改再落。现在给了 PRINT_PK 就在预演里用内存里的候选模板
     * 出一次打印（PrintSim.tryCandidate），不落库、不改单据；没给就说一句能照抄的单据 id。
     */
    private static void tryOnBill(String number, Map<String, Object> candidate, String lang, List<String> cells)
            throws Exception {
        String pk = env("PRINT_PK", "");
        if (!pk.isEmpty()) {
            PrintSim.tryCandidate(number, candidate, lang, pk, cells);
            return;
        }
        if (cells.isEmpty()) return;
        String[] bill = PrintSim.latestBill(number);
        System.out.println("[PROBE] 真单预览：加 --pk <单据ID 或 billno:编号> 就用这份候选在那张单上出一次打印（预览，不落库），"
                + "看 " + join(cells) + " 输出什么；"
                + (bill[1] == null ? "这张模板打的 " + bill[0] + " 库里一张单都没有，预览和落库后的 run print 都没有单可打"
                        : "这张模板打 " + bill[0] + "，最近一张 pk=" + bill[1]));
    }

    private static String json(Object value) {
        return value == null ? "" : SerializeUtils.toJsonString(value);
    }

    /** 取值变了的控件 key（没有 key 用 id）：公式、绑定字段或数据源变了，或者是新加的。 */
    private static List<String> valueChanged(Map<String, Object> before, Map<String, Object> after) {
        Map<String, Map<String, Object>> a = PrintTplDiff.byId(before);
        List<String> out = new ArrayList<String>();
        for (Map.Entry<String, Map<String, Object>> e : PrintTplDiff.byId(after).entrySet()) {
            Map<String, Object> now = e.getValue();
            Map<String, Object> old = a.get(e.getKey());
            boolean hasValue = now.get("formulaData") instanceof List && !((List<?>) now.get("formulaData")).isEmpty()
                    || now.get("bindField") != null && !String.valueOf(now.get("bindField")).isEmpty();
            if (!hasValue) continue;
            boolean changed = old == null;
            for (String k : new String[]{"formulaData", "bindField", "dataSource"}) {
                if (!changed && !json(now.get(k)).equals(json(old.get(k)))) changed = true;
            }
            if (!changed) continue;
            Object key = now.get("key");
            out.add(key == null || String.valueOf(key).isEmpty() ? e.getKey() : String.valueOf(key));
        }
        return out;
    }

    private static String join(List<String> parts) {
        StringBuilder b = new StringBuilder();
        for (String p : parts) b.append(b.length() == 0 ? "" : "；").append(p);
        return b.toString();
    }

    // ── 改前快照 ────────────────────────────────────────────────────────

    /**
     * APPLY 时核对用户确认过的那份改前快照（S32 1.5）。
     *
     * 为什么不够用现有那两次核对：它们都在同一次执行里（开头读一次、写前再读一次），
     * 中间隔着「用户看确认单、点确认」那段时间根本没盖住。确认单上写的「哪个控件从什么变成什么」
     * 是 dry-run 那一刻的事实；这中间别人在设计器里保存过，那份事实就不是真的了。
     */
    private static boolean confirmedBaseline(String baseline) {
        String confirmed = System.getProperty("cosmic.baseline", "").trim();
        if (confirmed.isEmpty()) {
            System.out.println("[PROBE] 未落库：没拿到用户确认过的改前快照，一个字都没改。"
                    + "先 dry-run 一次拿确认，再用同一组入参执行");
            return false;
        }
        if (!confirmed.equals(baseline)) {
            System.out.println("[PROBE] 未落库：改前数据和预演时不一样了（确认时 " + confirmed
                    + "，现在 " + baseline + "），一个字都没改。"
                    + "中间有人在设计器里保存过，确认单上的改动已经不是真的，重新 dry-run、重新确认");
            return false;
        }
        return true;
    }

    // ── 整份提交 ────────────────────────────────────────────────────────

    /**
     * 候选和库里那份是不是同一张模板。
     *
     * 交错文件是整份提交最容易犯、后果最重的错：一整张模板被另一张顶掉，
     * 而且 `beforeSave` 不会拦（那份候选自己是合法的）。挂靠单据和模板编码各核一次。
     */
    private static void assertSameTemplate(String number, String formId,
                                           Map<String, Object> current, Map<String, Object> candidate) {
        String want = String.valueOf(current.get("key"));
        String got = String.valueOf(candidate.get("key"));
        if (!want.equals(got)) {
            throw new IllegalArgumentException("候选文件不是这张模板：库里的编码是「" + want
                    + "」，文件里写的是「" + got + "」。别把另一张模板的 dump 交上来");
        }
        String candidateForm = String.valueOf(candidate.get("formId"));
        if (formId != null && !formId.equals(candidateForm)) {
            throw new IllegalArgumentException("候选文件挂靠的单据对不上：库里是「" + formId
                    + "」，文件里是「" + candidateForm + "」");
        }
    }

    /**
     * 差异由程序比，不由模型转述（S32 1.2）。返回 false 表示没有要改的，调用方直接结束。
     *
     * 逐处差异也发一条 `t=tpl-change`，确认单上「改了什么」那一栏就是从这里来的 —— 和
     * `TPL_SET` 那条路上的 `t=tpl-set` 同一个位置、同一个用途（S23）。
     */
    private static boolean reportChanges(Map<String, Object> current, Map<String, Object> candidate) {
        PrintTplDiff.Summary summary = PrintTplDiff.summarize(current, candidate);
        List<PrintTplDiff.Change> changes = PrintTplDiff.diff(current, candidate);
        if (changes.isEmpty()) {
            System.out.println("[PROBE] 候选和库里那份一模一样，没有要改的，不落库");
            return false;
        }
        System.out.println("[PROBE] 这次改动：" + summary.oneLine() + "（逐处差异 " + changes.size() + " 条）");
        report("新增控件", summary.added);
        report("删除控件", summary.removed);
        report("公式变化", summary.formula);
        report("绑定变化", summary.binding);
        report("属性变化", summary.other);
        report("模板级变化", summary.root);
        //一条不少：确认单的差异表和条数都从这些记录来，这里截了，确认单就少报（S44 批 1）
        for (PrintTplDiff.Change c : changes) {
            System.out.println("[PROBE]   " + c);
            ProbeJson.emit("tpl-change", "owner", c.owner == null ? "" : c.owner,
                    "path", c.path, "before", c.from, "after", c.to);
        }
        return true;
    }

    private static void report(String what, List<String> items) {
        if (items.isEmpty()) return;
        StringBuilder b = new StringBuilder();
        //不全列：摘要行，逐处差异紧跟着全列
        for (int i = 0; i < items.size() && i < 12; i++) b.append(b.length() == 0 ? "" : "、").append(items.get(i));
        if (items.size() > 12) b.append("…共 ").append(items.size()).append(" 个");
        System.out.println("[PROBE]   " + what + "：" + b);
    }

    /**
     * 候选在落库之前先过平台自己那两关（S32 1.3）。返回 false 表示没过、调用方结束。
     *
     * 第一关是 `parseMetadata` —— 平台加载模板用的就是它，候选能不能被平台读懂由它说了算，
     * 不是由我们自己写的规则说了算。第二关是拓扑审计：重复 id、孤儿父子、行列格矩阵不完整、
     * 合并区越界，这些 `beforeSave` 不查，但会在打印时变成排版错乱或干脆打不出来。
     */
    private static boolean validateCandidate(Map<String, Object> candidate, String lang) {
        try {
            PrintMetadataUtil.parseMetadata(copy(candidate), lang);
        } catch (Throwable e) {
            System.out.println("[PROBE] 未落库：候选平台解析不过，一个字都没改 —— "
                    + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()));
            return false;
        }
        List<String> errors = PrintTplDesignProbe.audit(candidate, PrintTplDesignProbe.controls(candidate));
        if (!errors.isEmpty()) {
            System.out.println("[PROBE] 未落库：候选拓扑审计有 " + errors.size() + " 处问题，一个字都没改");
            for (String error : errors) System.out.println("[PROBE]   ✗ " + error);
            return false;
        }
        System.out.println("[PROBE] 候选已过平台解析和拓扑审计");
        return true;
    }

    /**
     * 这次新登记（或刚改成启用）的打印插件，落库之前找一遍类：类路径上有没有、是不是打印插件。
     * 返回 false 表示有插件平台加载不了，调用方停在落库之前。
     *
     * 为什么要有这一关：平台是按类名现场建插件实例的，建不出来只往日志里记一条错、然后跳过这个插件
     * （`PrintPluginProxy` 的构造函数）。类名写错一个字母，解析、`beforeSave`、预览、保存全都照过，
     * 要等有人打印、发现插件没起作用才知道（真机实测）。`Type` 不是整数更糟：平台直接强转，整张单打不出来。
     *
     * 只查这次新登记的：模板上原有的插件不归这次改动管，不因为它们拦住别的改动。
     * 整份恢复只提醒不拦 —— 恢复是退路，不能因为旧版本登记的类后来删了就退不回去。
     */
    private static boolean checkPlugins(Map<String, Object> current, Map<String, Object> candidate,
                                        boolean restoring) {
        List<Map<String, Object>> after;
        Set<String> before = new HashSet<String>();
        try {
            after = pluginsOf(candidate);
            for (Map<String, Object> one : pluginsOf(current)) {
                if (one.get("Enabled") == Boolean.TRUE) before.add(String.valueOf(one.get("ClassName")));
            }
        } catch (Throwable e) {
            System.out.println("[PROBE] 未落库：候选的 plugins 读不懂（它应当是一段 JSON 数组文本），一个字都没改 —— "
                    + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()));
            return false;
        }
        List<String> errors = new ArrayList<String>();
        for (Map<String, Object> one : after) {
            String className = String.valueOf(one.get("ClassName"));
            if (one.get("Enabled") != Boolean.TRUE || before.contains(className)) continue;
            Object type = one.get("Type");
            if (!(type instanceof Integer)) {
                errors.add(className + "：Type 写的是 " + brief(type) + "，平台要整数（Java 插件是 0）");
                continue;
            }
            //脚本插件（Type 1、4）不是按类名找类的，这里判不了
            if (((Integer) type).intValue() != 0) continue;
            //只读类文件看它继承了谁，不加载（写探针不碰业务类），和改单据挂插件同一个办法（ClassFiles）
            Set<String> types = ClassFiles.ancestors(className.replace('.', '/'));
            if (types == null) {
                String source = ProjectSources.of(className);
                if (source == null) {
                    errors.add(className + "：找不到这个类，工程源码里没有，类路径上也没有 —— 类名写错了");
                } else {
                    System.out.println("[PROBE] 新登记的打印插件 " + className + " 的源码在 " + source
                            + "，类路径上还没有它（没编译），没核对它是不是打印插件");
                }
            } else if (!types.contains("kd/bos/print/core/plugin/IPrintPlugin")) {
                errors.add(className + "：类找得到，但不是打印插件（要继承 AbstractPrintPlugin）");
            } else if (ClassFiles.isAbstract(className.replace('.', '/'))) {
                errors.add(className + "：是抽象类或接口，平台建不出它的实例");
            } else {
                System.out.println("[PROBE] 新登记的打印插件 " + className + "：类路径上有这个类，是打印插件");
            }
        }
        if (errors.isEmpty()) return true;
        System.out.println("[PROBE] " + (restoring ? "!! 提醒（整份恢复不拦）" : "未落库")
                + "：新登记的打印插件有 " + errors.size() + " 个不成立"
                + (restoring ? "" : "，一个字都没改") + " —— 平台对加载不了的插件不报错，只是打印时不执行它");
        for (String error : errors) System.out.println("[PROBE]   ✗ " + error);
        return restoring;
    }

    /** 根节点 `plugins`：平台存的是一段塞在字符串里的 JSON 数组，没登记过是 null。 */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> pluginsOf(Map<String, Object> root) {
        Object raw = root.get("plugins");
        if (raw instanceof String && !((String) raw).trim().isEmpty()) {
            raw = SerializeUtils.fromJsonString((String) raw, List.class);
        }
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        if (!(raw instanceof List)) return out;
        for (Object one : (List<Object>) raw) {
            if (!(one instanceof Map)) throw new IllegalArgumentException("plugins 里有一项不是对象");
            out.add((Map<String, Object>) one);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> copy(Map<String, Object> node) {
        return (Map<String, Object>) SerializeUtils.fromJsonString(SerializeUtils.toJsonString(node), Map.class);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> readJsonMap(String path, String what) throws Exception {
        File f = new File(path);
        if (!f.isFile()) throw new IllegalArgumentException(what + " 指的文件不存在：" + f.getAbsolutePath());
        InputStream in = new FileInputStream(f);
        String text;
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            text = new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
        Object parsed;
        try {
            parsed = SerializeUtils.fromJsonString(text, Map.class);
        } catch (Throwable e) {
            throw new IllegalArgumentException(what + " 不是合法 JSON：" + f.getAbsolutePath()
                    + " —— " + oneLine(e.getMessage()));
        }
        if (!(parsed instanceof Map)) {
            throw new IllegalArgumentException(what + " 顶层不是对象：" + f.getAbsolutePath());
        }
        System.out.println("[PROBE] 读入 " + what + "：" + f.getAbsolutePath() + "  "
                + text.getBytes(StandardCharsets.UTF_8).length + " 字节");
        return (Map<String, Object>) parsed;
    }

    private static String oneLine(String message) {
        return message == null ? "" : message.replace('\n', ' ').replace('\r', ' ');
    }

    // ── 参数 ────────────────────────────────────────────────────────────
    private static class Setter {
        String locator;
        String[] path;
        String raw;

        public String toString() { return locator + "." + join(path) + "=" + raw; }
    }

    /**
     * `<控件>.<属性路径>=<值>` —— 控件和属性用**第一个点**分开，剩下的点都属于属性路径。
     * 控件 id 是平台生成的短串（`iaAmP4AXY6`），里面不会有点。
     */
    private static List<Setter> parseSets(String spec) {
        List<Setter> out = new ArrayList<Setter>();
        for (String part : spec.split(";")) {
            String t = part.trim();
            if (t.isEmpty()) continue;
            int eq = t.indexOf('=');
            if (eq < 0) throw new IllegalArgumentException("TPL_SET 少了等号: " + t);
            String left = t.substring(0, eq).trim();
            int dot = left.indexOf('.');
            if (dot <= 0 || dot == left.length() - 1) {
                throw new IllegalArgumentException("TPL_SET 要写成 <控件>.<属性路径>=<值>: " + t);
            }
            Setter s = new Setter();
            s.locator = left.substring(0, dot);
            s.path = left.substring(dot + 1).split("\\.");
            s.raw = t.substring(eq + 1).trim();
            out.add(s);
        }
        return out;
    }

    // ── 改一处 ──────────────────────────────────────────────────────────
    private static void applyOne(Map<String, Object> metadata, Map<String, ?> localeValueMap,
                                 String lang, Setter s) {
        List<Map<String, Object>> hits = new ArrayList<Map<String, Object>>();
        find(metadata, s.locator, hits);
        if (hits.isEmpty()) {
            throw new IllegalArgumentException("找不到控件「" + s.locator
                    + "」—— 先 meta ptpl dump <编码> 把设计 JSON 导下来，在本地 grep id/key");
        }
        if (hits.size() > 1) {
            StringBuilder b = new StringBuilder();
            for (Map<String, Object> h : hits) {
                b.append("\n[PROBE]   id=").append(h.get("id")).append(" key=").append(h.get("key"))
                        .append(" type=").append(h.get("type"));
            }
            throw new IllegalArgumentException("控件「" + s.locator + "」命中 " + hits.size()
                    + " 个，用 id 重来：" + b);
        }
        Map<String, Object> ctl = hits.get(0);
        Map<String, Object> node = ctl;
        for (int i = 0; i < s.path.length - 1; i++) {
            Object next = node.get(s.path[i]);
            if (!(next instanceof Map)) {
                throw new IllegalArgumentException("属性路径走不通：" + s.locator + " 上的 "
                        + join(s.path) + "，在「" + s.path[i] + "」这一段拿到的是 " + brief(next));
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) next;
            node = m;
        }
        String leaf = s.path[s.path.length - 1];
        //不新建属性：拼错的属性名照样能保存，但永远不生效，症状是「改了没反应」
        if (!node.containsKey(leaf)) {
            throw new IllegalArgumentException("控件 " + s.locator + " 上没有属性「" + leaf
                    + "」，本探针不新建属性（新建的属性平台不报错也不生效）");
        }
        Object old = node.get(leaf);
        Object val = coerce(old, s.raw);
        node.put(leaf, val);
        System.out.println("[PROBE] " + label(ctl) + "  " + join(s.path)
                + ": " + brief(old) + "  ->  " + brief(val)
                + "  [" + (val == null ? "null" : val.getClass().getSimpleName()) + "]");
        //授权确认单的「原值 → 新值」由这一条排出来，不让模型转述（S23）
        ProbeJson.emit("tpl-set", "control", String.valueOf(ctl.get("key")), "type", String.valueOf(ctl.get("type")),
                "prop", join(s.path), "before", brief(old), "after", brief(val));
        syncLocale(localeValueMap, lang, String.valueOf(ctl.get("id")), leaf, s.raw);
    }

    /**
     * 多语言旁路映射里同名的键。**只在它当前语言下确实有值时才跟着改** ——
     * 空串表示「没有本地化覆盖，用主 metadata 的值」，往里写值等于凭空造一个覆盖。
     */
    @SuppressWarnings("unchecked")
    private static void syncLocale(Map<String, ?> localeValueMap, String lang,
                                   String ctlId, String prop, String raw) {
        String key = ctlId + "." + prop;
        Object entry = localeValueMap.get(key);
        if (entry == null) return;
        Object cur = null;
        if (entry instanceof Map) {
            cur = ((Map<String, Object>) entry).get(lang);
        }
        if (cur == null || String.valueOf(cur).isEmpty()) {
            System.out.println("[PROBE]   多语言旁路 " + key + " 在 " + lang + " 下为空（继承主值），不动");
            return;
        }
        ((Map<String, Object>) entry).put(lang, raw);
        System.out.println("[PROBE]   多语言旁路 " + key + "[" + lang + "]: " + cur + " -> " + raw);
    }

    /** 递归找 id 或 key 等于 locator 的 Map 节点 */
    private static void find(Object node, String locator, List<Map<String, Object>> out) {
        if (node instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> m = (Map<String, Object>) node;
            if (locator.equals(String.valueOf(m.get("id"))) || locator.equals(String.valueOf(m.get("key")))) {
                out.add(m);
            }
            for (Object v : m.values()) find(v, locator, out);
        } else if (node instanceof List) {
            for (Object v : (List<?>) node) find(v, locator, out);
        }
    }

    /** 新值的类型跟旧值走；旧值是 null 时按字面量猜，并把猜的结果打出来 */
    private static Object coerce(Object old, String raw) {
        if ("null".equals(raw)) return null;
        if (old instanceof Boolean) return Boolean.valueOf(raw);
        if (old instanceof Integer) return Integer.valueOf(raw);
        if (old instanceof Long) return Long.valueOf(raw);
        if (old instanceof Double) return Double.valueOf(raw);
        if (old instanceof Float) return Float.valueOf(raw);
        if (old instanceof BigDecimal) return new BigDecimal(raw);
        if (old instanceof String) return raw;
        if (old == null) {
            if ("true".equals(raw) || "false".equals(raw)) return Boolean.valueOf(raw);
            if (raw.matches("-?\\d+")) return Long.valueOf(raw);
            if (raw.matches("-?\\d*\\.\\d+")) return Double.valueOf(raw);
            return raw;
        }
        throw new IllegalArgumentException("旧值是 " + old.getClass().getSimpleName()
                + "（" + brief(old) + "），本探针只改标量属性");
    }

    // ── 备份 ────────────────────────────────────────────────────────────
    private static void backup(String dir, String number, Map<String, Object> metadata,
                               Map<String, ?> localeValueMap) throws Exception {
        File d = new File(dir);
        if (!d.exists() && !d.mkdirs()) throw new IllegalStateException("建目录失败: " + d);
        String safe = number.replaceAll("[^A-Za-z0-9._-]", "_");
        //文件名和 PrintTplJsonProbe 一致，所以备份目录可以直接当 meta ptpl diff 的 A 侧
        write(new File(d, safe + ".meta.json"), JsonLayout.layout(SerializeUtils.toJsonString(metadata)));
        write(new File(d, safe + ".locale.json"), JsonLayout.layout(SerializeUtils.toJsonString(localeValueMap)));
        System.out.println("[PROBE] 改前快照已存到 " + d.getAbsolutePath()
                + "（可直接当 meta ptpl diff 的 A 侧）");
    }

    private static void write(File f, String content) throws Exception {
        Writer w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8);
        try {
            w.write(content);
        } finally {
            w.close();
        }
    }

    // ── 小工具 ──────────────────────────────────────────────────────────
    private static String label(Map<String, Object> ctl) {
        return String.valueOf(ctl.get("key")) + "(" + ctl.get("type") + ") id=" + ctl.get("id");
    }

    private static String join(String[] path) {
        StringBuilder b = new StringBuilder();
        for (String p : path) b.append(b.length() == 0 ? "" : ".").append(p);
        return b.toString();
    }

    private static String brief(Object v) {
        if (v == null) return "null";
        String s = v instanceof Map || v instanceof List ? SerializeUtils.toJsonString(v) : String.valueOf(v);
        return s.length() > 80 ? s.substring(0, 77) + "…" : s;
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
        for (String v : values) if (v != null && !v.trim().isEmpty()) return v;
        return "zh_CN";
    }

    private static String env(String k, String def) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? def : v.trim();
    }
}
