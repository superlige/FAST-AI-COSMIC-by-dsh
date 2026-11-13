/**
 * 复盘-harness-FormRuleProbe只读拦截与临时探针预检误报 §8.4-2（2026-09-11 第二轮）：
 * 已发布探针只以类名出现在提示里，DataProbe 看名字像「查数据」，实际只数行数、取一条样本，
 * 不能按条件查——会话只能翻源码才知道。`cosmic_knowledge probes` 按需给出每个探针一行能力说明。
 */
import { describe, expect, it } from "vitest";
import { knowledgeProbes } from "../../src/kernel/commands/knowledge.ts";
import { probeSummary } from "../../src/kernel/commands/probe.ts";
import { META_HELP, parseMeta } from "../../src/kernel/meta/parse.ts";
import { describeAttach, describeBinding, PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";
import { releasedProbeCatalog } from "../../src/runtime/resources.ts";

describe("probeSummary：探针源码头注释的第一句", () => {
	it("类注释排在 import 之后照样读到，只取第一句，去掉 ** 和 {@link}", () => {
		const source = [
			"import java.util.List;",
			"",
			"/**",
			" * 只读：用 {@link FormView} 看**全部下游布局**，",
			" * 再判断控件显不显示。后面这句不要。",
			" *",
			" *   TREE_ROOT=单据标识",
			" */",
			'@SuppressWarnings("unused")',
			"public class TreeProbe {",
			"  /** 字段注释不算。 */",
			"}",
		].join("\n");
		expect(probeSummary(source)).toBe("只读：用 FormView 看全部下游布局，再判断控件显不显示。");
	});

	it("类上没有注释就是空串，不拿上面别处的注释顶替", () => {
		expect(probeSummary("public class Bare { public static void run() {} }")).toBe("");
		const stray = ["/** 这是文件头，不是类注释。 */", "import java.util.List;", "public class Stray {}"].join("\n");
		expect(probeSummary(stray)).toBe("");
	});
});

describe("已发布探针能力清单", () => {
	const catalog = releasedProbeCatalog(EMBEDDED_RESOURCES);

	it("每个已发布探针都有一句说明——新探针不写头注释，这里就红", () => {
		expect(catalog.length).toBeGreaterThan(0);
		expect(catalog.filter((entry) => entry.summary === "").map((entry) => entry.name)).toEqual([]);
	});

	it("DataProbe 那一行说清它只回答有没有数据", () => {
		const listed = knowledgeProbes(catalog, "").probes;
		expect(listed).toHaveLength(catalog.length);
		expect(listed.find((line) => line.startsWith("DataProbe(DATA_ENTITY)："))).toContain("有没有数据");
	});

	it("按类名查（不分大小写）附上全部入参，含可选；不认识的名字单独列出", () => {
		const report = knowledgeProbes(catalog, "DataProbe, fieldlimitprobe Nope");
		expect(report.probes).toHaveLength(2);
		expect(report.usage.DataProbe?.join("\n")).toContain("DATA_PK=");
		expect(report.usage.FieldLimitProbe?.join("\n")).toContain("LIMIT_VALUES=");
		expect(report.unknown).toEqual(["Nope"]);
	});

	it("不给类名时不附入参块，免得整份清单翻几倍", () => {
		expect(knowledgeProbes(catalog, "").usage).toEqual({});
	});
});

/**
 * 2026-10-12 真机：模型要给提交操作挂一个新写的操作插件，看探针名单里 `FormLayoutWriteProbe` 名字是"布局"，
 * 认定没有探针能挂，让用户去开发平台点。写探针的说明和入参注释里都写着挂插件，只是清单只能按类名取。
 */
describe("探针清单按要做的事查", () => {
	const catalog = releasedProbeCatalog(EMBEDDED_RESOURCES);
	const namesOf = (query: string) =>
		knowledgeProbes(catalog, query).probes.map((line) => /^[A-Za-z0-9_]+/.exec(line)?.[0]);

	it("不是类名的词去对说明和入参注释：挂操作插件找得到改单据的写探针，连写法那一行一起回", () => {
		const report = knowledgeProbes(catalog, "挂操作插件");
		expect(namesOf("挂操作插件")).toContain("FormLayoutWriteProbe");
		expect(report.matched?.FormLayoutWriteProbe?.join("\n")).toContain(
			"add plugin <类全名> [to list | to op <操作>]",
		);
		// 按用途找出来的不附整块入参：那一块 30 多行，要看再按类名查
		expect(report.usage).toEqual({});
		expect(report.unknown).toEqual([]);
	});

	it("只回对得上的几个，不是整张清单", () => {
		for (const query of ["操作插件 绑定", "op plugin binding write", "按条件查数据", "界面规则 锁定字段"]) {
			const listed = namesOf(query);
			expect(listed.length).toBeGreaterThan(0);
			expect(listed.length).toBeLessThanOrEqual(5);
		}
		expect(namesOf("按条件查数据")[0]).toBe("DataQueryProbe");
		expect(namesOf("界面规则 锁定字段")[0]).toBe("FormRuleProbe");
	});

	it("类名和要做的事混着给：点了名的附全部入参排前面，其余按用途找", () => {
		const report = knowledgeProbes(catalog, "FormPluginProbe 挂操作插件");
		expect(report.probes[0]).toMatch(/^FormPluginProbe\(/);
		expect(Object.keys(report.usage)).toEqual(["FormPluginProbe"]);
		expect(namesOf("FormPluginProbe 挂操作插件")).toContain("FormLayoutWriteProbe");
	});

	it("一个词都对不上：清单是空的，照实说没对上，不拿整张清单顶替", () => {
		const report = knowledgeProbes(catalog, "xyzzy");
		expect(report.probes).toEqual([]);
		expect(report.unknown).toEqual(["xyzzy"]);
		expect(report.note).toContain("没有探针");
	});
});

describe("插件路线表里「怎么挂」那一栏指向的写法真在探针里", () => {
	const catalog = releasedProbeCatalog(EMBEDDED_RESOURCES);

	it("工具挂不了的每一族都说了登记在哪、要用户去哪配；不用登记的说了靠什么生效", () => {
		const byUser = PLUGIN_ROUTES.filter((route) => "byUser" in route.attach);
		// 报表取数两族、开放接口五族、转换、反写、引入、后台任务、工作流（移动端三族由写探针挂）
		expect(byUser).toHaveLength(12);
		for (const route of byUser) {
			const text = describeAttach(route.attach);
			expect(text, route.base).toMatch(/^没挂上的工具挂不了：登记在.+，要用户在.+/);
		}
		const inCode = PLUGIN_ROUTES.filter((route) => "inCode" in route.attach);
		expect(inCode.map((route) => route.base)).toEqual(["AbstractValidator"]);
		expect(describeAttach(inCode[0]?.attach ?? null)).toBe("不用登记：由操作插件在 onAddValidators 里加上");
	});

	it("查绑定的探针都是已发布的；没有探针能查的四族写明用代码关系表查", () => {
		for (const route of PLUGIN_ROUTES) {
			if (route.bind === null) continue;
			expect(
				catalog.find((entry) => entry.name === route.bind),
				`${route.base} 的查法指向 ${route.bind}`,
			).toBeDefined();
			// 单独跑它只打各处的条数，类名走的是建表用的旁路，答不了「这个类挂在哪」
			expect(route.bind, route.base).not.toBe("PluginIndexProbe");
		}
		const unread = PLUGIN_ROUTES.filter((route) => route.bind === null);
		expect(unread.map((route) => route.base)).toEqual([
			"AbstractReportTreeDataPlugin",
			"AbstractWriteBackPlugIn",
			"BatchImportPlugin",
			"AbstractTask",
		]);
		for (const route of unread) {
			expect(describeBinding(route.bind, route.attach)).toMatch(
				/^先 cosmic_impact 查这个类挂在哪，没挂上的工具挂不了：/,
			);
		}
	});

	it("靠 cosmic_meta 挂的（打印插件）：两条命令都解析得过，登记那条在用法说明里", () => {
		const viaMeta = PLUGIN_ROUTES.filter((route) => "meta" in route.attach);
		expect(viaMeta.map((route) => route.base)).toContain("AbstractPrintPlugin");
		const argv = (line: string) =>
			line
				.replace("<候选目录>", "D:/x")
				.replace("<类全名>", "demo.print.DemoPrintPlugin")
				.replace("<模板编码>", "demo_tpl")
				.replace("<候选文件>", "D:/x/demo_tpl.meta.json")
				.split(" ");
		for (const route of viaMeta) {
			const attach = route.attach;
			if (!("meta" in attach)) continue;
			const edit = parseMeta(argv(attach.meta));
			expect(edit.ok && edit.value.kind === "edit" && edit.value.op.op, attach.meta).toBe("plugin");
			expect(parseMeta(argv(attach.handBack)).ok, attach.handBack).toBe(true);
			expect(META_HELP).toContain("--plugin 类全名");
		}
	});

	it("探针是已发布的、入参名在头注释里、那一行写法头注释里有", () => {
		const attached = PLUGIN_ROUTES.filter((route) => "probe" in route.attach);
		expect(attached.map((route) => route.base)).toContain("AbstractOperationServicePlugIn");
		expect(attached.map((route) => route.base)).toContain("AbstractReportFormPlugin");
		for (const route of attached) {
			const attach = route.attach;
			if (!("probe" in attach)) continue;
			const probe = catalog.find((entry) => entry.name === attach.probe);
			expect(probe, `${route.base} 的挂法指向 ${attach.probe}`).toBeDefined();
			const usage = (probe?.usage ?? []).join("\n");
			expect(usage).toContain(`${attach.input}=`);
			// 头注释把三种挂法写成一行：add plugin <类全名> [to list | to op <操作>]
			const [head, tail] = attach.line.split(/ (?=to )/);
			expect(usage).toContain(`${head} [`);
			if (tail !== undefined) expect(usage).toContain(tail);
			// 移动端那几族先切布局：头注释里那一行写着 layout bill|mobile|mobilelist
			if (attach.layout !== undefined) expect(usage).toMatch(/layout bill|mobile|mobilelist/);
		}
		const mobile = attached.filter((route) => route.base.startsWith("AbstractMob"));
		expect(mobile.map((route) => describeAttach(route.attach))).toEqual([
			"没挂上就用 FormLayoutWriteProbe 挂：LAYOUT_EDIT 里先写 layout mobile（独立的移动表单不写这行），再写 add plugin <类全名>",
			"没挂上就用 FormLayoutWriteProbe 挂：LAYOUT_EDIT 里先写 layout mobilelist，再写 add plugin <类全名>",
			"没挂上就用 FormLayoutWriteProbe 挂：LAYOUT_EDIT 里先写 layout mobile（独立的移动表单不写这行），再写 add plugin <类全名>",
		]);
	});
});
