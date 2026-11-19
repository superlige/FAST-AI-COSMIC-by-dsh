/**
 * S21 造测试数据：DataSeedProbe 自己的边界，和 Harness 这边认它的那几处判据。
 *
 * 边界写在 Java 里、没有开关，所以只能从源码上钉：只新建、只本 ISV、走操作链、整批一个事务、
 * 回读全部找到才说写成。Harness 那边的判据（是不是写探针、按哪一档跑、写入目标怎么写、
 * 什么输出算计划 / 算写成）都要和这份源码对得上——对不上的时候是静默的。
 */

import { describe, expect, it } from "vitest";
import { dataWriteEffectNotes } from "../../src/kernel/policy/external-effects.ts";
import { releasedLane } from "../../src/kernel/policy/probe-freshness.ts";
import { buildWriteForm } from "../../src/kernel/policy/write-form.ts";
import {
	DATA_WRITERS,
	dataBaseline,
	isAppliedWrite,
	isBlockedWrite,
	isDataWriter,
	isMetadataWriter,
	isPlannedDryRun,
	isSharedWriter,
	isStaleBaseline,
	queriedIds,
	requiredTargets,
	seededRows,
	seededRowText,
	updatedRows,
	writePlanDigest,
	writerKind,
	writtenRows,
} from "../../src/kernel/policy/write-plan.ts";
import { normTarget } from "../../src/kernel/policy/write-targets.ts";
import { writtenTablesOf } from "../../src/kernel/verify/evidence.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";
import { makeContext } from "./fake-context.ts";

const source = (name: string): string =>
	EMBEDDED_RESOURCES.find((entry) => entry.relativePath === `probes/${name}.java`)?.content ?? "";

const SEED = source("DataSeedProbe");
/** Source with comments removed: the header explains what it does NOT call, and must not count as calling it. */
const SEED_CODE = SEED.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("S37 批 8：造数的门禁、默认值、下推", () => {
	const GUARD_CODE = source("IsvGuard")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");

	it("目标属于平台服务云（接口登记、流程、调度、应用登记）就在报目标之前拦下；基础服务云不拦", () => {
		const at = GUARD_CODE.indexOf("public static void assertDataTarget");
		const check = GUARD_CODE.indexOf("PLATFORM_CLOUDS.contains", at);
		const reported = GUARD_CODE.indexOf('"[PROBE] 数据写入目标 data:"', at);
		expect(check).toBeGreaterThan(at);
		expect(reported).toBeGreaterThan(check);
		const clouds = /PLATFORM_CLOUDS = [\s\S]*?asList\(([\s\S]*?)\)\);/.exec(GUARD_CODE)?.[1] ?? "";
		for (const cloud of ["SYS", "DEV", "OSC", "WFS"]) expect(clouds).toContain(`"${cloud}"`);
		expect(clouds).not.toContain('"BAMP"');
	});

	it("新建的对象先填元数据默认值（单据状态暂存这类），再套 SEED_SET", () => {
		const created = SEED_CODE.indexOf("row.obj = BusinessDataServiceHelper.newDynamicObject(entity);");
		const defaults = SEED_CODE.indexOf("defaults(met, row.obj);", created);
		const sets = SEED_CODE.indexOf("OpSandbox.applySets(met, row.obj, row.set)", created);
		expect(created).toBeGreaterThan(0);
		expect(defaults).toBeGreaterThan(created);
		expect(sets).toBeGreaterThan(defaults);
	});

	it("SEED_FROM 按转换规则下推；多条启用规则不猜，列出来要 SEED_RULE；推出的对象交给操作链保存", () => {
		expect(SEED_CODE).toContain("ConvertServiceHelper.push(args)");
		expect(SEED_CODE).toContain('"SEED_RULE"');
		expect(SEED_CODE).toMatch(/if \(heads\.size\(\) > 1\) \{[\s\S]*?throw new IllegalArgumentException/);
		const push = SEED_CODE.slice(SEED_CODE.indexOf("private static List<Row> pushRows"));
		expect(push.slice(0, push.indexOf("private static List<String[]> rules"))).not.toMatch(
			/executeOperate|SaveServiceHelper/,
		);
	});
});

describe("S48 照现成的复制、从上游下推、按上下游单的字段查", () => {
	const FORM_SIM = source("FormSim");
	const QUERY_CODE = source("DataQueryProbe")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");

	it("复制走平台自己的「复制」：新增态 + iscopy 打开表单，数据取表单模型里的，不自己逐字段抄", () => {
		const open = FORM_SIM.slice(FORM_SIM.indexOf("static FormView openCopy("));
		const body = open.slice(0, open.indexOf("\n    }\n"));
		expect(body).toContain("bill.setStatus(OperationStatus.ADDNEW);");
		expect(body).toContain("bill.setPkId(pk);");
		expect(body).toContain('bill.getCustomParams().put("iscopy", true);');
		// 下推关联分录不带：和界面上点复制一样，复制出来的单不挂在上游下面
		expect(body).toContain('bill.getCustomParams().put("isCopyRelateEntity", false);');
		const copied = SEED_CODE.slice(SEED_CODE.indexOf("private static FormView copied("));
		const fn = copied.slice(0, copied.indexOf("\n    }\n"));
		expect(fn).toContain("FormSim.openCopy(FormSim.FORM, pk,");
		// loadData 没跑通时复制出来的是半截数据，整批不保存
		expect(fn).toMatch(/if \(!FormSim\.LOADED\) \{\s*throw/);
		expect(fn).toContain("view.getModel().getDataEntity(true)");
	});

	it("SEED_FROM 只给源单标识时按规则的源单条件挑单；给了几张只推出几张时把没推出来的说出来", () => {
		expect(SEED_CODE).toContain("new FilterBuilder(st, cond.getFilterCondition())");
		const push = SEED_CODE.slice(SEED_CODE.indexOf("private static List<Row> pushRows"));
		const body = push.slice(0, push.indexOf("\n    }\n"));
		expect(body).toMatch(
			/List<Long> missed = notPushed\(st, filter, pushed, ids\);[\s\S]*?explain\(st, by, filter, missed, entity\)/,
		);
		// 推不出来时逐张说满足不满足源单条件，字段取平台转好的查询条件（分录字段带前缀）
		const explain = SEED_CODE.slice(SEED_CODE.indexOf("private static void explain("));
		expect(explain.slice(0, explain.indexOf("\n    }\n"))).toContain("q.getNests(true)");
	});

	it("复制后说出原单有值、复制出来空着的字段；满足条件却推不出来时和推出过下游的源单比", () => {
		const copied = SEED_CODE.slice(SEED_CODE.indexOf("private static FormView copied("));
		const fn = copied.slice(0, copied.indexOf("\n    }\n"));
		// 不只必录的：拿原单逐字段比（分录里有一行有值就算有值）；原单只用只读查询取，不按 pk 拿单据对象
		expect(fn).toMatch(
			/missing\(fields, filled\(fields, obj\),[\s\S]*?filled\(met, fields, Collections\.singletonList\(src\)\)/,
		);
		const query = SEED_CODE.slice(SEED_CODE.indexOf("private static void fill("));
		expect(query.slice(0, query.indexOf("\n    }\n"))).toContain("QueryServiceHelper.query(met.getName()");
		// 推不出来时：满足源单条件的（没有条件就是全部）拿去和推出过本单的几张源单比
		const explain = SEED_CODE.slice(SEED_CODE.indexOf("private static void explain("));
		expect(explain.slice(0, explain.indexOf("\n    }\n"))).toMatch(
			/List<Long> stuck = q == null \? ids : pass;[\s\S]*?compareWithPushed\(st, by, q, stuck, target\)/,
		);
		const compare = SEED_CODE.slice(SEED_CODE.indexOf("private static void compareWithPushed("));
		const body = compare.slice(0, compare.indexOf("\n    }\n"));
		expect(body).toContain("down.containsKey(target)");
		expect(body).toContain("missing(fields, has.get(id), refs)");
	});

	it("照现成复制的单第一步在复制出来的表单上点；保存后编号和库里别的单重了要说；自动挑源单跳过的逐张说原因", () => {
		const chain = SEED_CODE.slice(SEED_CODE.indexOf("private static boolean runChain("));
		const fn = chain.slice(0, chain.indexOf("\n    }\n"));
		// 绕过表单直接调操作，编码规则的表单插件没机会让保存占号：下一张复制出来还是同一个号
		expect(fn).toContain("boolean onForm = i == 0 && row.view != null;");
		expect(fn).toMatch(/if \(onForm\) \{\s*Object o = row\.view\.invokeOperation\(op\);/);
		expect(fn).toContain("sameNumber(entity, met, row.obj, pk);");
		// 第二条起照现成复制的，前一条跑完才开表单：几张先开好再挨个存，后面几张都存成第一张保存前预读的号
		const main = SEED_CODE.slice(SEED_CODE.indexOf("public static void run()"));
		expect(main.slice(0, main.indexOf("String numBefore"))).toMatch(
			/boolean later = target == null && !row\.copy\.isEmpty\(\) && row != rows\.get\(0\);\s*if \(later\) \{[\s\S]*?target = BusinessDataServiceHelper\.newDynamicObject\(entity\);[\s\S]*?later \? quietSets\(met, target, row\.set\)/,
		);
		const rows = SEED_CODE.slice(SEED_CODE.indexOf("private static boolean runRows("));
		expect(rows.slice(0, rows.indexOf("\n    }\n"))).toMatch(
			/if \(row\.obj == null && !copyNow\(entity, met, row\)\) \{\s*return false;\s*\}\s*ok = runChain\(entity, met, row\);/,
		);
		const now = SEED_CODE.slice(SEED_CODE.indexOf("private static boolean copyNow("));
		expect(now.slice(0, now.indexOf("\n    }\n"))).toMatch(
			/row\.view = copied\(entity, met, row\.copy\);[\s\S]*?OpSandbox\.applySets\(met, row\.obj, row\.set\);/,
		);
		// 复制前清掉上一张的页面缓存：编码规则按新单 pk 记标记，新单 pk 都一样
		const copied = SEED_CODE.slice(SEED_CODE.indexOf("private static FormView copied("));
		expect(copied.slice(0, copied.indexOf("\n    }\n"))).not.toContain("PAGE_CACHE.putAll");
		// 自动挑源单：同一张只试一次；跳过的都说原因，再和推出过本单的源单比
		const push = SEED_CODE.slice(SEED_CODE.indexOf("private static List<Row> pushRows"));
		const body = push.slice(0, push.indexOf("\n    }\n"));
		expect(body).toContain('picked.add(r.getLong("id"))');
		expect(body).toMatch(
			/for \(String t : tried\) \{[\s\S]*?compareWithPushed\(st, noField == null \? "id" : noField, q, skipped, entity\);[\s\S]*?if \(objs\.isEmpty\(\)\)/,
		);
	});

	it("每条跑完放掉复制出来的表单占着的编辑锁；表单模拟跑完也放", () => {
		// 在表单上保存过，平台给这张单记了「正在编辑」，界面关掉才放；没人关，之后提交被拒「正在PC端编辑该记录」
		const rows = SEED_CODE.slice(SEED_CODE.indexOf("private static boolean runRows("));
		expect(rows.slice(0, rows.indexOf("\n    }\n"))).toMatch(
			/try \{[\s\S]*?ok = runChain\(entity, met, row\);\s*\} finally \{[\s\S]*?FormSim\.releaseMutex\(row\.view\);\s*\}/,
		);
		const sim = source("FormSim");
		// run form 总是真实缓存：releaseReal 先放锁再清缓存（下面查 releaseRealView 的顺序）
		expect(sim).toMatch(/if \(released\.add\(v\.getPageId\(\)\)\) \{\s*releaseReal\(v\);\s*\}/);
		const ui = source("HeadlessUiSupport");
		const release = ui.slice(ui.indexOf("public static List<String> releaseRealView("));
		// 锁的标识在页面缓存里：先放锁，再清页面缓存
		const body = release.slice(0, release.indexOf("\n    }\n"));
		expect(body.indexOf("releaseMutex(view);")).toBeGreaterThan(-1);
		expect(body.indexOf("releaseMutex(view);")).toBeLessThan(body.indexOf("((PageCache) cache).release();"));
		expect(ui).toContain('cache.get("MUTEX_OBJ_ID")');
		// 平台回 false 是锁还挂着：报出去，不当放了
		expect(ui).toContain("if (!MutexHelper.release(view)) {");
		// 清理那一行带上编辑锁的结果，没占也写
		const real = sim.slice(sim.indexOf("static void releaseReal(FormView view) {"));
		const realBody = real.slice(0, real.indexOf("\n    }\n"));
		expect(realBody).toContain('lock = released == null ? "没占" : "已放 " + released;');
		expect(realBody).toContain('"  编辑锁=" + lock');
	});

	it("真实页面缓存每次写当场落 Redis，不攒批（攒批时打开单据记的编辑锁标识丢掉，锁放不掉）", () => {
		// FormView.activate 里平台另建一份同 pageId 的页面缓存登记进 SessionManager；视图手里那份要是攒批，
		// 之后写进它的编辑锁标识 commitCache 提交不到，下一次请求和跑完放锁都读不到（真机 2026-11-18）
		const ui = source("HeadlessUiSupport");
		const real = ui.slice(ui.indexOf("public static IPageCache realPageCache("));
		const body = real.slice(0, real.indexOf("\n    }\n"));
		expect(body).toContain("new PageCache(pageId, false)");
		expect(body).not.toContain("new PageCache(pageId, true)");
	});

	it("多条转换规则时写了源单编号就按源单挑，只写源单标识的报错里说写上编号", () => {
		const push = SEED_CODE.slice(SEED_CODE.indexOf("private static List<Row> pushRows"));
		const body = push.slice(0, push.indexOf("\n    }\n"));
		expect(body).toContain("if (heads.size() > 1 && colon < 0) {");
		expect(body).toContain("按这几张源单挑满足条件、推得出来的那条");
		expect(body).toContain("Object[] picked = pickRule(st, by, met, heads, ids, found);");
		const pick = SEED_CODE.slice(SEED_CODE.indexOf("private static Object[] pickRule("));
		const fn = pick.slice(0, pick.indexOf("\n    }\n"));
		// 源单都满足条件的才试推；转不成查询的条件当满足，试推兜住
		expect(fn).toMatch(
			/if \(q != null\) \{[\s\S]*?if \(!pass\.containsAll\(want\)\) \{[\s\S]*?continue;\s*\}\s*\}\s*fits\.add\(h\);/,
		);
		// 按顺序看，满足就当场试推，推得出来就停（后面的规则不再读、不再查库）；推的结果原样交回，不再推一次
		expect(fn).toMatch(/fits\.add\(h\);\s*ConvertOperationResult pushed = push\(/);
		expect(fn).toContain("return new Object[]{h, pushed};");
		// 一条都满足不了：列出每条条件和源单的值；都推不出来：列原因再按第一条比字段
		expect(fn).toContain("printValues(st, by, fields, ids);");
		expect(fn).toContain("explain(st, by, sourceFilter(fits.get(0)[0]), ids, met.getName());");
	});

	it("认出的单据排进后台预读布局方案，只在常驻进程里、一类单据一次", () => {
		const resolve = source("MetaResolve");
		const fn = resolve.slice(resolve.indexOf("static String entityNumber(String key, boolean say) {"));
		expect(fn.slice(0, fn.indexOf("\n    }\n"))).toMatch(
			/String number = resolve\(key, say\);\s*Warmup\.layouts\(number\);\s*return number;/,
		);
		const warm = source("Warmup");
		expect(warm).toContain('System.getProperty("probe.hotOut") == null');
		expect(warm).toContain('System.getProperties().putIfAbsent("cosmic.warmup.layouts." + entity, "1") != null');
		expect(warm).toContain("ThreadPools.executeOnceIncludeRequestContext(");
		expect(warm).toContain("BillLayoutReader.loadDifferentialControlInfosFromCache(entity, s.getId());");
	});

	it("run op 的 message= 比界面弹出的整段提示：顶上那句加逐条列出的错", () => {
		const spec = source("ExpectSpec");
		expect(spec).toContain('ProbeAssert.containsText("op-message", key, want, shownMessage(result));');
		const shown = spec.slice(spec.indexOf("private static String shownMessage("));
		expect(shown.slice(0, shown.indexOf("\n    }\n"))).toContain('top + " | " + items');
	});

	it("验「会被拦」时拦住它的不只是写明的原因：按输入不成立、不留验证记录", () => {
		const spec = source("ExpectSpec");
		const op = spec.slice(
			spec.indexOf("public static void operation(OperationResult result, DynamicObject obj, String spec, boolean"),
		);
		const body = op.slice(0, op.indexOf("\n    }\n"));
		// message 和 error 写的都算原因；只写 success=false 的不比
		expect(body).toMatch(/OP_MESSAGE\.equals\(kv\[0\]\) \|\| OP_ERROR\.equals\(kv\[0\]\)/);
		expect(body).toContain("expectsFailure && failed && !causes.isEmpty()");
		// 不记 FAIL：换一张单就是另一个场景，FAIL 会永远挡着交付
		expect(body).toContain('ProbeAssert.inputInvalid("op-success", key,');
		const unexplained = spec.slice(spec.indexOf("private static List<String> unexplained("));
		const fn = unexplained.slice(0, unexplained.indexOf("\n    }\n"));
		// 和 message= / error= 同一种比法：逐条的错包含写明的片段
		expect(fn).toContain("result.getAllErrorOrValidateInfo()");
		expect(fn).toContain("text.contains(ProbeAssert.shown(cause))");
	});

	it("查数据时下拉字段另起一行列全部选项，值本身照存的代码打", () => {
		const query = source("DataQueryProbe");
		const run = query.slice(query.indexOf("public static void run()"));
		const body = run.slice(0, run.indexOf("\n    }\n"));
		expect(body).toMatch(/comboLegends\(t, fields\);\s*\}\s*for \(int i = 0; i < shown; i\+\+\)/);
		// 值照原样：写成「A(暂存)」照抄进 --set 会把这几个字存进下拉字段
		const render = query.slice(query.indexOf("private static String render(Object v)"));
		expect(render.slice(0, render.indexOf("\n    }\n"))).not.toContain("ComboProp");
		const legends = query.slice(query.indexOf("private static void comboLegends("));
		const fn = legends.slice(0, legends.indexOf("\n    }\n"));
		expect(fn).toContain('comboAt(l.type, "billstatus")');
		expect(fn).toContain("comboAt(l.type, l.sub)");
		expect(query).toMatch(/field \+ " 最近的值有：" \+ String\.join\("、", seen\) \+ items/);
	});

	it("元数据探针的字段过滤：逗号隔开的几个关键字，含任一个就算", () => {
		const meta = source("MetaProbe");
		const fn = meta.slice(meta.indexOf("static boolean matches("));
		expect(fn.slice(0, fn.indexOf("\n    }\n"))).toContain('filter.split("[,，]")');
		expect(meta).not.toContain("!name.toLowerCase().contains(filter.toLowerCase())");
	});

	it("确认单写明照哪张复制、从哪张上游推、推出几条", () => {
		const form = buildWriteForm({
			probe: "DataSeedProbe",
			env: { SEED_ENTITY: "demo_test", SEED_FROM: "demo_order", SEED_RULE: "化学", SEED_OPS: "save" },
			records: [
				{ t: "data-entity", entity: "demo_test", name: "检测单" },
				{
					t: "seed-from",
					source: "demo_order",
					name: "委托单",
					bills: "DO-1、DO-2",
					rule: "委托单下推检测单",
					count: "2",
				},
			],
			targets: ["data:demo_test"],
		});
		expect(form.head).toContainEqual({
			label: "从上游下推",
			cells: [{ text: "委托单 demo_order：DO-1、DO-2，规则「委托单下推检测单」" }],
		});
		expect(form.head).toContainEqual({ label: "条数", cells: [{ text: "2 条" }] });
		const copy = buildWriteForm({
			probe: "DataSeedProbe",
			env: { SEED_ENTITY: "demo_order", SEED_COPY: "DO-1", SEED_SET: "demo_qty=3" },
			records: [{ t: "seed-copy", label: "1", template: "DO-1" }],
			targets: ["data:demo_order"],
		});
		expect(copy.head).toContainEqual({
			label: "照着复制",
			cells: [{ text: "DO-1（按字段的「是否复制」带值，下表只列这次另设的）" }],
		});
	});

	it("@上游 / @下游 后面接单据标识：字段条件先在那类单上查、再按转换关系一次反查回本单，流程条件逐张判", () => {
		expect(QUERY_CODE).toContain('f.startsWith("@上游.") || f.startsWith("@下游.")');
		const reach = QUERY_CODE.slice(QUERY_CODE.indexOf("private static QFilter reach("));
		const body = reach.slice(0, reach.indexOf("\n    }\n"));
		expect(body).toContain("BFTrackerServiceHelper.findTargetBills(entity, ids)");
		expect(body).toContain("BFTrackerServiceHelper.findSourceBills(entity, ids)");
		// 那类单满足的太多就退回逐张判，不把几万个 id 塞进 in
		expect(body).toMatch(/if \(hit\.size\(\) > REACH_CAP\) \{\s*return null;/);
		// 只问有没有（@下游.单据 is null / is not null）也反查：取那类单全部，没有这类单的用 not in
		expect(body).toContain("QFilter[] on = any ? new QFilter[0] : new QFilter[]{p.where};");
		expect(body).toContain('return new QFilter("id", none ? "not in" : "in", ids);');
	});
});

describe("S21 DataSeedProbe 的边界写在源码里", () => {
	it("只新建：造对象用 newDynamicObject，没有 pk 入参，不按 pk 取任何单据", () => {
		expect(SEED_CODE).toContain("BusinessDataServiceHelper.newDynamicObject(entity)");
		expect(SEED_CODE).not.toMatch(/"SEED_\w*PK\w*"/);
		expect(SEED_CODE).not.toMatch(/\bloadSingle\w*\s*\(/);
	});

	it("操作链第二步起按 pk 调，而 pk 只来自本条第一步刚造出来的那一行", () => {
		// 2026-09-15 真机：save 后把同一个对象再传给 submit，平台会再 INSERT 一次同一行。
		expect(SEED_CODE).toContain(
			"OperationServiceHelper.executeOperate(op, entity, new Object[]{pk}, OperateOption.create())",
		);
		const chain = SEED_CODE.slice(
			SEED_CODE.indexOf("private static boolean runChain("),
			SEED_CODE.indexOf("private static List<Row> parseRows("),
		);
		const assigned = [...chain.matchAll(/\bpk = ([^;]+);/g)].map((match) => match[1]);
		// 最后一项是 row.pk = pk：记下来给回读用，不是别处来的 pk
		expect(assigned).toEqual(["null", "row.obj.getPkValue()", "r.getSuccessPkIds().get(0)", "pk"]);
	});

	it("先过 IsvGuard.assertDataTarget，写入目标是 data:<单据>；不查 ISV（2026-09-15）、不查确认清单（S27）", () => {
		expect(SEED_CODE).toContain("IsvGuard.assertDataTarget(entity)");
		const guard = source("IsvGuard");
		const method = guard.slice(guard.indexOf("public static void assertDataTarget(String number)"));
		const body = method.slice(0, method.indexOf("\n    }\n"));
		expect(body).toContain('planned("data:" + nz(number));');
		expect(body).not.toContain("assertConfirmedTagged");
		expect(body).not.toContain("requireIsv");
		expect(guard).not.toContain("assertOwnData");
		expect(normTarget("DATA:ZLGD_QTY_WTD")).toBe("data:zlgd_qty_wtd");
	});

	it("每个设上的字段发一条 t=seed-field，确认单的表由它排", () => {
		expect(SEED_CODE).toContain('ProbeJson.emit("seed-field", "label", row.label, "field", pair[0],');
		const form = buildWriteForm({
			probe: "DataSeedProbe",
			env: { SEED_ENTITY: "zlgd_qty_wtd", SEED_OPS: "save,audit", SEED_SET: "zlgd_org=100" },
			records: [
				{ t: "data-entity", entity: "zlgd_qty_wtd", name: "检验委托单" },
				{ t: "seed-field", label: "1", field: "zlgd_org", name: "组织", value: "100 华东公司" },
			],
			targets: ["data:zlgd_qty_wtd"],
		});
		expect(form.names).toEqual([]);
		expect(form.tables[0]?.rows).toEqual([[{ text: "1" }, { text: "组织" }, { text: "100 华东公司" }]]);
		expect(form.head).toContainEqual({ label: "操作", cells: [{ text: "保存 → 审核" }] });
	});

	it("走单据自己的操作链，不绕过校验器和插件直接存、删、发 SQL", () => {
		expect(SEED_CODE).toContain("OperationServiceHelper.executeOperate(op, entity,");
		expect(SEED_CODE).not.toMatch(/\bSaveServiceHelper\s*\.|\bDeleteServiceHelper\s*\.|\bDB\s*\.\s*(update|execute)/);
		expect(SEED_CODE).not.toMatch(/\bORM\s*\.\s*create\s*\(\s*\)\s*\.\s*(insert|update|delete|save)/);
	});

	it("S37 批 8：预演整批一个回滚事务；落库按平台自己的事务逐条提交，没跑通时已提交的照样回读列出", () => {
		// 落库包在外层事务里时，事务后再存一次的操作插件会重复插入（09-28 真机 zlgd_sys_test_bill 主键重复）
		expect(SEED_CODE.match(/TX\.beginNew\(\)/g)).toHaveLength(1);
		expect(SEED_CODE).toMatch(/if \(apply\) \{[^}]*allOk = runRows\(entity, met, rows\);\s*\} else \{/);
		expect(SEED_CODE).toMatch(/try \(TXHandle tx = TX\.beginNew\(\)\) \{\s*tx\.markRollback\(\);\s*allOk = runRows/);
		const readBack = SEED_CODE.indexOf("boolean there = count(entity");
		const failed = SEED_CODE.indexOf('"[PROBE] !! 操作链没跑通"');
		expect(readBack).toBeGreaterThan(0);
		expect(failed).toBeGreaterThan(readBack);
		expect(SEED_CODE).toContain("static final int MAX_ROWS = 50;");
	});

	it("S27：预演结束行不再列写入目标、也不算一份待确认计划，落库不查确认清单", () => {
		expect(SEED_CODE).not.toContain("IsvGuard.reportTargets();");
		expect(SEED_CODE).toContain("要落库就去掉 PREVIEW=1 再跑（测试环境，不用确认）");
		const line =
			"[PROBE] dry-run 结束，未写入（2 条都在回滚事务里跑通了操作链）。要落库就去掉 PREVIEW=1 再跑（测试环境，不用确认）";
		expect(isPlannedDryRun({ cls: "DataSeedProbe", adHoc: false, env: {}, exitCode: 0, output: line })).toBe(false);
	});

	it("落库成功行只在回读条数对上之后打，Harness 只认这一行", () => {
		const check = SEED_CODE.indexOf("if (found != rows.size())");
		const success = SEED_CODE.indexOf('"[PROBE] 测试数据已落库 "');
		expect(check).toBeGreaterThan(0);
		expect(success).toBeGreaterThan(check);
		const ok = "[PROBE] 测试数据已落库 2 条，回读都在库里。";
		expect(isAppliedWrite({ cls: "DataSeedProbe", exitCode: 0, output: ok })).toBe(true);
		expect(
			isAppliedWrite({
				cls: "DataSeedProbe",
				exitCode: 0,
				output: "[PROBE] !! 操作链没跑通，整批已回滚，库里没有留下这批数据",
			}),
		).toBe(false);
		expect(isAppliedWrite({ cls: "DataSeedProbe", exitCode: 0, output: "[PROBE] 测试数据已落库 0 条" })).toBe(false);
	});
});

describe("S21 Harness 对它的判据", () => {
	it("是写探针，但不是元数据写探针；按严格档跑（要加载业务插件）", () => {
		expect(Object.keys(DATA_WRITERS)).toEqual(["DataSeedProbe", "DataUpdateProbe"]);
		expect(isDataWriter("DataSeedProbe")).toBe(true);
		expect(isSharedWriter("DataSeedProbe")).toBe(true);
		expect(isMetadataWriter("DataSeedProbe")).toBe(false);
		expect(writerKind("DataSeedProbe")).toBe("造测试数据");
		expect(releasedLane("DataSeedProbe")).toBe("business");
		expect(writerKind("DataUpdateProbe")).toBe("修改数据");
		expect(releasedLane("DataUpdateProbe")).toBe("business");
		expect(isSharedWriter("OpSandbox")).toBe(false);
	});

	it("写入目标从入参就能算出来：data:<单据>，小写", () => {
		expect(requiredTargets("DataSeedProbe", { SEED_ENTITY: " ZLGD_Qty_Wtd " })).toEqual(["data:zlgd_qty_wtd"]);
		expect(requiredTargets("DataSeedProbe", {})).toEqual([]);
	});

	it("指纹不含 APPLY，改一条数据就是另一个操作", () => {
		const env = { SEED_ENTITY: "zlgd_qty_wtd", SEED_SET: "zlgd_org=100" };
		expect(writePlanDigest("DataSeedProbe", { ...env, APPLY: "1" })).toBe(writePlanDigest("DataSeedProbe", env));
		expect(writePlanDigest("DataSeedProbe", { ...env, SEED_SET: "zlgd_org=101" })).not.toBe(
			writePlanDigest("DataSeedProbe", env),
		);
	});

	it("造出的数据只收回读找到的那几条", () => {
		const rows = seededRows([
			{ t: "seed-row", label: "1", pk: "11", number: "WTD-0001", found: true },
			{ t: "seed-row", label: "2", pk: "12", number: null, found: true },
			{ t: "seed-row", label: "3", pk: "13", number: "WTD-0003", found: false },
			{ t: "assert", label: "x", found: true },
		]);
		expect(rows.map(seededRowText)).toEqual(["WTD-0001（pk 11）", "pk 12"]);
	});
});

const UPDATE = source("DataUpdateProbe");
const UPDATE_CODE = UPDATE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("S23 DataUpdateProbe 的边界写在源码里", () => {
	it("只改已有数据：按 pk 读出来改，不新建、不删", () => {
		expect(UPDATE_CODE).toContain("BusinessDataServiceHelper.loadSingle(row.pk, entity)");
		expect(UPDATE_CODE).not.toContain("newDynamicObject");
		expect(UPDATE_CODE).not.toMatch(/\bDeleteServiceHelper\s*\.|\bDB\s*\.\s*(update|execute)/);
		expect(UPDATE_CODE).toContain("IsvGuard.assertDataTarget(entity)");
		expect(UPDATE_CODE).toContain("static final int MAX_ROWS = 50;");
	});

	it("整批一个事务：dry-run 先标回滚；落库时没全成、或回读有一格不是新值，也标回滚", () => {
		expect(UPDATE_CODE.match(/TX\.beginNew\(\)/g)).toHaveLength(1);
		expect(UPDATE_CODE).toMatch(/if \(!apply\) \{\s*tx\.markRollback\(\);/);
		expect(UPDATE_CODE).toMatch(/if \(apply && !allOk\) \{\s*tx\.markRollback\(\);/);
		expect(UPDATE_CODE).toMatch(/if \(allOk\) \{\s*allOk = readBack\(entity, rows, "存完回读"\);/);
	});

	it("改前快照在进事务之前核对；对不上打「未落库」，Harness 认得它是前置拦截、且这一项要重新 dry-run", () => {
		const check = UPDATE_CODE.indexOf('System.getProperty("cosmic.baseline", "")');
		expect(check).toBeGreaterThan(0);
		expect(check).toBeLessThan(UPDATE_CODE.indexOf("TX.beginNew()"));
		const line =
			"[PROBE] 未落库：改前数据和预演时不一样了（确认时 0123456789abcdef，现在 fedcba9876543210），一条都没改。";
		expect(UPDATE_CODE).toContain('"[PROBE] 未落库：改前数据和预演时不一样了（确认时 "');
		expect(isBlockedWrite({ cls: "DataUpdateProbe", output: line })).toBe(true);
		expect(isStaleBaseline(line)).toBe(true);
		expect(isStaleBaseline("[PROBE] 未落库：这次在写入之前就被拦下（IsvGuard）")).toBe(false);
		expect(UPDATE_CODE).toContain('"[PROBE] 改前快照=" + baseline');
		expect(dataBaseline("[PROBE] 改前快照=0123456789abcdef（2 条）")).toBe("0123456789abcdef");
		expect(dataBaseline("[PROBE] 改前快照=zzz")).toBeUndefined();
	});

	it("落库成功行只在提交后回读都对上之后打；S27 起没给快照也能落库，给了且对不上才中止", () => {
		expect(UPDATE_CODE).not.toContain("IsvGuard.reportTargets();");
		const readback = UPDATE_CODE.indexOf('if (!readBack(entity, rows, "提交后回读"))');
		const success = UPDATE_CODE.indexOf('"[PROBE] 数据已修改 "');
		expect(readback).toBeGreaterThan(0);
		expect(success).toBeGreaterThan(readback);
		expect(
			isAppliedWrite({
				cls: "DataUpdateProbe",
				exitCode: 0,
				output: "[PROBE] 数据已修改 2 条，提交后回读都是新值。",
			}),
		).toBe(true);
		expect(UPDATE_CODE).toContain("if (!confirmed.isEmpty() && !confirmed.equals(baseline))");
		expect(UPDATE_CODE).not.toContain("缺改前快照");
	});

	it("每一格发 t=data-change；写入目标从 UPD_ENTITY 算；回执留原值", () => {
		expect(UPDATE_CODE).toContain('ProbeJson.emit("data-change", "entity", entity, "label", row.label,');
		expect(requiredTargets("DataUpdateProbe", { UPD_ENTITY: " ZLGD_Qty_Wtd " })).toEqual(["data:zlgd_qty_wtd"]);
		expect(
			updatedRows([
				{ t: "data-change", label: "WTD-0001", name: "检验结论", before: "空", after: "合格" },
				{ t: "seed-row", label: "x" },
			]),
		).toEqual(["WTD-0001 检验结论：空 → 合格"]);
	});

	it("造数改数落到库里的单记下单据和主键，交付前按它回读", () => {
		expect(
			writtenRows([
				{ t: "seed-row", entity: "zlgd_qty_wtd", label: "第1条", pk: "11", number: "WTD-0001", found: true },
				// 回读没找到的那条不是造出来的数据
				{ t: "seed-row", entity: "zlgd_qty_wtd", label: "第2条", pk: "12", number: "WTD-0002", found: false },
				{ t: "data-change", entity: "zlgd_qty_wtd", label: "WTD-0003", pk: "13", name: "检验结论" },
				// 同一张单改了几格只记一次
				{ t: "data-change", entity: "zlgd_qty_wtd", label: "WTD-0003", pk: "13", name: "报告类型" },
				{ t: "data-entity", entity: "zlgd_qty_wtd" },
			]),
		).toEqual([
			{ entity: "zlgd_qty_wtd", pk: "11", label: "WTD-0001" },
			{ entity: "zlgd_qty_wtd", pk: "13", label: "WTD-0003" },
		]);
	});

	it("运行日志里认写了哪些表：只读的认成空，平台锁表不算，没打 SQL 的认不出", () => {
		const sql = (statement: string) =>
			`2026-10-14 11:01:01.259  INFO   --- [cosmic-probe-hot] DB : ----sql@secd->secd#con1----\n#cost:1ms\n${statement}\n2589\n`;
		expect(writtenTablesOf(sql(" /*ORM*/  SELECT T1.FId FROM tk_zlgd_bill T1 WHERE T1.FId= ?"))).toEqual([]);
		expect(
			writtenTablesOf(
				sql("INSERT INTO t_mutex_datalock (FID) VALUES (?)") +
					sql("/*ORM*/ DELETE FROM tk_zlgd_bill WHERE FId IN (?)") +
					sql("/*ORM*/ INSERT INTO tk_zlgd_bill_e(FId,FEntryId) VALUES (?,?)") +
					sql("update TK_ZLGD_BILL set fk_x = ?") +
					sql("delete from t_mutex_datalock where fid = ?"),
			),
		).toEqual(["tk_zlgd_bill", "tk_zlgd_bill_e"]);
		// 业务代码里打印的话不是 SQL 日志
		expect(writtenTablesOf("[PROBE] update 成功\n[PROBE] 只读结束")).toBeUndefined();
	});

	it("回读只认查询走完的：列出的 id 是还在的，没走到「只读结束」的是没查成", () => {
		const query = source("DataQueryProbe");
		expect(query).toContain('new StringBuilder("[PROBE] #").append(i + 1).append("  ")');
		expect(query).toContain('System.out.println("[PROBE] 只读结束，未做任何写入");');
		expect(
			queriedIds(
				"[PROBE] 实体 zlgd_qty_wtd  委托单  主表=t\r\n[PROBE] #1  id=13\r\n[PROBE] 命中 1 条\r\n[PROBE] 只读结束，未做任何写入",
			),
		).toEqual(new Set(["13"]));
		expect(queriedIds("[PROBE] 命中 0 条。\n[PROBE] 只读结束，未做任何写入")).toEqual(new Set());
		expect(queriedIds("[PROBE] ✗ 查询失败：连接断开")).toBeNull();
	});
});

describe("S21 链上有撤不回的插件时，造数的预演在起 JVM 前拒", () => {
	const index = (bindings: { entity: string; kind: string; numbers: string[] }[]) =>
		JSON.stringify({
			kind: "ImpactIndex",
			at: "2026-09-15T00:00:00.000Z",
			classes: [
				{
					class: "com.demo.NotifyPlugin",
					file: "src/main/java/com/demo/NotifyPlugin.java",
					pluginType: "operation",
					bindings: bindings.map((binding) => ({ ...binding, layouts: binding.numbers.length, enabled: true })),
					entities: [],
					fields: [],
					chain: [],
				},
			],
		});

	function withPlugin() {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		fake.fs.put(
			`${fake.ctx.layout.moduleDirs[0]?.src ?? ""}/com/demo/NotifyPlugin.java`,
			'public class NotifyPlugin { String bill = "zlgd_qty_wtd"; void run(){ MessagePublisher.publish(); } }',
		);
		return fake;
	}

	it("登记在单据操作链上：S27 起不拦，只提醒会真的发出去", () => {
		const fake = withPlugin();
		fake.fs.put(fake.ctx.layout.impactIndex, index([{ entity: "zlgd_qty_wtd", kind: "entity", numbers: [] }]));
		const notes = dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("MessagePublisher");
		expect(notes[0]).toContain("会真的发出去");
	});

	it("只登记成表单插件（操作链调不到）：不提醒", () => {
		const fake = withPlugin();
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			index([{ entity: "zlgd_qty_wtd", kind: "form", numbers: ["zlgd_qty_wtd"] }]),
		);
		expect(dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed")).toEqual([]);
	});

	it("没有代码关系表：按源码里提到过单据判，提醒里标明可能误判", () => {
		const fake = withPlugin();
		const notes = dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("可能是误判");
	});

	it("改数据用同一个判据，提醒里说怎么绕开插件", () => {
		const fake = withPlugin();
		fake.fs.put(fake.ctx.layout.impactIndex, index([{ entity: "zlgd_qty_wtd", kind: "entity", numbers: [] }]));
		const notes = dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "update");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("UPD_OP=direct");
	});

	it("单据上没有本工程的插件：不提醒", () => {
		const fake = withPlugin();
		fake.fs.put(fake.ctx.layout.impactIndex, index([{ entity: "zlgd_other", kind: "entity", numbers: [] }]));
		expect(dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed")).toEqual([]);
	});

	it("插件自己文件里没有、经工具类调到外部接口的：顺着调用边提醒，写出路径和快照日期", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		fake.fs.put(
			`${fake.ctx.layout.moduleDirs[0]?.src ?? ""}/com/demo/NotifyPlugin.java`,
			"public class NotifyPlugin { void run(){ Util.isHoliday(); } }",
		);
		const base = JSON.parse(index([{ entity: "zlgd_qty_wtd", kind: "entity", numbers: [] }]));
		const edge = (from: string, to: string) => ({
			from: `com.demo.${from}()`,
			to: `com.demo.${to}()`,
			fromClass: `com.demo.${from.split("#")[0]}`,
			toClass: `com.demo.${to.split("#")[0]}`,
		});
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				...base,
				meta: { at: "2026-09-23T00:00:00.000Z" },
				edges: [
					edge("NotifyPlugin#run", "Util#isHoliday"),
					edge("Util#isHoliday", "Util#fromApi"),
					edge("Util#format", "Util#pad"),
				],
				effects: [
					{ class: "com.demo.Util", inMethod: "com.demo.Util#fromApi()", line: 9, effect: "HttpURLConnection" },
				],
			}),
		);
		const notes = dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed");
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("（HttpURLConnection）");
		expect(notes[0]).toContain("经 NotifyPlugin#run → Util#isHoliday → Util#fromApi；");
		expect(notes[0]).toContain("快照 09-23");
	});

	it("调到的只是工具类里不出门的方法：不提醒", () => {
		const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
		fake.fs.put(
			`${fake.ctx.layout.moduleDirs[0]?.src ?? ""}/com/demo/NotifyPlugin.java`,
			"public class NotifyPlugin { void run(){ Util.format(); } }",
		);
		const base = JSON.parse(index([{ entity: "zlgd_qty_wtd", kind: "entity", numbers: [] }]));
		fake.fs.put(
			fake.ctx.layout.impactIndex,
			JSON.stringify({
				...base,
				edges: [
					{
						from: "com.demo.NotifyPlugin#run()",
						to: "com.demo.Util#format()",
						fromClass: "com.demo.NotifyPlugin",
						toClass: "com.demo.Util",
					},
				],
				effects: [
					{ class: "com.demo.Util", inMethod: "com.demo.Util#fromApi()", line: 9, effect: "HttpURLConnection" },
				],
			}),
		);
		expect(dataWriteEffectNotes(fake.ctx, "zlgd_qty_wtd", "seed")).toEqual([]);
	});
});
