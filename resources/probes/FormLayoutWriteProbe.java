import java.beans.Introspector;
import java.beans.PropertyDescriptor;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;

import com.fasterxml.jackson.databind.ObjectMapper;

import kd.bos.dataentity.entity.LocaleString;
import kd.bos.dataentity.utils.Uuid16;
import kd.bos.db.DB;
import kd.bos.db.DBRoute;
import kd.bos.db.ResultSetHandler;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.BasedataEntityType;
import kd.bos.entity.EntityType;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.ValueMapItem;
import kd.bos.designer.ai.copilot.engine.handler.ControlApFactory;
import kd.bos.designer.ai.copilot.engine.handler.ControlValidation;
import kd.bos.designer.ai.copilot.engine.handler.FieldValidation;
import kd.bos.designer.property.operation.MetaOperationService;
import kd.bos.designer.property.operation.OperationTypeDTO;
import kd.bos.designer.property.operation.OperationTypeListParam;
import kd.bos.designer.property.operation.OperationTypeListResult;
import kd.bos.designer.property.setting.MetaPropertyService;
import kd.bos.designer.property.setting.PropertySchema;
import kd.bos.designer.ai.service.FieldCreatorRegistry;
import kd.bos.metadata.Plugin;
import kd.bos.metadata.dao.EntityMetadataUtil;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.dao.MetadataSerializer;
import kd.bos.metadata.dao.MetadataWriter;
import kd.bos.metadata.domainmodel.DomainModelType;
import kd.bos.metadata.entity.Entity;
import kd.bos.metadata.entity.EntityItem;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.metadata.entity.EntryEntity;
import kd.bos.metadata.entity.businessfield.AmountField;
import kd.bos.metadata.entity.businessfield.BasedataField;
import kd.bos.metadata.entity.businessfield.MulBasedataField;
import kd.bos.metadata.entity.commonfield.ComboField;
import kd.bos.metadata.entity.commonfield.ComboItem;
import kd.bos.metadata.entity.commonfield.Field;
import kd.bos.metadata.entity.commonfield.IDBField;
import kd.bos.metadata.entity.commonfield.LargeTextField;
import kd.bos.metadata.entity.commonfield.MuliLangTextField;
import kd.bos.metadata.entity.operation.EntryOpParameter;
import kd.bos.metadata.entity.operation.NewEntryParameter;
import kd.bos.metadata.entity.operation.Operation;
import kd.bos.metadata.filter.FilterColumnAp;
import kd.bos.metadata.filter.CommonFilterColumnAp;
import kd.bos.metadata.form.BillFormAp;
import kd.bos.metadata.form.ContainerAp;
import kd.bos.metadata.form.ControlAp;
import kd.bos.metadata.form.FormMetadata;
import kd.bos.metadata.form.Margin;
import kd.bos.metadata.form.Style;
import kd.bos.metadata.form.cardentry.CardEntryFieldAp;
import kd.bos.metadata.form.cardentry.CardEntryRowAp;
import kd.bos.metadata.form.container.AdvConAp;
import kd.bos.metadata.form.container.AdvConBarItemAp;
import kd.bos.metadata.form.container.AdvConChildPanelAp;
import kd.bos.metadata.form.container.AdvConSummaryPanelAp;
import kd.bos.metadata.form.container.AdvConToolbarAp;
import kd.bos.metadata.form.control.BarItemAp;
import kd.bos.metadata.form.control.EntryAp;
import kd.bos.metadata.form.control.EntryFieldAp;
import kd.bos.metadata.form.control.FieldAp;
import kd.bos.metadata.form.control.ToolbarAp;
import kd.bos.metadata.list.ListColumnAp;
import kd.bos.servicehelper.DBServiceHelper;

/**
 * 写探针：改单据——加删字段、加分录、改控件和字段的属性、挪控件、加删控件，加删操作，挂插件、摘插件，配置列表常用过滤和快捷搜索字段。默认 dry-run，必须 APPLY=1 才落库。
 *
 *   LAYOUT_FORM=demo_sys_bgjl      单据或布局标识，必填
 *   LAYOUT_EDIT=改动清单            一行一条，# 开头是注释，按顺序改，后面的行能用前面新加的东西：
 *       set <元素>.<属性>=<值>       属性名和能填的值看 FormLayoutProbe 的 LAYOUT_PROPS；值写 true/false、数字或文字。
 *                                    边框样式 Style 写 JSON：set <元素>.Style={"border":"1px_solid_#e5e5e5","margin":{"top":"10px"},"padding":{"left":"8px"}}，
 *                                    border 边框（宽度_线型_颜色）、margin 外边距、padding 内边距，给一个值是四条边一样，分边写 top、right、bottom、left；
 *                                    只改写到的边，别的边留着，写空串清掉那条边，Style= 留空清掉全部
 *       move <控件> into <容器>      挪到容器的最后
 *       move <控件> before <控件>    挪到另一个控件前面（同一容器里调顺序也用它）
 *       move <控件> after <控件>     挪到另一个控件后面
 *       add <控件类型> <新标识> into|before|after <目标> [名称]
 *                                    加界面控件，类型用平台类名：FlexPanelAp、TabAp、TabPageAp、AttachmentPanelAp、LabelAp、
 *                                    工具栏按钮 BarItemAp（放进 ToolbarAp）等；新标识带 <isv>_ 前缀，加完用 set 改它的属性
 *       remove <控件>                删控件，连同里面的控件；里面有字段的不删
 *       add field <字段类型> <新标识> into|before|after <目标> <名称> [base=<基础资料>] [items=<值:名称,…>] [currency=<币别字段>] [table=<关系表>]
 *                                    加字段，控件跟着建：放进分录（EntryAp）或挨着分录字段的是分录字段，否则是表头字段。
 *                                    类型用平台类名：TextField、DecimalField、ComboField、BasedataField、PictureField、AmountField 等；
 *                                    数据库列名 fk_<标识>，落库时业务表加这一列；长度、精度、必录加完用 set 改。
 *                                    多选基础资料（MulBasedataField）选的值存在自己的关系表里，表名默认 tk_<标识>，table= 另起名
 *                                    （tk_<开发商标识>_ 开头，不超过 25 个字符），落库时新建
 *       copy field <源单据>.<字段> into|before|after <目标> [replace=<旧>=<新>,…] [table=<关系表>]
 *                                    把别的单据上的字段照搬过来，配置一模一样，标识和数据库列名不变；replace 换掉过滤条件里引用的源单据字段；
 *                                    多选基础资料另起关系表，规则同 add field
 *       remove field <字段>          删字段，连同它的控件和列表上的这一列；数据库里的列和数据留着
 *       add entry <新分录标识> into|before|after <目标> <名称>
 *                                    加分录（单据体）：分录面板放在目标处，面板里带工具栏、增行删行按钮和它们的操作，落库时新建业务表 tk_<标识>；
 *                                    后面的行用 add field … into <新分录标识> 往里加字段。子分录、树形分录、卡片分录到开发平台建
 *       add op <新操作标识> <操作类型> <名称>   加操作，类型如 donothing；按钮用 set <按钮>.OperationKey=<操作> 绑上
 *       remove op <操作>
 *       add plugin <类全名> [to list | to op <操作>]       挂插件：不带 to 挂在当前这份布局上（电脑端是单据插件，移动端是移动端插件，
 *                                    移动端列表是移动端列表插件），to list 是列表插件，to op 是操作插件
 *       remove plugin <类全名> [from list | from op <操作>]
 *       layout bill|list|mobile|mobilelist  后面的行改哪份布局：bill 单据电脑端（不写就是它），list 电脑端列表，mobile 单据带的移动端布局，mobilelist 移动端列表。
 *                                    几份布局里的控件标识会重名（billno、tbmain），切过去以后按这一份找；
 *                                    加删字段、分录、操作和 to list、to op 写在 bill 下。独立的移动表单直接改，不用写 layout
 *       show <字段或路径> [as <新控件标识>] into|before|after <目标>
 *                                    把已有字段放成电脑端列表的一列（放进 ListGridViewAp，如 gridview），或放到移动端布局、移动端列表卡片上；
 *                                    字段本身不动。撤下用 remove <控件>，字段留着。电脑端列表加按钮用 add BarItemAp <新标识> into _toolbar_ <名称>，
 *                                    再 set <按钮>.OperationKey=<已有操作>；新操作先在 layout bill 下用 add op 加
 *                                    列表基础资料字段不带后缀时显示其配置的名称字段；用 creator.name、creator.number 等完整路径选择属性。
 *                                    完整路径用 FormLayoutProbe LAYOUT_LIST_FIELDS=1 查；路径中的点转下划线作为新列控件标识，as 可指定带开发商前缀的标识。
 *                                    before、after 的目标是已有列控件的标识，不是它绑定的字段路径
 *       show filter <字段路径> as <新标识> into|before|after <目标>
 *                                    layout list 下把字段加进常用过滤（FilterGridViewAp）或快捷搜索（FastSearchGridViewAp）；
 *                                    字段路径用 FormLayoutProbe 的 LAYOUT_FILTER_FIELDS=1 查，类型、字段绑定和选项由平台生成。
 *                                    例如 show filter billstatus as demo_status_filter into filtergridview；同一视图不重复加同一字段。
 *                                    属性用 set 改（Multi、DefValue、DateConst 等，先查 LAYOUT_PROPS），顺序用 move，撤下用 remove；字段本身保留
 *   LAYOUT_RESTORE=<备份目录>      把改前备份原样写回，和 LAYOUT_EDIT 二选一
 *   LAYOUT_BACKUP=<目录>           APPLY=1 时必给：落库前把改前的布局（改了字段属性或操作时连同实体）存进去
 *   APPLY=1                        真落库
 *
 * 整份清单先在内存里的元数据对象上改完，问题一次列全，有一处不对就一处都不写；某行要加的东西没加成，后面用到它的行合成一句，不逐行报；
 * 差异由程序逐元素、逐属性比出来；有新字段、新分录时另报落库后的样子：新建哪张表，哪张表加哪几列、类型和长度（没改的默认长度也报）、列表上有没有这一列；
 * 落库只保存一次，存前核对改前快照，存后重新读一遍逐项核对。
 * 属性按设计器属性面板的清单校验：不在清单上、设计器对这类元素不显示、只读、标识和数据库列名、可选值和上下限以外的值，都拒；
 * 能不能设和 FormLayoutProbe 的 LAYOUT_ONLY_PROPS 同一个方法判，写之前可以一批元素一次查。
 * 同一个标识既是字段又有控件时，属性先落在字段上（所有布局都生效），字段上没有的再落在这张布局的控件上，和设计器一致。
 * 删字段、控件、操作前查引用：界面规则、按钮这些元数据里还指着它的，这张单据挂的插件源码里还写着它标识的，都列出来、不删。
 * 模板或标准产品带来的字段、控件、操作、插件只能改属性，删不了。
 */
public class FormLayoutWriteProbe {

    static final ObjectMapper OM = new ObjectMapper();

    public static void run() throws Exception {
        String form = req("LAYOUT_FORM", "单据或布局标识");
        String edit = env("LAYOUT_EDIT", "");
        String restoreDir = env("LAYOUT_RESTORE", "");
        if (edit.trim().isEmpty() == restoreDir.isEmpty()) {
            throw new IllegalArgumentException("LAYOUT_EDIT 和 LAYOUT_RESTORE 必须给一个、只能给一个："
                    + "改属性、挪位置用 LAYOUT_EDIT=<改动清单>；把改前备份写回用 LAYOUT_RESTORE=<备份目录>");
        }
        boolean apply = "1".equals(env("APPLY", ""));
        String backupDir = env("LAYOUT_BACKUP", "");
        if (apply && backupDir.isEmpty()) {
            p("!! APPLY=1 必须同时给 LAYOUT_BACKUP=<目录>，中止");
            return;
        }

        String formId = MetadataDao.getIdByNumber(form, MetaCategory.Form);
        if (formId == null || formId.isEmpty()) throw new IllegalArgumentException("布局不存在: " + form);
        FormMetadata fm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(fm.getEntityId(), MetaCategory.Entity);
        String entity = em.getKey();
        //建在原厂或别家实体上的本 ISV 布局（例如在原厂合同上建的移动单据）：布局本身是本 ISV 的，只改布局，实体一处不动
        boolean layoutOnly = !formId.equals(em.getId()) && !IsvGuard.ISV.equalsIgnoreCase(String.valueOf(em.getIsv()))
                && IsvGuard.ISV.equalsIgnoreCase(String.valueOf(fm.getIsv()));
        if (layoutOnly) {
            IsvGuard.assertOwnLayoutOnForeignEntity(entity, em.getIsv(), form, fm.getIsv());
        } else {
            IsvGuard.assertOwnEntity(entity, em);
            IsvGuard.assertOwnLayout(entity, form);
        }

        MetadataSerializer fser = new MetadataSerializer(fm.getModelType());
        MetadataSerializer eser = new MetadataSerializer(em.getModelType());
        Map<String, Object> formBefore = fser.serializeToMap(fm);
        Map<String, Object> entityBefore = eser.serializeToMap(em);
        String baseline = baseline(formBefore, entityBefore);
        p("模式=" + (apply ? "APPLY 真写" : "dry-run 只演算") + "  改法=" + (restoreDir.isEmpty() ? "改动清单" : "整份恢复")
                + "  布局=" + form + "  实体=" + entity + "  控件 " + fm.getItems().size() + " 个"
                + (blank(fm.getParentId()) ? "" : "  继承自 " + fm.getParentId()));
        p("改前快照=" + baseline);
        if (apply && !confirmedBaseline(baseline)) return;

        //平台保存的第一步（convertToDesignMeta）会原地规整对象：去掉顶层面板多余的父节点、重写列表布局。
        //每次保存都这样，不是这份清单改的。改前那份也拷一份过同样的规整，两边抵消，差异里只剩真正的改动
        Map<String, Object> formBase = formBefore;
        Map<String, Object> entityBase = entityBefore;
        //拷贝要从库里再读一份：从序列化结果反序列化出来的对象不带继承信息，规整出来和原对象不一样
        try {
            FormMetadata f = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
            EntityMetadata e = (EntityMetadata) MetadataDao.readMeta(em.getId(), MetaCategory.Entity);
            if (f == fm || e == em) throw new IllegalStateException("平台读元数据给的是同一个对象，拷不出第二份");
            new MetadataWriter(fm.getModelType()).convertToDesignMeta(e, f);
            formBase = fser.serializeToMap(f);
            entityBase = eser.serializeToMap(e);
        } catch (Throwable e) {
            p("改前那份过平台保存前的规整没成（" + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage())
                    + "），差异里会多出平台自己规整的几处");
        }

        FormMetadata formAfter = fm;
        EntityMetadata entityAfter = em;
        boolean entityTouched;
        Set<String> targeted = new LinkedHashSet<String>();
        List<String> problems = new ArrayList<String>();
        Editor editor = null;
        if (!restoreDir.isEmpty()) {
            File dir = new File(restoreDir);
            File formFile = new File(dir, safe(form) + ".form.json");
            File entityFile = new File(dir, safe(form) + ".entity.json");
            if (!formFile.isFile()) {
                throw new IllegalArgumentException("备份目录里没有这张布局的备份：" + formFile.getAbsolutePath()
                        + " —— 要的是 LAYOUT_BACKUP 落下的那个目录");
            }
            Map<String, Object> formSaved = readJson(formFile);
            formAfter = (FormMetadata) fser.deserializeFromMap(formSaved, null);
            if (!formId.equals(formAfter.getId())) {
                throw new IllegalArgumentException("备份里的布局 id 是 " + formAfter.getId() + "，这张布局是 " + formId + "，不是同一张");
            }
            restoreInherit(formSaved, formAfter, "布局", problems);
            entityTouched = entityFile.isFile() && !layoutOnly;
            if (entityTouched) {
                Map<String, Object> entitySaved = readJson(entityFile);
                entityAfter = (EntityMetadata) eser.deserializeFromMap(entitySaved, null);
                if (!em.getId().equals(entityAfter.getId())) {
                    throw new IllegalArgumentException("备份里的实体 id 是 " + entityAfter.getId() + "，这张单据是 " + em.getId() + "，不是同一张");
                }
                restoreInherit(entitySaved, entityAfter, "实体", problems);
            }
        } else {
            editor = new Editor(form, fm, em);
            editor.applyAll(edit);
            editor.checkFilters();
            if (layoutOnly && editor.entityTouched) {
                Set<String> touched = new LinkedHashSet<String>(editor.fieldTargets);
                touched.addAll(editor.ownOps);
                touched.addAll(editor.opHosts);
                editor.problems.add("实体 " + entity + " 是 " + em.getIsv() + " 的，" + form + " 是建在它上面的本 ISV 布局：只能改布局本身（控件、位置、"
                        + "布局上的插件），改字段、操作的行都要去掉" + (touched.isEmpty() ? "" : "（这次改到了 " + String.join("、", touched) + "）")
                        + "；字段本身的属性（名称、必录这类）改不了，控件上的属性照常能改");
            }
            if (editor.problems.isEmpty()) editor.checkRemoved(fser.serializeToMap(fm), eser.serializeToMap(em));
            problems = editor.problems;
            entityTouched = editor.entityTouched;
            targeted = editor.targeted;
            if (problems.isEmpty()) {
                for (String key : editor.fieldTargets) IsvGuard.assertOwnField(key);
                for (String key : editor.ownOps) IsvGuard.assertOwnOperation(key);
                for (String key : editor.opHosts) IsvGuard.assertOperationHost(key);
            }
        }
        boolean inputInvalid = !problems.isEmpty() && (editor == null || !editor.executionFailed);
        if (problems.isEmpty()) designCheck(entityAfter, formAfter, problems);
        //实体这次要存才查：只改布局时实体不落库，别人的实体上有空表名也轮不到这里管
        if (problems.isEmpty() && entityTouched) relationTablesFilled(entityAfter, formAfter.getModelType(), problems);
        //平台保存前的规整会重写一部分对象（列表布局就是重写的）：新加的东西过完规整还在，才算加上了
        if (problems.isEmpty() && editor != null) {
            for (Supplier<String> s : editor.survive) {
                String lost = s.get();
                if (lost != null) problems.add(lost);
            }
        }
        if (!problems.isEmpty()) {
            StringBuilder sb = new StringBuilder(restoreDir.isEmpty() ? "改动清单有 " : "备份有 ")
                    .append(problems.size()).append(" 处问题，一处都没写：");
            for (String x : problems) sb.append("\n  - ").append(x);
            if (inputInvalid) throw new IllegalArgumentException(sb.toString());
            throw new IllegalStateException(sb.toString());
        }

        Map<String, Object> formPlanned = fser.serializeToMap(formAfter);
        Map<String, Object> entityPlanned = entityTouched ? eser.serializeToMap(entityAfter) : entityBase;
        List<Change> changes = new ArrayList<Change>();
        changes.addAll(diff("布局", formBase, formPlanned));
        if (entityTouched) changes.addAll(diff("字段", entityBase, entityPlanned));
        if (changes.isEmpty()) {
            p(restoreDir.isEmpty() ? "改完和现在一模一样，没有要写的" : "现在和备份一模一样，不用恢复");
            return;
        }
        //整份恢复没有清单，改到哪些字段、操作看差异：和改动清单一样每个都过 ISV 检查、进写入目标
        if (!restoreDir.isEmpty()) {
            for (Change c : changes) {
                if ("（整张）".equals(c.key)) continue;
                if ("字段".equals(c.scope) || "分录".equals(c.scope)) IsvGuard.assertOwnField(c.key);
                else if ("操作".equals(c.scope) && (ADDED.equals(c.prop) || REMOVED.equals(c.prop))) IsvGuard.assertOwnOperation(c.key);
                else if ("操作".equals(c.scope)) IsvGuard.assertOperationHost(c.key);
            }
        }
        int shown = report(changes, targeted);
        if (editor != null) editor.landing();
        heirs(formId);

        if (!apply) {
            IsvGuard.reportTargets();
            System.out.println("[PROBE] dry-run 结束，数据库未修改。确认无误后加 APPLY=1 和 LAYOUT_BACKUP=<目录>");
            return;
        }

        //二次核对：读到基线之后到现在，有没有别人在设计器里保存过
        FormMetadata nowForm = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
        EntityMetadata nowEntity = (EntityMetadata) MetadataDao.readMeta(em.getId(), MetaCategory.Entity);
        if (!baseline.equals(baseline(fser.serializeToMap(nowForm), eser.serializeToMap(nowEntity)))) {
            p("未落库：改前数据和预演时不一样了，刚刚有人在设计器里保存过，一处都没改，以免覆盖。重新 dry-run、重新确认");
            return;
        }
        //备份的永远是库里现在那份，不是要写进去的那份
        backup(backupDir, form, formBefore, entityTouched ? entityBefore : null);

        MetadataWriter writer = new MetadataWriter(fm.getModelType());
        //平台保存时会往标准输出倒一整份设计态 XML，收掉，只留下面这行成败
        PrintStream out = System.out;
        Map<String, Object> r;
        try {
            System.setOut(new PrintStream(new ByteArrayOutputStream(), true, "UTF-8"));
            r = entityTouched ? writer.save(entityAfter, formAfter) : writer.save(formAfter);
        } finally {
            System.setOut(out);
        }
        //保存结果里带着整份设计态 XML，只留成败和出错信息
        p("save -> {success=" + r.get("success") + (r.get("errors") == null ? "" : ", errors=" + oneLine(String.valueOf(r.get("errors"))))
                + (r.get("message") == null ? "" : ", message=" + oneLine(String.valueOf(r.get("message")))) + "}");
        if (!Boolean.TRUE.equals(r.get("success"))) {
            p("!! 平台没有存上，库里还是改前那份");
            return;
        }
        MetadataDao.rebuildRuntimeMetaById(formId);
        if (entityTouched && !em.getId().equals(formId)) MetadataDao.rebuildRuntimeMetaById(em.getId());
        System.out.println("[PROBE] 布局已落库：" + shown + " 处" + (changes.size() > shown ? "，另有 " + (changes.size() - shown) + " 个控件序号顺延" : "")
                + (entityTouched ? "（布局和实体一起存）" : "") + "，备份在 "
                + new File(backupDir).getAbsolutePath() + "，要退回用 LAYOUT_RESTORE=<这个目录>");
        readBack(formId, em.getId(), fser, eser, formPlanned, entityTouched ? entityPlanned : null);
    }

    // ---------- 改动清单 ----------

    /**
     * 单据里的一份布局：电脑端布局本身、电脑端列表（ListMeta）、移动端布局（MobMeta）、移动端列表布局（MobListMeta）。
     * 各份有各自的控件，标识可以重名，跟着单据布局一起存；清单里 layout 切到哪份，后面的行就在哪份上找控件、算属性清单。
     */
    static final class Part {
        final String name;
        final String title;
        FormMetadata fm;
        final Map<String, ControlAp<?>> byId = new HashMap<String, ControlAp<?>>();
        final Map<String, ControlAp<?>> added = new HashMap<String, ControlAp<?>>();
        final Map<String, List<PropertySchema>> schemas = new HashMap<String, List<PropertySchema>>();

        Part(String name, String title, FormMetadata fm) {
            this.name = name;
            this.title = title;
            this.fm = fm;
            for (ControlAp<?> c : fm.getItems()) byId.put(c.getId(), c);
        }
    }

    static final class Editor {
        final String form;
        /** 电脑端布局（整张单据存的就是它，移动端两份塞在它的根控件里）；fm 是清单当前在改的那份。 */
        final FormMetadata bill;
        FormMetadata fm;
        Part part;
        final Map<String, Part> parts = new LinkedHashMap<String, Part>();
        /** 建在原厂或别家实体上的本 ISV 布局：只能改布局本身，实体一处不能动。 */
        boolean layoutOnly;
        final EntityMetadata em;
        final List<String> problems = new ArrayList<String>();
        /** 清单里点了名的元素：确认单上它们的每处变化都列，别的控件只因顺延改了序号的合成一行。 */
        final Set<String> targeted = new LinkedHashSet<String>();
        final Set<String> fieldTargets = new LinkedHashSet<String>();
        /** 加、删的本单据操作（要带前缀）；挂、摘了插件的操作（可以是模板带来的）。 */
        final Set<String> ownOps = new LinkedHashSet<String>();
        final Set<String> opHosts = new LinkedHashSet<String>();
        /** 当前这份布局的属性清单缓存；切布局时跟着换。 */
        Map<String, List<PropertySchema>> schemas;
        /** 当前这份布局的控件，按 id：控件 id 不随挪动变，一份建一次；父子关系每次现读 ParentId。 */
        Map<String, ControlAp<?>> byId;
        /** 当前这份布局上这份清单新加的控件：库里还没有，属性清单按类型现算。 */
        Map<String, ControlAp<?>> added;
        final Map<String, Field<?>> addedFields = new HashMap<String, Field<?>>();
        /** 这份清单新加的分录 → 它的表在库里是不是已经有了（以前建过同名分录留下的）。 */
        final Map<EntryEntity, Boolean> addedEntries = new LinkedHashMap<EntryEntity, Boolean>();
        /** 这份清单给多选基础资料定的关系表：字段标识 → 表名（新加、照搬的，和 set 补上表名的）。落库时新建。 */
        final Map<String, String> relationTables = new LinkedHashMap<String, String>();
        /** 删掉的控件、字段和操作：改完查还有没有地方指着它们。 */
        final List<String[]> removed = new ArrayList<String[]>();
        /** 新加的东西过完平台保存前的规整还在不在，在 run() 里逐个问。 */
        final List<Supplier<String>> survive = new ArrayList<Supplier<String>>();
        /** 同一份清单里加了又删掉的：保存前的规整之后它本来就不该在，不当成被平台去掉。 */
        final Set<String> dropped = new HashSet<String>();
        /** 这份清单里没加上的新元素 → 第几行：后面提到它的行只说这一句，不再各报一遍"没有控件"。 */
        final Map<String, Integer> notAdded = new HashMap<String, Integer>();
        Set<String> opTypes;
        boolean entityTouched;
        boolean executionFailed;

        Editor(String form, FormMetadata fm, EntityMetadata em) {
            this.form = form;
            this.bill = fm;
            this.em = em;
            em.createIndex();
            use(new Part("bill", "电脑端布局", fm));
        }

        void use(Part p) {
            parts.put(p.name, p);
            part = p;
            fm = p.fm;
            byId = p.byId;
            added = p.added;
            schemas = p.schemas;
        }

        /** 某份布局现在的对象：电脑端就是 bill，移动端两份现取。 */
        FormMetadata partNow(String name) {
            return "bill".equals(name) ? bill : nested(name);
        }

        boolean onBill() {
            return "bill".equals(part.name);
        }

        /** 单据里塞着的列表及移动端布局；没有是 null。每次现取：平台保存前的规整可能换掉这些对象。 */
        FormMetadata nested(String name) {
            if (!(bill.getRootAp() instanceof BillFormAp)) return null;
            BillFormAp root = (BillFormAp) bill.getRootAp();
            return "list".equals(name) ? root.getListMeta() : "mobile".equals(name) ? root.getMobMeta() : "mobilelist".equals(name) ? root.getMobListMeta() : null;
        }

        /** layout bill|list|mobile|mobilelist：后面的行改哪份布局。 */
        void layout(String where, String name) {
            if ("bill".equals(name)) {
                use(parts.get("bill"));
                return;
            }
            if (!"list".equals(name) && !"mobile".equals(name) && !"mobilelist".equals(name)) {
                problems.add(where + "要写成 layout bill、layout list、layout mobile 或 layout mobilelist");
                return;
            }
            String title = "list".equals(name) ? "电脑端列表布局" : "mobile".equals(name) ? "移动端布局" : "移动端列表布局";
            String self = bill.getRootAp().getClass().getSimpleName();
            //独立的移动单据（MobileBillFormAp）也是 BillFormAp 的子类，先按名字认
            if (self.startsWith("Mobile") || !(bill.getRootAp() instanceof BillFormAp)) {
                problems.add(where + form + " 是 " + self + (self.startsWith("Mobile") ? "，本身就是移动端布局，直接改，不用写 layout"
                        : "，这类布局不带" + title));
                return;
            }
            FormMetadata meta = nested(name);
            if (meta == null || meta.getRootAp() == null) {
                problems.add(where + "这张单据没有" + title + "，在开发平台里建");
                return;
            }
            Part p = parts.get(name);
            use(p != null ? p : new Part(name, title, meta));
        }

        /** 现在改的是哪份：独立的移动表单按它自己的根控件认。 */
        String kind() {
            if ("list".equals(part.name)) return "list";
            String root = fm.getRootAp().getClass().getSimpleName();
            return root.startsWith("MobileList") ? "mobilelist" : root.startsWith("Mobile") ? "mobile" : "bill";
        }

        /** 加删字段、分录、操作只在电脑端布局下：这几样改的是实体，控件跟着建在电脑端。 */
        boolean billOnly(String where, String what) {
            if (onBill()) return true;
            problems.add(where + what + "写在 layout bill 下（现在改的是" + part.title + "）"
                    + (what.contains("字段") ? "；要让字段出现在" + part.title + "上，加完再切过来用 show <字段>" : ""));
            return false;
        }

        void applyAll(String edit) {
            int no = 0;
            //起因行 → 跟着没改的行号；起因行最后一条问题在 problems 里的位置，合成的那句插在它后面
            Map<Integer, List<Integer>> skipped = new TreeMap<Integer, List<Integer>>();
            Map<Integer, Integer> rootAt = new HashMap<Integer, Integer>();
            for (String raw : edit.split("\r?\n")) {
                no++;
                String line = raw.trim();
                if (line.isEmpty() || line.startsWith("#")) continue;
                String where = "第 " + no + " 行「" + clip(line, 80) + "」：";
                String gone = mentionsNotAdded(line);
                if (gone != null) {
                    //这一行要加的新元素也就没有，再往后提到它的行算在同一个起因下
                    int root = notAdded.get(gone.toLowerCase());
                    skipped.get(root).add(no);
                    String key = addedKey(line);
                    if (key != null && !exists(key, line.startsWith("add op "))) notAdded.put(key.toLowerCase(), root);
                    continue;
                }
                int before = problems.size();
                try {
                    if (line.startsWith("set ")) set(where, line.substring(4).trim());
                    else if (line.startsWith("move ")) move(where, line.substring(5).trim());
                    else if (line.startsWith("layout ")) layout(where, line.substring(7).trim());
                    else if (line.startsWith("show filter ")) showFilter(where, line.substring(12).trim());
                    else if (line.startsWith("show ")) showField(where, line.substring(5).trim());
                    else if (line.startsWith("add field ")) {
                        if (billOnly(where, "加字段")) addField(where, line.substring(10).trim());
                    } else if (line.startsWith("copy field ")) {
                        if (billOnly(where, "照搬字段")) copyField(where, line.substring(11).trim());
                    } else if (line.startsWith("remove field ")) {
                        if (billOnly(where, "删字段")) removeField(where, line.substring(13).trim());
                    } else if (line.startsWith("add entry ")) {
                        if (billOnly(where, "加分录")) addEntry(where, line.substring(10).trim());
                    } else if (line.startsWith("add op ")) {
                        if (billOnly(where, "加操作")) addOp(where, line.substring(7).trim());
                    } else if (line.startsWith("add plugin ")) plugin(where, line.substring(11).trim(), true);
                    else if (line.startsWith("add ")) addControl(where, line.substring(4).trim());
                    else if (line.startsWith("remove op ")) {
                        if (billOnly(where, "删操作")) removeOp(where, line.substring(10).trim());
                    } else if (line.startsWith("remove plugin ")) plugin(where, line.substring(14).trim(), false);
                    else if (line.startsWith("remove ")) removeControl(where, line.substring(7).trim());
                    else problems.add(where + "认不出。每行以 set、move、add、copy、remove、show、layout 开头，写法见 FormLayoutWriteProbe 的说明");
                } catch (Exception e) {
                    if (!(e instanceof IllegalArgumentException)) executionFailed = true;
                    problems.add(where + "改的时候平台报错 " + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()));
                }
                //要带 true：不带参数的 createIndex 建过一次就不再重建（读平台字节码确认），加删控件、字段后按标识找不到新的、还找得到删掉的
                if (problems.size() == before) {
                    fm.createIndex(true);
                    em.createIndex(true);
                } else {
                    String key = addedKey(line);
                    if (key != null && !exists(key, line.startsWith("add op "))) {
                        notAdded.put(key.toLowerCase(), no);
                        skipped.put(no, new ArrayList<Integer>());
                        rootAt.put(no, problems.size());
                    }
                }
            }
            //一个起因一句，紧跟在起因那条后面；从后往前插，前面的位置不变
            List<Integer> roots = new ArrayList<Integer>(skipped.keySet());
            Collections.reverse(roots);
            for (int root : roots) {
                List<Integer> lines = skipped.get(root);
                if (lines.isEmpty()) continue;
                List<String> keys = new ArrayList<String>();
                for (Map.Entry<String, Integer> e : notAdded.entrySet()) {
                    if (e.getValue() == root) keys.add(e.getKey());
                }
                Collections.sort(keys);
                List<String> nos = new ArrayList<String>();
                for (int n : lines) nos.add(String.valueOf(n));
                problems.add(rootAt.get(root), "第 " + String.join("、", nos) + " 行跟着没改：第 " + root + " 行没加成，这几行直接或间接用到它"
                        + "（因此没有的：" + String.join("、", keys) + "）；改好第 " + root + " 行再试算，这几行才逐行检查");
            }
        }

        /** add / copy 行要加的新标识；别的行回 null。 */
        static String addedKey(String line) {
            String[] p = line.split("\\s+");
            if (line.startsWith("show filter ")) return p.length > 4 ? p[4] : null;
            if (line.startsWith("show ")) return p.length > 3 && "as".equals(p[2]) ? p[3] : p.length > 1 ? p[1].replace('.', '_') : null;
            if (line.startsWith("add field ")) return p.length > 3 ? p[3] : null;
            if (line.startsWith("copy field ")) {
                int dot = p.length > 2 ? p[2].lastIndexOf('.') : -1;
                return dot < 0 ? null : p[2].substring(dot + 1);
            }
            if (line.startsWith("add plugin ")) return null;
            if (line.startsWith("add op ")) return p.length > 2 ? p[2] : null;
            if (line.startsWith("add ")) return p.length > 2 ? p[2] : null;
            return null;
        }

        boolean exists(String key, boolean op) {
            return op ? findOp(key) != null : fm.getItemByKey(key) != null || onBill() && element(key) != null;
        }

        /** 这一行提到的、前面没加上的新元素。 */
        String mentionsNotAdded(String line) {
            if (notAdded.isEmpty()) return null;
            for (String token : line.split("[\\s.=,:]+")) {
                if (notAdded.containsKey(token.toLowerCase())) return token;
            }
            return null;
        }

        // ---------- set ----------

        void set(String where, String spec) throws Exception {
            int eq = spec.indexOf('=');
            int dot = eq < 0 ? -1 : spec.lastIndexOf('.', eq);
            if (eq < 0 || dot <= 0) {
                problems.add(where + "要写成 <元素>.<属性>=<值>");
                return;
            }
            String key = spec.substring(0, dot).trim();
            String prop = spec.substring(dot + 1, eq).trim();
            String value = spec.substring(eq + 1).trim();
            List<PropertySchema> schema = schema(key);
            ControlAp<?> listAp = schema.isEmpty() ? listItem(key) : null;
            if (listAp != null) schema = listSchema(key, listAp);
            if (schema.isEmpty()) {
                problems.add(where + (onBill() ? "这张布局上没有元素 " + key + "；用 FormLayoutProbe 的 LAYOUT_FIND 按名称找" : missing(key)));
                return;
            }
            PropertySchema s = null;
            for (PropertySchema x : schema) {
                if (x.getPropertyName().equalsIgnoreCase(prop)) s = x;
            }
            if (s == null) {
                //这份清单新加的元素库里还没有，LAYOUT_PROPS 查不到它：能设的直接列在这里
                boolean fresh = added.containsKey(key.toLowerCase()) || addedFields.containsKey(key.toLowerCase());
                List<String> near = fresh ? Collections.<String>emptyList() : near(schema, prop);
                problems.add(where + key + " 的属性清单里没有 " + prop
                        + (near.isEmpty() ? "" : "，名字相近的有 " + String.join("、", near))
                        + (fresh ? "；它能设的：" + String.join("、", settable(key, schema))
                                : "；全部属性用 FormLayoutProbe 的 " + (onBill() ? "" : "LAYOUT_PART=" + part.name + " ") + "LAYOUT_PROPS=" + key + " 看"));
                return;
            }
            String name = s.getPropertyName();
            ControlAp<?> ap = listAp != null ? listAp : fm.getItemByKey(key);
            Object element = listAp != null ? null : onBill() ? element(key) : fieldOf(ap);
            boolean hide = listAp != null ? listHidden(listAp, name) : hidden(key, ap, name);
            //能不能设和 FormLayoutProbe 的 LAYOUT_ONLY_PROPS 同一个方法判：查到能设的，这里不会因属性本身拒
            FormLayoutProbe.Target target = FormLayoutProbe.target(key, s, hide, element, ap);
            if (target.why != null) {
                problems.add(where + target.why);
                return;
            }
            if ("tablename".equalsIgnoreCase(name) && element instanceof MulBasedataField) {
                String bad = relationTableProblem((MulBasedataField) element, value.trim());
                if (bad != null) {
                    problems.add(where + bad);
                    return;
                }
                relationTables.put(key, value.trim());
            }
            if ("operationkey".equalsIgnoreCase(name) && !value.isEmpty() && findOp(value) == null) {
                problems.add(where + "这张单据没有操作 " + value + "；新操作先用 add op 加上，已有的操作用 OpMetaProbe 看");
                return;
            }
            Object bean = target.bean;
            PropertyDescriptor pd = target.pd;
            boolean onEntity = !(bean instanceof ControlAp);
            if ("mcombo".equalsIgnoreCase(s.getEditorType())) value = value.replaceAll("\\s*,\\s*", ",");
            Class<?> type = pd.getWriteMethod().getParameterTypes()[0];
            boolean style = type == Style.class;
            Object converted;
            try {
                //边框样式是一组值：在现在的样式上只改写到的边
                converted = style ? FormLayoutProbe.styleMerge(pd.getReadMethod() == null ? null : pd.getReadMethod().invoke(bean), value)
                        : convert(value, type);
            } catch (IllegalArgumentException e) {
                problems.add(where + name + (style ? " " + e.getMessage() : " 要 " + e.getMessage() + "，给的是「" + value + "」"));
                return;
            }
            String bad = style ? null : outOfRange(s, value, converted);
            if (bad != null) {
                problems.add(where + name + " " + bad);
                return;
            }
            pd.getWriteMethod().invoke(bean, converted);
            Object got = pd.getReadMethod() == null ? converted : pd.getReadMethod().invoke(bean);
            if (!same(got, converted)) {
                problems.add(where + name + " 设了 " + show(converted) + "，读回来是 " + show(got) + "，平台没按这个值存");
                return;
            }
            //字段改名时布局上同标识的控件跟着改，和设计器一致
            if (onEntity && "name".equalsIgnoreCase(name) && ap != null) {
                PropertyDescriptor apName = descriptor(ap, "name");
                if (apName != null && apName.getWriteMethod() != null) apName.getWriteMethod().invoke(ap, converted);
            }
            targeted.add(key.toLowerCase());
            if (onEntity) {
                entityTouched = true;
                fieldTargets.add(key);
            }
            if (!onBill() && !onEntity) {
                final PropertyDescriptor read = pd;
                final Object want = converted;
                final String n = name;
                final Part in = part;
                survive.add(() -> {
                    FormMetadata now = nested(in.name);
                    ControlAp<?> c = now == null ? null : now.getItemByKey(key);
                    Object kept = null;
                    try {
                        kept = c == null || read.getReadMethod() == null ? null : read.getReadMethod().invoke(c);
                    } catch (Exception e) {
                        return where + in.title + "上 " + key + " 的 " + n + " 读不回来：" + oneLine(e.getMessage());
                    }
                    return c != null && same(kept, want) ? null : where + "平台保存前的规整把" + in.title + "上 " + key + " 的 " + n + " 改回去了，这样存不进去";
                });
            }
            if (listAp != null) {
                final PropertyDescriptor read = pd;
                final Object want = converted;
                final String n = name;
                survive.add(() -> {
                    ControlAp<?> now = listItem(key);
                    Object kept = null;
                    try {
                        kept = now == null || read.getReadMethod() == null ? null : read.getReadMethod().invoke(now);
                    } catch (Exception e) {
                        return where + "列表布局上 " + key + " 的 " + n + " 读不回来：" + oneLine(e.getMessage());
                    }
                    return now != null && same(kept, want) ? null : where + "平台保存前的规整把列表布局上 " + key + " 的 " + n + " 改回去了，这样存不进去";
                });
            }
        }

        /**
         * 单据的列表布局（列表工具栏的按钮、列表列……）是塞在单据布局里的另一份布局，跟着单据布局一起存（S42 §16.8）。
         * 只在单据布局上找不到这个标识时才来这里找；设计器的属性清单服务不认它，属性清单按它的类型现算，和新加的控件一样。
         */
        FormMetadata listMeta() {
            return bill.getRootAp() instanceof BillFormAp ? ((BillFormAp) bill.getRootAp()).getListMeta() : null;
        }

        ControlAp<?> listItem(String key) {
            //移动端那两份上找不到的控件，不再去电脑端的列表布局里找：标识会重名
            if (!onBill()) return null;
            FormMetadata list = listMeta();
            if (list == null) return null;
            for (ControlAp<?> c : list.getItems()) {
                if (key.equalsIgnoreCase(c.getKey()) && c != list.getRootAp()) return c;
            }
            return null;
        }

        List<PropertySchema> listSchema(String key, ControlAp<?> ap) throws Exception {
            String k = "list:" + key.toLowerCase();
            List<PropertySchema> s = schemas.get(k);
            if (s == null) {
                s = schemaOf(ap, null, listMeta().getModelType());
                schemas.put(k, s);
            }
            return s;
        }

        boolean listHidden(ControlAp<?> ap, String prop) {
            FormMetadata list = listMeta();
            String apType = ap.getClass().getSimpleName();
            String parentType = null;
            for (ControlAp<?> c : list.getItems()) {
                if (!blank(ap.getParentId()) && ap.getParentId().equals(c.getId())) parentType = c.getClass().getSimpleName();
            }
            Map<String, Map<String, Object>> hides = FormLayoutProbe.hides(list, apType);
            return FormLayoutProbe.hidden(hides.get(prop.toLowerCase()), apType, null, parentType);
        }

        List<PropertySchema> schema(String key) throws Exception {
            String k = key.toLowerCase();
            List<PropertySchema> s = schemas.get(k);
            if (s == null) {
                ControlAp<?> fresh = added.get(k);
                Field<?> field = addedFields.get(k);
                if (!onBill()) {
                    //平台的属性清单服务按标识在电脑端布局上找，移动端同名控件会答成电脑端那个：按这份布局上的控件现算。
                    //字段控件和设计器一样，字段类型的属性加上控件类型的属性
                    ControlAp<?> ap = fresh != null ? fresh : fm.getItemByKey(key);
                    if (ap == null) return Collections.emptyList();
                    EntityItem<?> f = fieldOf(ap);
                    s = f != null ? schemaOf(f, ap, fm.getModelType()) : schemaOf(ap, null, fm.getModelType());
                } else s = field != null ? schemaOf(field, fm.getItemByKey(key), fm.getModelType()) : fresh != null ? schemaOf(fresh, null, fm.getModelType())
                        : MetaPropertyService.getPropertySchema(form, key);
                if (s == null || s.isEmpty()) return Collections.emptyList();
                schemas.put(k, s);
            }
            return s;
        }

        /** 新加的控件、字段库里还没有，平台的 getPropertySchema 找不到它，按类型现算（和读探针同一份做法）。 */
        List<PropertySchema> schemaOf(Object el, ControlAp<?> fieldAp, String modelType) throws Exception {
            return FormLayoutProbe.schemaOf(el, fieldAp, modelType);
        }

        /** set 改得了的属性：和 set 本身同一个判法。 */
        List<String> settable(String key, List<PropertySchema> schema) throws Exception {
            ControlAp<?> ap = fm.getItemByKey(key);
            Object element = element(key);
            List<String> out = new ArrayList<String>();
            for (PropertySchema s : schema) {
                String name = s.getPropertyName();
                if (FormLayoutProbe.target(key, s, hidden(key, ap, name), element, ap).why != null) continue;
                out.add(name + "「" + s.getDisplayName() + "」");
            }
            return out;
        }

        /** 单据布局上没有的控件；列表元素给出切换布局的写法。 */
        String missing(String key) {
            List<String> bound = new ArrayList<String>();
            for (ControlAp<?> c : fm.getItems()) {
                if (c instanceof ListColumnAp && key.equalsIgnoreCase(((ListColumnAp) c).getListFieldId())) {
                    bound.add(c.getKey() + "（绑定 " + ((ListColumnAp) c).getListFieldId() + "）");
                }
            }
            if (!bound.isEmpty()) return key + " 是字段路径，" + part.title + "上对应的列控件是 " + String.join("、", bound)
                    + "；before、after、set、move、remove 的目标用列控件标识";
            if (!onBill()) return part.title + "上没有控件 " + key + "；用 FormLayoutProbe 的 LAYOUT_FIND 按名称找（结果标着在哪份布局上）";
            return listItem(key) != null ? key + " 在电脑端列表布局上，先写 layout list，再改它的位置、加删控件；改属性也可以直接 set"
                    : "这张布局上没有控件 " + key + "；用 FormLayoutProbe 的 LAYOUT_FIND 按名称找";
        }

        Object element(String key) {
            Object f = em.getFieldByKey(key);
            if (f != null) return f;
            for (EntityItem<?> it : em.getItems()) {
                if (key.equalsIgnoreCase(it.getKey())) return it;
            }
            return null;
        }

        boolean hidden(String key, ControlAp<?> ap, String prop) {
            String apType = ap == null ? null : ap.getClass().getSimpleName();
            String fieldType = ap == null ? null : fieldType(ap);
            if (fieldType == null) {
                Object el = element(key);
                if (el != null) fieldType = el.getClass().getSimpleName();
            }
            ControlAp<?> parent = ap == null ? null : parentOf(ap);
            String parentType = parent == null ? null : parent.getClass().getSimpleName();
            Map<String, Map<String, Object>> hides = FormLayoutProbe.hides(fm, apType, fieldType);
            return FormLayoutProbe.hidden(hides.get(prop.toLowerCase()), apType, fieldType, parentType);
        }

        String fieldType(ControlAp<?> ap) {
            EntityItem<?> it = fieldOf(ap);
            return it == null ? null : it.getClass().getSimpleName();
        }

        EntityItem<?> fieldOf(ControlAp<?> ap) {
            if (!(ap instanceof FieldAp)) return null;
            FieldAp f = (FieldAp) ap;
            return em.getItemById(blank(f.getFieldId()) ? ap.getId() : f.getFieldId());
        }

        // ---------- move ----------

        void move(String where, String spec) {
            String[] parts = spec.split("\\s+");
            if (parts.length != 3 || !(parts[1].equals("into") || parts[1].equals("before") || parts[1].equals("after"))) {
                problems.add(where + "要写成 move <控件> into <容器>，或 move <控件> before|after <控件>");
                return;
            }
            String key = parts[0];
            String how = parts[1];
            ControlAp<?> el = fm.getItemByKey(key);
            ControlAp<?> target = fm.getItemByKey(parts[2]);
            if (el == null) {
                problems.add(where + (element(key) != null ? "字段 " + key + " 在这张布局上没有控件，挪不了" : missing(key)));
                return;
            }
            if (el == fm.getRootAp()) {
                problems.add(where + key + " 是整张单据的最外层，挪不了");
                return;
            }
            if (target == null) {
                problems.add(where + missing(parts[2]));
                return;
            }
            if (target == el) {
                problems.add(where + "目标就是它自己");
                return;
            }
            ControlAp<?> parent = how.equals("into") ? target : parentOf(target);
            if (how.equals("into") && !(target instanceof ContainerAp)) {
                problems.add(where + parts[2] + " 是 " + target.getClass().getSimpleName() + "，不是容器；要挪到它旁边用 before 或 after");
                return;
            }
            for (ControlAp<?> x = parent; x != null; x = parentOf(x)) {
                if (x == el) {
                    problems.add(where + "不能把 " + key + " 挪进它自己里面");
                    return;
                }
            }
            String boundary = entityBoundary(el, parent);
            if (boundary == null && el instanceof FilterColumnAp) boundary = misplaced(el.getClass().getSimpleName(), el, parent);
            if (boundary != null) {
                problems.add(where + boundary);
                return;
            }

            place(el, how, target, parent);
            targeted.add(key.toLowerCase());
        }

        /** 先从原来的容器里拿出来，再放进新容器；两边都按位置重排序号，和设计器一样。新加的控件「原来的容器」就是新容器。 */
        void place(ControlAp<?> el, String how, ControlAp<?> target, ControlAp<?> parent) {
            List<ControlAp<?>> old = children(parentOf(el));
            old.remove(el);
            renumber(old);
            List<ControlAp<?>> dest = children(parent);
            dest.remove(el);
            int at = how.equals("into") ? dest.size() : dest.indexOf(target) + (how.equals("after") ? 1 : 0);
            dest.add(at, el);
            el.setParentId(parent.getId());
            renumber(dest);
            syncFlatOrder(el, dest, at, parent);
        }

        /** 字段控件只能待在它的字段所在的那一层：表头字段不进分录，分录字段不出自己的分录。 */
        String entityBoundary(ControlAp<?> el, ControlAp<?> parent) {
            String destEntity = entityIdOf(parent);
            List<ControlAp<?>> all = new ArrayList<ControlAp<?>>();
            all.add(el);
            descendants(el, all);
            String rootId = em.getRootEntity().getId();
            for (ControlAp<?> c : all) {
                EntityItem<?> f = fieldOf(c);
                if (f == null) continue;
                String own = blank(f.getParentId()) ? rootId : f.getParentId();
                if (own.equals(destEntity)) continue;
                return c.getKey() + " 是" + (own.equals(rootId) ? "表头字段" : "分录 " + entityKey(own) + " 的字段") + "，"
                        + (destEntity.equals(rootId) ? "不能挪到分录外面" : "不能挪进分录 " + entityKey(destEntity));
            }
            return null;
        }

        String entityIdOf(ControlAp<?> c) {
            for (ControlAp<?> x = c; x != null; x = parentOf(x)) {
                if (x instanceof EntryAp) {
                    String id = ((EntryAp) x).getEntryId();
                    if (!blank(id)) return id;
                    for (EntityItem<?> it : em.getItems()) {
                        if (x.getKey().equalsIgnoreCase(it.getKey())) return it.getId();
                    }
                }
            }
            return em.getRootEntity().getId();
        }

        String entityKey(String id) {
            EntityItem<?> it = em.getItemById(id);
            return it == null ? id : it.getKey();
        }

        ControlAp<?> parentOf(ControlAp<?> c) {
            ControlAp<?> root = fm.getRootAp();
            if (c == root) return null;
            ControlAp<?> p = blank(c.getParentId()) ? null : byId.get(c.getParentId());
            return p == null ? root : p;
        }

        /** 一个容器下的直接子控件，按序号排。父节点没记或指向不存在的，算在最外层下面（和 FormLayoutProbe 一样）。 */
        List<ControlAp<?>> children(ControlAp<?> parent) {
            List<ControlAp<?>> out = new ArrayList<ControlAp<?>>();
            for (ControlAp<?> x : fm.getItems()) {
                if (x != fm.getRootAp() && parentOf(x) == parent) out.add(x);
            }
            Collections.sort(out, (a, b) -> Integer.compare(a.getIndex(), b.getIndex()));
            return out;
        }

        void descendants(ControlAp<?> c, List<ControlAp<?>> out) {
            for (ControlAp<?> k : children(c)) {
                out.add(k);
                descendants(k, out);
            }
        }

        static void renumber(List<ControlAp<?>> list) {
            for (int i = 0; i < list.size(); i++) {
                if (list.get(i).getIndex() != i) list.get(i).setIndex(i);
            }
        }

        /** 平板列表里也挪到新兄弟旁边（平台 syncFlatListOrder 同样的做法）。 */
        void syncFlatOrder(ControlAp<?> el, List<ControlAp<?>> siblings, int at, ControlAp<?> parent) {
            List<ControlAp<?>> flat = fm.getItems();
            flat.remove(el);
            int pos;
            if (at > 0) pos = flat.indexOf(siblings.get(at - 1)) + 1;
            else if (siblings.size() > 1) pos = flat.indexOf(siblings.get(1));
            else pos = flat.indexOf(parent) + 1;
            if (pos <= 0 || pos > flat.size()) flat.add(el);
            else flat.add(pos, el);
        }

        // ---------- add / remove 控件 ----------

        void addControl(String where, String spec) throws Exception {
            String[] parts = spec.split("\\s+", 5);
            if (parts.length < 4 || !(parts[2].equals("into") || parts[2].equals("before") || parts[2].equals("after"))) {
                problems.add(where + "要写成 add <控件类型> <新标识> into|before|after <目标> [名称]");
                return;
            }
            String type = parts[0];
            String key = parts[1];
            String how = parts[2];
            String name = parts.length > 4 ? parts[4].trim() : "";
            String bad = newKey(key, "控件");
            if (bad == null && (fm.getItemByKey(key) != null || element(key) != null)) bad = "这张单据上已经有 " + key + "，换一个标识";
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            DomainModelType dmt = DomainModelType.getDomainModelType(fm.getModelType(), true);
            if (!ControlApFactory.isSupported(type) || (dmt != null && dmt.getElementType(type) == null)) {
                String common = "mobilelist".equals(kind()) ? "LabelAp（标签）、ImageAp（图片）、VectorAp（图标）、ButtonAp（按钮）；卡片上的字段列用 show <字段> 放"
                        : "mobile".equals(kind()) ? "FlexPanelAp（Flex面板）、LabelAp（标签）、ImageAp（图片）、VectorAp（图标）、ButtonAp（按钮）、"
                                + "MBarItemAp（移动端工具栏按钮，放进 MToolbarAp）、AttachmentPanelAp（附件面板）"
                        : "FlexPanelAp（Flex面板）、FieldsetPanelAp（分组面板）、"
                                + "TabAp（页签）、TabPageAp（页签页，放进 TabAp）、AttachmentPanelAp（附件面板）、LabelAp（标签）、ButtonAp（按钮）、"
                                + "BarItemAp（工具栏按钮，放进 ToolbarAp）、HtmlAp、ImageAp";
                problems.add(where + (onBill() ? "这类单据" : part.title) + "的设计器里没有控件类型 " + type + "；常用的有 " + common);
                return;
            }
            ControlAp<?> ap = ControlApFactory.create(type);
            if (ap == null) {
                problems.add(where + "这个环境里加载不到控件类 " + type);
                return;
            }
            if ((ap instanceof FieldAp || ap instanceof EntryAp) && !onBill()) {
                problems.add(where + type + (ap instanceof EntryAp ? " 是卡片分录，到开发平台加" : " 是字段控件，用 show <字段> into|before|after <目标> 把字段放上来"));
                return;
            }
            if (ap instanceof FieldAp || ap instanceof EntryAp) {
                problems.add(where + type + (!(ap instanceof EntryAp) ? " 是字段控件，加字段用 add field，控件跟着建"
                        : type.equals("EntryAp") ? " 是分录，加分录用 add entry <新分录标识> into|before|after <目标> <名称>，分录面板、工具栏和业务表跟着建"
                        : " 是子分录或卡片分录，这里只加普通分录（add entry），这一类到开发平台建"));
                return;
            }
            ControlAp<?> target = fm.getItemByKey(parts[3]);
            if (target == null) {
                problems.add(where + missing(parts[3]));
                return;
            }
            ControlAp<?> parent = how.equals("into") ? target : parentOf(target);
            if (how.equals("into") && !(target instanceof ContainerAp)) {
                problems.add(where + parts[3] + " 是 " + target.getClass().getSimpleName() + "，不是容器；要放到它旁边用 before 或 after");
                return;
            }
            String misplaced = misplaced(type, ap, parent);
            if (misplaced != null) {
                problems.add(where + misplaced);
                return;
            }
            ap.setId(DBServiceHelper.genStringId());
            ap.setKey(key);
            ap.setName(new LocaleString(name.isEmpty() ? key : name));
            ap.setIsv(IsvGuard.ISV);
            ap.setParentId(parent.getId());
            fm.getItems().add(ap);
            byId.put(ap.getId(), ap);
            place(ap, how, target, parent);
            added.put(key.toLowerCase(), ap);
            targeted.add(key.toLowerCase());
            //不按索引找：强制重建索引会给顶层面板补父节点，规整之后再建就多出差异
            final String in = part.name;
            survive.add(() -> {
                if (dropped.contains(key.toLowerCase())) return null;
                FormMetadata now = partNow(in);
                for (ControlAp<?> c : now == null ? Collections.<ControlAp<?>>emptyList() : now.getItems()) {
                    if (key.equals(c.getKey())) return null;
                }
                return where + "平台保存前的规整把新控件 " + key + " 去掉了，这样放存不进去";
            });
        }

        /**
         * 平台自己加控件时的放置规则（ControlValidation：按设计器的元素类型定义看容器收不收这类控件，分录、工具栏只收各自的子控件）。
         * 工具栏按钮它另走一路，这里照平台：普通按钮只进工具栏，分录工具栏按钮只进分录工具栏。
         */
        /**
         * 设计器的元素类型定义收不收：容器才能放东西，容器的「不收」名单、「只收」名单（按类型或类型所属的大类），
         * 被放的元素自己的「只进」名单。和平台加控件校验里查元素类型定义那一步同一套（读平台代码确认），
         * 只多认一样：「只收」名单写的是大类（例如 Field）时，按被放元素所属的大类比。
         */
        String accepts(ControlAp<?> parent, String type) {
            DomainModelType dmt = DomainModelType.getDomainModelType(fm.getModelType(), true);
            String parentType = parent.getClass().getSimpleName();
            kd.bos.metadata.domainmodel.ElementType pet = dmt == null ? null : dmt.getElementType(parentType);
            if (pet == null) return null;
            String head = "平台不让把 " + type + " 放进 " + parent.getKey() + "（" + parentType + "）：";
            if (!pet.isContainer() && !(parent instanceof ContainerAp) && !"Container".equals(category(dmt, parentType))) {
                return head + "它不是容器";
            }
            if (strings(pet.getNotAccept(), "ids").contains(type)) return head + "它不收这一类";
            String base = category(dmt, type);
            List<String> ids = strings(pet.getAccept(), "ids");
            List<String> bases = strings(pet.getAccept(), "baseType", "basetypes");
            if ((!ids.isEmpty() || !bases.isEmpty()) && !ids.contains(type) && !bases.contains(type) && (base == null || !bases.contains(base))) {
                return head + "它只收 " + String.join("、", ids) + (bases.isEmpty() ? "" : "（或 " + String.join("、", bases) + " 类）");
            }
            kd.bos.metadata.domainmodel.ElementType cet = dmt.getElementType(type);
            List<String> up = strings(cet == null ? null : cet.getAcceptParent(), "ids");
            List<String> upBases = strings(cet == null ? null : cet.getAcceptParent(), "baseType", "basetypes");
            if ((!up.isEmpty() || !upBases.isEmpty()) && !up.contains(parentType) && !upBases.contains(parentType)) {
                return head + type + " 只能放进 " + String.join("、", up);
            }
            return null;
        }

        /** 元素类型所属的大类（Container、Field……）：设计器按大类分组列元素。 */
        static String category(DomainModelType dmt, String type) {
            kd.bos.metadata.domainmodel.ElementType et = dmt.getElementType(type);
            if (et != null && !blank(et.getBaseType())) return et.getBaseType();
            if (dmt.getCategories() == null) return null;
            for (kd.bos.metadata.domainmodel.Category c : dmt.getCategories()) {
                if (c == null || c.getElementTypes() == null) continue;
                for (kd.bos.metadata.domainmodel.ElementType e : c.getElementTypes()) {
                    if (e != null && type.equals(e.getId())) return c.getBaseType();
                }
            }
            return null;
        }

        static List<String> strings(Map<String, Object> m, String... keys) {
            List<String> out = new ArrayList<String>();
            if (m == null) return out;
            for (String k : keys) {
                if (!(m.get(k) instanceof List)) continue;
                for (Object o : (List<?>) m.get(k)) {
                    if (o != null && !out.contains(o.toString())) out.add(o.toString());
                }
            }
            return out;
        }

        String misplaced(String type, ControlAp<?> ap, ControlAp<?> parent) {
            if (ap instanceof FilterColumnAp && !(ap instanceof kd.bos.metadata.filter.SchemeFilterColumnAp)) {
                String wanted = ap instanceof CommonFilterColumnAp ? "FilterGridViewAp" : "FastSearchGridViewAp";
                return wanted.equals(parent.getClass().getSimpleName()) ? null
                        : type + " 只能放进" + (ap instanceof CommonFilterColumnAp ? "常用过滤（FilterGridViewAp）" : "快捷搜索（FastSearchGridViewAp）");
            }
            if (ap instanceof BarItemAp) {
                boolean adv = ap instanceof AdvConBarItemAp;
                boolean ok = adv ? parent instanceof AdvConToolbarAp : parent instanceof ToolbarAp && !(parent instanceof AdvConToolbarAp);
                return ok ? null : type + " 是工具栏按钮，只能放进" + (adv ? "分录工具栏（AdvConToolbarAp）" : "工具栏（ToolbarAp，单据主工具栏是 tbmain）")
                        + "，" + parent.getKey() + " 是 " + parent.getClass().getSimpleName();
            }
            //移动端布局的最外层：平台加控件的校验说它不是容器，开发平台设计器却能往上放面板（真机工程里的移动端布局就这样摆）。
            //照设计器：最外层直接放容器，别的控件放进容器里
            if (!onBill() && parent == fm.getRootAp()) {
                DomainModelType dmt = DomainModelType.getDomainModelType(fm.getModelType(), true);
                kd.bos.metadata.domainmodel.ElementType et = dmt == null ? null : dmt.getElementType(type);
                boolean container = ap instanceof ContainerAp || et != null && et.isContainer() || dmt != null && "Container".equals(category(dmt, type));
                return container ? null : part.title + "的最外层只直接放面板这类容器，" + type + " 放进容器里（没有合适的就先 add FlexPanelAp 放在最外层）";
            }
            //字段控件、列表列不在平台加控件的工厂里，它的校验一上来就拒；照它校验里按设计器元素类型定义查的那一步自己查
            if (!ControlApFactory.isSupported(type)) return accepts(parent, type);
            ControlValidation.ValidationResult r = ControlValidation.validate(fm, parent.getKey(), type);
            if (r.isAllowed()) return null;
            //容器不收这一类时，平台理由后面附着设计器全部 200 多种控件类型，和这次放置无关
            String why = r.getReason() == null ? "" : r.getReason().replaceAll("\\.?\\s*Supported types:\\s*\\[.*", "");
            return "平台不让把 " + type + " 放进 " + parent.getKey() + "（" + parent.getClass().getSimpleName() + "）：" + clip(why, 200);
        }

        void removeControl(String where, String key) {
            ControlAp<?> el = fm.getItemByKey(key);
            if (el == null) {
                problems.add(where + (onBill() && element(key) != null ? key + " 是字段，删字段用 remove field " + key : missing(key)));
                return;
            }
            if (el == fm.getRootAp()) {
                problems.add(where + key + " 是整张单据的最外层，删不了");
                return;
            }
            List<ControlAp<?>> all = new ArrayList<ControlAp<?>>();
            all.add(el);
            descendants(el, all);
            //移动端那两份上的字段控件、卡片分录只是把字段摆出来：撤下控件，字段和数据都不动
            boolean view = !onBill();
            for (ControlAp<?> c : all) {
                String in = c == el ? "" : "，它在 " + key + " 里面，先把它挪出去";
                if (c.isInherit()) {
                    problems.add(where + c.getKey() + " 是模板或标准产品带来的控件，删不了" + (c == el ? "；不想让人看见就改它的 Visible" : in));
                    return;
                }
                if (view) continue;
                if (c instanceof EntryAp) {
                    problems.add(where + c.getKey() + " 是分录，这个入口不删分录" + in);
                    return;
                }
                if (c instanceof FieldAp) {
                    problems.add(where + c.getKey() + " 是字段，删字段用 remove field " + c.getKey() + in);
                    return;
                }
            }
            ControlAp<?> parent = parentOf(el);
            fm.getItems().removeAll(all);
            for (ControlAp<?> c : all) {
                byId.remove(c.getId());
                added.remove(c.getKey().toLowerCase());
                dropped.add(c.getKey().toLowerCase());
                //撤下字段显示不删字段；筛选条件、其他布局和插件仍可按字段标识取值，不能把这些当成对已撤控件的引用。
                if (!(view && (c instanceof FieldAp || c instanceof EntryAp || c instanceof ListColumnAp))) removed.add(new String[] {"控件", c.getKey(), c.getId()});
            }
            renumber(children(parent));
            targeted.add(key.toLowerCase());
        }

        /**
         * show <字段> into|before|after <目标>：把已有字段摆到电脑端列表、移动端布局或移动端列表上，字段本身不动。
         *
         * 和开发平台移动端设计器建的一样（读平台设计器代码确认）：移动端布局上是一个字段控件，标识、名称取字段的，FieldId 指向字段；
         * 分录字段是卡片分录（CardEntryAp）里的 CardEntryFieldAp。移动端列表上是一列，类型是电脑端列表这一列的类型前面加 Card
         * （平台按字段算列类型的 getlistFieldTree），ListFieldId 是列表字段树上的标识（分录字段是「分录.字段」）。
         */
        void showField(String where, String spec) throws Exception {
            String[] parts = spec.split("\\s+");
            boolean named = parts.length == 5 && "as".equals(parts[1]);
            int howAt = named ? 3 : 1;
            if ((!named && parts.length != 3) || !isHow(parts[howAt])) {
                problems.add(where + "要写成 show <字段路径> [as <新控件标识>] into|before|after <目标>");
                return;
            }
            String key = parts[0];
            String how = parts[howAt];
            String k = kind();
            if ("bill".equals(k)) {
                problems.add(where + "show 用在列表、移动端布局和移动端列表上（先写 layout list、layout mobile 或 layout mobilelist）；"
                        + (em.getFieldByKey(key) == null ? "需要新字段时用 add field 或 copy field" : "字段 " + key + " 已在实体上，不要重复 add field 或 copy field；已有电脑端控件用 move 调位置"));
                return;
            }
            Field<?> f = em.getFieldByKey(key);
            boolean column = "list".equals(k) || "mobilelist".equals(k);
            if (!column && (f == null || named)) {
                problems.add(where + (named ? "as 只用于列表列" : element(key) != null ? key + " 是分录，不是字段" : "这张单据没有字段 " + key));
                return;
            }
            String targetKey = parts[howAt + 1];
            ControlAp<?> target = fm.getItemByKey(targetKey);
            if (target == null) {
                problems.add(where + missing(targetKey));
                return;
            }
            if (how.equals("into") && !(target instanceof ContainerAp)) {
                problems.add(where + targetKey + " 是 " + target.getClass().getSimpleName() + "，不是容器；要放到它旁边用 before 或 after");
                return;
            }
            ControlAp<?> parent = how.equals("into") ? target : parentOf(target);
            ControlAp<?> ap = column ? listColumn(where, key, named ? parts[2] : null) : fieldControl(where, f, parent);
            if (ap == null) return;
            ap.setId(DBServiceHelper.genStringId());
            ap.setIsv(IsvGuard.ISV);
            ap.setParentId(parent.getId());
            String bad = entityBoundary(ap, parent);
            if (bad == null) bad = misplaced(ap.getClass().getSimpleName(), ap, parent);
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            fm.getItems().add(ap);
            byId.put(ap.getId(), ap);
            place(ap, how, target, parent);
            String apKey = ap.getKey();
            added.put(apKey.toLowerCase(), ap);
            targeted.add(apKey.toLowerCase());
            final String in = part.name;
            final String title = part.title;
            survive.add(() -> {
                if (dropped.contains(apKey.toLowerCase())) return null;
                FormMetadata now = partNow(in);
                if (now != null) {
                    for (ControlAp<?> c : now.getItems()) {
                        if (apKey.equals(c.getKey())) return null;
                    }
                }
                return where + "平台保存前的规整把" + title + "上新放的 " + key + " 去掉了，这样放存不进去";
            });
        }

        /** 从设计器的字段树创建筛选项，控件自己的 setProperties 带入字段路径、类型、选项和基础资料设置。 */
        void showFilter(String where, String spec) throws Exception {
            String[] args = spec.split("\\s+");
            if (args.length != 5 || !"as".equals(args[1]) || !isHow(args[3])) {
                problems.add(where + "要写成 show filter <字段路径> as <新标识> into|before|after <目标>");
                return;
            }
            if (!"list".equals(kind())) {
                problems.add(where + "常用过滤和快捷搜索的字段配置写在 layout list 下");
                return;
            }
            String field = args[0];
            String key = args[2];
            String bad = newKey(key, "筛选控件");
            if (bad == null && (fm.getItemByKey(key) != null || element(key) != null)) bad = "这张布局上已经有 " + key + "，换一个标识";
            if (bad != null) { problems.add(where + bad); return; }
            ControlAp<?> target = fm.getItemByKey(args[4]);
            if (target == null) { problems.add(where + missing(args[4])); return; }
            ControlAp<?> parent = "into".equals(args[3]) ? target : parentOf(target);
            String parentType = parent == null ? "" : parent.getClass().getSimpleName();
            boolean common = "FilterGridViewAp".equals(parentType);
            if (!common && !"FastSearchGridViewAp".equals(parentType)) {
                problems.add(where + "筛选字段只能放进常用过滤（FilterGridViewAp）或快捷搜索（FastSearchGridViewAp），用 FormLayoutProbe LAYOUT_PART=list 查容器");
                return;
            }
            Map<String, Object> node = filterNode(EntityMetadataUtil.getlistFieldTree(em, 3, false, true), field);
            if (node == null) {
                problems.add(where + field + " 不在平台可用过滤字段清单上；用 FormLayoutProbe LAYOUT_FILTER_FIELDS=1 查完整字段路径");
                return;
            }
            String type = str(node.get(common ? "CommonFilterApType" : "FilterApType"));
            DomainModelType dmt = DomainModelType.getDomainModelType(fm.getModelType(), true);
            kd.bos.metadata.domainmodel.ElementType et = dmt == null ? null : dmt.getElementType(type);
            Object made = et == null || et.getDataEntityType() == null ? null : et.getDataEntityType().createInstance();
            if (!(made instanceof FilterColumnAp) || common != (made instanceof CommonFilterColumnAp)) {
                problems.add(where + field + " 在平台字段树上没有可用于" + (common ? "常用过滤" : "快捷搜索") + "的控件类型，不支持该字段");
                return;
            }
            FilterColumnAp ap = (FilterColumnAp) made;
            ap.setProperties(node);
            if (ap instanceof CommonFilterColumnAp && "enum".equals(node.get("DataType"))) {
                List<ComboItem> options = filterOptions(ap.getFieldName());
                if (options.isEmpty()) {
                    problems.add(where + field + " 的枚举选项没有查到，不添加没有选项的筛选项");
                    return;
                }
                ((CommonFilterColumnAp) ap).setComboItems(options);
            }
            if (blank(ap.getFieldName())) { problems.add(where + "平台没有给 " + field + " 生成过滤字段绑定，不添加空筛选项"); return; }
            for (ControlAp<?> c : children(parent)) {
                if (c instanceof FilterColumnAp && ap.getFieldName().equalsIgnoreCase(((FilterColumnAp) c).getFieldName())) {
                    problems.add(where + field + " 已经在这份过滤视图里（控件 " + c.getKey() + "）；改属性用 set，调顺序用 move");
                    return;
                }
            }
            bad = misplaced(type, ap, parent);
            if (bad != null) { problems.add(where + bad); return; }
            ap.setId(DBServiceHelper.genStringId());
            ap.setKey(key);
            ap.setName(new LocaleString(str(node.get("Name"))));
            ap.setIsv(IsvGuard.ISV);
            ap.setParentId(parent.getId());
            fm.getItems().add(ap);
            byId.put(ap.getId(), ap);
            place(ap, args[3], target, parent);
            added.put(key.toLowerCase(), ap);
            targeted.add(key.toLowerCase());
            final String binding = ap.getFieldName();
            survive.add(() -> {
                if (dropped.contains(key.toLowerCase())) return null;
                FormMetadata now = nested("list");
                ControlAp<?> kept = now == null ? null : now.getItemByKey(key);
                return kept instanceof FilterColumnAp && binding.equals(((FilterColumnAp) kept).getFieldName())
                        ? null : where + "平台保存前的规整没有保留筛选项 " + key + " 的字段绑定，这样存不进去";
            });
        }

        @SuppressWarnings("unchecked")
        static Map<String, Object> filterNode(Map<String, Object> tree, String field) {
            if (tree == null) return null;
            if (field.equalsIgnoreCase(str(tree.get("Id"))) && (tree.containsKey("FilterApType") || tree.containsKey("CommonFilterApType"))) return tree;
            Object items = tree.get("Items");
            if (items instanceof List) for (Object item : (List<?>) items) {
                if (!(item instanceof Map)) continue;
                Map<String, Object> found = filterNode((Map<String, Object>) item, field);
                if (found != null) return found;
            }
            return null;
        }

        List<Map<String, Object>> filterValues;
        List<ComboItem> filterOptions(String field) {
            if (filterValues == null) filterValues = new EntityMetadataUtil().getFilterColumns(em);
            List<ComboItem> out = new ArrayList<ComboItem>();
            for (Map<String, Object> row : filterValues) {
                if (!field.equalsIgnoreCase(str(row.get("fieldName")))) continue;
                Object items = row.get("items");
                if (!(items instanceof List)) continue;
                for (Object item : (List<?>) items) {
                    if (!(item instanceof ValueMapItem)) continue;
                    ValueMapItem value = (ValueMapItem) item;
                    out.add(new ComboItem(out.size(), value.getName(), value.getValue()));
                }
            }
            return out;
        }

        /** 枚举缺省值必须来自实际选项；在整份清单之后查，多选设置的先后顺序不影响结果。 */
        void checkFilters() {
            FormMetadata list = nested("list");
            if (list == null) return;
            for (ControlAp<?> c : list.getItems()) {
                if (!(c instanceof CommonFilterColumnAp) || !targeted.contains(c.getKey().toLowerCase())) continue;
                CommonFilterColumnAp f = (CommonFilterColumnAp) c;
                if (blank(f.getDefValue()) || f.getComboItems() == null || f.getComboItems().isEmpty()) continue;
                Set<String> values = new HashSet<String>();
                for (ComboItem item : f.getComboItems()) values.add(item.getValue());
                for (String v : f.isMulti() ? f.getDefValue().split(",", -1) : new String[] {f.getDefValue()}) {
                    if (!values.contains(v.trim())) problems.add("筛选项 " + c.getKey() + " 的缺省值「" + v + "」不在字段选项中");
                }
            }
        }

        /** 移动端布局上的字段控件：表头字段是 FieldAp，分录字段是卡片分录里的 CardEntryFieldAp。已经摆着的不重复摆。 */
        ControlAp<?> fieldControl(String where, Field<?> f, ControlAp<?> parent) {
            for (ControlAp<?> c : fm.getItems()) {
                if (c instanceof FieldAp && (f.getId().equals(((FieldAp) c).getFieldId()) || f.getKey().equalsIgnoreCase(c.getKey()))) {
                    problems.add(where + f.getKey() + " 已经在" + part.title + "上了（控件 " + c.getKey() + "）；换位置用 move");
                    return null;
                }
            }
            String rootId = em.getRootEntity().getId();
            boolean head = blank(f.getParentId()) || rootId.equals(f.getParentId());
            if (!head && !f.getParentId().equals(entityIdOf(parent))) {
                List<String> cards = new ArrayList<String>();
                for (ControlAp<?> c : fm.getItems()) {
                    if (c instanceof EntryAp && f.getParentId().equals(entityIdOf(c))) cards.add(c.getKey());
                }
                problems.add(where + f.getKey() + " 是分录 " + entityKey(f.getParentId()) + " 的字段，要放进这个分录的卡片分录里"
                        + (cards.isEmpty() ? "；" + part.title + "上还没有它的卡片分录，到开发平台加" : "（" + String.join("、", cards) + "）"));
                return null;
            }
            FieldAp ap = head ? new FieldAp() : new CardEntryFieldAp();
            ap.setKey(f.getKey());
            ap.setName(f.getName() == null ? new LocaleString(f.getKey()) : f.getName());
            ap.setFieldId(f.getId());
            return ap;
        }

        /** 列表的一列：平台字段树给电脑端类型，移动端卡片类型前面加 Card，标识用字段标识。 */
        ControlAp<?> listColumn(String where, String requested, String alias) throws Exception {
            Map<String, Object> tree = EntityMetadataUtil.getlistFieldTree(em, 3, false, true);
            Field<?> f = em.getFieldByKey(requested);
            if (f == null && requested.contains(".")) {
                Field<?> candidate = em.getFieldByKey(requested.substring(requested.lastIndexOf('.') + 1));
                if (candidate != null && requested.equalsIgnoreCase(fieldPath(candidate))) f = candidate;
            }
            String path = requested;
            if (f instanceof BasedataField || f instanceof MulBasedataField) {
                String baseId = f instanceof BasedataField ? ((BasedataField) f).getBaseEntityId() : ((MulBasedataField) f).getBaseEntityId();
                EntityMetadata base = (EntityMetadata) MetadataDao.readMeta(baseId, MetaCategory.Entity);
                MainEntityType runtime = EntityMetadataCache.getDataEntityType(base.getKey());
                String display = runtime instanceof BasedataEntityType ? ((BasedataEntityType) runtime).getNameProperty() : null;
                if (blank(display)) {
                    problems.add(where + requested + " 的基础资料没有配置名称字段；用 FormLayoutProbe LAYOUT_LIST_FIELDS=1 查可用的完整字段路径后选择");
                    return null;
                }
                path = fieldPath(f) + "." + display;
            }
            Map<String, Object> node = listNode(tree, path);
            if (node == null) {
                List<String> choices = new ArrayList<String>();
                String prefix = requested.contains(".") ? requested.substring(0, requested.lastIndexOf('.')) : requested;
                for (Map<String, Object> candidate : FormLayoutProbe.columnNodes(tree)) {
                    String id = str(candidate.get("Id"));
                    if (id.startsWith(prefix + ".") || id.endsWith("." + requested)) choices.add(id);
                }
                problems.add(where + requested + " 不在平台给列表用的字段清单上，或路径不唯一"
                        + (choices.isEmpty() ? "" : "；可选路径：" + String.join("、", choices))
                        + "；用 FormLayoutProbe LAYOUT_LIST_FIELDS=1 查完整字段路径，已有字段不用重复新建");
                return null;
            }
            String id = str(node.get("Id"));
            String key = alias == null ? requested.replace('.', '_') : alias;
            String keyProblem = alias == null ? null : newKey(alias, "列控件");
            if (keyProblem != null) { problems.add(where + keyProblem); return null; }
            for (ControlAp<?> c : fm.getItems()) {
                if (c instanceof ListColumnAp && id.equalsIgnoreCase(((ListColumnAp) c).getListFieldId())) {
                    problems.add(where + requested + " 已经在" + part.title + "上了（列 " + c.getKey() + "，绑定 " + id + "）；换位置用 move");
                    return null;
                }
            }
            if (fm.getItemByKey(key) != null) {
                problems.add(where + part.title + "上已经有控件叫 " + key + "；用 show " + requested + " as <本开发商前缀的新控件标识> into <容器> 另起标识");
                return null;
            }
            String type = ("mobilelist".equals(kind()) ? "Card" : "") + str(node.get("Type"));
            DomainModelType dmt = DomainModelType.getDomainModelType(fm.getModelType(), true);
            kd.bos.metadata.domainmodel.ElementType et = dmt == null ? null : dmt.getElementType(type);
            Object made = et == null || et.getDataEntityType() == null ? null : et.getDataEntityType().createInstance();
            if (!(made instanceof ListColumnAp)) {
                problems.add(where + requested + " 在列表上是 " + node.get("Type") + "，" + part.title + "没有对应的列（" + type + "），放不上去");
                return null;
            }
            ListColumnAp col = (ListColumnAp) made;
            col.setKey(key);
            col.setName(f != null && f.getName() != null ? f.getName() : new LocaleString(str(node.get("Name"))));
            col.setListFieldId(id);
            return col;
        }

        /** 列表字段树里这个字段的那一项：表头字段的 Id 是字段标识，分录字段是「分录.字段」。 */
        static Map<String, Object> listNode(Map<String, Object> tree, String key) {
            Map<String, Object> found = null;
            int matches = 0;
            for (Map<String, Object> node : FormLayoutProbe.columnNodes(tree)) {
                String id = str(node.get("Id"));
                if (id.equalsIgnoreCase(key)) return node;
                if (!key.contains(".") && id.toLowerCase().endsWith("." + key.toLowerCase())) {
                    found = node;
                    matches++;
                }
            }
            return matches == 1 ? found : null;
        }

        String fieldPath(Field<?> field) {
            String parent = field.getParentId();
            return blank(parent) || parent.equals(em.getRootEntity().getId()) ? field.getKey() : entityKey(parent) + "." + field.getKey();
        }

        static boolean isHow(String how) {
            return how.equals("into") || how.equals("before") || how.equals("after");
        }

        /** 平台校验的结论：通过返回 null，不通过返回理由。 */
        static String check(ControlValidation.ValidationResult r) {
            return r.isAllowed() ? null : r.getReason();
        }

        /** 新标识：平台的标识规则，再加上要带本 ISV 的前缀——和标准产品、模板带来的东西一眼分开，删的时候也靠它认。 */
        String newKey(String key, String what) {
            if (!key.matches("[a-z][a-z0-9_]*")) return "新" + what + "标识 " + key + " 只能用小写字母、数字、下划线，字母开头";
            if (!key.startsWith(IsvGuard.PREFIX)) return "新" + what + "标识 " + key + " 要带 " + IsvGuard.PREFIX + " 前缀";
            return null;
        }

        // ---------- 分录 ----------

        /**
         * add entry <新分录标识> into|before|after <目标> <名称>：加一个普通分录（单据体）。
         *
         * 建出来的和单据模板自带的那个分录、平台自己加分录（EntityOperationHandler.applyAddEntity）是同一副样子：
         * 分录面板（AdvConAp）里摘要容器、工具栏、子容器三样，工具栏上增行、删行两个按钮各绑一个操作，子容器里是分录表格。
         * 差别只在标识：模板那套叫 advconap、tb_new、newentry，一张单据只能有一套；这里全部从分录标识派生，带本 ISV 前缀。
         * 表名 tk_<标识>：分录标识带 ISV 前缀，正好是平台要的 tk_<开发商标识>_ 开头（TableNameUpdateValue.checkTableName）。
         * 落库时平台见表不在就建（AlterTableUtil.createTable），在就只补缺的列。
         */
        void addEntry(String where, String spec) throws Exception {
            String[] parts = spec.split("\\s+", 4);
            if (parts.length < 4 || !isHow(parts[1])) {
                problems.add(where + "要写成 add entry <新分录标识> into|before|after <目标> <名称>");
                return;
            }
            String key = parts[0];
            String how = parts[1];
            String name = parts[3].trim();
            String table = "tk_" + key;
            String[] controls = {key, key + "_adv", key + "_advsum", key + "_advbar", key + "_advbody", key + "_new", key + "_del"};
            String newOp = key + "_newentry";
            String delOp = key + "_deleteentry";
            String bad = newKey(key, "分录");
            for (String k : controls) {
                if (bad == null && (fm.getItemByKey(k) != null || element(k) != null)) bad = "这张单据上已经有 " + k + "，换一个分录标识";
            }
            for (String k : new String[] {newOp, delOp}) {
                if (bad == null && findOp(k) != null) bad = "这张单据上已经有操作 " + k + "，换一个分录标识";
            }
            //留两位给多语言表（<表名>_L）；Oracle 的标识上限是 30
            if (bad == null && table.length() > 28) bad = "分录的表名 " + table + " 超过 28 个字符，换短一点的标识";
            Set<String> types = bad == null ? opTypes() : null;
            if (bad == null && (types == null || !types.contains("newentry") || !types.contains("deleteentry"))) {
                bad = "这张单据用不了增行、删行这两类操作（newentry、deleteentry），分录加不了";
            }
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            ControlAp<?> target = fm.getItemByKey(parts[2]);
            if (target == null) {
                problems.add(where + missing(parts[2]));
                return;
            }
            if (how.equals("into") && !(target instanceof ContainerAp)) {
                problems.add(where + parts[2] + " 是 " + target.getClass().getSimpleName() + "，不是容器；要放到它旁边用 before 或 after");
                return;
            }
            ControlAp<?> parent = how.equals("into") ? target : parentOf(target);
            if (parent == null) {
                problems.add(where + parts[2] + " 是整张单据的最外层，分录只能放进它里面（into）");
                return;
            }
            if (!entityIdOf(parent).equals(em.getRootEntity().getId())) {
                problems.add(where + parent.getKey() + " 在分录 " + entityKey(entityIdOf(parent)) + " 里面；分录里再放分录是子分录，到开发平台建");
                return;
            }
            AdvConAp adv = new AdvConAp();
            String misplaced = misplaced("AdvConAp", adv, parent);
            if (misplaced != null) {
                problems.add(where + "分录放在分录面板（AdvConAp）里，" + misplaced);
                return;
            }
            Boolean reused = tableTaken(where, table);
            if (reused == null) return;

            String id = DBServiceHelper.genStringId();
            EntryEntity entry = new EntryEntity();
            entry.setId(id);
            entry.setKey(key);
            entry.setName(new LocaleString(name));
            entry.setTableName(table);
            entry.setParentId(em.getRootEntity().getId());
            entry.setIsv(IsvGuard.ISV);
            entry.setEntityMetadata(em);
            entityItems().add(entry);

            Operation add = new Operation();
            add.setId(Uuid16.create().toString());
            add.setKey(newOp);
            add.setName(new LocaleString("新增分录"));
            add.setOperationType("newentry");
            NewEntryParameter addParam = new NewEntryParameter();
            addParam.setEntryId(id);
            add.setParameter(addParam);
            add.setIsv(IsvGuard.ISV);
            operations().add(add);
            Operation del = new Operation();
            del.setId(Uuid16.create().toString());
            del.setKey(delOp);
            del.setName(new LocaleString("删除分录"));
            del.setOperationType("deleteentry");
            EntryOpParameter delParam = new EntryOpParameter();
            delParam.setEntryId(id);
            del.setParameter(delParam);
            del.setIsv(IsvGuard.ISV);
            operations().add(del);

            //下面这些属性值照平台加分录时设的（EntityOperationHandler.createAdvConChain），和模板自带的那个分录一样
            adv.setCollapsible(true);
            adv.setBackColor("#ffffff");
            adv.setGrow(0);
            adv.setShrink(0);
            Style style = new Style();
            Margin margin = new Margin();
            margin.setTop("10px");
            style.setMargin(margin);
            adv.setStyle(style);
            child(adv, controls[1], name, parent, 0);
            place(adv, how, target, parent);
            child(new AdvConSummaryPanelAp(), controls[2], "高级面板摘要容器", adv, 0);
            AdvConToolbarAp bar = new AdvConToolbarAp();
            child(bar, controls[3], "高级面板工具栏", adv, 1);
            AdvConChildPanelAp body = new AdvConChildPanelAp();
            body.setDirection("column");
            body.setWrap(false);
            body.setAlignItems("stretch");
            child(body, controls[4], "高级面板子容器", adv, 2);
            AdvConBarItemAp addBtn = new AdvConBarItemAp();
            addBtn.setOperationKey(newOp);
            addBtn.setOperationStyle(Integer.valueOf(0));
            child(addBtn, controls[5], "增行", bar, 0);
            AdvConBarItemAp delBtn = new AdvConBarItemAp();
            delBtn.setOperationKey(delOp);
            delBtn.setOperationStyle(Integer.valueOf(0));
            child(delBtn, controls[6], "删行", bar, 1);
            //分录表格和分录实体同一个 id，平台按它把两边对上
            EntryAp grid = new EntryAp();
            grid.setId(id);
            grid.setEntryId(id);
            grid.setShowSeq(true);
            grid.setShowSelChexkbox(true);
            grid.setEntry(entry);
            child(grid, key, name, body, 0);

            addedEntries.put(entry, reused);
            entityTouched = true;
            fieldTargets.add(key);
            ownOps.add(newOp);
            ownOps.add(delOp);
            survive.add(() -> {
                boolean inEntity = false;
                boolean inForm = false;
                for (EntityItem<?> it : em.getItems()) inEntity |= key.equals(it.getKey());
                for (ControlAp<?> c : bill.getItems()) inForm |= key.equals(c.getKey());
                return inEntity && inForm && findOp(newOp) != null && findOp(delOp) != null ? null
                        : where + "平台保存前的规整把新分录 " + key + " 的" + (!inEntity ? "实体" : !inForm ? "表格" : "增行删行操作") + "去掉了，这样放存不进去";
            });
        }

        /** 新分录带出来的一个控件：标识、名称、挂在谁下面、排第几。分录表格的 id 进来前已经设好（和实体同一个）。 */
        void child(ControlAp<?> ap, String key, String name, ControlAp<?> parent, int index) {
            if (blank(ap.getId())) ap.setId(DBServiceHelper.genStringId());
            ap.setKey(key);
            ap.setName(new LocaleString(name));
            ap.setIsv(IsvGuard.ISV);
            ap.setParentId(parent.getId());
            if (index > 0) ap.setIndex(index);
            fm.getItems().add(ap);
            byId.put(ap.getId(), ap);
            added.put(key.toLowerCase(), ap);
            targeted.add(key.toLowerCase());
        }

        /**
         * 新分录的表名有没有人占着：这张单据别的分录在用、别的单据的元数据里写着它，都拒——两个分录共用一张表，行会串。
         * 库里有这张表、但没有哪份元数据在用（以前建过同名分录、后来退回了，表留了下来）：接着用，返回 true。
         * 表不在返回 false；拒了或者查不成返回 null（问题已经记下）。
         */
        Boolean tableTaken(String where, String table) {
            for (EntityItem<?> it : em.getItems()) {
                if (it instanceof Entity && table.equalsIgnoreCase(((Entity<?, ?>) it).getTableName())) {
                    problems.add(where + "这张单据的 " + it.getKey() + " 已经在用表 " + table + "，换一个分录标识");
                    return null;
                }
            }
            final List<String> users = new ArrayList<String>();
            try {
                if (!DB.exitsTable(DBRoute.of(em.getDBRouteKey()), table)) return Boolean.FALSE;
                //设计态元数据是一份 XML，表名写在 <TableName> 里
                DB.query(DBRoute.meta, "/*dialect*/select FNUMBER from t_meta_entitydesign where (FDATA like ? or FDATA like ?) and FID <> ?",
                        new Object[]{"%>" + table + "<%", "%>" + table.toUpperCase() + "<%", em.getId()},
                        (ResultSetHandler<Object>) rs -> {
                            while (rs.next()) users.add(rs.getString(1));
                            return null;
                        });
            } catch (Throwable e) {
                problems.add(where + "核对不了表 " + table + " 有没有人在用（" + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage())
                        + "），没法确认新分录不会和别的单据共用一张表");
                return null;
            }
            if (users.isEmpty()) return Boolean.TRUE;
            problems.add(where + "表 " + table + " 已经是 " + clip(String.join("、", users), 200) + " 的表，两个分录共用一张表行会串；换一个分录标识");
            return null;
        }

        /**
         * 多选基础资料的关系表：选中的值一行一个存在这里（行内码 FPKID、单据或分录内码、基础资料内码 FBasedataId 三列）。
         * 表名空着平台不建表，字段读回来是空集合、保存单据时序列化报空指针；开发平台保存时拦「表名不能为空」，平台的保存服务不拦。
         * 没给表名用 tk_<字段标识>（字段标识带 ISV 前缀，正好是平台要的 tk_<开发商标识>_ 开头）。
         */
        boolean relationTable(String where, MulBasedataField f, String explicit) {
            boolean derived = blank(explicit);
            String table = derived ? "tk_" + f.getKey() : explicit.trim();
            String bad = relationTableProblem(f, table);
            if (bad != null) {
                problems.add(where + bad + (derived ? "；用 table=<表名> 另起一个" : ""));
                return false;
            }
            f.setTableName(table);
            relationTables.put(f.getKey(), table);
            return true;
        }

        /**
         * 关系表名能不能用。平台落库时只在表不存在时建（AlterTableUtil.genAlertMulBsdTableSQL），表在就一列不补、原有的行也不清；
         * 建表时拼索引名 idx_<表名去掉 tk>_fk，Oracle 的标识上限是 30，表名就不能超过 25 个字符。
         */
        String relationTableProblem(EntityItem<?> self, String table) {
            String prefix = "tk_" + IsvGuard.PREFIX;
            if (!table.matches("[A-Za-z][A-Za-z0-9_]*")) return "关系表名「" + table + "」只能用字母、数字、下划线，字母开头";
            if (!table.toLowerCase().startsWith(prefix)) return "关系表名 " + table + " 要以 " + prefix + " 开头（平台的表名规范 tk_<开发商标识>_…）";
            if (table.length() > 25) {
                return "关系表名 " + table + " 有 " + table.length() + " 个字符，超过 25：平台建表时拼的索引名 idx_<表名去掉 tk>_fk 会超过 Oracle 的 30 个字符";
            }
            for (EntityItem<?> it : em.getItems()) {
                if (it == self) continue;
                String used = it instanceof Entity ? ((Entity<?, ?>) it).getTableName()
                        : it instanceof MulBasedataField ? ((MulBasedataField) it).getTableName() : null;
                if (table.equalsIgnoreCase(used)) return "这张单据的 " + it.getKey() + " 已经在用表 " + table + "，换一个表名";
            }
            for (Map.Entry<String, String> e : relationTables.entrySet()) {
                if (!e.getKey().equalsIgnoreCase(self.getKey()) && table.equalsIgnoreCase(e.getValue())) {
                    return "这份清单里 " + e.getKey() + " 已经用了表 " + table + "，换一个表名";
                }
            }
            try {
                if (!DB.exitsTable(DBRoute.of(em.getDBRouteKey()), table)) return null;
            } catch (Throwable e) {
                return "核对不了库里有没有表 " + table + "（" + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()) + "）";
            }
            return "库里已经有表 " + table + "：关系表平台只在不存在时新建，已有的表不补列、原有的行也留着，选的值会和别人的混在一起；换一个没用过的表名";
        }

        // ---------- 字段 ----------

        /**
         * 这里能加的字段类型：平台建出来就完整，或者只差 base=、items=、currency= 这几样。
         * 别的（数量配单位、单选配组、公式、弹性域……）要配关联字段，到开发平台配。
         */
        /**
         * 平台建字段的工具类第一次加载时，按本环境没有的人力字段类各打一行警告（Class not found …），和这次改动无关。
         * 父日志调到只报严重错误；引用存成静态字段，日志对象没人引用会被回收、设置跟着丢。
         */
        static final java.util.logging.Logger CREATOR_LOG = quiet("kd.bos.designer.ai.service");

        static java.util.logging.Logger quiet(String name) {
            java.util.logging.Logger log = java.util.logging.Logger.getLogger(name);
            log.setLevel(java.util.logging.Level.SEVERE);
            return log;
        }

        static final List<String> FIELD_TYPES = Arrays.asList("TextField", "TextAreaField", "LargeTextField", "MuliLangTextField",
                "IntegerField", "BigIntField", "DecimalField", "AmountField", "PriceField", "DateField", "TimeField", "DateTimeField",
                "CheckBoxField", "ComboField", "MulComboField", "BasedataField", "MulBasedataField", "UserField", "OrgField",
                "EmailField", "TelephoneField", "PictureField");

        /** add field <字段类型> <新标识> into|before|after <目标> <名称> [base=…] [items=…] [currency=…] [table=…] */
        void addField(String where, String spec) throws Exception {
            String[] parts = spec.split("\\s+");
            if (parts.length < 5 || !isHow(parts[2])) {
                problems.add(where + "要写成 add field <字段类型> <新标识> into|before|after <目标> <名称>"
                        + " [base=<基础资料>] [items=<值:名称,…>] [currency=<币别字段>] [table=<关系表>]");
                return;
            }
            String type = parts[0];
            String key = parts[1];
            Map<String, String> opts = new LinkedHashMap<String, String>();
            List<String> name = new ArrayList<String>();
            for (int i = 4; i < parts.length; i++) {
                int eq = parts[i].indexOf('=');
                String k = eq > 0 ? parts[i].substring(0, eq) : "";
                if (k.equals("base") || k.equals("items") || k.equals("currency") || k.equals("table")) opts.put(k, parts[i].substring(eq + 1));
                else name.add(parts[i]);
            }
            if (name.isEmpty()) {
                problems.add(where + "少了字段名称");
                return;
            }
            String col = "fk_" + key;
            String bad = freshField(key);
            if (bad == null && col.length() > 30) bad = "数据库列名 " + col + " 超过 30 个字符（Oracle 的上限），换短一点的标识";
            if (bad == null && !FIELD_TYPES.contains(type)) {
                bad = "这里加不了字段类型 " + type + "；能加的有 " + String.join("、", FIELD_TYPES)
                        + "。基础资料用 base=<基础资料标识>，下拉用 items=<值:名称,…>，金额用 currency=<币别字段>，多选基础资料的关系表用 table=<表名>，长度、精度、必录加完用 set 改";
            }
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            Slot at = slot(where, parts[2], parts[3]);
            if (at == null) return;
            String why = check(FieldValidation.canAddField(em, fm, key, type, col, at.entry));
            if (why != null) {
                problems.add(where + "平台不让加：" + why);
                return;
            }
            Field<?> f = FieldCreatorRegistry.createBare(type);
            String id = DBServiceHelper.genStringId();
            f.setId(id);
            f.setKey(key);
            f.setName(new LocaleString(String.join(" ", name)));
            f.setFieldName(col);
            f.setParentId(at.entityId);
            f.setIsv(IsvGuard.ISV);
            f.setEntityMetadata(em);
            bad = options(f, opts);
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            if (f instanceof MulBasedataField && !relationTable(where, (MulBasedataField) f, opts.get("table"))) return;
            FieldAp ap = at.entry == null ? new FieldAp() : at.parent instanceof CardEntryRowAp ? new CardEntryFieldAp() : new EntryFieldAp();
            ap.setName(new LocaleString(String.join(" ", name)));
            ap.setField(f);
            attach(where, f, ap, at);
        }

        /**
         * copy field <源单据>.<字段> into|before|after <目标> [replace=<旧>=<新>,…] [table=<关系表>]：字段和它的控件照搬，标识、数据库列名不变。
         * 多选基础资料不照搬关系表名：两张单据的值会存进同一张表，另起一张，规则和 add field 一样。
         */
        void copyField(String where, String spec) throws Exception {
            String[] parts = spec.split("\\s+");
            int dot = parts[0].lastIndexOf('.');
            String replaceSpec = null;
            String tableSpec = null;
            boolean badOption = false;
            for (int i = 3; i < parts.length; i++) {
                if (parts[i].startsWith("replace=") && replaceSpec == null) replaceSpec = parts[i].substring(8);
                else if (parts[i].startsWith("table=") && tableSpec == null) tableSpec = parts[i].substring(6);
                else badOption = true;
            }
            if (parts.length < 3 || badOption || dot <= 0 || !isHow(parts[1])) {
                problems.add(where + "要写成 copy field <源单据>.<字段> into|before|after <目标> [replace=<旧>=<新>,…] [table=<关系表>]");
                return;
            }
            String src = parts[0].substring(0, dot);
            String key = parts[0].substring(dot + 1);
            String bad = freshField(key);
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            String srcId = MetadataDao.getIdByNumber(src, MetaCategory.Entity);
            if (blank(srcId)) {
                problems.add(where + "找不到单据 " + src);
                return;
            }
            EntityMetadata sem = (EntityMetadata) MetadataDao.readMeta(srcId, MetaCategory.Entity);
            FormMetadata sfm = (FormMetadata) MetadataDao.readMeta(srcId, MetaCategory.Form);
            Field<?> sf = sem.getFieldByKey(key);
            ControlAp<?> sap = sfm.getItemByKey(key);
            if (sf == null || !(sap instanceof FieldAp)) {
                problems.add(where + "单据 " + src + " 上" + (sf == null ? "没有字段 " + key : "字段 " + key + " 没有界面控件，照搬过来界面上看不到"));
                return;
            }
            Slot at = slot(where, parts[1], parts[2]);
            if (at == null) return;
            boolean srcEntry = sap instanceof EntryFieldAp;
            if (srcEntry != (at.entry != null)) {
                problems.add(where + key + " 在 " + src + " 上是" + (srcEntry ? "分录字段" : "表头字段") + "，" + parts[2]
                        + (at.entry != null ? " 在分录 " + at.entry + " 里" : " 在表头") + "；表头和分录的字段控件不是一类，不能互换");
                return;
            }
            String why = check(FieldValidation.canAddField(em, fm, key, sf.getClass().getSimpleName(), sf.getFieldName(), at.entry));
            if (why != null) {
                problems.add(where + "平台不让加：" + why);
                return;
            }
            //深拷贝走平台自己的元数据序列化（Java 序列化会撞上不可序列化的成员）
            MetadataSerializer ser = new MetadataSerializer(fm.getModelType());
            Field<?> f = (Field<?>) ser.deserializeFromMap(ser.serializeToMap(sf), null);
            FieldAp ap = (FieldAp) ser.deserializeFromMap(ser.serializeToMap(sap), null);
            f.setParentId(at.entityId);
            f.setIsv(IsvGuard.ISV);
            f.setEntityMetadata(em);
            if (replaceSpec != null) replaceInFilter(where, f, replaceSpec);
            if (tableSpec != null && !(f instanceof MulBasedataField)) {
                problems.add(where + "table= 只给多选基础资料字段（它的值存在自己的关系表里），" + key + " 是 " + f.getClass().getSimpleName());
                return;
            }
            if (f instanceof MulBasedataField && !relationTable(where, (MulBasedataField) f, tableSpec)) return;
            //源单据上这类字段常是「默认隐藏、由源单据自己的界面规则打开」，规则不跟着来：清掉，不然字段建出来永远看不见
            PropertyDescriptor invisible = descriptor(ap, "Invisible");
            if (invisible != null && invisible.getWriteMethod() != null) invisible.getWriteMethod().invoke(ap, Boolean.FALSE);
            f.setId(DBServiceHelper.genStringId());
            ap.setField(f);
            attach(where, f, ap, at);
        }

        /** 新字段的标识：平台的标识规则加本 ISV 前缀，布局和实体上都还没有。 */
        String freshField(String key) {
            String bad = newKey(key, "字段");
            if (bad == null && (fm.getItemByKey(key) != null || element(key) != null)) bad = "这张单据上已经有 " + key + "，换一个标识";
            return bad;
        }

        /** 字段放在哪：控件的父容器，字段所在的实体（表头是主实体，分录是那个分录）。 */
        static final class Slot {
            String how;
            ControlAp<?> target;
            ControlAp<?> parent;
            String entityId;
            /** 分录标识；表头是 null（平台校验按这个找父实体）。 */
            String entry;
        }

        Slot slot(String where, String how, String targetKey) {
            ControlAp<?> target = fm.getItemByKey(targetKey);
            if (target == null) {
                problems.add(where + missing(targetKey));
                return null;
            }
            if (how.equals("into") && !(target instanceof ContainerAp)) {
                problems.add(where + targetKey + " 是 " + target.getClass().getSimpleName() + "，不是容器；要放到它旁边用 before 或 after");
                return null;
            }
            Slot s = new Slot();
            s.how = how;
            s.target = target;
            s.parent = how.equals("into") ? target : parentOf(target);
            s.entityId = entityIdOf(s.parent);
            s.entry = s.entityId.equals(em.getRootEntity().getId()) ? null : entityKey(s.entityId);
            return s;
        }

        /** 字段进实体、控件进布局，放到位，记下要核对的东西。实体里表头字段排在分录前面，和平台一样。 */
        void attach(String where, Field<?> f, FieldAp ap, Slot at) {
            String key = f.getKey();
            //平台的 ControlValidation 只管界面控件（它的类型表里没有字段控件）；字段的去处照平台加字段时的定法：
            //分录字段直接挂在分录（卡片分录挂在卡片行）下，表头字段挂在面板、分组这类容器里
            String type = at.parent.getClass().getSimpleName();
            String misplaced = at.entry != null
                    ? at.parent instanceof EntryAp || at.parent instanceof CardEntryRowAp ? null
                            : "分录 " + at.entry + " 的字段要直接放进分录控件里，" + at.parent.getKey() + " 是 " + type
                    : !(at.parent instanceof ContainerAp) || at.parent instanceof ToolbarAp
                            ? "字段放不进 " + at.parent.getKey() + "（" + type + "），要放进面板、分组这类容器" : null;
            if (misplaced != null) {
                problems.add(where + misplaced);
                return;
            }
            ap.setId(f.getId());
            ap.setFieldId(f.getId());
            ap.setKey(key);
            ap.setIsv(IsvGuard.ISV);
            ap.setParentId(at.parent.getId());
            List<EntityItem<?>> items = entityItems();
            int pos = items.size();
            if (at.entry == null) {
                for (int i = 0; i < items.size(); i++) {
                    if (items.get(i) instanceof EntryEntity) {
                        pos = i;
                        break;
                    }
                }
            }
            items.add(pos, f);
            fm.getItems().add(ap);
            byId.put(ap.getId(), ap);
            place(ap, at.how, at.target, at.parent);
            addedFields.put(key.toLowerCase(), f);
            entityTouched = true;
            fieldTargets.add(key);
            targeted.add(key.toLowerCase());
            survive.add(() -> {
                if (dropped.contains(key.toLowerCase())) return null;
                boolean inEntity = false;
                boolean inForm = false;
                for (EntityItem<?> it : em.getItems()) inEntity |= key.equals(it.getKey());
                for (ControlAp<?> c : bill.getItems()) inForm |= key.equals(c.getKey());
                return inEntity && inForm ? null : where + "平台保存前的规整把新字段 " + key + " 的" + (inEntity ? "控件" : "字段") + "去掉了";
            });
        }

        /**
         * 新加的字段落库后数据库里是什么样：哪张表、加哪几列、类型和长度。照平台加列的同一套算——平台（AlterTableUtil）
         * 逐字段取 getTableName、getDBFields，每列用 IDBField.genFieldDesc 拼类型和长度。差异只列改过的值，
         * 没改的默认长度（文本 50）在差异里看不到，这里照实报；大文本另有一列存全文。
         * 多语言文本、多选基础资料、附件字段不在业务表上加列，平台另建表。列表布局在保存前的规整之后看，和真存进去的一致。
         */
        void landing() {
            List<String> lines = new ArrayList<String>();
            List<String> notInList = new ArrayList<String>();
            FormMetadata list = listMeta();
            for (String key : fieldTargets) {
                Field<?> f = addedFields.get(key.toLowerCase());
                if (f == null || element(key) == null) continue;
                String head = "  " + key + "  " + f.getClass().getSimpleName() + "  ";
                EntityItem<?> owner = em.getItemById(f.getParentId());
                String table = tableOf(owner);
                if (f instanceof MuliLangTextField && !((MuliLangTextField) f).isGL()) {
                    lines.add(head + "业务表不加列，按语言存在多语言表 " + table + "_L 的 " + f.getFieldName() + " 列");
                } else if (f instanceof MulBasedataField) {
                    lines.add(head + "业务表不加列，选中的值一行一个存在关系表 " + ((MulBasedataField) f).getTableName() + "（落库时新建）");
                } else if (isA(f, "kd.bos.mservice.svc.attach.IAttachmentField")) {
                    lines.add(head + "业务表不加列，附件存在平台的附件关系表");
                } else {
                    List<String> cols = new ArrayList<String>();
                    for (IDBField d : f.getDBFields()) {
                        String desc = IDBField.genFieldDesc(d).replaceAll("\\s+DEFAULT\\(.*$", "").replaceAll("\\s+NULL$", "").trim();
                        if (!desc.isEmpty()) cols.add(desc);
                    }
                    //拆分表（字段设了所属拆分表）落在 <表>_<后缀>，和平台 Field.getTableName 一样拼
                    String suffix = owner instanceof Entity ? f.getTableName((Entity<?, ?>) owner) : "";
                    String own = owner instanceof Entity ? ((Entity<?, ?>) owner).getTableName() : "";
                    String at = !blank(own) && suffix.startsWith(own + "_") ? table + suffix.substring(own.length()) : table;
                    lines.add(head + "表 " + at + " 加列 " + String.join("、", cols)
                            + (f instanceof LargeTextField ? "（前一列是界面上的摘要，全文存在 " + ((LargeTextField) f).getTagFieldName() + "）" : ""));
                }
                boolean inList = false;
                if (list != null) {
                    for (ControlAp<?> c : list.getItems()) {
                        inList |= c instanceof ListColumnAp && key.equalsIgnoreCase(((ListColumnAp) c).getListFieldId());
                    }
                }
                if (!inList) notInList.add(key);
            }
            for (Map.Entry<EntryEntity, Boolean> e : addedEntries.entrySet()) {
                EntryEntity entry = e.getKey();
                if (element(entry.getKey()) == null) continue;
                boolean reused = e.getValue();
                p("新分录 " + entry.getKey() + (reused
                        ? "  接着用库里已有的表 " + entry.getTableName() + "（以前建过同名分录留下的，没有哪份元数据在用它；表里原有的行还在，缺的列落库时补上）"
                        : "  落库时新建业务表 " + entry.getTableName() + "（单据内码、分录内码、行号三列平台自带，字段列见下）；以后退回元数据，这张表留在库里"));
                ProbeJson.emit("layout-entry-table", "entry", entry.getKey(), "table", entry.getTableName(), "existing", reused);
            }
            for (Map.Entry<String, String> e : relationTables.entrySet()) {
                if (addedFields.containsKey(e.getKey().toLowerCase()) || element(e.getKey()) == null) continue;
                p("多选基础资料 " + e.getKey() + "  关系表定为 " + e.getValue() + "，落库时新建；选中的值一行一个存在里面");
            }
            if (lines.isEmpty()) return;
            p("新字段落库后的样子（照平台加列的同一套算，没改的默认长度也在这里）：");
            for (String l : lines) p(l);
            if (list != null && !notInList.isEmpty()) {
                p("  列表上" + (notInList.size() == lines.size() ? "都没有这些新字段的列"
                        : "没有这 " + notInList.size() + " 个新字段的列：" + String.join("、", notInList)) + "；列表布局的列不跟着加字段自动加");
            }
        }

        /** 字段所在实体的表：从单据模板继承来的实体，设计态对象上常没记表名，取运行时的（数据库里真用的那张）。 */
        String tableOf(EntityItem<?> owner) {
            String t = owner instanceof Entity ? ((Entity<?, ?>) owner).getTableName() : null;
            if (!blank(t)) return t;
            try {
                MainEntityType main = EntityMetadataCache.getDataEntityType(em.getKey());
                if (owner == null || em.getKey().equalsIgnoreCase(owner.getKey())) return main.getAlias();
                EntityType entry = main.getAllEntities().get(owner.getKey());
                if (entry != null) return entry.getAlias();
            } catch (Throwable e) {
                //运行时还没有这个实体（新分录）：表名保存时才定
            }
            return "（保存时定）";
        }

        /** 按名字沿继承链和接口比，不加载类：写探针不碰类加载（跳过编译新鲜度检查的前提）。 */
        static boolean isA(Object o, String type) {
            List<Class<?>> todo = new ArrayList<Class<?>>();
            for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) todo.add(c);
            for (int i = 0; i < todo.size(); i++) {
                Class<?> c = todo.get(i);
                if (c.getName().equals(type)) return true;
                todo.addAll(Arrays.asList(c.getInterfaces()));
            }
            return false;
        }

        /** base=、items=、currency= 只给用得上的字段类型；基础资料、下拉、金额缺了对应那项就是半个字段。 */
        String options(Field<?> f, Map<String, String> opts) {
            if (opts.get("table") != null && !(f instanceof MulBasedataField)) {
                return "table= 只给多选基础资料字段（它的值存在自己的关系表里），" + f.getClass().getSimpleName() + " 用不上";
            }
            boolean basedata = f instanceof BasedataField || f instanceof MulBasedataField;
            String base = opts.get("base");
            if (base != null) {
                if (!basedata) return "base= 只给基础资料字段，" + f.getClass().getSimpleName() + " 用不上";
                String baseId = MetadataDao.getIdByNumber(base, MetaCategory.Entity);
                if (blank(baseId)) return "找不到基础资料 " + base;
                if (f instanceof BasedataField) ((BasedataField) f).setBaseEntityId(baseId);
                else ((MulBasedataField) f).setBaseEntityId(baseId);
            }
            String baseId = f instanceof BasedataField ? ((BasedataField) f).getBaseEntityId()
                    : f instanceof MulBasedataField ? ((MulBasedataField) f).getBaseEntityId() : "";
            if (basedata && blank(baseId)) return f.getClass().getSimpleName() + " 要给 base=<基础资料标识>";
            String items = opts.get("items");
            if (items != null && !(f instanceof ComboField)) return "items= 只给下拉字段，" + f.getClass().getSimpleName() + " 用不上";
            if (f instanceof ComboField) {
                int seq = 1;
                for (String pair : items == null ? new String[0] : items.split(",")) {
                    if (pair.trim().isEmpty()) continue;
                    String[] kv = pair.split(":", 2);
                    ComboItem item = new ComboItem(seq++, new LocaleString(kv.length > 1 ? kv[1].trim() : kv[0].trim()), kv[0].trim());
                    item.setIsv(IsvGuard.ISV); // 平台保存时也会补上，先带上，回读才对得上
                    ((ComboField) f).getItems().add(item);
                }
                if (seq == 1) return f.getClass().getSimpleName() + " 要给 items=<值:名称,值:名称>";
            }
            String currency = opts.get("currency");
            if (currency != null && !(f instanceof AmountField)) return "currency= 只给金额字段，" + f.getClass().getSimpleName() + " 用不上";
            if (f instanceof AmountField) {
                if (currency == null) return f.getClass().getSimpleName() + " 要给 currency=<币别字段>，金额的精度按币别取";
                //平台按字段 id 找币别（getFieldById），存标识找不到
                Field<?> cur = em.getFieldByKey(currency);
                if (cur == null) return "这张单据上没有币别字段 " + currency;
                ((AmountField) f).setCurrencyFieldId(cur.getId());
            }
            return null;
        }

        /** 基础资料的过滤条件里引用了源单据上的字段，目标单据上往往叫别的名字：条件值和给人看的描述一起换。 */
        void replaceInFilter(String where, Field<?> f, String spec) throws Exception {
            Map<String, String> reps = new LinkedHashMap<String, String>();
            for (String pair : spec.split(",")) {
                String[] kv = pair.split("=", 2);
                if (kv.length == 2 && !kv[0].trim().isEmpty()) reps.put(kv[0].trim(), kv[1].trim());
            }
            PropertyDescriptor fd = descriptor(f, "Filter");
            Object fc = fd == null || fd.getReadMethod() == null ? null : fd.getReadMethod().invoke(f);
            int n = 0;
            if (fc != null) {
                n += replaceProp(fc, "Filter", reps);
                PropertyDescriptor rd = descriptor(fc, "FilterRow");
                Object rows = rd == null || rd.getReadMethod() == null ? null : rd.getReadMethod().invoke(fc);
                if (rows instanceof List) {
                    for (Object row : (List<?>) rows) {
                        PropertyDescriptor vd = descriptor(row, "Value");
                        Object vals = vd == null || vd.getReadMethod() == null ? null : vd.getReadMethod().invoke(row);
                        if (vals instanceof List) for (Object v : (List<?>) vals) n += replaceProp(v, "Value", reps);
                    }
                }
            }
            if (n == 0) problems.add(where + "replace= 给了，但 " + f.getKey() + " 的过滤条件里没有要换的文字");
        }

        static int replaceProp(Object o, String prop, Map<String, String> reps) throws Exception {
            PropertyDescriptor d = descriptor(o, prop);
            if (d == null || d.getReadMethod() == null || d.getWriteMethod() == null) return 0;
            Object v = d.getReadMethod().invoke(o);
            if (!(v instanceof String)) return 0;
            String r = (String) v;
            for (Map.Entry<String, String> e : reps.entrySet()) r = r.replace(e.getKey(), e.getValue());
            if (r.equals(v)) return 0;
            d.getWriteMethod().invoke(o, r);
            return 1;
        }

        /** remove field <字段>：实体里的字段、各处的字段控件、列表上的这一列一起去掉（平台删字段也连带列表列）；数据库列和数据留着。 */
        void removeField(String where, String key) {
            Field<?> f = em.getFieldByKey(key);
            if (f == null) {
                problems.add(where + (element(key) != null ? key + " 是分录，这个入口不删分录；退回刚加的分录用 LAYOUT_RESTORE" : "这张单据没有字段 " + key));
                return;
            }
            if (f.isInherit() || !f.getKey().toLowerCase().startsWith(IsvGuard.PREFIX)) {
                problems.add(where + key + " 是模板或标准产品带来的字段，删不了；不想让人看见就改它的 Visible");
                return;
            }
            entityItems().remove(f);
            //单据带的移动端布局上它的控件、两份列表上它的列也一起去掉：留着的话控件指着一个已经没有的字段
            Part was = part;
            dropFieldControls(f, key);
            if (nested("mobile") != null) {
                layout(where, "mobile");
                dropFieldControls(f, key);
            }
            use(was);
            for (FormMetadata list : new FormMetadata[] {listMeta(), nested("mobilelist")}) {
                if (list == null) continue;
                for (ControlAp<?> c : new ArrayList<ControlAp<?>>(list.getItems())) {
                    if (!(c instanceof ListColumnAp) || !columnReferences(((ListColumnAp) c).getListFieldId(), fieldPath(f))) continue;
                    list.getItems().remove(c);
                    dropped.add(c.getKey().toLowerCase());
                    for (Part p : parts.values()) if (p.fm == list) {
                        p.byId.remove(c.getId());
                        p.added.remove(c.getKey().toLowerCase());
                    }
                }
            }
            addedFields.remove(key.toLowerCase());
            dropped.add(key.toLowerCase());
            removed.add(new String[] {"字段", f.getKey(), f.getId()});
            entityTouched = true;
            fieldTargets.add(f.getKey());
            targeted.add(key.toLowerCase());
        }

        /** 当前这份布局上绑着这个字段的控件全部去掉。 */
        void dropFieldControls(Field<?> f, String key) {
            List<ControlAp<?>> aps = new ArrayList<ControlAp<?>>();
            for (ControlAp<?> c : fm.getItems()) {
                if (c instanceof FieldAp && (f.getId().equals(((FieldAp) c).getFieldId()) || key.equalsIgnoreCase(c.getKey()))) aps.add(c);
            }
            for (ControlAp<?> c : aps) {
                ControlAp<?> parent = parentOf(c);
                fm.getItems().remove(c);
                byId.remove(c.getId());
                renumber(children(parent));
            }
        }

        static boolean columnReferences(String binding, String fieldPath) {
            return binding != null && (binding.equalsIgnoreCase(fieldPath) || binding.toLowerCase().startsWith(fieldPath.toLowerCase() + "."));
        }

        @SuppressWarnings("unchecked")
        List<EntityItem<?>> entityItems() {
            return (List<EntityItem<?>>) (List<?>) em.getItems();
        }

        // ---------- 操作 ----------

        List<Operation> operations() {
            return em.getRootEntity().getOperations();
        }

        Operation findOp(String key) {
            for (Operation op : operations()) {
                if (key.equalsIgnoreCase(op.getKey())) return op;
            }
            return null;
        }

        String opList() {
            List<String> keys = new ArrayList<String>();
            for (Operation op : operations()) keys.add(op.getKey());
            return clip(String.join("、", keys), 300);
        }

        void addOp(String where, String spec) {
            String[] parts = spec.split("\\s+", 3);
            if (parts.length < 3) {
                problems.add(where + "要写成 add op <新操作标识> <操作类型> <名称>");
                return;
            }
            String key = parts[0];
            String type = parts[1];
            String bad = newKey(key, "操作");
            if (bad == null && findOp(key) != null) bad = "已经有操作 " + key + "，换一个标识";
            if (bad != null) {
                problems.add(where + bad);
                return;
            }
            Set<String> types = opTypes();
            if (types == null) {
                problems.add(where + "查不到这张单据能用的操作类型，核对不了 " + type);
                return;
            }
            if (!types.contains(type)) {
                //平台给的清单有几百种、按它自己的顺序排，常用的排不到前面：先列常用的，再列名字沾边的
                List<String> shown = new ArrayList<String>();
                for (String t : new String[] {"donothing", "save", "submit", "audit", "unaudit", "delete", "refresh", "close"}) {
                    if (types.contains(t)) shown.add(t);
                }
                for (String t : types) {
                    String a = t.toLowerCase();
                    String b = type.toLowerCase();
                    if (shown.size() < 16 && !shown.contains(t) && (a.contains(b) || b.contains(a))) shown.add(t);
                }
                problems.add(where + "这张单据用不了操作类型 " + type + "；能用的共 " + types.size() + " 种，常用的有 " + String.join("、", shown)
                        + "（donothing 是空操作，按钮点了只走插件）");
                return;
            }
            //平台加操作时这三类必须带参数（目标单和转换规则、要打开的表单）：这里不配参数，到开发平台配
            if (type.equals("push") || type.equals("pushandsave") || type.equals("openform")) {
                problems.add(where + type + " 要配参数（下推的目标单和转换规则、要打开的表单），这里加不了，到开发平台配");
                return;
            }
            Operation op = new Operation();
            op.setId(Uuid16.create().toString());
            op.setKey(key);
            op.setName(new LocaleString(parts[2].trim()));
            op.setOperationType(type);
            op.setIsv(IsvGuard.ISV);
            operations().add(op);
            entityTouched = true;
            ownOps.add(key);
            survive.add(() -> findOp(key) != null ? null : where + "平台保存前的规整把新操作 " + key + " 去掉了");
        }

        /** 平台按单据的页面类型和应用过滤过的操作类型（和开发平台加操作时能选的一样）。查不到返回 null。 */
        Set<String> opTypes() {
            if (opTypes == null) {
                OperationTypeListParam param = new OperationTypeListParam();
                param.setFormNumber(form);
                OperationTypeListResult r = MetaOperationService.listAvailableOperationTypes(param);
                if (r == null || !r.isSuccess() || r.getOperationTypes() == null) return null;
                opTypes = new LinkedHashSet<String>();
                for (OperationTypeDTO t : r.getOperationTypes()) opTypes.add(t.getId());
            }
            return opTypes;
        }

        void removeOp(String where, String key) {
            Operation op = findOp(key);
            if (op == null) {
                problems.add(where + "这张单据没有操作 " + key + "；有的是 " + opList());
                return;
            }
            if (op.isInherit()) {
                problems.add(where + key + " 是模板或标准产品带来的操作，删不了");
                return;
            }
            operations().remove(op);
            entityTouched = true;
            ownOps.add(op.getKey());
            removed.add(new String[] {"操作", op.getKey(), op.getId()});
        }

        // ---------- 插件 ----------

        /** add plugin <类> [to list | to op <操作>]；remove plugin <类> [from list | from op <操作>]。 */
        void plugin(String where, String spec, boolean adding) {
            String[] parts = spec.split("\\s+");
            String cls = parts[0];
            String word = adding ? "to" : "from";
            String hostOp = null;
            boolean list = false;
            if (parts.length == 3 && parts[1].equals(word) && parts[2].equals("list")) list = true;
            else if (parts.length == 4 && parts[1].equals(word) && parts[2].equals("op")) hostOp = parts[3];
            else if (parts.length != 1) {
                problems.add(where + "要写成 " + (adding ? "add" : "remove") + " plugin <类全名> [" + word + " list | " + word + " op <操作>]");
                return;
            }
            if (!cls.matches("[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*)+")) {
                problems.add(where + cls + " 不是类全名，要带包名");
                return;
            }
            if ((list || hostOp != null) && !onBill()) {
                problems.add(where + word + (list ? " list" : " op") + " 写在 layout bill 下（现在改的是" + part.title + "）"
                        + (list ? "；移动端列表插件先写 layout mobilelist，再挂，不带 to" : ""));
                return;
            }
            final boolean onList = list;
            final String opKey = hostOp;
            final String in = part.name;
            String label = opKey != null ? "操作 " + opKey : onList ? "列表" : onBill() ? "单据" : part.title;
            if (opKey != null && findOp(opKey) == null) {
                problems.add(where + "这张单据没有操作 " + opKey + "；有的是 " + opList());
                return;
            }
            List<Plugin> plugins = plugins(onList, opKey);
            if (plugins == null) {
                problems.add(where + "这张单据没有列表布局，挂不了列表插件");
                return;
            }
            Plugin found = null;
            for (Plugin x : plugins) {
                if (cls.equals(x.getClassName())) found = x;
            }
            if (adding) {
                if (found != null) {
                    problems.add(where + cls + " 已经挂在" + label + "上了");
                    return;
                }
                String bad = pluginClass(cls, onList, opKey != null);
                if (bad != null) {
                    problems.add(where + bad);
                    return;
                }
                int row = 0;
                for (Plugin x : plugins) row = Math.max(row, x.getRowKey());
                Plugin p = new Plugin();
                p.setClassName(cls);
                p.setEnabled(true);
                p.setDescription("");
                p.setBizAppId("");
                p.setType(0);
                p.setRowKey(row + 1);
                p.setIsv(IsvGuard.ISV);
                plugins.add(p);
                survive.add(() -> {
                    List<Plugin> now = pluginsOf(in, onList, opKey);
                    if (now != null) {
                        for (Plugin x : now) {
                            if (cls.equals(x.getClassName())) return null;
                        }
                    }
                    return where + "平台保存前的规整把挂在" + label + "上的 " + cls + " 去掉了";
                });
            } else {
                if (found == null) {
                    List<String> names = new ArrayList<String>();
                    for (Plugin x : plugins) names.add(x.getClassName());
                    problems.add(where + label + "上没挂 " + cls + (names.isEmpty() ? "，它上面一个插件都没有" : "；挂着的是 " + String.join("、", names)));
                    return;
                }
                if (found.isInherit()) {
                    problems.add(where + cls + " 是模板或标准产品挂的插件，摘不了");
                    return;
                }
                plugins.remove(found);
            }
            if (opKey != null) {
                entityTouched = true;
                opHosts.add(findOp(opKey).getKey());
            }
            targeted.add((opKey != null ? findOp(opKey).getKey() : fm.getRootAp().getKey()).toLowerCase());
        }

        List<Plugin> plugins(boolean list, String opKey) {
            return pluginsOf(part.name, list, opKey);
        }

        /** 插件清单：操作上的、电脑端列表上的，或者某份布局（电脑端、移动端、移动端列表）根上的。 */
        List<Plugin> pluginsOf(String partName, boolean list, String opKey) {
            if (opKey != null) {
                Operation op = findOp(opKey);
                if (op == null) return null;
                if (op.getPlugins() == null) op.setPlugins(new ArrayList<Plugin>());
                return op.getPlugins();
            }
            FormMetadata host = list ? listMeta() : partNow(partName);
            return host == null || host.getRootAp() == null ? null : host.getRootAp().getPlugins();
        }

        /**
         * 插件类得找得到、挂对地方：单据插件实现 IFormPlugin、列表插件实现 IListPlugin、操作插件实现 IOperationServicePlugIn。
         * 只读类文件看它继承了谁，不加载（写探针不碰业务类）。类路径上没有、但工程源码里有的（刚写还没编译），放行、不核类型。
         */
        String pluginClass(String cls, boolean list, boolean op) {
            Set<String> types = ClassFiles.ancestors(cls.replace('.', '/'));
            if (types == null) {
                if (ProjectSources.of(cls) != null) {
                    p("插件 " + cls + " 的源码在 " + ProjectSources.of(cls) + "，类路径上还没有它（没编译），没核对插件类型");
                    return null;
                }
                return "找不到类 " + cls + "：工程源码里没有，类路径上也没有";
            }
            boolean isOp = types.contains("kd/bos/entity/plugin/IOperationServicePlugIn");
            boolean isList = types.contains("kd/bos/list/plugin/IListPlugin");
            boolean isForm = types.contains("kd/bos/form/plugin/IFormPlugin");
            boolean isMobList = types.contains("kd/bos/list/plugin/IMobListPlugin");
            boolean isMob = types.contains("kd/bos/form/plugin/IMobFormPlugin");
            String here = kind();
            boolean standalone = !(bill.getRootAp() instanceof BillFormAp) || bill.getRootAp().getClass().getSimpleName().startsWith("Mobile");
            // 移动端插件也实现 IFormPlugin、移动端列表插件也实现 IListPlugin，只按上面三个接口分会挂到电脑端那两份上（真机试算通过过）。
            // 它们登记在移动端那两份布局上：移动端列表插件在移动端列表，其余移动端插件在移动端布局。
            if (!op && !isOp && (isMob || isMobList)) {
                String want = isMobList ? "mobilelist" : "mobile";
                String title = isMobList ? "移动端列表插件" : "移动端插件";
                if (want.equals(here)) return list ? cls + " 是" + title + "，挂在当前这份布局上，挂法不带 to" : null;
                if (standalone) return cls + " 是" + title + "，这张 " + form + " 是" + ("mobile".equals(here) ? "移动端布局" : "电脑端布局")
                        + "，挂不了；" + (isMobList ? "移动端列表插件挂在单据的移动端列表上" : "移动端插件挂在移动端布局上");
                return cls + " 是" + title + "，登记在" + ("mobile".equals(want) ? "移动端布局" : "移动端列表") + "上：先写 layout " + want
                        + "，再 add plugin " + cls + "（不带 to）";
            }
            String kind = isOp ? "操作插件，挂法 to op <操作>" : isList ? "列表插件，挂法 to list" : isForm ? "单据插件，挂法不带 to" : null;
            //移动端列表上不带 to 挂的是列表一类的插件
            boolean listHost = list || "list".equals(here) || "mobilelist".equals(here);
            boolean ok = op ? isOp : listHost ? isList : isForm && !isList;
            if (ok) return null;
            return cls + (kind == null ? " 不是单据、列表或操作插件" + elsewhere(types) : " 是" + kind);
        }

        /** 不归这个入口挂的插件：认得出是哪一类的，说它登记在哪。认不出返回空串。 */
        String elsewhere(Set<String> types) {
            String[][] known = {
                {"kd/bos/print/core/plugin/IPrintPlugin", "打印插件，登记在打印模板上"},
                {"kd/bos/entity/report/AbstractReportListDataPlugin", "报表取数插件，登记在报表列表控件的查询插件属性上"},
                {"kd/bos/entity/report/AbstractReportTreeDataPlugin", "报表树取数插件，登记在报表树控件的插件属性上"},
                {"kd/bos/entity/botp/plugin/AbstractConvertPlugIn", "转换插件，登记在转换规则上"},
                {"kd/bos/entity/botp/plugin/AbstractWriteBackPlugIn", "反写插件，登记在单据实体的关联配置上"},
                {"kd/bos/schedule/executor/AbstractTask", "后台任务，登记在调度的任务定义上"},
                {"kd/bos/workflow/engine/extitf/IWorkflowPlugin", "工作流插件，登记在流程节点上"},
                {"kd/bos/form/plugin/impt/BatchImportPlugin", "引入插件，登记在引入数据操作的参数里"},
                {"kd/bos/entity/validate/AbstractValidator", "校验器，不用登记，由操作插件在 onAddValidators 里加上"},
            };
            for (String[] one : known) {
                if (types.contains(one[0])) return "：它是" + one[1] + "，这个入口挂不了";
            }
            return "";
        }

        // ---------- 删之前查引用 ----------

        /**
         * 删掉的控件和操作，改完以后还有没有地方指着它：元数据里（界面规则、按钮绑的操作、列表工具栏……）按值找它的标识和 id，
         * 这张单据挂的插件源码里按带引号的标识找。有就列出来、一处都不删——先把引用去掉再删。
         */
        void checkRemoved(Map<String, Object> formMap, Map<String, Object> entityMap) {
            if (removed.isEmpty()) return;
            Set<String> classes = new LinkedHashSet<String>();
            for (String name : new String[] {"bill", "mobile", "mobilelist"}) {
                List<Plugin> own = pluginsOf(name, false, null);
                if (own != null) for (Plugin x : own) classes.add(x.getClassName());
            }
            List<Plugin> listPlugins = plugins(true, null);
            if (listPlugins != null) for (Plugin x : listPlugins) classes.add(x.getClassName());
            for (Operation op : operations()) {
                if (op.getPlugins() != null) for (Plugin x : op.getPlugins()) classes.add(x.getClassName());
            }
            for (String[] r : removed) {
                Set<String> hits = new LinkedHashSet<String>();
                refs("布局", formMap, r, null, hits);
                refs("实体", entityMap, r, null, hits);
                hits.addAll(ProjectSources.mentions(classes, r[1]));
                if (hits.isEmpty()) continue;
                List<String> shown = new ArrayList<String>(hits);
                problems.add("删掉的" + r[0] + " " + r[1] + " 还有 " + shown.size() + " 处在用："
                        + String.join("；", shown) + "。先改掉这些地方再删");
            }
        }
    }

    /** 元数据里按值找：哪个元素的哪个属性的值正好是这个标识或 id（标识、id、名称本身不算引用）。 */
    @SuppressWarnings("unchecked")
    static void refs(String scope, Object node, String[] removed, String owner, Set<String> hits) {
        if (node instanceof List) {
            for (Object o : (List<Object>) node) refs(scope, o, removed, owner, hits);
            return;
        }
        if (!(node instanceof Map)) return;
        Map<String, Object> m = (Map<String, Object>) node;
        String here = m.get("Key") instanceof String ? (String) m.get("Key") : owner;
        for (Map.Entry<String, Object> e : m.entrySet()) {
            String p = e.getKey();
            Object v = e.getValue();
            if (v instanceof String) {
                if (p.equals("Key") || p.equals("Id") || p.equals("Name")) continue;
                if (((String) v).equalsIgnoreCase(removed[1]) || v.equals(removed[2])) hits.add(scope + " " + (here == null ? "" : here + " 的 ") + p);
            } else if (!p.equals("Name")) {
                refs(scope, v, removed, here, hits);
            }
        }
    }

    /** 平台保存的第一步（序列化 + 元数据插件校验），不落库。它会原地规整对象，所以存的就是规整过的这一份。 */
    static void designCheck(EntityMetadata em, FormMetadata fm, List<String> problems) {
        try {
            new MetadataWriter(fm.getModelType()).convertToDesignMeta(em, fm);
        } catch (Throwable e) {
            problems.add("平台保存前的校验不通过 " + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()));
        }
    }

    /**
     * 开发平台保存时拦的「多选基础资料表名不能为空」（DesignerData），平台的保存服务不拦，这里照着拦：
     * 表名空着不建关系表，选的值存不下，读回来是空集合，保存单据时平台序列化报空指针。
     * 和开发平台一样，参数表单、报表、宽表不要求，附件字段不算。
     */
    static void relationTablesFilled(EntityMetadata em, String modelType, List<String> problems) {
        List<String> exempt = Arrays.asList("ParameterFormModel_application", "ParameterFormModel_public", "ReportFormModel",
                "WideTableBillFormModel", "WideTableBaseFormModel");
        for (String m : exempt) {
            if (m.equalsIgnoreCase(modelType)) return;
        }
        for (EntityItem<?> it : em.getItems()) {
            if (!(it instanceof MulBasedataField) || Editor.isA(it, "kd.bos.mservice.svc.attach.IAttachmentField")) continue;
            if (!blank(((MulBasedataField) it).getTableName())) continue;
            problems.add("多选基础资料 " + it.getKey() + " 没有关系表（表名是空的）：选的值存不下，读回来是空集合，保存单据时平台序列化报空指针；"
                    + "用 set " + it.getKey() + ".TableName=<表名> 补上（tk_" + IsvGuard.PREFIX + " 开头，不超过 25 个字符），落库时新建");
        }
    }

    // ---------- 值 ----------

    static Object convert(String value, Class<?> type) {
        if (type == String.class) return value;
        if (type == LocaleString.class) return new LocaleString(value);
        try {
            if (type == boolean.class || type == Boolean.class) {
                if ("true".equalsIgnoreCase(value)) return Boolean.TRUE;
                if ("false".equalsIgnoreCase(value)) return Boolean.FALSE;
                throw new IllegalArgumentException("true 或 false");
            }
            if (type == int.class || type == Integer.class) return Integer.valueOf(value);
            if (type == long.class || type == Long.class) return Long.valueOf(value);
            if (type == double.class || type == Double.class) return Double.valueOf(value);
            if (type == BigDecimal.class) return new BigDecimal(value);
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException(type.getSimpleName() + " 类型的数");
        }
        throw new IllegalArgumentException(type.getSimpleName() + " 类型的值（不是简单值，这个入口还改不了）");
    }

    /** 可选值和上下限，都取自平台属性清单。多选（mcombo）写成逗号分隔，每一项都要是可选值；空串是一项都不选。 */
    static String outOfRange(PropertySchema s, String value, Object converted) {
        List<Map<String, Object>> options = s.getOptions();
        if (options != null && !options.isEmpty()) {
            Set<String> allowed = new LinkedHashSet<String>();
            List<String> ids = new ArrayList<String>();
            for (Map<String, Object> o : options) {
                String id = String.valueOf(o.get("id"));
                allowed.add(id);
                Object label = o.get("name");
                ids.add(label == null || String.valueOf(label).equals(id) ? id : id + "（" + label + "）");
            }
            boolean multi = "mcombo".equalsIgnoreCase(s.getEditorType());
            List<String> wrong = new ArrayList<String>();
            for (String one : multi ? value.split(",", -1) : new String[] {value}) {
                if (multi && value.isEmpty()) break;
                if (!allowed.contains(one.trim())) wrong.add("「" + one.trim() + "」");
            }
            if (wrong.isEmpty()) return null;
            return String.join("", wrong) + " 不是可选值，" + (multi ? "可以多选（逗号分隔）" : "只能填") + " "
                    + clip(String.join("、", ids), 300);
        }
        Map<String, Object> c = s.getConstraints();
        if (c == null || !(converted instanceof Number)) return null;
        double v = ((Number) converted).doubleValue();
        Object min = c.get("min");
        Object max = c.get("max");
        if (min instanceof Number && v < ((Number) min).doubleValue()) return "最小 " + min + "，给的是 " + value;
        if (max instanceof Number && v > ((Number) max).doubleValue()) return "最大 " + max + "，给的是 " + value;
        return null;
    }

    static boolean same(Object a, Object b) {
        if (a instanceof Number && b instanceof Number) return ((Number) a).doubleValue() == ((Number) b).doubleValue();
        if (a instanceof Style || b instanceof Style) return FormLayoutProbe.styleText(a).equals(FormLayoutProbe.styleText(b));
        return String.valueOf(a).equals(String.valueOf(b));
    }

    static List<String> near(List<PropertySchema> schema, String prop) {
        String q = prop.toLowerCase();
        List<String> out = new ArrayList<String>();
        for (PropertySchema s : schema) {
            String n = s.getPropertyName().toLowerCase();
            if (n.contains(q) || q.contains(n) || (q.length() >= 4 && n.startsWith(q.substring(0, 4)))) {
                out.add(s.getPropertyName() + "「" + s.getDisplayName() + "」");
            }
            if (out.size() >= 6) break;
        }
        return out;
    }

    // ---------- 差异 ----------

    static final class Change {
        final String scope;
        final String key;
        final String prop;
        final String from;
        final String to;

        Change(String scope, String key, String prop, String from, String to) {
            this.scope = scope;
            this.key = key;
            this.prop = prop;
            this.from = from;
            this.to = to;
        }

        public String toString() {
            String head = scope + " " + key + "  ";
            if (ADDED.equals(prop)) return head + "新增：" + to;
            if (REMOVED.equals(prop)) return head + "删除：" + from;
            if (PLUGIN.equals(prop)) return head + (from.isEmpty() ? "挂插件 " + to : "摘插件 " + from);
            return head + prop + "：" + (from.isEmpty() ? "（默认）" : from) + " → " + (to.isEmpty() ? "（默认）" : to);
        }
    }

    static final String ADDED = "（新增）";
    static final String REMOVED = "（删除）";
    static final String PLUGIN = "插件";

    /**
     * 两份存库序列化逐元素、逐属性比。序列化只写非默认值，所以属性改回默认就是「有 → 没有」。
     * 元素按 Id 对齐，不按下标：挪一个控件会顶动后面每个下标。所在容器（ParentId）换成容器的标识再比。
     */
    static List<Change> diff(String scope, Map<String, Object> before, Map<String, Object> after) {
        List<Change> out = new ArrayList<Change>();
        elements(scope, list(before.get("Items")), list(after.get("Items")), out);
        Set<String> top = new LinkedHashSet<String>(before.keySet());
        top.addAll(after.keySet());
        for (String p : top) {
            if ("Items".equals(p)) continue;
            String x = json(before.get(p));
            String y = json(after.get(p));
            if (!x.equals(y)) out.add(new Change(scope, "（整张）", p, x, y));
        }
        return out;
    }

    /** 一组带 Id 的元素（控件、字段、操作）按 Id 对齐逐个比；新增、删除的一行说清是什么、在哪、叫什么。 */
    static void elements(String scope, List<Object> before, List<Object> after, List<Change> out) {
        Map<String, Map<String, Object>> a = byId(before);
        Map<String, Map<String, Object>> b = byId(after);
        final String all = scope;
        for (Map.Entry<String, Map<String, Object>> e : b.entrySet()) {
            Map<String, Object> was = a.get(e.getKey());
            String key = keyOf(e.getValue(), e.getKey());
            scope = scopeOf(all, e.getValue());
            if (was == null) {
                //新加的元素除了「是什么、在哪」，设了的属性和挂的插件也逐行列：按钮绑哪个操作、操作挂了什么插件，确认时要看得见
                out.add(new Change(scope, key, ADDED, "", what(e.getValue(), b)));
                Map<String, Object> set = new LinkedHashMap<String, Object>(e.getValue());
                //字段控件的 FieldId 就是字段自己的 id，Features 是平台给每个新字段补的版本号：都不是这次要确认的
                set.keySet().removeAll(Arrays.asList("Id", "Key", "Name", "ParentId", "Index", "_Type_", "IsvFlag", "OperationType",
                        "FieldId", "Features"));
                props(scope, key, Collections.<String, Object>emptyMap(), set, a, b, out);
            } else {
                props(scope, key, was, e.getValue(), a, b, out);
            }
        }
        for (Map.Entry<String, Map<String, Object>> e : a.entrySet()) {
            if (!b.containsKey(e.getKey())) out.add(new Change(scopeOf(all, e.getValue()), keyOf(e.getValue(), e.getKey()), REMOVED, what(e.getValue(), a), ""));
        }
    }

    /** 实体那一份里除了字段还有分录（EntryEntity、子分录、树形分录）：单独标成「分录」，新增、删除连着的是一整张表，不是一列。 */
    static String scopeOf(String scope, Map<String, Object> item) {
        return "字段".equals(scope) && str(item.get("_Type_")).endsWith("EntryEntity") ? "分录" : scope;
    }

    @SuppressWarnings("unchecked")
    static void props(String scope, String key, Map<String, Object> was, Map<String, Object> now,
                      Map<String, Map<String, Object>> a, Map<String, Map<String, Object>> b, List<Change> out) {
        Set<String> names = new LinkedHashSet<String>(was.keySet());
        names.addAll(now.keySet());
        for (String p : names) {
            if ("Id".equals(p)) continue;
            Object x0 = was.get(p);
            Object y0 = now.get(p);
            //根控件上挂着列表、移动端这几份内嵌布局：往里逐元素比，不把整份 JSON 当一个值
            if (x0 instanceof Map && y0 instanceof Map && ((Map<String, Object>) x0).get("Items") instanceof List) {
                out.addAll(diff(scope + " " + p, (Map<String, Object>) x0, (Map<String, Object>) y0));
                continue;
            }
            //实体的主实体上挂着操作，每个操作上又挂着插件：同样逐个比
            if ("Operations".equals(p)) {
                elements("操作", list(x0), list(y0), out);
                continue;
            }
            if ("Plugins".equals(p)) {
                plugins(scope, key, list(x0), list(y0), out);
                continue;
            }
            String x = value(p, x0, a);
            String y = value(p, y0, b);
            if (!x.equals(y)) out.add(new Change(scope, key, label(p), x, y));
        }
    }

    /** 插件没有 Id，按类名对齐（脚本插件按 FPK）。 */
    static void plugins(String scope, String key, List<Object> before, List<Object> after, List<Change> out) {
        Map<String, Map<String, Object>> a = byClass(before);
        Map<String, Map<String, Object>> b = byClass(after);
        for (Map.Entry<String, Map<String, Object>> e : b.entrySet()) {
            Map<String, Object> was = a.get(e.getKey());
            if (was == null) {
                out.add(new Change(scope, key, PLUGIN, "", e.getKey()));
                continue;
            }
            Set<String> names = new LinkedHashSet<String>(was.keySet());
            names.addAll(e.getValue().keySet());
            for (String p : names) {
                String x = value(p, was.get(p), a);
                String y = value(p, e.getValue().get(p), b);
                if (!x.equals(y)) out.add(new Change(scope, key, PLUGIN + " " + e.getKey() + " " + p, x, y));
            }
        }
        for (String cls : a.keySet()) {
            if (!b.containsKey(cls)) out.add(new Change(scope, key, PLUGIN, cls, ""));
        }
    }

    /** 新增、删除的元素是什么：类型（操作带操作类型）、在哪个容器、名称。 */
    static String what(Map<String, Object> item, Map<String, Map<String, Object>> all) {
        StringBuilder sb = new StringBuilder(str(item.get("_Type_")));
        if (item.get("OperationType") != null) sb.append(" ").append(item.get("OperationType"));
        Object parent = item.get("ParentId");
        if (parent != null && all.containsKey(String.valueOf(parent))) sb.append("，在 ").append(value("ParentId", parent, all));
        Object name = item.get("Name");
        if (name != null && !"".equals(name)) sb.append("「").append(name instanceof String ? name : json(name)).append("」");
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    static List<Object> list(Object o) {
        return o instanceof List ? (List<Object>) o : Collections.emptyList();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Map<String, Object>> byId(List<Object> items) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<String, Map<String, Object>>();
        for (Object o : items) {
            if (o instanceof Map && ((Map<String, Object>) o).get("Id") != null) {
                out.put(String.valueOf(((Map<String, Object>) o).get("Id")), (Map<String, Object>) o);
            }
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Map<String, Object>> byClass(List<Object> plugins) {
        Map<String, Map<String, Object>> out = new LinkedHashMap<String, Map<String, Object>>();
        for (int i = 0; i < plugins.size(); i++) {
            if (!(plugins.get(i) instanceof Map)) continue;
            Map<String, Object> m = (Map<String, Object>) plugins.get(i);
            String id = !blank(str(m.get("ClassName"))) ? str(m.get("ClassName")) : !blank(str(m.get("FPK"))) ? "脚本 " + m.get("FPK") : "第 " + (i + 1) + " 个";
            out.put(id, m);
        }
        return out;
    }

    static String keyOf(Map<String, Object> item, String id) {
        Object k = item.get("Key");
        return k == null || "".equals(k) ? "id:" + id : String.valueOf(k);
    }

    static String value(String prop, Object v, Map<String, Map<String, Object>> all) {
        //序号 0 是默认值，存库时不写
        if (v == null) return "Index".equals(prop) ? "0" : "";
        if ("ParentId".equals(prop)) {
            Map<String, Object> parent = all.get(String.valueOf(v));
            return parent == null ? "id:" + v : keyOf(parent, String.valueOf(v));
        }
        //边框样式按 set 收的写法列，改前改后照着就能写回去
        if ("Style".equals(prop) && v instanceof Map) return FormLayoutProbe.styleText(v);
        return v instanceof String ? (String) v : json(v);
    }

    static String label(String prop) {
        if ("ParentId".equals(prop)) return "所在容器";
        if ("Index".equals(prop)) return "序号";
        return prop;
    }

    /**
     * 打差异，返回逐条列出的处数（顺延的不算）。
     * 一处不少：太长由工具那一层裁、能按行号或关键字取回；这里先截掉的，哪里都取不回（S44 批 1，
     * 真机一次预演 96 处只列 60 处，模型为找剩下 36 处翻了四次落盘文件）。
     */
    static int report(List<Change> changes, Set<String> targeted) {
        List<Change> shown = new ArrayList<Change>();
        int shifted = 0;
        for (Change c : changes) {
            //没点名的控件只是被挤得顺延了序号：合成一行，不逐个列
            if (!targeted.isEmpty() && "序号".equals(c.prop) && !targeted.contains(c.key.toLowerCase())) shifted++;
            else shown.add(c);
        }
        p("差异（改前 → 改后，按元素逐项比出来的）" + shown.size() + " 处" + (shifted == 0 ? "" : "，另有 " + shifted + " 个控件序号顺延") + "：");
        for (Change c : shown) {
            p("  " + clip(c.toString(), 300));
            ProbeJson.emit("layout-change", "scope", c.scope, "element", c.key, "prop", c.prop,
                    "before", clip(c.from, 200), "after", clip(c.to, 200));
        }
        if (shifted > 0) ProbeJson.emit("layout-shift", "count", shifted);
        return shown.size();
    }

    /**
     * 从这张布局派生出去的布局（继承路径里有它）：布局上的改动它们都继承，自己改过的那几项属性除外。
     * 确认单的「影响」照它写，不让模型猜（S42 批 5 真机：模型说派生布局没加上按钮，其实都继承到了）。
     */
    static void heirs(String formId) {
        final List<String> names = new ArrayList<String>();
        try {
            DB.query(DBRoute.meta, "/*dialect*/select FNUMBER from t_meta_formdesign"
                            + " where (FINHERITPATH like ? or FPARENTID = ?) and FID <> ? order by FNUMBER",
                    new Object[]{"%" + formId + "%", formId, formId},
                    (ResultSetHandler<Object>) rs -> {
                        while (rs.next()) names.add(rs.getString(1));
                        return null;
                    });
        } catch (Throwable e) {
            p("派生布局没查成（" + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage()) + "）");
            return;
        }
        if (names.isEmpty()) return;
        String some = String.join("、", names);
        p("派生布局 " + names.size() + " 张跟着变（它们自己改过的属性不变）：" + some);
        ProbeJson.emit("layout-heirs", "count", names.size(), "forms", some);
    }

    // ---------- 落库后回读 ----------

    /**
     * 重新读一遍库里那份，和交上去的逐元素比。交上去那份过了平台保存前的规整（列表布局是重写过的），
     * 读回来的也过一遍同样的规整再比，否则每次都报列表布局对不上。
     * 平台保存时会给没记父节点的控件补上 ParentId，这一类不算走样。
     * 已经落库了，这里报的是「库里以什么为准」，不是「要不要写」。
     */
    static void readBack(String formId, String entityId, MetadataSerializer fser, MetadataSerializer eser,
                         Map<String, Object> formPlanned, Map<String, Object> entityPlanned) {
        try {
            List<Change> left = new ArrayList<Change>();
            FormMetadata f = (FormMetadata) MetadataDao.readMeta(formId, MetaCategory.Form);
            EntityMetadata e = (EntityMetadata) MetadataDao.readMeta(entityId, MetaCategory.Entity);
            new MetadataWriter(f.getModelType()).convertToDesignMeta(e, f);
            left.addAll(diff("布局", formPlanned, fser.serializeToMap(f)));
            if (entityPlanned != null) left.addAll(diff("字段", entityPlanned, eser.serializeToMap(e)));
            int filled = 0;
            List<Change> real = new ArrayList<Change>();
            for (Change c : left) {
                if ("所在容器".equals(c.prop) && c.from.isEmpty()) filled++;
                else real.add(c);
            }
            if (real.isEmpty()) {
                p("回读核对：库里那份和交上去的一致（逐元素、逐属性比）"
                        + (filled == 0 ? "" : "；平台保存时给 " + filled + " 个控件补记了所在容器，不影响界面"));
                return;
            }
            p("!! 回读核对：库里那份和交上去的有 " + real.size() + " 处对不上 —— 已经落库了，这几处以库里为准：");
            for (Change c : real) {
                p("  " + clip(c.toString(), 300));
                ProbeJson.emit("layout-readback", "scope", c.scope, "element", c.key, "prop", c.prop,
                        "sent", clip(c.from, 200), "stored", clip(c.to, 200));
            }
        } catch (Throwable e) {
            p("!! 回读核对没跑成（已经落库了）：" + e.getClass().getSimpleName() + ": " + oneLine(e.getMessage())
                    + " —— 用 FormLayoutProbe 看一眼改过的地方");
        }
    }

    // ---------- 快照、备份 ----------

    static String baseline(Map<String, Object> form, Map<String, Object> entity) throws Exception {
        return sha256(json(form) + "\n" + json(entity)).substring(0, 16);
    }

    static boolean confirmedBaseline(String baseline) {
        String confirmed = System.getProperty("cosmic.baseline", "").trim();
        if (confirmed.isEmpty()) {
            p("未落库：没拿到用户确认过的改前快照，一处都没改。先 dry-run 一次拿确认，再用同一组入参执行");
            return false;
        }
        if (!confirmed.equals(baseline)) {
            p("未落库：改前数据和预演时不一样了（确认时 " + confirmed + "，现在 " + baseline + "），一处都没改。"
                    + "中间有人在设计器里保存过，确认单上的改动已经不是真的，重新 dry-run、重新确认");
            return false;
        }
        return true;
    }

    static void backup(String dir, String form, Map<String, Object> formMap, Map<String, Object> entityMap) throws Exception {
        File d = new File(dir);
        if (!d.isDirectory() && !d.mkdirs()) throw new IllegalStateException("建不了备份目录 " + d.getAbsolutePath());
        write(new File(d, safe(form) + ".form.json"), JsonLayout.layout(json(formMap)));
        File entityFile = new File(d, safe(form) + ".entity.json");
        if (entityMap != null) write(entityFile, JsonLayout.layout(json(entityMap)));
        //同一个目录上次留下的实体备份不属于这一次：留着，恢复时会把实体也写回去
        else if (entityFile.isFile() && !entityFile.delete()) throw new IllegalStateException("删不掉上次的实体备份 " + entityFile);
        p("改前备份：" + d.getAbsolutePath() + (entityMap == null ? "（布局）" : "（布局和实体）"));
    }

    static void write(File f, String text) throws Exception {
        try (Writer w = new OutputStreamWriter(new FileOutputStream(f), StandardCharsets.UTF_8)) {
            w.write(text);
        }
    }

    /**
     * 备份里记着哪些东西是从模板继承来的（Inherit：控件、字段、插件、内嵌的列表和移动端布局里的也有），
     * 平台从 JSON 反序列化时会丢掉这个标记。不补回去，写回库时它们会从「跟着模板走」变成「这张单据自己的一份」，
     * 模板以后再改就跟不上了。备份的 JSON 和反序列化出的对象结构一一对应，并排往下走，见到 Inherit=true 就设回去。
     */
    @SuppressWarnings("unchecked")
    static void restoreInherit(Object saved, Object obj, String path, List<String> problems) throws Exception {
        if (obj == null) return;
        if (saved instanceof List) {
            List<Object> list = (List<Object>) saved;
            List<Object> objs = obj instanceof List ? (List<Object>) obj : null;
            if (objs == null || objs.size() != list.size()) {
                if (json(list).contains("\"Inherit\":true")) problems.add("备份的 " + path + " 和读回来的对不上，继承标记补不回去");
                return;
            }
            //有 Id 的按 Id 配对：反序列化出的元素顺序和 JSON 里不一定一样（真机上内嵌列表布局的工具栏按钮就换过位置）
            Map<String, Object> byId = new HashMap<String, Object>();
            for (Object o : objs) {
                PropertyDescriptor pd = o == null ? null : descriptor(o, "Id");
                if (pd != null && pd.getReadMethod() != null) byId.put(String.valueOf(pd.getReadMethod().invoke(o)), o);
            }
            for (int i = 0; i < list.size(); i++) {
                Object s = list.get(i);
                Object id = s instanceof Map ? ((Map<String, Object>) s).get("Id") : null;
                Object o = id == null ? objs.get(i) : byId.get(String.valueOf(id));
                if (o == null) {
                    if (json(s).contains("\"Inherit\":true")) problems.add("备份的 " + path + " 里 " + id + " 读回来找不到，继承标记补不回去");
                    continue;
                }
                restoreInherit(s, o, path + "[" + (id == null ? String.valueOf(i) : String.valueOf(id)) + "]", problems);
            }
            return;
        }
        if (!(saved instanceof Map)) return;
        Map<String, Object> m = (Map<String, Object>) saved;
        if (Boolean.TRUE.equals(m.get("Inherit"))) {
            PropertyDescriptor pd = descriptor(obj, "Inherit");
            if (pd == null || pd.getWriteMethod() == null) problems.add("备份的 " + path + " 标着继承自模板，读回来的对象上设不了");
            else pd.getWriteMethod().invoke(obj, Boolean.TRUE);
        }
        for (Map.Entry<String, Object> e : m.entrySet()) {
            if (!(e.getValue() instanceof Map || e.getValue() instanceof List)) continue;
            if (!json(e.getValue()).contains("\"Inherit\":true")) continue;
            PropertyDescriptor pd = descriptor(obj, e.getKey());
            Object child = pd == null || pd.getReadMethod() == null ? null : pd.getReadMethod().invoke(obj);
            if (child == null) problems.add("备份的 " + path + "." + e.getKey() + " 读回来没有，继承标记补不回去");
            else restoreInherit(e.getValue(), child, path + "." + e.getKey(), problems);
        }
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> readJson(File f) throws Exception {
        return OM.readValue(new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8), Map.class);
    }

    // ---------- 小工具 ----------

    static PropertyDescriptor descriptor(Object o, String name) throws Exception {
        for (PropertyDescriptor pd : Introspector.getBeanInfo(o.getClass(), Object.class).getPropertyDescriptors()) {
            if (pd.getName().equalsIgnoreCase(name)) return pd;
        }
        return null;
    }

    static String sha256(String s) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    static String json(Object o) {
        try {
            return OM.writeValueAsString(o);
        } catch (Exception e) {
            return String.valueOf(o);
        }
    }

    static String show(Object o) {
        if (o instanceof Style) return FormLayoutProbe.styleText(o);
        return o instanceof String || o instanceof Number || o instanceof Boolean ? String.valueOf(o) : json(o);
    }

    static String safe(String s) {
        return s.replaceAll("[^A-Za-z0-9._-]", "_");
    }

    static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    static boolean blank(String s) {
        return s == null || s.trim().isEmpty();
    }

    static String oneLine(String s) {
        if (s == null) return "";
        String one = s.replace("\r", "").replace("\n", " ");
        return one.length() <= 300 ? one : one.substring(0, 300) + "…";
    }

    static String clip(String s, int n) {
        String one = s.replace("\r", "").replace("\n", " ");
        return one.length() <= n ? one : one.substring(0, n) + "…";
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
