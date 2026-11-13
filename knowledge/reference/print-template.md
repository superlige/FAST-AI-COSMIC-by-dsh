---
class: B
when: 打印模板查询、审计、预览与本地备份
---

# 打印模板（读取、审计与预览）

来源：真实苍穹 8.0 二开工程实测。本文只管模板读取、审计、备份和预览；
修改设计内容见 [print-template-write.md](print-template-write.md)，打印插件运行态见
[plugin-print-runtime.md](plugin-print-runtime.md)。

**日常查模板、导设计 JSON、比改前改后走 `meta ptpl`**（[meta-cmd.md](meta-cmd.md)）；
本文讲的是它底下的通道、审计口径和探针参数。

副作用等级沿用 [metadata-read.md](metadata-read.md)：清单、设计审计和网格展开是 **R0**；
设计 JSON 导出、备份、PDF、PNG 或占位图会写本地文件，是 **R1**，但不修改共享元数据。

- [三层模型](#三层模型)
- [清单与批量校验](#清单与批量校验--printtplprobe)
- [导出设计 JSON](#导出设计-json-到本地--printtpljsonprobe)
- [设计审计](#只读审计--printtpldesignprobe)
- [表格网格](#看某个表格的行列下标--printgriddumpprobe)
- [备份](#备份--printtplbackupprobe)
- [预览](#按指定模板预览)
- [排版测量](#验排版--printmeasureprobe不用起节点)


## 三层模型

| 层 | 实体 / 表 | 作用 | 正确入口 |
|---|---|---|---|
| 模板目录 | `bos_manageprinttpl` / `t_bas_printtplinfo` | 编码、启用、A/B 类型、单据和组织管控；`printtplid` 指向本体 | `QueryServiceHelper` / `PrintTplProbe` |
| 模板本体 | `bos_print_meta` / `t_svc_printmeta` | 设计元数据头和 `FDATA` | `PrintTplService` |
| 运行输出 | 临时打印附件 | 按模板和业务主键生成 PDF 等文件 | `BosPrintServiceHelper` |

三条一开始就会认错的事：

- **`bos_printtemplate` 不是打印模板**，它是表单布局 `t_meta_formdesign`。
- **模板设计内容不是 `bos_manageprinttpl` 的普通字段**；`bos_print_meta` 物理列虽有 `FDATA`，
  运行态 ORM 没有 `data` 属性。**不要用普通 ORM 或 SQL 改模板设计内容。**
- **目录 `type=B` 才是新打印模板。**

## 查：清单、审计、预览

### 清单与批量校验 —— `PrintTplProbe`

先用目录实体按 `billformid` 查，编码前缀只能作兜底：同一单据的模板编码不保证都以单据标识开头。

```bash
# 列出某张单据可用的模板
TPL_FORM=<实体标识> node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplProbe

# 批量校验模板编码；底层走 getTplIdByNum(List)，不要逐个调 String 重载
TPL_NUMBERS=demo_xxx_prtpl_1,demo_xxx_prtpl_2 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplProbe
```

### 导出设计 JSON 到本地 —— `PrintTplJsonProbe`

副作用等级：**R1**。只读数据库，写两个本地 JSON。

**要找某个控件、要看它的公式长什么样，用这个，不要用连库探针一轮轮试。** 导出的就是设计器
提交给服务端的那两份东西（`SerializeUtils` JSON 往返之后的形态），所以本地读到的结构和写探针
里要改的结构逐字段一致 —— 定位、改法设计、改完比对，全在本地文件上做。

```bash
TPL_NUMBER=demo_sys_test_bill_prtpl_21 OUT_DIR=outputs/print-tpl-json/before \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplJsonProbe
```

产出 `<编码>.meta.json`（主设计数据）和 `<编码>.locale.json`（多语言旁路映射，
键的含义见 [print-template-write.md](print-template-write.md#多语言旁路映射)），
同名文件直接覆盖 —— **改前改后要用不同的 `OUT_DIR`**，否则基线就被自己盖掉了。
输出里的 `modifyVersion` 和 `dataSha256` 就是落库前后的比对基线。

拿到文件之后：控件按 `id` / `key` grep，公式按可见文字 grep（`grep -o "CONCAT('批准者：'" …`）；
落库后再导一份到 `.../after`，**对两份 `meta.json` 做递归 diff，断言只有预期的那几个节点变了**
—— 这比读探针输出可靠，也是 [print-template-write.md](print-template-write.md) 要求的 dry-run 比对。

### 只读审计 —— `PrintTplDesignProbe`

改之前和落库之后都要跑。它只读本体，不调任何保存 API；默认输出设计数据哈希、控件类型、
绑定/公式数量、拓扑审计、`parseMetadata` 和 `beforeSave` 结果。

⚠️ **它是审计工具，不是定位工具。** `DETAIL=1` 最多只打 20 个公式控件，模板公式一多，
要找的那个大概率不在里面 —— 拿它找控件会白跑一轮还看不出为什么。定位走「导出设计 JSON 到本地」那节的
`PrintTplJsonProbe`；这里的 `TPL_CONTROL=` 用于已经知道 id / key 之后看单个控件。

```bash
TPL_NUMBER=demo_sys_test_bill_prtpl_21 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplDesignProbe

#看表格、合并区、公式；并把拓扑或平台校验失败变成非零退出
TPL_NUMBER=demo_as_ap_contract_prtpl DETAIL=1 STRICT=1 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplDesignProbe

#按稳定 id 或 key 查看一个控件的完整 JSON；LayoutCell 会同时给出行列坐标
TPL_NUMBER=demo_sys_test_bill_prtpl_21 TPL_CONTROL=iqXrHx9bBf \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplDesignProbe
```

`STRICT=1` 适合写探针落库前后的冷进程门禁。老模板可能因历史删除字段导致 `parseMetadata` 失败；
这不是本次修改造成的，但说明整份模板已不能安全通过当前平台解析，应先修复旧绑定，
不能仅凭目标节点看起来正常就继续保存。

### 先看整张模板长什么样 —— `meta ptpl dump <模板编码> --overview`

一屏看完：模板绑了哪些字段（按数据源列，**打印引擎只查这些**，这里没有的字段插件在数据行里取不到）、
每页每张表格几行几列、每一格是 `[控件key]{绑定字段}` / `[控件key]写死的字` / `=公式`，以及表格外的控件。
要知道「有没有格子绑检验项目」「备注在哪个格子里」先看它，**它比把设计 JSON dump 到本地自己写脚本解析快得多**。某张表的行高、列宽、合并区再用下面的 `--grid`。

```bash
meta ptpl dump demo_sys_test_bill_prtpl_58 --overview
```

### 看某个表格的行列下标 —— `PrintGridDumpProbe`

`PrintTplDesignProbe` 只告诉你拓扑完整，不告诉你「第 2 行第 3 列绑的是哪个字段」。
插件要 `delColumn`/`insertColumn`/`addMerge`（行转列、动态列）就得先有这份下标表：

```bash
TPL_NUMBER=demo_sys_test_bill_prtpl_45 GRID=DataGrid \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintGridDumpProbe
```

输出每行的 `rowType`（`Normal` 表头 / `Detail` 数据行 / `Statistic` 统计行 —— 这三种在插件里
写值的方式不同，见 [plugin-print-runtime.md](plugin-print-runtime.md#datagrid-统计行绑定)）、
每列的 `columnWidth`（设计态毫米，
运行态要现场量）、每格的绑定字段和公式，以及 `mergeConfig`。`GRID` 收 id 或 key，
隐藏的加载器表格照样能查。

### 备份 —— `PrintTplBackupProbe`

副作用等级：**R1**。该探针不修改共享元数据，但会写本地 ZIP。

```bash
TPL_NUMBER=demo_sys_test_bill_prtpl_21 \
  node .claude/skills/long-cosmic-dev/driver.mjs probe PrintTplBackupProbe
```

默认写到 `outputs/print-template-backups/`，`BACKUP_DIR` 可改。内部走官方导出：

```java
String downloadUrl = new PrintTplImpExp().doExport(Collections.singletonList(tplId), 0);
```

`doExport` 返回的是带 `taskId/attachId` 的临时下载地址，**不是本地路径**；探针用
`getPrtAttach → AttachDetail.filePath + diskType → getFileInputStream` 读取附件再写本地 ZIP。
ZIP 至少要有一个 `.prt` 和已有语言的 `.prtx`，并记录 SHA-256、条目与资源数量。

⚠️ **`doExport` 会产出空备份，而且不报错。** 实测同一批模板里，有的导出来是 204 字节的 ZIP、
只有 1 个条目、里面的 `.prt` 本身 0 字节，其余几张都正常（15~18KB）。
**校验产物大小和条目数，别看到「备份完成」就往下改。** 拿不到有效备份时的兜底是两条一起上：
把设计数据原文（`getDesignMeta` 那份 JSON）另存一份快照，并把改动收敛成能反向执行的单点修改。

### 按指定模板预览

完整实现可参考出处工程的 `PrintPreviewUtil`：

```java
String tplId = BosPrintServiceHelper.getTplIdByNum(tplNumber);
PrintWork work = new PrintWork();
work.setPrintLang("zh_CN");
work.setExpType("1");                         // PDF

PrintTask task = new PrintTask();
task.setTplId(tplId);
task.setPkIds(Collections.singletonList(pkId));
work.setTaskList(Collections.singletonList(task));

PrtAttach att = BosPrintServiceHelper.execPrint(work);
String attachId = att.getAttachDetail().get(0).getAttachId();
```

下载地址用 `taskId + attachId` 拼 `/api/print/download.do`。下拉切换模板时可直接在
`propertyChanged` 刷 IFrame；`afterCreateNewData` 的 `setValue` 也会触发该事件，
用 `PageCache` 挡掉重复出图。

`BosPrintServiceHelper.execPrint` 走微服务分发，宿主已装好分发桥，探针里原路可用
（见 [probes.md](probes.md#服务分发边界)）；绕开分发直接调本地实现是备选。

### 验排版 —— `PrintMeasureProbe`（不用起节点）

出 PDF 并把每张图片、每段文字在页面上的位置量成数字：在第几列、多宽、有没有居中。
副作用等级：**R1**，可生成本地 PDF/PNG 和图片占位文件。
**排版问题不要靠把 PNG 读进上下文肉眼看**（一页 4~5 万 token），要的只是坐标：

```bash
TPL_NUMBER=demo_sys_test_bill_prtpl_22 BILL_ID=2533418123571278848 \
PLANT_FROM=demo_sys_test_bill:demo_entryentity_jxsy.demo_subentryentity_jx.demo_picture \
node .claude/skills/long-cosmic-dev/driver.mjs probe PrintMeasureProbe
```

```
[PROBE] === 第 2 页  840.9 x 594.6pt  图片 4 张 ===
[PROBE] 参考中轴 420.7（取自全文档 1 个多图行）
[PROBE]  行1  3 张  y=199.9  cx=230.8,420.7,610.7  中轴=420.7  Δ=+0.0  尺寸=183.9x137.9
[PROBE]  行2  1 张  y=341.5  cx=421.0        中轴=421.0  Δ=+0.3  尺寸=183.9x137.9  [单图·居中]
```

- 坐标从 PDF 内容流里的图片变换矩阵直接读，单位 pt，原点已翻到左上角。
- **`TEXT=1` 连文字一起量**（`TEXT_LIKE=关键字` 过滤，整页文字多时必用）。**图片摆正了不等于
  文字也正**：格子里的文字和图片共用一份样式却按不同系数吃内边距，一定要两个一起量：

  ```
  [PROBE]  文本 y=493.2  x=269.5~571.0  cx=420.2  Δ=-0.5  "试样号：112(试验室编号…"
  ```
- **判居中的基准是"多图行的中轴"，不是页宽中心** —— 表格未必占满页宽。全文档一个多图行都没有
  时会退回页宽中心并标 `[单图·基准存疑]`。
- 页眉 logo 也会被当成一行单图算进来，用 `PAGES=-1`（最后一页）之类限定要测的页。
- `PDF_OUT` / `PNG_OUT` 按需出文件；PNG 只在最后确认整体观感时看**一张**。
- **图片渲染不出来（`图片 0 张`）**：附件实体在开发服务器的文件服务上，探针的 `LightFileStorage`
  根目录是 `${user.dir}/filestorage`，本机没有那些文件。用 `PLANT_FROM=实体:图片字段路径`
  让它按单据字段里的路径造占位图（只造缺的，不覆盖真实文件）。**验完删掉那个目录下造出来的图**，
  本地节点也在用它。日志里那条下载失败**不打印路径**，别去日志里捞。
- **`PLANT_FROM` 造完还是 `图片 0 张`，就别再修取图了。** 它只对「字段里存的就是文件路径」的
  单据管用。同一个图片字段，不同单据存的东西可能不是一回事：一种是
  `ierp/<accountId>/…/xxx.png` 这样的路径，占位图造上去就能渲染；另一种是
  `235efdd041800c00` 这样的影像服务 fileId，要过 `AttachFileService` 才换得出真实路径，
  占位图造在哪都读不到 —— `AttachmentServiceProvider.getImage` 这时**静默返回 `null`**，
  只往日志甩一串栈，探针照常出 PDF，只是没有图。穷举路径去试是白费。
  **换验证口径就行**：图片被压扁、跑偏、换页这些，判据都是**行高和坐标**，不是像素。
  量图片下方的标签行和图注（`TEXT=1`）照样能定位 —— 实测有一张两列图片模板的第三张图被跨页
  压扁，就是靠标签行 `y=66.9 → 185.8` 认出来并验完的，全程一张图都没渲染出来
  （成因见 [plugin-print-runtime.md](plugin-print-runtime.md#放不下的行会被劈开压缩)）。

底层链路（取数 → 插件 `beforeOutputWidget` → 排版 → iText 出 PDF）整条都在探针进程里跑得通，
只有分发和文件服务要绕，自己写别的打印探针时照抄：

```java
PrintTask task = new PrintTask();
task.setTplId(BosPrintServiceHelper.getTplIdByNum(number));
task.setFormId("demo_sys_test_bill");
task.setPkIds(Collections.<Object>singletonList(billId));
task.setPageId("probe-" + System.currentTimeMillis());

PrintWork work = new PrintWork();
work.setExpType("pdf");
work.setPrintLang("zh_CN");
work.setPageId(task.getPageId());
work.setTaskList(Collections.singletonList(task));

String taskId = String.valueOf(System.currentTimeMillis());   //必须能 parse 成数字
new BosPrintServiceImpl().doPrint(taskId, work);              //kd.bos.print.service.BosPrintServiceImpl

PrtAttach attach = ExecuteService.getAttachService().getPrtAttach(taskId);
InputStream in = BosPrintServiceHelper.getFileInputStream(
        attach.getAttachDetail().get(0).getFilePath(), attach.getDiskType());
```

- `taskId` 后面要被 parse 成数字，传 `"probeTask123"` 这种会 `NumberFormatException`。
- `exportPdf(List, String)` 的第一个参数是 `List<PrintTask>`，不是主键列表。
- `trd` 里有 `pdfbox-2.0.24.jar`，可以在探针里解析或渲染产出的 PDF。
  想自己走内容流拿图片位置，**要重写 protected 的 `processOperator(Operator, List)`** ——
  public 的 `processOperator(String, List)` 是反过来调它的，重写那个一个操作符都收不到；
  还必须 `addOperator` 注册 `q` / `Q` / `cm` / `gs`，否则 CTM 恒为初始矩阵，所有图片会量到同一处。
