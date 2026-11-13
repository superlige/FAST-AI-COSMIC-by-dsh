import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.entity.MainEntityType;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.orm.query.QFilter;
import kd.bos.print.api.PrintTask;
import kd.bos.print.api.PrintWork;
import kd.bos.print.api.facade.IPrintUnitTestFacade;
import kd.bos.print.api.facade.PrtUnitTestFacadeFactory;
import kd.bos.print.api.metedata.DesignerMetadata;
import kd.bos.print.api.metedata.PrintMetadata;
import kd.bos.print.api.utils.SerializeUtils;
import kd.bos.print.business.metedata.PrintMetadataUtil;
import kd.bos.print.business.metedata.bean.DesignMetadata;
import kd.bos.print.business.metedata.service.PrintTplService;
import kd.bos.print.core.ExecuteContext;
import kd.bos.print.core.data.DataRowSet;
import kd.bos.print.core.data.field.CollectionField;
import kd.bos.print.core.data.field.Field;
import kd.bos.print.core.plugin.AbstractPrintPlugin;
import kd.bos.print.core.plugin.PrintPluginProxy;
import kd.bos.print.core.plugin.event.AfterLoadDataEvent;
import kd.bos.print.core.plugin.event.AfterOutputRowEvent;
import kd.bos.print.core.plugin.event.AfterOutputWidgetEvent;
import kd.bos.print.core.plugin.event.bo.PWGridCellBo;
import kd.bos.print.service.BosPrintServiceHelper;
import kd.bos.print.service.BosPrintServiceImpl;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.operation.SaveServiceHelper;

/**
 * 打印插件的运行方式（S24 批 A）：拿一张真单据出一次打印，按格子断言最终输出的文字。
 *
 * <pre>
 * PRINT_TPL     模板编码（必填）
 * PRINT_PK      单据主键（必填）；写成 billno:单据编号 就按编号查出主键（run 的 --billno）
 * PRINT_SET     先改这些字段、保存（真提交）再出打印，写法同 run op 的 --set，`;` 分隔（可选）
 * PRINT_EXPECT  格子断言，`;` 分隔（和 PRINT_SHOW 至少给一个）：
 *               格子=值          格子每一行输出都要等于值
 *               格子[1]=值       第 2 行明细（从 0 数）
 *               格子~=片段       包含；和 [i] 可以一起用
 *               格子写模板里的控件名（datacell9），也可以写它绑定的字段（zlgd_bz_jx）
 *               表格key[行]=a | b | c   表格这次输出的第几行（从 0 数），格子用 | 隔开，含插件新插的行
 *               表格key[行][列]=值      那一行的第几格（从 0 数）
 * PRINT_SHOW   只打出来看、不断言，`;` 分隔（可选）：格子名、绑定字段，或表格 key（整张表逐行打出最终输出）
 *               数据源 / 数据源:分录名  插件拿到的数据行里有哪些字段（模板没绑的字段打印引擎不查）
 * </pre>
 *
 * <p>插件在 beforeOutputWidget 里新插的行、列没有模板控件名，按格子名断言看不到它们（真机 2026-09-18：
 * 插件插出来的试样行全看不见，模型据此推成「插件没跑」，又拿故意写错的断言去「看一眼」反复出打印）。
 * 所以观察插件另外按表格逐行记下每一行的全部格子；断言红了就把那张表的最终输出整张打出来，
 * 只想看不想断言用 PRINT_SHOW。插件插的行也能断言：写 表格key[行] 或 表格key[行][列]
 * （真机 2026-09-18：断言不了插件插的行，模型为了「能断言」两次改了业务代码的写法）。
 *
 * <p>三件事是 S24 批 0 真机实验定下来的（docs/S24-verify-routes.md §6）：
 * <ul>
 * <li><b>出打印走预览</b>（{@code ExecuteContext.setPreview(true)}，平台「打印预览」同一个开关）。
 * 普通走法每出一次在打印结果表 {@code t_svc_printresult} 留一条永久记录；预览只进缓存和临时文件，自己过期。</li>
 * <li><b>格子文字不解析 PDF</b>：打印内核建插件列表时会回调 {@link PrtUnitTestFacadeFactory} 里登记的门面，
 * 借它挂一个观察插件，逐行拿每个格子的最终文字。格子在运行时只剩设计器 id（datacell9 → 9glHpy0hVm），
 * 所以先读模板设计把控件名换成 id。</li>
 * <li><b>--set 改值并保存再出打印</b>：S27 起真提交（用户 2026-09-19：agent 连的必然是纯测试环境），
 * 这张单之后就是改过的样子；保存走 {@link SaveServiceHelper}，不走操作插件。</li>
 * </ul>
 *
 * <p>断言在出打印<b>之前</b>先把格子名、字段名全部核一遍：拼错的当场给候选并停下，不白出一次打印。
 */
public class PrintSim {

    /** 一个格子这次输出了哪些文字，按输出顺序。键是设计器 id；按绑定字段找的另记一份。 */
    static final Map<String, List<String>> BY_ID = new LinkedHashMap<String, List<String>>();
    static final Map<String, List<String>> BY_BIND = new LinkedHashMap<String, List<String>>();
    static final Map<String, List<String>> BY_WIDGET = new LinkedHashMap<String, List<String>>();
    /** 表格 key → 这次输出的每一行（格子文字用 | 连起来），含插件新插的行 */
    static final Map<String, List<String>> BY_GRID = new LinkedHashMap<String, List<String>>();
    /** 表格 key → 每一行的每个格子原文（不压成一行），给 表格key[行][列] 断言用 */
    static final Map<String, List<List<String>>> GRID_CELLS = new LinkedHashMap<String, List<List<String>>>();
    /**
     * 数据源（分录接在后面：主单.分录）→ 插件拿到的数据行里有哪些字段、共几行。
     * 观察插件登记在业务插件后面，所以这是业务插件 afterLoadData 改完之后的样子。
     * 打印引擎只查模板用到的字段：模板没绑的字段这里没有，插件 getField 也取不到（真机 2026-09-18，
     * 模型为了确认「检验项目还在不在数据行里」绕了十几分钟）。
     */
    static final Map<String, Set<String>> DS_FIELDS = new LinkedHashMap<String, Set<String>>();
    static final Map<String, Integer> DS_ROWS = new LinkedHashMap<String, Integer>();
    /** PRINT_SHOW 里点名看数据源用的词 */
    static final String SHOW_DATA = "数据源";

    public static void run() throws Exception {
        BY_ID.clear();
        BY_BIND.clear();
        BY_WIDGET.clear();
        BY_GRID.clear();
        GRID_CELLS.clear();
        DS_FIELDS.clear();
        DS_ROWS.clear();
        String number = req("PRINT_TPL");
        String pk = req("PRINT_PK");
        String set = env("PRINT_SET");
        String spec = env("PRINT_EXPECT");
        String show = env("PRINT_SHOW");
        if (spec.isEmpty() && show.isEmpty()) {
            throw new IllegalArgumentException("PRINT_EXPECT 和 PRINT_SHOW 至少给一个");
        }

        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        if (tplId == null || tplId.isEmpty()) {
            ProbeAssert.inputInvalid("print-template", number, templateMissing(number));
            finish();
            return;
        }
        String formId = formIdOf(number);
        try {
            pk = MetaResolve.pkOf(formId, pk);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("print-bill", formId + " " + pk, e.getMessage());
            finish();
            return;
        }
        System.out.println("[PROBE] 模板 " + number + " tplId=" + tplId + " 单据 " + formId + " pk=" + pk);
        if (!QueryServiceHelper.exists(formId, new QFilter[]{new QFilter("id", "=", longOr(pk))})) {
            ProbeAssert.inputInvalid("print-bill", formId + " pk=" + pk,
                    "这张模板打的是 " + formId + "，这个 pk 在 " + formId + " 里查不到（pk 写错，或者是别的单据的 pk）");
            finish();
            return;
        }

        List<Map<String, Object>> controls = controls(tplId);
        List<Target> targets = resolve(number, controls, spec);
        List<Target> shows = resolveShow(number, controls, show);
        if (targets == null || shows == null) {
            finish();
            return;
        }

        IPrintUnitTestFacade facade = new IPrintUnitTestFacade() {
            public void afterBuildPlugin(Object proxy) {
                ((PrintPluginProxy) proxy).registerPlugin(new Collector());
            }
        };
        PrtUnitTestFacadeFactory.register(facade);
        try {
            if (set.isEmpty()) {
                render(tplId, formId, pk, null);
            } else {
                MainEntityType met = MetaResolve.type(formId);
                if (!setsResolve(met, set)) {
                    finish();
                    return;
                }
                EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                        MetadataDao.getIdByNumber(formId, MetaCategory.Entity), MetaCategory.Entity);
                IsvGuard.assertOwnEntity(formId, em);
                //S27：改值、保存是真提交，这张单之后就是改过的样子；打印读的就是库里的新值
                System.out.println("[PROBE] --- 改值、保存（真提交）、出打印 ---");
                DynamicObject bill = BusinessDataServiceHelper.loadSingle(pk, formId);
                List<String> unresolved = OpSandbox.applySets(met, bill, set);
                if (!unresolved.isEmpty()) {
                    for (String path : unresolved) {
                        ProbeAssert.inputInvalid("print-set", path, "基础资料没物化，打印读到的会是空");
                    }
                    finish();
                    return;
                }
                SaveServiceHelper.save(new DynamicObject[]{bill});
                MetaResolve.reportCommitted(formId, pk, "改过", Boolean.TRUE);
                render(tplId, formId, pk, null);
            }
        } finally {
            PrtUnitTestFacadeFactory.removeRegister(facade);
        }

        report();
        for (Target t : shows) {
            t.show();
        }
        Set<String> failedGrids = new LinkedHashSet<String>();
        for (Target t : targets) {
            if (!t.check() && !t.grid.isEmpty()) {
                failedGrids.add(t.grid);
            }
        }
        Set<String> shown = shownGrids(shows);
        for (String grid : failedGrids) {
            if (!shown.contains(grid)) {
                System.out.println("[PROBE] 断言没过的格子在表格 " + grid + " 里，它这次的最终输出（含插件新插的行）：");
                showGrid(grid);
            }
        }
        System.out.println("[PROBE] 提示：出打印走的是预览，数据库不留打印记录；平台留下一份临时 PDF 和一条缓存，3 小时内自己过期。");
        finish();
    }

    // ---------------- 出打印 ----------------

    /** md 不为空时用它出打印（候选预览），为空时引擎照常从库里读模板。 */
    private static void render(String tplId, String formId, String pk, PrintMetadata md) {
        PrintTask task = new PrintTask();
        task.setTplId(tplId);
        if (md != null) {
            task.setMetadata(md);
        }
        task.setFormId(formId);
        task.setPkIds(Collections.<Object>singletonList(pk));
        task.setPageId("printsim-" + System.currentTimeMillis());
        PrintWork work = new PrintWork();
        work.setExpType("pdf");
        work.setPrintLang("zh_CN");
        work.setPageId(task.getPageId());
        work.setTaskList(Collections.singletonList(task));
        //taskId 后面会被 parse 成数字
        String taskId = String.valueOf(System.currentTimeMillis());
        ExecuteContext.get().setPreview(true);
        long t0 = System.currentTimeMillis();
        new BosPrintServiceImpl().doPrint(taskId, work);
        System.out.println("[PROBE] 出打印（预览）" + (System.currentTimeMillis() - t0) + "ms");
    }

    /**
     * 候选预览（S36 批 5）：模板改动还没落库时，拿候选设计数据在一张真单上出一次打印（预览），
     * 打改过的格子这次输出了什么。引擎的规矩是「任务上带了设计数据就用它，没带才去库里查」
     * （S32 §10.1 真机实测），所以不用先落库、也不用建临时模板；出打印入口和观察插件都跟 run print 同一套，
     * 只是模板换成候选。只看：不改单据、不断言，不算验收——落库后仍用 run print --expect。
     *
     * @param cells 要看的格子（控件 key），一般是这次改过的那几个；PRINT_SHOW 点名的另外加上
     */
    public static void tryCandidate(String number, Map<String, Object> candidate, String lang, String pk,
            List<String> cells) throws Exception {
        if (!env("PRINT_SET").isEmpty() || !env("PRINT_EXPECT").isEmpty()) {
            throw new IllegalArgumentException("预演里的候选预览只看：不改单据（PRINT_SET）、不断言（PRINT_EXPECT）。"
                    + "候选还没落库，断言过了也不算验收；落库后用 run print --set / --expect");
        }
        BY_ID.clear();
        BY_BIND.clear();
        BY_WIDGET.clear();
        BY_GRID.clear();
        GRID_CELLS.clear();
        DS_FIELDS.clear();
        DS_ROWS.clear();
        String tplId = BosPrintServiceHelper.getTplIdByNum(number);
        String formId = formIdOf(number);
        try {
            pk = MetaResolve.pkOf(formId, pk);
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("候选预览的单据不成立：" + e.getMessage());
        }
        if (!QueryServiceHelper.exists(formId, new QFilter[]{new QFilter("id", "=", longOr(pk))})) {
            throw new IllegalArgumentException("候选预览的单据不成立：这张模板打的是 " + formId + "，pk=" + pk
                    + " 在 " + formId + " 里查不到（pk 写错，或者是别的单据的 pk）");
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> copy = (Map<String, Object>) SerializeUtils.fromJsonString(
                SerializeUtils.toJsonString(candidate), Map.class);
        List<Map<String, Object>> controls = new ArrayList<Map<String, Object>>();
        walk(copy, controls);
        StringBuilder show = new StringBuilder();
        for (String cell : cells) {
            show.append(show.length() == 0 ? "" : ";").append(cell);
        }
        String extra = env("PRINT_SHOW");
        if (!extra.isEmpty()) {
            show.append(show.length() == 0 ? "" : ";").append(extra);
        }
        List<Target> shows = resolveShow(number, controls, show.toString());
        if (shows == null) {
            throw new IllegalArgumentException("候选预览：要看的格子在候选模板里对不上，见上面 ✘ 行");
        }
        PrintMetadata md = PrintMetadataUtil.parseMetadata(copy, lang);
        System.out.println("[PROBE] --- 候选预览：内存里的候选模板在 " + formId + " pk=" + pk
                + " 上出一次打印（预览，模板未落库，单据不改）---");
        IPrintUnitTestFacade facade = new IPrintUnitTestFacade() {
            public void afterBuildPlugin(Object proxy) {
                ((PrintPluginProxy) proxy).registerPlugin(new Collector());
            }
        };
        PrtUnitTestFacadeFactory.register(facade);
        try {
            render(tplId, formId, pk, md);
        } finally {
            PrtUnitTestFacadeFactory.removeRegister(facade);
        }
        for (Target t : shows) {
            t.show();
        }
        System.out.println("[PROBE] 候选预览只看这一张单：别的单据、分页和排版没验；落库后用 run print --expect 断言");
    }

    /**
     * 候选预览能打哪张单：{单据标识, 这张模板挂的单据里最近一张的 id}（按 id 倒序）；库里一张都没有时 id 为 null。
     * 给出的是能照抄的真 id，不是占位符；这张单上字段有没有值，预览出来一看便知。
     */
    public static String[] latestBill(String number) {
        String formId = formIdOf(number);
        DynamicObjectCollection rows = QueryServiceHelper.query(formId, "id", new QFilter[0], "id desc", 1);
        if (rows.isEmpty()) {
            return new String[]{formId, null};
        }
        return new String[]{formId, String.valueOf(rows.get(0).get("id"))};
    }

    /** 观察插件：只读，不改任何输出。 */
    public static class Collector extends AbstractPrintPlugin {
        @Override
        public void afterLoadData(AfterLoadDataEvent evt) {
            try {
                String ds = evt.getDataSource() == null ? "?" : evt.getDataSource().getDsName();
                collectFields(ds, evt.getDataRowSets(), 0);
            } catch (Exception e) {
                System.out.println("[PROBE] ⚠ 观察插件读数据源失败：" + e);
            }
        }

        @Override
        public void afterOutputRow(AfterOutputRowEvent evt) {
            try {
                Object gridRow = field(AfterOutputRowEvent.class, "gridRow").get(evt);
                int count = ((Integer) gridRow.getClass().getMethod("getCellCount").invoke(gridRow)).intValue();
                java.lang.reflect.Field cellField = field(PWGridCellBo.class, "cell");
                StringBuilder line = new StringBuilder();
                List<String> cells = new ArrayList<String>();
                for (int i = 0; i < count; i++) {
                    PWGridCellBo bo = evt.getCell(i);
                    if (i > 0) {
                        line.append(" | ");
                    }
                    if (bo == null || bo.isNullBo()) {
                        cells.add("");
                        continue;
                    }
                    cells.add(bo.getOutputText() == null ? "" : bo.getOutputText());
                    line.append(oneLine(bo.getOutputText()));
                    Object cell = cellField.get(bo);
                    String id = cell == null ? null : (String) cell.getClass().getMethod("getId").invoke(cell);
                    String text = bo.getOutputText();
                    if (id != null) {
                        add(BY_ID, id, text);
                    }
                    String bind = bo.getBindField();
                    if (bind != null && !bind.isEmpty()) {
                        add(BY_BIND, bind, text);
                    }
                }
                String grid = evt.getGrid() == null ? null : evt.getGrid().getKey();
                if (grid != null && !grid.isEmpty()) {
                    add(BY_GRID, grid, line.toString());
                    List<List<String>> rows = GRID_CELLS.get(grid);
                    if (rows == null) {
                        rows = new ArrayList<List<String>>();
                        GRID_CELLS.put(grid, rows);
                    }
                    rows.add(cells);
                }
            } catch (Exception e) {
                System.out.println("[PROBE] ⚠ 观察插件读格子失败：" + e);
            }
        }

        @Override
        public void afterOutputWidget(AfterOutputWidgetEvent evt) {
            try {
                Object widget = field(AfterOutputWidgetEvent.class, "widget").get(evt);
                String id = widget == null ? null : (String) widget.getClass().getMethod("getId").invoke(widget);
                Field value = evt.getOutputValue();
                String text = value == null ? null : value.getDisplayVal() != null ? value.getDisplayVal()
                        : value.getValue() == null ? null : String.valueOf(value.getValue());
                if (id != null) {
                    add(BY_WIDGET, id, text);
                }
            } catch (Exception e) {
                System.out.println("[PROBE] ⚠ 观察插件读控件失败：" + e);
            }
        }
    }

    /** 记下一层数据行的字段；分录（CollectionField）往下再走一层，路径写成 上层.分录 */
    private static void collectFields(String path, List<DataRowSet> rows, int depth) {
        if (rows == null) {
            return;
        }
        Set<String> keys = DS_FIELDS.get(path);
        if (keys == null) {
            keys = new TreeSet<String>();
            DS_FIELDS.put(path, keys);
        }
        Integer before = DS_ROWS.get(path);
        DS_ROWS.put(path, (before == null ? 0 : before.intValue()) + rows.size());
        Map<String, List<DataRowSet>> subs = new LinkedHashMap<String, List<DataRowSet>>();
        for (DataRowSet row : rows) {
            if (row == null) {
                continue;
            }
            for (String key : row.getFieldKeys()) {
                Field f = row.getField(key);
                if (!(f instanceof CollectionField)) {
                    keys.add(key);
                    continue;
                }
                keys.add(key + "[]");
                List<DataRowSet> value = ((CollectionField) f).getValue();
                if (depth < 2 && value != null) {
                    List<DataRowSet> list = subs.get(key);
                    if (list == null) {
                        list = new ArrayList<DataRowSet>();
                        subs.put(key, list);
                    }
                    list.addAll(value);
                }
            }
        }
        for (Map.Entry<String, List<DataRowSet>> e : subs.entrySet()) {
            collectFields(path + "." + e.getKey(), e.getValue(), depth + 1);
        }
    }

    /** --show 数据源[:过滤词]：插件拿到的数据行里有哪些字段 */
    private static void showData(String filter) {
        System.out.println("[PROBE] 数据源：插件拿到的数据行里有哪些字段（业务插件 afterLoadData 之后；分录写成 主单.分录，"
                + "字段名后带 [] 的是分录）。打印引擎只查模板用到的字段，这里没有的字段插件 getField 取不到：");
        int shown = 0;
        for (Map.Entry<String, Set<String>> e : DS_FIELDS.entrySet()) {
            if (!filter.isEmpty() && !e.getKey().contains(filter)) {
                continue;
            }
            shown++;
            List<String> keys = new ArrayList<String>(e.getValue());
            StringBuilder line = new StringBuilder();
            for (int i = 0; i < keys.size(); i++) {
                line.append(i == 0 ? "" : ", ").append(keys.get(i));
            }
            System.out.println("[PROBE]   " + e.getKey() + "：" + DS_ROWS.get(e.getKey()) + " 行，字段 " + keys.size()
                    + " 个：" + line);
        }
        if (shown == 0) {
            System.out.println("[PROBE]   没有" + (filter.isEmpty() ? "" : "名字含 " + filter + " 的") + "数据源；这次加载过的："
                    + DS_FIELDS.keySet());
        }
    }

    private static void add(Map<String, List<String>> map, String key, String text) {
        List<String> list = map.get(key);
        if (list == null) {
            list = new ArrayList<String>();
            map.put(key, list);
        }
        list.add(text == null ? "" : text);
    }

    /** 每个被断言的格子打一行它实际输出了什么，断言红了不用再跑一次去看。 */
    private static void report() {
        System.out.println("[PROBE] 数据网格格子 " + BY_ID.size() + " 个，文本控件 " + BY_WIDGET.size() + " 个有输出，表格 "
                + BY_GRID.size() + " 张");
    }

    /** 一张表这次输出的每一行。插件新插的行没有模板控件名，只有这里看得到。 */
    private static void showGrid(String grid) {
        List<String> rows = BY_GRID.get(grid);
        if (rows == null || rows.isEmpty()) {
            System.out.println("[PROBE]   表格 " + grid + " 这次没有输出任何行（被隐藏、所在页没打出来，或插件把行删光了）");
            return;
        }
        System.out.println("[PROBE]   表格 " + grid + " 共输出 " + rows.size() + " 行（行号从 0 数，格子用 | 隔开）：");
        for (int i = 0; i < rows.size(); i++) {
            System.out.println("[PROBE]     " + i + ": " + rows.get(i));
        }
        System.out.println("[PROBE]   （插件拿到的数据行里有哪些字段：--show " + SHOW_DATA + "）");
    }

    private static Set<String> shownGrids(List<Target> shows) {
        Set<String> out = new LinkedHashSet<String>();
        for (Target t : shows) {
            if (t.wholeGrid) {
                out.add(t.key);
            }
        }
        return out;
    }

    /** 格子文字打成一行：换行写 \n，和断言比的是同一种写法（{@link ProbeAssert#shown}）。 */
    private static String oneLine(String text) {
        return text == null ? "" : ProbeAssert.shown(text);
    }

    // ---------------- 断言 ----------------

    /** 一条 `格子[i]~=值`，已经解析成运行时能对上的东西。 */
    static final class Target {
        String written;
        String key;
        int row = -1;
        boolean contains;
        String want;
        /** 找格子输出用哪张表、用哪个键 */
        Map<String, List<String>> table;
        String lookup;
        String label;
        /** PRINT_SHOW 点的是数据源；key 是过滤词（可空） */
        boolean data;
        /** 格子所在表格的 key；不在表格里是空串 */
        String grid = "";
        /** PRINT_SHOW 点的是整张表 */
        boolean wholeGrid;
        /** 断言写的是 表格key[行] / 表格key[行][列]：按表格这次的最终输出比，含插件新插的行 */
        boolean gridRow;
        int col = -1;

        private List<String> got() {
            List<String> got = table.get(lookup);
            if (got == null && table == BY_ID) {
                got = BY_WIDGET.get(lookup);
            }
            return got;
        }

        /** 只打出来看，不算断言 */
        void show() {
            if (data) {
                showData(key);
                return;
            }
            if (wholeGrid) {
                showGrid(key);
                return;
            }
            List<String> got = got();
            if (got == null || got.isEmpty()) {
                System.out.println("[PROBE] 看 " + written + "：" + label + " 这次打印没有输出" + (grid.isEmpty() ? ""
                        : "（插件新插的行没有模板控件名，看整张表写 --show " + grid + "）"));
                return;
            }
            System.out.println("[PROBE] 看 " + written + "：" + label + " 输出 " + got.size() + " 行"
                    + (grid.isEmpty() ? "" : "（只含带模板控件名的行；插件新插的行看 --show " + grid + "）"));
            for (int i = 0; i < got.size(); i++) {
                System.out.println("[PROBE]   [" + i + "] " + oneLine(got.get(i)));
            }
        }

        /** @return 全过 */
        boolean check() {
            if (gridRow) {
                return checkGridRow();
            }
            List<String> got = got();
            String kind = contains ? "print-cell-contains" : "print-cell";
            if (got == null || got.isEmpty()) {
                ProbeAssert.unresolved(kind, written, want, label + " 这次打印没有输出（被隐藏、所在页没打出来，或明细没有数据）");
                return false;
            }
            if (row >= 0) {
                if (row >= got.size()) {
                    ProbeAssert.unresolved(kind, written, want, label + " 只输出了 " + got.size() + " 行（行号从 0 数）"
                            + (grid.isEmpty() ? "" : "；插件新插的行不带模板控件名，见下面表格 " + grid + " 的全部输出，"
                            + "要断言插件插的行写 " + grid + "[行] 或 " + grid + "[行][列]"));
                    return false;
                }
                return one(kind, written, got.get(row));
            }
            if (got.size() == 1) {
                return one(kind, written, got.get(0));
            }
            boolean ok = true;
            for (int i = 0; i < got.size(); i++) {
                ok &= one(kind, key + "[" + i + "]" + (contains ? "~" : ""), got.get(i));
            }
            return ok;
        }

        /**
         * 表格key[行]：整行按格子比，每格去掉首尾空白，写的时候 | 两边空不空格都行；
         * 表格key[行][列]：那一格的原文。多行文字两种都按 --show 的写法比（换行写 \n）。
         */
        private boolean checkGridRow() {
            String kind = col >= 0 ? (contains ? "print-grid-cell-contains" : "print-grid-cell")
                    : (contains ? "print-grid-row-contains" : "print-grid-row");
            List<List<String>> rows = GRID_CELLS.get(key);
            if (rows == null || rows.isEmpty()) {
                ProbeAssert.unresolved(kind, written, want, "表格 " + key + " 这次没有输出任何行（被隐藏、所在页没打出来，或插件把行删光了）");
                return false;
            }
            if (row >= rows.size()) {
                ProbeAssert.unresolved(kind, written, want, "表格 " + key + " 只输出了 " + rows.size() + " 行（行号从 0 数），全部输出见下面");
                return false;
            }
            List<String> cells = rows.get(row);
            if (col >= 0) {
                if (col >= cells.size()) {
                    ProbeAssert.unresolved(kind, written, want, "表格 " + key + " 第 " + row + " 行只有 " + cells.size()
                            + " 格（列号从 0 数）");
                    return false;
                }
                return one(kind, written, cells.get(col));
            }
            List<String> trimmed = new ArrayList<String>();
            for (String cell : cells) {
                trimmed.add(oneLine(cell).trim());
            }
            String actual = join(trimmed);
            if (contains) {
                return ProbeAssert.containsText(kind, written, want.trim(), actual);
            }
            List<String> wanted = new ArrayList<String>();
            for (String part : want.split("\\|", -1)) {
                wanted.add(part.trim());
            }
            return ProbeAssert.isEqual(kind, written, join(wanted), actual);
        }

        private boolean one(String kind, String target, String actual) {
            if (contains) {
                return ProbeAssert.containsText(kind, target, want, actual);
            }
            return ProbeAssert.isEqual(kind, target, want, actual);
        }
    }

    /** 把断言里的格子名全部对到模板上；有一条对不上就返回 null（已经记了 unresolved）。 */
    private static List<Target> resolve(String number, List<Map<String, Object>> controls, String spec) {
        Map<String, Map<String, Object>> byKey = new LinkedHashMap<String, Map<String, Object>>();
        Map<String, List<Map<String, Object>>> byBind = new LinkedHashMap<String, List<Map<String, Object>>>();
        for (Map<String, Object> c : controls) {
            String key = s(c.get("key"));
            if (!key.isEmpty() && !byKey.containsKey(key)) {
                byKey.put(key, c);
            }
            String bind = s(c.get("bindField"));
            if (!bind.isEmpty()) {
                List<Map<String, Object>> list = byBind.get(bind);
                if (list == null) {
                    list = new ArrayList<Map<String, Object>>();
                    byBind.put(bind, list);
                }
                list.add(c);
            }
        }
        List<Target> out = new ArrayList<Target>();
        boolean ok = true;
        for (String[] kv : ExpectSpec.pairs(spec)) {
            Target t = new Target();
            String left = kv[0];
            t.written = left;
            t.want = kv[1];
            if (left.endsWith("~")) {
                t.contains = true;
                left = left.substring(0, left.length() - 1).trim();
            }
            List<Integer> index = new ArrayList<Integer>();
            boolean badIndex = false;
            while (left.endsWith("]")) {
                int open = left.lastIndexOf('[');
                if (open <= 0) {
                    break;
                }
                try {
                    index.add(0, Integer.valueOf(left.substring(open + 1, left.length() - 1).trim()));
                } catch (NumberFormatException e) {
                    badIndex = true;
                    break;
                }
                left = left.substring(0, open).trim();
            }
            if (badIndex || index.size() > 2) {
                ProbeAssert.unresolved("print-cell", t.written, t.want,
                        "下标要写数字：格子[行] 例如 datacell9[1]，表格[行] 或 表格[行][列] 例如 layoutgrid1[2][3]");
                ok = false;
                continue;
            }
            t.key = left;
            Map<String, Object> grid = gridNamed(left, controls);
            if (grid != null) {
                t.key = s(grid.get("key")).isEmpty() ? s(grid.get("id")) : s(grid.get("key"));
                if (index.isEmpty()) {
                    ProbeAssert.unresolved("print-grid-row", t.written, t.want, left + " 是表格，要写行号："
                            + left + "[行]=整行（格子用 | 隔开）或 " + left + "[行][列]=单格，行列都从 0 数；只想看整张表写 --show " + left);
                    ok = false;
                    continue;
                }
                t.gridRow = true;
                t.row = index.get(0).intValue();
                t.col = index.size() > 1 ? index.get(1).intValue() : -1;
                t.grid = t.key;
                t.label = "表格 " + t.key;
                out.add(t);
                continue;
            }
            if (index.size() > 1) {
                ProbeAssert.unresolved("print-cell", t.written, t.want, left + " 不是表格，只能写一个行号（格子[行]）；"
                        + "两个下标 表格[行][列] 只给表格 key 用");
                ok = false;
                continue;
            }
            if (index.size() == 1) {
                t.row = index.get(0).intValue();
            }
            Map<String, Object> control = byKey.get(left);
            if (control != null) {
                t.table = BY_ID;
                t.lookup = s(control.get("id"));
                t.label = "控件 " + left + "（" + s(control.get("type"))
                        + (s(control.get("bindField")).isEmpty() ? "" : " 绑 " + s(control.get("bindField"))) + "）";
                t.grid = gridOf(control, controls);
            } else if (byBind.containsKey(left)) {
                List<Map<String, Object>> cells = byBind.get(left);
                if (cells.size() > 1) {
                    List<String> keys = new ArrayList<String>();
                    for (Map<String, Object> c : cells) {
                        keys.add(s(c.get("key")).isEmpty() ? s(c.get("id")) : s(c.get("key")));
                    }
                    ProbeAssert.unresolved("print-cell", t.written, t.want, "模板里有 " + cells.size()
                            + " 个格子都绑 " + left + "，分不清是哪个，改写控件名：" + keys);
                    ok = false;
                    continue;
                }
                t.table = BY_BIND;
                t.lookup = left;
                t.label = "绑 " + left + " 的格子（" + s(cells.get(0).get("key")) + "）";
                t.grid = gridOf(cells.get(0), controls);
            } else {
                ProbeAssert.unresolved("print-cell", t.written, t.want, "模板 " + number + " 里没有叫 " + left
                        + " 的控件，也没有格子绑这个字段。相近的：" + near(left, byKey.keySet(), byBind.keySet()));
                ok = false;
                continue;
            }
            out.add(t);
        }
        return ok ? out : null;
    }

    /**
     * PRINT_SHOW：格子名、绑定字段或表格 key，只打出来看。名字对不上和断言一样当场给候选、不出打印。
     */
    private static List<Target> resolveShow(String number, List<Map<String, Object>> controls, String show) {
        List<Target> out = new ArrayList<Target>();
        if (show.isEmpty()) {
            return out;
        }
        StringBuilder spec = new StringBuilder();
        for (String one : show.split(";")) {
            String name = one.trim();
            if (name.isEmpty()) {
                continue;
            }
            if (name.equals(SHOW_DATA) || name.startsWith(SHOW_DATA + ":")) {
                Target t = new Target();
                t.written = name;
                t.key = name.substring(SHOW_DATA.length()).replaceFirst("^:", "").trim();
                t.data = true;
                out.add(t);
                continue;
            }
            Map<String, Object> grid = gridNamed(name, controls);
            if (grid != null) {
                Target t = new Target();
                t.written = name;
                t.key = s(grid.get("key")).isEmpty() ? s(grid.get("id")) : s(grid.get("key"));
                t.wholeGrid = true;
                out.add(t);
                continue;
            }
            spec.append(spec.length() == 0 ? "" : ";").append(name).append("=?");
        }
        if (spec.length() == 0) {
            return out;
        }
        List<Target> cells = resolve(number, controls, spec.toString());
        if (cells == null) {
            return null;
        }
        for (Target t : cells) {
            t.written = t.key;
            out.add(t);
        }
        return out;
    }

    /** key 或 id 叫这个名字的表格（LayoutGrid / DataGrid）；不是表格返回 null。 */
    private static Map<String, Object> gridNamed(String name, List<Map<String, Object>> controls) {
        for (Map<String, Object> c : controls) {
            String type = s(c.get("type"));
            if (("LayoutGrid".equals(type) || "DataGrid".equals(type))
                    && (name.equals(s(c.get("key"))) || name.equals(s(c.get("id"))))) {
                return c;
            }
        }
        return null;
    }

    private static String join(List<String> cells) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < cells.size(); i++) {
            out.append(i == 0 ? "" : " | ").append(cells.get(i));
        }
        return out.toString();
    }

    /** 格子所在表格的 key（往上找父控件，第一个 LayoutGrid / DataGrid）；不在表格里返回空串。 */
    private static String gridOf(Map<String, Object> control, List<Map<String, Object>> controls) {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<String, Map<String, Object>>();
        for (Map<String, Object> c : controls) {
            byId.put(s(c.get("id")), c);
        }
        Map<String, Object> at = byId.get(s(control.get("parentId")));
        for (int depth = 0; at != null && depth < 8; depth++) {
            String type = s(at.get("type"));
            if ("LayoutGrid".equals(type) || "DataGrid".equals(type)) {
                return s(at.get("key")).isEmpty() ? s(at.get("id")) : s(at.get("key"));
            }
            at = byId.get(s(at.get("parentId")));
        }
        return "";
    }

    /** --set 里写的字段先在单据上核一遍（和造数、改数、run op 同一处）：拼错了不保存、不出打印。 */
    private static boolean setsResolve(MainEntityType met, String set) {
        List<String[]> wrong = OpSandbox.wrongPaths(met, set);
        for (String[] w : wrong) {
            ProbeAssert.inputInvalid("print-set", w[0], "单据 " + met.getName() + " " + w[1]);
        }
        return wrong.isEmpty();
    }

    /** 模板设计里所有控件，拍平。和 PrintGridDumpProbe 读的是同一份设计数据。 */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> controls(String tplId) {
        PrintTplService service = new PrintTplService();
        DesignMetadata dm = (DesignMetadata) service.getDesignMeta(tplId);
        PrintMetadata pm = service.getPrintMetadata(dm);
        String lang = pm.getFixedLang() == null || pm.getFixedLang().isEmpty() ? "zh_CN" : pm.getFixedLang();
        DesignerMetadata designer = PrintMetadataUtil.toDesignerMetadata(pm, lang);
        Object root = SerializeUtils.fromJsonString(SerializeUtils.toJsonString(designer.getMetadata()), Map.class);
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        walk(root, out);
        return out;
    }

    @SuppressWarnings("unchecked")
    private static void walk(Object node, List<Map<String, Object>> out) {
        if (node instanceof Map) {
            Map<String, Object> map = (Map<String, Object>) node;
            if (map.get("id") instanceof String && map.get("type") instanceof String) {
                out.add(map);
            }
            for (Object child : map.values()) {
                walk(child, out);
            }
        } else if (node instanceof List) {
            for (Object child : (List<Object>) node) {
                walk(child, out);
            }
        }
    }

    /**
     * 拼错时的候选：按编辑距离排，最多 6 个。只按前缀挑的话，datacel9 会带出 datacell、datacell1…datacell9
     * 一整串，对的那个排在最后（真机 2026-09-17）。
     */
    private static String near(String wanted, java.util.Set<String> keys, java.util.Set<String> binds) {
        final String w = wanted.toLowerCase();
        List<String> pool = new ArrayList<String>(keys);
        for (String b : binds) {
            if (!pool.contains(b)) {
                pool.add(b);
            }
        }
        final Map<String, Integer> score = new LinkedHashMap<String, Integer>();
        for (String k : pool) {
            int d = distance(w, k.toLowerCase());
            if (d <= Math.max(2, w.length() / 3) || k.toLowerCase().contains(w)) {
                score.put(k, Integer.valueOf(d));
            }
        }
        List<String> hits = new ArrayList<String>(score.keySet());
        Collections.sort(hits, new java.util.Comparator<String>() {
            public int compare(String a, String b) {
                return score.get(a).compareTo(score.get(b));
            }
        });
        //不全列：按名字远近排的候选，给最像的几个
        return hits.isEmpty() ? "（没有）" : hits.subList(0, Math.min(6, hits.size())).toString();
    }

    private static int distance(String a, String b) {
        int[] prev = new int[b.length() + 1];
        int[] cur = new int[b.length() + 1];
        for (int j = 0; j <= b.length(); j++) {
            prev[j] = j;
        }
        for (int i = 1; i <= a.length(); i++) {
            cur[0] = i;
            for (int j = 1; j <= b.length(); j++) {
                int cost = a.charAt(i - 1) == b.charAt(j - 1) ? 0 : 1;
                cur[j] = Math.min(Math.min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            int[] t = prev;
            prev = cur;
            cur = t;
        }
        return prev[b.length()];
    }

    /**
     * 模板编码查不到时说清下一步。最常见的写错是把单据标识当成模板编码（真机复盘，2026-09-17），
     * 那就直接把这张单上的模板列出来，省一次按单据查模板。
     */
    private static String templateMissing(String number) {
        String why = "模板编码查不到";
        try {
            DynamicObjectCollection rows = QueryServiceHelper.query("bos_manageprinttpl", "number,name",
                    new QFilter[]{new QFilter("billformid", "=", number)});
            if (!rows.isEmpty()) {
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < rows.size(); i++) {
                    sb.append(i == 0 ? "" : "、").append(rows.get(i).getString("number"))
                            .append("（").append(rows.get(i).getString("name")).append("）");
                }
                return why + "；" + number + " 是单据标识，不是模板编码。这张单上的 " + rows.size() + " 张模板：" + sb;
            }
        } catch (RuntimeException e) {
            why += "（按单据列模板也没查成：" + e.getMessage() + "）";
        }
        return why + "；先用 PrintTplProbe 按单据查它的模板";
    }

    private static String formIdOf(String number) {
        DynamicObjectCollection rows = QueryServiceHelper.query("bos_manageprinttpl", "billformid",
                new QFilter[]{new QFilter("number", "=", number)});
        if (rows.isEmpty()) {
            throw new IllegalStateException("模板 " + number + " 在 bos_manageprinttpl 里查不到对应单据");
        }
        return rows.get(0).getString("billformid");
    }

    private static java.lang.reflect.Field field(Class<?> type, String name) throws NoSuchFieldException {
        java.lang.reflect.Field f = type.getDeclaredField(name);
        f.setAccessible(true);
        return f;
    }

    private static Object longOr(String pk) {
        try {
            return Long.valueOf(pk.trim());
        } catch (NumberFormatException e) {
            return pk.trim();
        }
    }

    private static void finish() {
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败");
        }
    }

    private static String s(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static String env(String key) {
        String value = System.getenv(key);
        return value == null ? "" : value.trim();
    }

    private static String req(String key) {
        String value = env(key);
        if (value.isEmpty()) {
            throw new IllegalArgumentException("必须给 " + key);
        }
        return value;
    }
}
