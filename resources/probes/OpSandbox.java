import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import kd.bos.dataentity.OperateOption;
import kd.bos.dataentity.entity.DynamicObject;
import kd.bos.dataentity.entity.DynamicObjectCollection;
import kd.bos.dataentity.metadata.ICollectionProperty;
import kd.bos.dataentity.metadata.IDataEntityProperty;
import kd.bos.dataentity.metadata.IDataEntityType;
import kd.bos.entity.BillEntityType;
import kd.bos.entity.EntityMetadataCache;
import kd.bos.entity.MainEntityType;
import kd.bos.entity.operate.result.IOperateInfo;
import kd.bos.entity.operate.result.OperateErrorInfo;
import kd.bos.entity.operate.result.OperationResult;
import kd.bos.entity.property.BasedataProp;
import kd.bos.entity.property.EntryProp;
import kd.bos.entity.property.MulBasedataProp;
import kd.bos.entity.validate.ValidateResult;
import kd.bos.entity.validate.ValidateResultCollection;
import kd.bos.metadata.dao.MetaCategory;
import kd.bos.metadata.dao.MetadataDao;
import kd.bos.metadata.entity.EntityMetadata;
import kd.bos.orm.ORM;
import kd.bos.orm.query.QFilter;
import kd.bos.servicehelper.BusinessDataServiceHelper;
import kd.bos.servicehelper.QueryServiceHelper;
import kd.bos.servicehelper.coderule.CodeRuleServiceHelper;
import kd.bos.servicehelper.operation.OperationServiceHelper;
import kd.bos.coderule.api.CodeRuleInfo;

/**
 * 操作插件免界面验证沙箱：造一张单 → 跑一次操作（真提交，S27）→ 把结果摊平成一行一条。
 *
 * 不起节点、不点界面，走的是业务代码同一条路径
 * （OperationServiceHelper.executeOperate → 分发桥 → OperationServiceImpl.localInvokeOperation），
 * 所以操作插件（AbstractOperationServicePlugin / AbstractValidator）会真的被调用。
 *
 * **真提交**（S27，用户 2026-09-19：agent 连的必然是纯测试环境，数据坏了能从生产复原）。
 * 以前整段套在 TX.beginNew() + markRollback() 里永远不落库，代价是每次一个新进程、提交后的事验不到。
 * 现在和界面上点一下一样：操作自己开事务、自己提交；跑完打一行这张单在库里的现状（pk、编号、状态），
 * 下一次再跑同一张单，拿到的就是那个样子。
 *
 * 参数（driver.mjs run op 会替你填）：
 *   OP_ENTITY  实体标识，必填
 *   OP_NAME    操作标识，默认 save
 *   OP_SET     赋值，`字段=值` 用 `;` 隔开。分录写 `分录标识.字段=值` 或 `分录标识[2].字段=值`，
 *              子分录写 `分录标识[2].子分录标识[1].字段=值`（行不够都会自动补）。
 *              值的写法见 {@link ExpectSpec#convert}：基础资料 id 或 number 都认、多选逗号分隔、
 *              日期 `yyyy-MM-dd` / `yyyy-MM-dd HH:mm:ss` / `now`、`null` 表示清空。
 *              `@上游.单据标识.字段=值`（`@下游.` 同理）改的是这张单连着的那类单：跑之前直接存库改上，
 *              这个场景跑完改回，要配 OP_PK（见 {@link LinkedSet}）。
 *   OP_PK     给了就 loadSingle 这条已有单据（验 submit / audit / unaudit 这类），
 *              OP_SET 在它之上覆盖；不给就 newDynamicObject 造空单。写成 billno:单据编号 就按编号查出 pk。
 *              单据状态例外：提交、审核、反审核一开始平台从库里重读它（审核、反审核连 enable），
 *              OP_SET 写的和库里不同就记「输入不成立」、不跑（见 {@link #reloadedByOp}）
 *   OP_COUNT_FILTER  行数对照的过滤条件，形如 `字段=值`，不给就数全表
 *   OP_EXPECT  业务断言，`key=值` 用 `;` 隔开。`success` / `message` / `error` 断操作结果
 *              （后两者是**包含**不是相等），其余当字段路径；操作异常时独立回读数据库，字段符合不代表整体成功。
 *              **不给就只能算「跑过了」**：verify 判 EXECUTED 而不是 PASS。
 *   OP_PKGS    本工程的 Java 包前缀，逗号分隔（run op 会替你填）。只用来在异常栈里指认
 *              「出错的是本工程的哪个类」；不给就只能说「判不出是不是本工程的代码」。
 *   OP_CASES   **批量模式**：一次运行跑多个场景，格式见 {@link #parseCases()}。
 *              给了它就忽略上面那些单场景变量（OP_ENTITY 仍作为 entity 的默认值）。
 *              每个场景独立取单、断言按场景号分组归属；都是真提交，同一张单上前一个场景的结果后一个看得见。
 *              driver 的 `run op … --case …` 会替你编好这一串。
 *
 * <b>批量的边界</b>：N 个场景共用一个 JVM、按顺序真提交。造新单的场景互不影响；
 * 几个场景写同一个 --pk 时，后一个拿到的是前一个提交之后的单。`@上游.` 改的连着的单每个场景跑完就改回，
 * 后一个场景看到的是原值。
 */
public class OpSandbox {

    /**
     * 一个待跑的场景。批量模式下每个场景**独立取单、独立断言归属**，按顺序真提交。
     */
    private static final class Case {
        /** 打印用的名字，永不为空。 */
        String id = "单场景";
        /**
         * 断言归属键。**只有 OP_CASES 来的场景才有**：单场景旁路里不带 case 字段，
         * verify / 草稿那边 attributeAll 的归属方式不能被打破。
         *
         * 不能拿「场景数 > 1」当判据 —— `--case` 只写了一个时场景数就是 1，
         * 旁路里少了 case 字段，草稿侧按标签一条也认不回来（2026-09-14 复盘）。
         */
        String key;
        String entity = "";
        String op = "save";
        String pk = "";
        String set = "";
        String expect = "";
        String countFilter = "";
    }

    public static void run() throws Exception {
        List<Case> cases = parseCases();
        //横幅只跟场景数有关；断言归属跟它无关，由 c.key 说了算（见 Case.key）
        boolean batch = cases.size() > 1;
        if (batch) {
            System.out.println("[PROBE] === OpSandbox 批量 " + cases.size()
                    + " 个场景，共用这一次运行 ===");
        }

        int aborted = 0;
        for (int i = 0; i < cases.size(); i++) {
            Case c = cases.get(i);
            //断言归属：批量时按场景分组，verify 按旁路里的 case 字段各判各的
            ProbeAssert.inCase(c.key);
            if (batch) {
                System.out.println("[PROBE]");
                System.out.println("[PROBE] ########## 场景 " + (i + 1) + "/" + cases.size()
                        + "  " + c.id + " ##########");
            }
            try {
                runOne(c);
            } catch (Throwable t) {
                //**一个场景炸了不许带走后面的**：中途 return 等于把后面的场景都丢了。
                //记 FAIL 不记跳过 —— 「没跑成」和「通过了」之间没有中间态
                aborted++;
                System.out.println("[PROBE] ✘ 场景 " + c.id + " 中止：" + brief(t));
                if (t instanceof ProbeAssert.InputInvalid) {
                    //输入不成立已经在抛出处记过：再补一条 FAIL，这个带错字的场景就永远换不掉了
                    continue;
                }
                explain(t);
                ProbeAssert.unresolved("op-scenario", c.id, "能跑完", "场景中止：" + brief(t));
            }
        }
        ProbeAssert.inCase(null);

        if (batch) {
            System.out.println("[PROBE]");
            System.out.println("[PROBE] === 批量结束：" + cases.size() + " 个场景，"
                    + (aborted == 0 ? "无中止" : aborted + " 个中止") + " ===");
        }
        if (!ProbeAssert.summary()) {
            throw new ProbeAssert.Failed("断言失败");
        }
    }

    /** 跑一个场景：造单/取单 → 执行操作（真提交）→ 摊平结果 → 断言。 */
    private static void runOne(Case c) throws Exception {
        //run 的 --billno 传进来是 billno:编号，先换成 pk；后面的授权、查存在、loadSingle 全按 pk 走
        try {
            c.pk = MetaResolve.pkOf(c.entity, c.pk);
        } catch (IllegalArgumentException e) {
            ProbeAssert.inputInvalid("op-pk", c.entity + " " + c.pk, e.getMessage());
            throw new ProbeAssert.InputInvalid(e.getMessage());
        }
        System.out.println("[PROBE] === 实体=" + c.entity + " 操作=" + c.op
                + (c.pk.isEmpty() ? " 造空单" : " 单据pk=" + c.pk) + " ===");

        //只跑本 ISV 的单据（docs/项目管理/验收记录.md D3）：验的是本工程的插件，别家单据的操作链不是这里的对象。
        //**每个场景各查各的** —— 批量里混进一张别家单据，不能因为第一个场景过了就放行
        EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                MetadataDao.getIdByNumber(c.entity, MetaCategory.Entity), MetaCategory.Entity);
        IsvGuard.assertOwnEntity(c.entity, em);

        MainEntityType met = MetaResolve.type(c.entity);
        //`@上游.单据.字段=值` / `@下游.…` 改的是连着的单，交给 LinkedSet；剩下的才是这张单自己的
        String[] split = LinkedSet.split(c.set);
        String own = split[0];
        List<String[]> wrong = wrongPaths(met, own);
        if (!wrong.isEmpty()) {
            for (String[] w : wrong) {
                ProbeAssert.inputInvalid("op-set", w[0], w[1]);
            }
            throw new ProbeAssert.InputInvalid("--set 有 " + wrong.size() + " 处写错，这次没有保存");
        }
        //pk 先查一遍再 loadSingle：查不到时 loadSingle 直接抛平台异常，分不出是「pk 写错」还是操作链出了事
        if (!c.pk.isEmpty() && !QueryServiceHelper.exists(c.entity, new QFilter[]{new QFilter("id", "=", pkValue(c.pk))})) {
            ProbeAssert.inputInvalid("op-pk", c.entity + " pk=" + c.pk, "pk 在 " + c.entity + " 里查不到（pk 写错，或者是别的单据的 pk）");
            throw new ProbeAssert.InputInvalid("pk 查不到：" + c.pk);
        }
        List<String[]> reloaded = reloadedByOp(c, met, own);
        if (!reloaded.isEmpty()) {
            for (String[] w : reloaded) {
                ProbeAssert.inputInvalid("op-set", w[0], w[1]);
            }
            throw new ProbeAssert.InputInvalid("--set 有 " + reloaded.size() + " 处会被平台从库里重读盖掉，这次没有跑");
        }
        //连着的单先改好再取这张单：单上引用连着的单的字段，取单时就把那张单的值一起带进来了
        List<LinkedSet.Bill> linked = LinkedSet.apply(c.entity, c.pk, split[1]);
        try {
            runOn(c, met, own);
        } finally {
            LinkedSet.restore(linked);
        }
    }

    /** 连着的单已经摆好：取单、设值、执行操作、摊平结果、断言。 */
    private static void runOn(Case c, MainEntityType met, String own) throws Exception {
        DynamicObject obj = c.pk.isEmpty()
                ? BusinessDataServiceHelper.newDynamicObject(c.entity)
                : BusinessDataServiceHelper.loadSingle(c.pk, c.entity);
        if (obj == null) {
            ProbeAssert.inputInvalid("op-pk", c.entity + " pk=" + c.pk, "pk 在 " + c.entity + " 里查不到");
            throw new ProbeAssert.InputInvalid("pk 查不到：" + c.pk);
        }
        Map<String, String> prior = c.pk.isEmpty() ? null : ExpectSpec.priorValues(obj, c.expect, own);
        List<String> unresolved = applySets(met, obj, own);
        if (!unresolved.isEmpty()) {
            //跑下去也没意义：插件读这些字段就是 null，炸了也怪不到业务头上。
            //在这里停住，比让它伪装成一次业务失败强。
            for (String path : unresolved) {
                ProbeAssert.inputInvalid("op-set", path, "基础资料没物化，插件读到的会是 null");
            }
            throw new ProbeAssert.InputInvalid("基础资料没物化，插件读到的是 null，这次不跑了："
                    + String.join("、", unresolved));
        }

        QFilter[] cf = countFilter(c.countFilter);
        int before = count(c.entity, cf);
        System.out.println("[PROBE] 跑之前行数=" + before);

        //S27：真提交，和用户在界面上点一下同一回事 —— 操作自己开事务、自己提交，失败自己回退。
        //以前整段套在 TX.beginNew + markRollback 里：库是撤回了，常驻进程里的缓存撤不回，
        //于是每次都得起一个新进程（85～100 秒，真正在验的不到 10 秒），提交之后才发生的事也验不到。
        System.out.println("[PROBE] --- 执行 " + c.op + "（真提交，和界面上点一下一样）---");
        OperationResult r = null;
        Throwable err = null;
        long t0 = System.currentTimeMillis();
        try {
            r = OperationServiceHelper.executeOperate(c.op, c.entity,
                    new DynamicObject[]{obj}, OperateOption.create());
        } catch (Throwable t) {
            err = t;
        }
        System.out.println("[PROBE] 耗时 " + (System.currentTimeMillis() - t0) + "ms");

        if (err != null) {
            System.out.println("[PROBE] 抛异常 " + brief(err));
            explain(err, c.op, ownOpPlugins(c.entity, c.op));
        }
        report(met, r);

        int after = count(c.entity, cf);
        System.out.println("[PROBE] 跑之后行数=" + after
                + (before >= 0 && after >= 0 && after != before ? "（" + (after > before ? "+" : "") + (after - before) + "）" : ""));
        Boolean done = err == null && r != null && r.isSuccess() ? Boolean.TRUE : null;
        if (done == null) {
            System.out.println("[PROBE] 提交状态未知：操作已调用，但未取得成功结果；不能据此认定未提交，不应直接重跑。请以数据库回读核对现状。");
        }
        MetaResolve.reportCommitted(c.entity, obj.getPkValue(), c.pk.isEmpty() ? "新建" : c.op, done);

        //断言放在最后：上面那些行数对照是排查线索，业务对不对由 --expect 裁判。
        //读的是内存里的 obj —— 操作插件往单据对象上写的值，正是要断的东西。
        ProbeJson.emit("scenario", "case", c.key, "adapter", "run op",
                "entity", c.entity, "op", c.op,
                "pk", c.pk.isEmpty() ? null : c.pk, "committed", done);
        DynamicObject readback = null;
        if (done == null) {
            try {
                Object pk = c.pk.isEmpty() ? obj.getPkValue() : pkValue(c.pk);
                if (pk != null && !"0".equals(String.valueOf(pk))) {
                    readback = BusinessDataServiceHelper.loadSingle(pk, c.entity);
                }
                System.out.println("[PROBE] 字段数据库回读=" + (readback == null ? "未取得单据" : "已取得；仅证明当前值，不证明本次操作完整提交"));
            } catch (Throwable readError) {
                System.out.println("[PROBE] 字段数据库回读失败：" + brief(readError));
            }
        }
        if (err != null) {
            ProbeAssert.unresolved("op-exception", c.op, "无未处理异常", brief(err));
        }
        ExpectSpec.operation(r, readback == null ? obj : readback, c.expect, readback != null);
        //操作没成功时字段断言本来就不算数，没有「碰巧对上」可说
        if (r != null && r.isSuccess()) {
            ExpectSpec.notePrior(prior, obj, c.expect);
        }
    }

    /**
     * 场景清单。给了 OP_CASES 就按它解析，否则退回单场景（老的 OP_* 变量，行为一字不变）。
     *
     * 格式是逐行的、可读的 —— 存进 build/last-probe.out 之后人还看得懂这次到底跑了什么：
     * <pre>
     *   [case] CASE-035
     *   op=save
     *   pk=2552980953672728576
     *   set=zlgd_byzjl.zlgd_iabyz=99
     *   expect=success=true;zlgd_jcjl[0].zlgd_ddlac=12
     *   [case] CASE-036
     *   set=number=T1;zlgd_byzjl.zlgd_iabyz=7
     *   expect=success=true
     * </pre>
     * <b>不用 JSON</b>：值里本来就带等号和分号，再套一层转义只是多一处出错的地方。
     * 每行只切第一个等号，值原样取到行尾。entity 不写就用 OP_ENTITY。
     */
    private static List<Case> parseCases() {
        String spec = env("OP_CASES", "");
        String dftEntity = env("OP_ENTITY", "");
        List<Case> out = new ArrayList<Case>();

        if (spec.isEmpty()) {
            if (dftEntity.isEmpty()) {
                System.out.println("[PROBE] 缺 OP_ENTITY。用法：driver.mjs run op <实体> <操作> [--set 字段=值 …]");
                throw new IllegalStateException("缺 OP_ENTITY");
            }
            Case c = new Case();
            c.entity = dftEntity;
            c.op = env("OP_NAME", "save");
            c.pk = env("OP_PK", "");
            c.set = env("OP_SET", "");
            c.expect = env("OP_EXPECT", "");
            c.countFilter = env("OP_COUNT_FILTER", "");
            out.add(c);
            return out;
        }

        Case cur = null;
        for (String raw : spec.split("\n")) {
            String line = raw.trim();
            if (line.isEmpty()) {
                continue;
            }
            if (line.startsWith("[case]")) {
                cur = new Case();
                cur.id = line.substring("[case]".length()).trim();
                if (cur.id.isEmpty()) {
                    cur.id = "场景" + (out.size() + 1);
                }
                cur.key = cur.id;
                cur.entity = dftEntity;
                out.add(cur);
                continue;
            }
            if (cur == null) {
                System.out.println("[PROBE] ⚠ OP_CASES 里 [case] 之前的行被忽略：" + line);
                continue;
            }
            int eq = line.indexOf('=');
            if (eq <= 0) {
                System.out.println("[PROBE] ⚠ OP_CASES 忽略「" + line + "」—— 不是 键=值 的形状");
                continue;
            }
            String k = line.substring(0, eq).trim();
            String v = line.substring(eq + 1).trim();
            if ("entity".equals(k)) {
                cur.entity = v;
            } else if ("op".equals(k)) {
                cur.op = v.isEmpty() ? "save" : v;
            } else if ("pk".equals(k)) {
                cur.pk = v;
            } else if ("set".equals(k)) {
                cur.set = v;
            } else if ("expect".equals(k)) {
                cur.expect = v;
            } else if ("count".equals(k)) {
                cur.countFilter = v;
            } else {
                System.out.println("[PROBE] ⚠ OP_CASES 不认识的键「" + k
                        + "」，合法的是 entity / op / pk / set / expect / count");
            }
        }

        if (out.isEmpty()) {
            throw new IllegalStateException("OP_CASES 里一个 [case] 都没有");
        }
        //**重名当场拒绝**：verify 和草稿都按 case 字段分组，两个场景同名会被合成一条，
        //于是「场景 B 挂了」显示成「场景 A 挂了」—— 往错的方向找一整轮
        List<String> seen = new ArrayList<String>();
        for (Case c : out) {
            if (c.entity.isEmpty()) {
                throw new IllegalStateException("场景 " + c.id + " 没有 entity，OP_ENTITY 也没给");
            }
            if (seen.contains(c.id)) {
                throw new IllegalStateException("OP_CASES 里场景号重复：" + c.id);
            }
            seen.add(c.id);
        }
        return out;
    }

    // ---------- 结果摊平：一行一条，给 agent 直接读的 ----------

    static void report(MainEntityType met, OperationResult r) {
        if (r == null) {
            System.out.println("[PROBE] 结果 (无) —— 操作根本没跑起来，看上面的异常");
            return;
        }
        System.out.println("[PROBE] 结果 isSuccess=" + r.isSuccess()
                + "  成功=" + r.getSuccessPkIds().size()
                + "  message=" + nz(r.getMessage()));

        ValidateResultCollection vrs = r.getValidateResult();
        if (vrs != null) {
            for (ValidateResult vr : vrs.getValidateErrors()) {
                List<OperateErrorInfo> es = vr.getAllErrorInfo();
                System.out.println("[PROBE] 校验器 " + vr.getValidatorKey() + " 报 " + es.size() + " 条");
                for (OperateErrorInfo e : es) {
                    System.out.println("[PROBE]   [校验] " + oneLine(e.getMessage())
                            + keysIn(met, e.getMessage()));
                }
            }
        }
        List<IOperateInfo> infos = r.getAllErrorOrValidateInfo();
        if (!infos.isEmpty()) {
            System.out.println("[PROBE] 汇总 " + infos.size() + " 条");
            for (IOperateInfo i : infos) {
                System.out.println("[PROBE]   [错误] " + oneLine(i.getMessage())
                        + keysIn(met, i.getMessage()));
            }
        }
    }

    /** 数字 pk 按 long 查，查不成数字的原样查（有的单据主键是字符串）。 */
    private static Object pkValue(String pk) {
        try {
            return Long.valueOf(pk.trim());
        } catch (NumberFormatException notNumber) {
            return pk.trim();
        }
    }

    // ---------- 赋值 ----------

    /**
     * `字段=值;…` 里的每个路径先对着单据元数据核一遍：不是 `字段=值` 的形状、分录 / 子分录 / 字段标识写错、
     * 下拉写成了显示名（{@link ExpectSpec#comboNameProblem}），一次列全。返回 {路径, 哪里不对}，空表就是都对。
     * 不猜相近的名字：拼写像的候选一给就是好几个，多半不对（用户 2026-09-26 定）；只说哪一层没有，
     * 字段标识一字不差地在别的层时说它在哪一层——那是查到的，不是猜的。
     *
     * 造数、改数、run op、run print --set 这四条会保存的路，都在建对象、开事务之前调它，有一条就整次不跑。
     * 以前只有改数和打印自己核，造数和 run op 靠 {@link #applySets} 边设边打「⚠ 没有字段」，然后照样保存：
     * 真机 2026-09-22 造数把 zlgd_org、zlgd_wtdw 写错，探针打了两行 ⚠，还是走完保存，108 秒后败在校验器上。
     *
     * 核的是平台元数据，不是本地代码关系表：关系表只收代码里用到的字段、不收继承来的原厂字段，
     * 真机历史写入里真实存在的字段有三成在表里查不到（billno、org、number 都在其中）。
     */
    static List<String[]> wrongPaths(MainEntityType met, String spec) {
        List<String[]> wrong = new ArrayList<String[]>();
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            if (eq <= 0) {
                wrong.add(new String[]{s, "不是 字段=值 的形状"});
                continue;
            }
            String path = s.substring(0, eq).trim();
            ExpectSpec.Pos pos;
            try {
                pos = ExpectSpec.Pos.parse(path);
            } catch (RuntimeException e) {
                wrong.add(new String[]{path, "路径写法不对：" + e.getMessage()});
                continue;
            }
            IDataEntityType host = met;
            if (pos.entry != null) {
                IDataEntityType rows = ExpectSpec.itemType(host, pos.entry);
                if (rows == null) {
                    wrong.add(new String[]{path, "没有分录 " + pos.entry});
                    continue;
                }
                host = rows;
            }
            if (pos.sub != null) {
                IDataEntityType rows = ExpectSpec.itemType(host, pos.sub);
                if (rows == null) {
                    wrong.add(new String[]{path, "分录 " + pos.entry + " 上没有子分录 " + pos.sub});
                    continue;
                }
                host = rows;
            }
            Object prop = host.getProperties().get(pos.field);
            if (!(prop instanceof IDataEntityProperty)) {
                //名字对、层写错（分录上的字段写到表头，或反过来）比名字写错常见
                String other = elsewhere(met, pos.field);
                wrong.add(new String[]{path, where(pos) + "上没有字段 " + pos.field
                        + (other.isEmpty() ? "" : "；它在别的层，写成 " + other)});
                continue;
            }
            String combo = ExpectSpec.comboNameProblem((IDataEntityProperty) prop, s.substring(eq + 1));
            if (combo != null) {
                wrong.add(new String[]{path, combo});
            }
        }
        return wrong;
    }

    /**
     * `--set` 写到的、这次操作一开始平台就会从库里重读的表头字段。返回 {路径, 哪里不对}，空表就是没有。
     *
     * 平台的提交、审核、反审核（kd.bos.service.operation 的 Submit / Audit / UnAudit，以及继承它们的操作服务）
     * 在 initialize 里按 pk 把单据状态（操作参数 statusProp 指的字段）从库里读回来，盖掉传进来的值；
     * 审核、反审核连 enable 一起（反编译这三个类的 initialize 核过）。所以 --set 写的值到不了校验器，也到不了插件。
     * 真机 2026-10-17：两张已审核的检测单 --set billstatus=B 再审核，照样报「单据状态必须为已提交才能审核」，
     * 记成两条没过的验证记录，同一条命令怎么重跑都过不了，交付一直被挡着。
     *
     * 写的值和库里一样时放行：盖掉也还是这个值，这次运行照样成立。新建的单没有 pk，平台不重读。
     * 操作类型取不到时照常跑——平台自己会说操作有什么问题，这里不替它猜。
     */
    static List<String[]> reloadedByOp(Case c, MainEntityType met, String spec) {
        List<String[]> out = new ArrayList<String[]>();
        if (c.pk.isEmpty() || spec.trim().isEmpty() || !(met instanceof BillEntityType)) {
            return out;
        }
        Map<String, Object> meta;
        String kind;
        try {
            meta = EntityMetadataCache.getDataEntityOperate(c.entity, c.op);
            kind = statusOpKind(String.valueOf(meta.get("type")));
        } catch (Throwable t) {
            return out;
        }
        if (kind == null) {
            return out;
        }
        //和平台同一个来源：StatusConvertOperateService 只认操作参数里的 statusProp，没配就不重读
        Object parameter = meta.get("parameter");
        Object statusProp = parameter instanceof Map ? ((Map<?, ?>) parameter).get("statusProp") : null;
        if (statusProp == null || String.valueOf(statusProp).trim().isEmpty()) {
            return out;
        }
        List<String> fields = new ArrayList<String>();
        fields.add(String.valueOf(statusProp).trim());
        if (!"提交".equals(kind) && met.getProperties().get("enable") != null) {
            fields.add("enable");
        }
        for (String one : spec.split(";")) {
            int eq = one.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            String path = one.substring(0, eq).trim();
            String val = one.substring(eq + 1).trim();
            ExpectSpec.Pos pos = ExpectSpec.Pos.parse(path);
            if (pos.entry != null || !fields.contains(pos.field)) {
                continue;
            }
            DynamicObject row = QueryServiceHelper.queryOne(c.entity, pos.field,
                    new QFilter[]{new QFilter("id", "=", pkValue(c.pk))});
            String db = row == null || row.get(pos.field) == null ? "" : String.valueOf(row.get(pos.field));
            if (db.equals(val)) {
                continue;
            }
            out.add(new String[]{path, kind + "一开始平台会从库里重读 " + pos.field + "（这张单库里是 "
                    + (db.isEmpty() ? "空" : db) + "），--set 改不了它，校验器和插件看到的都是库里的值。"
                    + "要在库里是 " + val + " 的单上验，就换一张这样的单，或者先跑把它变成 " + val + " 的那个操作"});
        }
        return out;
    }

    /** 操作类型背后的操作服务是不是提交、审核、反审核（含继承它们的），按平台自己建操作服务的那一步认。 */
    private static String statusOpKind(String type) throws Exception {
        Object service = Class.forName("kd.bos.service.operation.EntityOperateTypes")
                .getMethod("createEntityOperate", String.class).invoke(null, type);
        for (Class<?> k = service == null ? null : service.getClass(); k != null; k = k.getSuperclass()) {
            if ("kd.bos.service.operation.Audit".equals(k.getName())) {
                return "审核";
            }
            if ("kd.bos.service.operation.UnAudit".equals(k.getName())) {
                return "反审核";
            }
            if ("kd.bos.service.operation.Submit".equals(k.getName())) {
                return "提交";
            }
        }
        return null;
    }

    /** 字段在表头、各分录、各子分录里的写法，逗号分隔；哪一层都没有返回空串。 */
    private static String elsewhere(MainEntityType met, String field) {
        List<String> at = new ArrayList<String>();
        Object head = met.getProperties().get(field);
        if (head instanceof IDataEntityProperty && !(head instanceof EntryProp)) {
            at.add(field);
        }
        for (Object o : met.getProperties()) {
            if (!(o instanceof EntryProp)) {
                continue;
            }
            EntryProp entry = (EntryProp) o;
            IDataEntityType rows = entry.getItemType();
            if (rows == null) {
                continue;
            }
            if (rows.getProperties().get(field) != null) {
                at.add(entry.getName() + "[0]." + field);
            }
            for (Object s : rows.getProperties()) {
                if (!(s instanceof EntryProp)) {
                    continue;
                }
                EntryProp sub = (EntryProp) s;
                IDataEntityType subRows = sub.getItemType();
                if (subRows != null && subRows.getProperties().get(field) != null) {
                    at.add(entry.getName() + "[0]." + sub.getName() + "[0]." + field);
                }
            }
        }
        return String.join(" 或 ", at);
    }

    static List<String> applySets(MainEntityType met, DynamicObject obj, String spec) {
        List<String> unresolved = new ArrayList<String>();
        if (spec.trim().isEmpty()) {
            return unresolved;
        }
        for (String one : spec.split(";")) {
            String s = one.trim();
            if (s.isEmpty()) {
                continue;
            }
            int eq = s.indexOf('=');
            if (eq <= 0) {
                System.out.println("[PROBE]   ⚠ 忽略「" + s + "」—— 不是 字段=值 的形状");
                continue;
            }
            String path = s.substring(0, eq).trim();
            String val = s.substring(eq + 1).trim();
            try {
                setOne(met, obj, path, val, unresolved);
            } catch (Throwable t) {
                System.out.println("[PROBE]   ⚠ " + path + " 设不上：" + brief(t));
            }
        }
        return unresolved;
    }

    /**
     * 一条 `字段=值`。路径与值都走共用契约：{@link ExpectSpec.Pos} 解析
     * `字段` / `分录[i].字段` / `分录[i].子分录[j].字段`，{@link ExpectSpec#convert} 转值。
     *
     * 此前这里自己切**第一个点**，于是三段路径被拆成 entry=分录、key=`子分录.字段`，
     * 报的是「分录 X 上没有字段 子分录.字段」—— 如实、但写不了；同一条 `--set` 在
     * `run form` 下成立、在 `run op` 下不成立，而用例正是从一个适配器抄到另一个的。
     */
    static void setOne(MainEntityType met, DynamicObject obj, String path, String val,
            List<String> unresolved) {
        ExpectSpec.Pos pos = ExpectSpec.Pos.parse(path);
        DynamicObject host = obj;
        if (pos.entry != null) {
            DynamicObjectCollection coll = obj.getDynamicObjectCollection(pos.entry);
            if (coll == null) {
                System.out.println("[PROBE]   ⚠ 没有分录 " + pos.entry);
                return;
            }
            while (coll.size() <= pos.row) {
                coll.addNew();
            }
            host = coll.get(pos.row);
            if (pos.sub != null) {
                //子分录挂在某一父行下，行数只能从那一行的集合上数
                DynamicObjectCollection subs = host.getDynamicObjectCollection(pos.sub);
                if (subs == null) {
                    System.out.println("[PROBE]   ⚠ 分录 " + pos.entry + " 上没有子分录 " + pos.sub);
                    return;
                }
                while (subs.size() <= pos.subRow) {
                    subs.addNew();
                }
                host = subs.get(pos.subRow);
            }
        }

        String key = pos.field;
        IDataEntityProperty p = (IDataEntityProperty) host.getDataEntityType().getProperties().get(key);
        if (p == null) {
            System.out.println("[PROBE]   ⚠ " + where(pos) + "上没有字段 " + key);
            return;
        }
        Object value = ExpectSpec.convert(p, val);
        String was = "（原值 " + was(host, key) + "）";
        //多选基础资料在 DynamicObject 上是一张子表：一行一个 fbasedataid_id。
        //没有 IDataModel 可以借（沙箱不建 View），所以这里自己写行，
        //而不是像 FormSim 那样把 id 数组交给 MulBasedataProp.setFieldValue
        if (p instanceof MulBasedataProp) {
            DynamicObjectCollection rows = host.getDynamicObjectCollection(key);
            if (rows == null) {
                System.out.println("[PROBE]   ⚠ " + path + " 取不到多选基础资料的子表，设不上");
                return;
            }
            rows.clear();
            Object[] ids = value == null ? new Object[0] : (Object[]) value;
            String mulBase = ((MulBasedataProp) p).getBaseEntityId();
            int missed = 0;
            for (Object id : ids) {
                DynamicObject row = rows.addNew();
                DynamicObject ref = loadRef(mulBase, id);
                if (ref == null) {
                    row.set(MulBasedataProp.KEY_BASEDATAID_ID, id);
                    missed++;
                } else {
                    row.set(MulBasedataProp.KEY_BASEDATAID, ref);
                }
            }
            if (missed > 0) {
                System.out.println("[PROBE]   ⚠ set " + path + " = " + val + "：" + missed + "/" + ids.length
                        + " 项在 " + mulBase + " 里取不到数据，只写进了 id，"
                        + "插件里 getDynamicObject(\"fbasedataid\") 会是 null");
                unresolved.add(path);
            } else {
                System.out.println("[PROBE]   set " + path + " = " + val + " (" + ids.length + " 项已物化)" + was);
            }
            return;
        }
        if (p instanceof BasedataProp) {
            setBasedata(host, (BasedataProp) p, key, path, val, value, unresolved, was);
            return;
        }
        host.set(key, value);
        System.out.println("[PROBE]   set " + path + " = " + val + was);
    }

    /**
     * --set 之前这个字段是什么。S27 起运行真提交，上一次运行改过的值会留在单上；
     * 打出原值，下一次运行的人才看得出「这个值是我这次给的，还是上次留下的」——
     * 断言靠的字段没在这次给值、却碰巧对上，就是假通过。
     */
    private static String was(DynamicObject host, String key) {
        try {
            Object v = host.get(key);
            if (v instanceof DynamicObjectCollection) {
                int n = ((DynamicObjectCollection) v).size();
                return n == 0 ? "空" : n + " 项";
            }
            if (v instanceof DynamicObject) {
                DynamicObject ref = (DynamicObject) v;
                for (String k : new String[]{"number", "name"}) {
                    if (ref.getDataEntityType().getProperties().get(k) != null && ref.get(k) != null
                            && !String.valueOf(ref.get(k)).isEmpty()) {
                        return String.valueOf(ref.get(k));
                    }
                }
                return "id=" + ref.getPkValue();
            }
            return v == null || String.valueOf(v).isEmpty() ? "空" : String.valueOf(v);
        } catch (Throwable t) {
            return "读不出";
        }
    }

    /**
     * 基础资料字段：光写 <字段>_id 不够。
     *
     * 平台的必录校验器认 _id，所以「设上了」看起来没问题；但操作插件普遍是
     * {@code obj.getDynamicObject("org").getString("number")} 这种读法，它拿到的是 null，当场 NPE
     * （2026-09-14 真机复盘：{@code zlgd_qty_wtd save} 必炸在 QTYWTDOpPlugin:53）。
     * FormSim 没这个病，是因为它走 {@code IDataModel.setValue}，由模型替它把基础资料物化；
     * 沙箱不建界面、没模型可借，所以自己把那条基础资料取回来放进字段。
     *
     * 取不到就退回写 _id 并记一笔：「set 成功」和「插件读得到」在输出里长得一模一样，
     * 不当场断言，它会再一次伪装成业务失败。
     */
    private static void setBasedata(DynamicObject host, BasedataProp p, String key, String path, String val,
            Object id, List<String> unresolved, String was) {
        if (id == null) {
            host.set(key, null);
            System.out.println("[PROBE]   set " + path + " = null（清空）" + was);
            return;
        }
        String base = p.getBaseEntityId();
        DynamicObject ref = loadRef(base, id);
        if (ref != null) {
            //BasedataProp.setValue 会顺手把 <字段>_id 一起写上，不用再补一次
            host.set(key, ref);
        } else {
            host.set(key + "_id", id);
        }
        Object got = null;
        try {
            got = host.getDynamicObject(key);
        } catch (Throwable ignored) {
            //个别实体的弱类型字段读不出 DynamicObject，当作没物化处理
        }
        if (got == null) {
            System.out.println("[PROBE]   ⚠ set " + path + " = " + val + " (id=" + id + ")：只写进了 "
                    + key + "_id，插件里 getDynamicObject(\"" + key + "\") 仍是 null"
                    + " —— " + base + " 里没有这条数据、或没权限读它");
            unresolved.add(path);
            return;
        }
        System.out.println("[PROBE]   set " + path + " = " + val + " (id=" + id + "，" + base + " 已物化)" + was);
    }

    /** 按 id 取一条基础资料。取不到返回 null，由调用方决定怎么告警。 */
    private static DynamicObject loadRef(String entity, Object id) {
        if (entity == null || entity.isEmpty() || id == null) {
            return null;
        }
        try {
            //用缓存版：一条 --set 一次库读，批量场景里会叠起来。
            return BusinessDataServiceHelper.loadSingleFromCache(id, entity);
        } catch (Throwable t) {
            System.out.println("[PROBE]   ⚠ 取 " + entity + " id=" + id + " 失败：" + brief(t));
            return null;
        }
    }

    /** 报错里说清写到哪一层去了 —— 「没有这个字段」最常见的原因就是层写错了。 */
    private static String where(ExpectSpec.Pos pos) {
        if (pos.entry == null) {
            return "表头";
        }
        return pos.sub == null ? "分录 " + pos.entry + " " : "子分录 " + pos.entry + "." + pos.sub + " ";
    }

    // ---------- 行数对照 ----------

    private static QFilter[] countFilter(String spec) {
        int eq = spec.indexOf('=');
        if (eq <= 0) {
            return null;
        }
        return new QFilter[]{new QFilter(spec.substring(0, eq).trim(), "=", spec.substring(eq + 1).trim())};
    }

    private static int count(String entity, QFilter[] f) {
        try {
            return ORM.create().count("opsandbox", entity, f);
        } catch (Throwable t) {
            System.out.println("[PROBE]   计数失败 " + brief(t));
            return -1;
        }
    }

    /** 读下一个可用单号，不消耗。前后各读一次就能看出流水号有没有被 save 吃掉。 */
    static String peekCodeRule(String entity, DynamicObject obj) {
        try {
            CodeRuleInfo info = CodeRuleServiceHelper.getCodeRule(entity, obj, null);
            if (info == null) {
                return null;
            }
            String n = CodeRuleServiceHelper.readNumber(info, obj);
            System.out.println("[PROBE] 编码规则 " + info.getName() + " 下一号=" + n);
            return n;
        } catch (Throwable t) {
            return null;
        }
    }

    // ---------- 小工具 ----------

    private static String oneLine(String s) {
        return s == null ? "(无)" : s.replace("\r", " ").replace("\n", " ");
    }

    private static String nz(String s) {
        return s == null || s.isEmpty() ? "(空)" : oneLine(s);
    }

    /** 每一环最多打几帧。三帧不够跨过一层代理，六帧够看到真正抛的那一行。 */
    private static final int FRAMES_PER_LINK = 6;

    /**
     * 异常的完整交代：**从最外层到最里层，每一环都打自己的类名、消息和栈顶几帧**。
     *
     * 为什么非要这样：原来 brief() 取最内层根因的类名和消息，top() 却打最外层
     * 包装异常的帧。真机上得到的是「java.lang.NullPointerException: (无)」配
     * 「OperationServiceImpl.localInvokeOperation:187」—— 名字来自里层、位置来自外层，
     * 两头对不上，等于没有栈：既判不出是平台还是本次插件的问题，
     * 也拿不到下一步可照抄的动作。一个无栈的 NPE 是不可交付的结论。
     *
     * 行前缀继续用 [PROBE]：人读通道只保留 [PROBE…] 开头的行，裸写 "at …"
     * 会被当成无归属栈帧折叠掉 —— 那正是这次要修的毛病。
     */
    static void explain(Throwable t) {
        explain(t, null, null);
    }

    /**
     * 同上，另说这次操作上挂着哪些本工程插件（{@link #ownOpPlugins}）。
     * {@code plugins} 为 null 是没读到，不当成「没挂」。
     */
    static void explain(Throwable t, String op, List<String> plugins) {
        int link = 0;
        for (Throwable cur = t; cur != null && link < 8; link++) {
            System.out.println("[PROBE]   " + (link == 0 ? "异常 " : "Caused by: ")
                    + cur.getClass().getName() + ": " + oneLine(cur.getMessage()));
            StackTraceElement[] st = cur.getStackTrace();
            int shown = Math.min(st.length, FRAMES_PER_LINK);
            for (int i = 0; i < shown; i++) {
                System.out.println("[PROBE]       at " + st[i]);
            }
            if (st.length > shown) {
                System.out.println("[PROBE]       …另 " + (st.length - shown) + " 帧");
            }
            Throwable next = cur.getCause();
            if (next == null || next == cur) {
                break;
            }
            cur = next;
        }
        System.out.println("[PROBE]   " + whose(t, op, plugins));
    }

    /**
     * 整条因果链里第一帧属于本工程的类；一帧都没有时，只说栈能说明的那一半。
     *
     * 没有包前缀就说“判不出”，不猜：此处猜错一次，使用者就会朝错的方向找一整轮。
     *
     * 栈里没有本工程的类，只说明抛异常那一刻在跑平台代码，**不说明问题不在本工程**：
     * 插件和它加的校验器先跑完，交给平台的东西在后面才出事，栈里照样一帧本工程的都没有。
     * 真机（2026-10-19，myCosmic-project）：校验器 addMessage2 第 4 参传了 null，平台序列化
     * 操作结果时空指针，栈全在 DataEntitySerializerWriter 里。原来这里接着下结论说是平台那边的问题、
     * 不是本次插件改出来的，模型照着判成平台缺陷，换了个值绕过去。
     */
    private static String whose(Throwable t, String op, List<String> plugins) {
        String[] pkgs = ownPkgs();
        if (pkgs.length == 0) {
            return "本次没拿到本工程的包前缀（OP_PKGS 未传），判不出这条栈里有没有本工程的类。";
        }
        for (Throwable cur = t; cur != null; ) {
            for (StackTraceElement e : cur.getStackTrace()) {
                for (String pkg : pkgs) {
                    if (e.getClassName().startsWith(pkg)) {
                        return "出错的是本工程的 " + e.getClassName() + "." + e.getMethodName()
                                + "(" + e.getFileName() + ":" + e.getLineNumber() + ")";
                    }
                }
            }
            Throwable next = cur.getCause();
            if (next == null || next == cur) {
                break;
            }
            cur = next;
        }
        String none = "整条因果链里没有本工程（" + String.join(" / ", pkgs) + "）的类：抛异常那一刻在跑的是平台代码。";
        if (plugins != null && plugins.isEmpty()) {
            return none + "这次 " + op + " 上没挂本工程的插件。";
        }
        String handed = "先跑完、交给平台的东西（校验器加的提示、写到单上的值）到后面才出错时，栈里同样没有";
        if (plugins == null) {
            return none + "本工程代码" + handed + "本工程的类。";
        }
        return none + "这次 " + op + " 挂着本工程的 " + String.join("、", plugins)
                + "：它们和它们加的校验器" + handed + "它们。";
    }

    /**
     * 这次操作上挂着、启用着的本工程插件类（按 OP_PKGS 认），按元数据里的顺序。
     * 读不到元数据、没给包前缀时是 null —— 和「确实没挂」分开。
     */
    static List<String> ownOpPlugins(String entity, String op) {
        String[] pkgs = ownPkgs();
        if (pkgs.length == 0 || entity == null || op == null) {
            return null;
        }
        try {
            EntityMetadata em = (EntityMetadata) MetadataDao.readMeta(
                    MetadataDao.getIdByNumber(entity, MetaCategory.Entity), MetaCategory.Entity);
            List<String> out = new ArrayList<String>();
            for (Object item : em.getItems()) {
                Object ops = getter(item, "getOperations");
                if (!(ops instanceof List)) {
                    continue;
                }
                for (Object o : (List<?>) ops) {
                    if (!op.equals(String.valueOf(getter(o, "getKey")))) {
                        continue;
                    }
                    Object pls = getter(o, "getPlugins");
                    if (!(pls instanceof List)) {
                        continue;
                    }
                    for (Object p : (List<?>) pls) {
                        String cls = String.valueOf(getter(p, "getClassName"));
                        if (Boolean.FALSE.equals(getter(p, "isEnabled")) || out.contains(cls)) {
                            continue;
                        }
                        for (String pkg : pkgs) {
                            if (cls.startsWith(pkg)) {
                                out.add(cls);
                                break;
                            }
                        }
                    }
                }
            }
            return out;
        } catch (Throwable unreadable) {
            return null;
        }
    }

    /** 无参 getter；没有这个方法或调用失败是 null。 */
    private static Object getter(Object target, String name) {
        if (target == null) {
            return null;
        }
        try {
            return target.getClass().getMethod(name).invoke(target);
        } catch (Throwable e) {
            return null;
        }
    }

    private static String[] ownPkgs() {
        String raw = env("OP_PKGS", "");
        if (raw.isEmpty()) {
            return new String[0];
        }
        List<String> out = new ArrayList<String>();
        for (String one : raw.split(",")) {
            String v = one.trim();
            if (!v.isEmpty()) {
                out.add(v.endsWith(".") ? v : v + ".");
            }
        }
        return out.toArray(new String[0]);
    }

    /**
     * 校验文案里出现的字段中文名 → 实体字段标识。
     *
     * 校验器只说人话：「请填写"委托单编号"」。可同一张单上既有 billno（单据编号）
     * 又有 zlgd_fnumber（委托单编号），要补哪一个只能再跑一轮 MetaProbe 反查。
     * 实体就在手上，这一跳本就不该留给调用方。
     *
     * 先按字面包含找候选；校验文案引号里的名字和某个字段的中文名**完全一样**时，只留那几个。
     * 光按包含会把「量具名称」和「量具名称（拉伸、腐蚀）」一起列出来，而报的是后者——
     * 真机 2026-09-17 调用方从两个里挑了前者，白跑一次 101 秒。没有完全一样的才全列：
     * 猜一个比列两个危险。
     */
    private static String keysIn(MainEntityType met, String message) {
        if (met == null || message == null || message.isEmpty()) {
            return "";
        }
        List<String[]> hit = new ArrayList<String[]>();
        try {
            collectKeys(met, "", message, hit);
        } catch (Throwable ignore) {
            return "";
        }
        List<String> quoted = quotedNames(message);
        List<String[]> exact = new ArrayList<String[]>();
        for (String[] one : hit) {
            if (quoted.contains(one[1])) {
                exact.add(one);
            }
        }
        List<String[]> shown = exact.isEmpty() ? hit : exact;
        List<String> text = new ArrayList<String>();
        for (String[] one : shown) {
            text.add(one[0] + "（" + one[1] + "）");
        }
        return text.isEmpty() ? "" : "   字段标识：" + String.join(" / ", text);
    }

    /** 文案里用引号括起来的那几段：校验器报字段名时总是这么括的（"…"、“…”、「…」）。 */
    static List<String> quotedNames(String message) {
        List<String> out = new ArrayList<String>();
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("[\"“「]([^\"”」]+)[\"”」]")
                .matcher(message);
        while (m.find()) {
            out.add(m.group(1).trim());
        }
        return out;
    }

    /** 递归进分录与子分录：必填报的很可能是分录字段，只扫表头等于没扫。每条是 {字段路径, 中文名}。 */
    private static void collectKeys(IDataEntityType type, String prefix, String message, List<String[]> hit) {
        for (IDataEntityProperty p : type.getProperties()) {
            String key = prefix.isEmpty() ? p.getName() : prefix + "." + p.getName();
            String name = String.valueOf(p.getDisplayName());
            //一两个字的名字在任何句子里都能命中，那不是证据是噪声
            if (name.length() >= 3 && message.contains(name) && !containsKey(hit, key)) {
                hit.add(new String[]{key, name});
            }
            if (p instanceof EntryProp && p instanceof ICollectionProperty) {
                collectKeys(((ICollectionProperty) p).getItemType(), key, message, hit);
            }
        }
    }

    private static boolean containsKey(List<String[]> hit, String key) {
        for (String[] one : hit) {
            if (one[0].equals(key)) {
                return true;
            }
        }
        return false;
    }

    static String brief(Throwable t) {
        Throwable r = t;
        while (r.getCause() != null && r.getCause() != r) {
            r = r.getCause();
        }
        return r.getClass().getName() + ": " + oneLine(r.getMessage());
    }

    private static String env(String k, String dft) {
        String v = System.getenv(k);
        return v == null || v.trim().isEmpty() ? dft : v.trim();
    }
}
