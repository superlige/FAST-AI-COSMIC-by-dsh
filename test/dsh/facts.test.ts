/**
 * cosmic_facts 报的是「现在和本会话开始时」的净差别：用户来回改几轮，完成情况只说最后的样子；
 * 桌面版重开同一个会话，起点不挪；不报编译、运行的次数。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rememberOriginal } from "../../src/agent/tools/style-check.ts";
import { SessionStore } from "../../src/dsh/session.ts";
import { factsText } from "../../src/dsh/tools/facts.ts";
import { runTouches } from "../../src/dsh/tools/run.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(): string {
	const root = mkdtempSync(join(tmpdir(), "cosmic-facts-"));
	dirs.push(root);
	return root;
}

/** 照文件工具的钩子走一遍：写之前记原文，写完记改动、落盘。 */
function edit(store: SessionStore<unknown>, id: string, root: string, file: string, text: string): void {
	const session = store.of(id);
	session.restore(root);
	rememberOriginal(session.style, file, file);
	writeFileSync(file, text);
	session.noteEdited(file);
	session.save(root);
}

const run = (at: string) => ({
	at,
	argv: ["op", "demo_bill", "save", "--expect", "success=true"],
	kind: "op",
	target: "demo_bill",
	exitCode: 0,
	passed: 1,
	failed: 0,
	outputFile: null,
});

describe("cosmic_facts 报净差别", () => {
	it("同一处改了几次只报最后的样子，改回原样的不算", () => {
		const root = project();
		const a = join(root, "A.java");
		const b = join(root, "B.java");
		writeFileSync(a, "class A {\n  int x = 1;\n}\n");
		writeFileSync(b, "class B {}\n");
		const store = new SessionStore<unknown>();
		edit(store, "s1", root, a, "class A {\n  int x = 2;\n}\n");
		edit(store, "s1", root, a, "class A {\n  int x = 3;\n}\n");
		edit(store, "s1", root, b, "class B { int y; }\n");
		edit(store, "s1", root, b, "class B {}\n");
		const text = factsText(store.of("s1"));
		expect(text).toContain("## 代码：1 个业务文件和会话开始时不同");
		expect(text).toContain("  -   int x = 1;");
		expect(text).toContain("  +   int x = 3;");
		expect(text).not.toContain("int x = 2;");
		expect(text).toContain("另有 1 个文件改过，现在和会话开始时一样");
		expect(text).not.toMatch(/编译：\d+ 次/);
	});

	it("桌面版重开同一个会话，比对起点还是第一次开始时", () => {
		const root = project();
		const a = join(root, "A.java");
		writeFileSync(a, "v0\n");
		const first = new SessionStore<unknown>();
		edit(first, "s1", root, a, "v1\n");
		const startedAt = first.of("s1").startedAt;
		// 进程重启：新的一份内存，同一个会话编号
		const second = new SessionStore<unknown>();
		edit(second, "s1", root, a, "v2\n");
		const session = second.of("s1");
		expect(session.startedAt).toBe(startedAt);
		const text = factsText(session);
		expect(text).toContain("  - v0");
		expect(text).toContain("  + v2");
		expect(text).not.toContain("v1");
	});

	it("元数据按对象归拢，带确认单上的表；没写成的单列", () => {
		const root = project();
		const store = new SessionStore<unknown>();
		const session = store.of("s1");
		session.restore(root);
		const base = {
			probe: "EntityFieldProbe",
			kind: "新增字段",
			object: "演示单（demo_bill）",
			undo: "删掉这个字段",
			backup: ".cosmic-ai/evidence/meta-backup/改前",
			outputFile: null,
		};
		session.metaWrites.push(
			{
				...base,
				at: "2026-01-01T00:00:01Z",
				purpose: "记原始值",
				outcome: "written",
				form: "字段  改前：无  改后：原始值",
			},
			{
				...base,
				at: "2026-01-01T00:00:02Z",
				purpose: "改名",
				outcome: "written",
				form: "字段  改前：原始值  改后：修约前值",
			},
			{ ...base, at: "2026-01-01T00:00:03Z", purpose: "加备注", outcome: "declined", form: "备注" },
		);
		const text = factsText(session);
		expect(text).toContain("## 元数据：1 个对象写进了测试环境");
		expect(text).toContain("### 演示单（demo_bill）（写了 2 次，按先后列；同一项以后一次为准）");
		expect(text).toContain("    字段  改前：原始值  改后：修约前值");
		expect(text).toContain("- 没写成的：1");
		expect(text).toContain("用户没确认，没写：新增字段 演示单（demo_bill）（加备注）");
	});

	it("改代码之前跑的断言标成验的不是现在的代码", () => {
		const root = project();
		const a = join(root, "A.java");
		writeFileSync(a, "v0\n");
		const store = new SessionStore<unknown>();
		const session = store.of("s1");
		session.runs.push(run("2000-01-01T00:00:00Z"));
		edit(store, "s1", root, a, "v1\n");
		session.runs.push(run("2999-01-01T00:00:00Z"));
		const lines = factsText(session).split("\n");
		const runs = lines.filter((line) => line.includes("run op demo_bill save"));
		expect(runs).toHaveLength(2);
		expect(runs[0]).toContain("之后又改过代码，验的不是现在的代码");
		expect(runs[1]).not.toContain("之后又改过代码");
		expect(lines).toContain("- 现在的代码：最后一次改代码之后还没编译过");
	});

	it("带了 --expect 但断言之前就中断的，报没验成，不说成只看值", () => {
		const session = new SessionStore<unknown>().of("s1");
		const form = ["form", "demo_bill", "--pk", "1", "--hyperlink", "billentry[0].demo_link"];
		session.runs.push({
			...run("2000-01-01T00:00:00Z"),
			argv: [...form, "--expect", "opened=demo_show", "--expect=opened.rows=@nonempty"],
			kind: "form",
			exitCode: 1,
			passed: 0,
		});
		session.runs.push({
			...run("2000-01-01T00:00:01Z"),
			argv: [...form, "--show", "opened"],
			kind: "form",
			passed: 0,
		});
		const lines = factsText(session)
			.split("\n")
			.filter((line) => line.includes("run form demo_bill"));
		expect(lines[0]).toContain("没验成：带了 2 条 --expect，运行在断言之前就中断了，一条都没执行到");
		expect(lines[0]).not.toContain("只看值");
		expect(lines[1]).toContain("只看值，没有断言");
	});

	// 真机 2026-11-19：run op save 真存进库的两张测试单，事实账报「造出 0 条」；
	// 模型拿自己手填字段建的那张跑反审核，报错归成了「既有插件报错」。
	it("cosmic_run 新建的单算进造数，带怎么造的；后面跑到它的运行标出来", () => {
		const session = new SessionStore<unknown>().of("s1");
		const bill = { entity: "demo_bill", pk: "100", billno: "T-1", what: "新建" };
		session.runs.push({
			...run("2000-01-01T00:00:00Z"),
			argv: ["op", "demo_bill", "save", "--set", "billno=T-1", "--expect", "success=true"],
			bills: [{ ...bill, status: "A", created: true }],
		});
		session.runs.push({
			...run("2000-01-01T00:00:01Z"),
			argv: ["op", "demo_bill", "unaudit", "--pk", "100", "--expect", "success=true"],
			exitCode: 1,
			passed: 0,
			failed: 1,
			bills: [{ ...bill, status: "C", created: false, what: "unaudit" }],
		});
		session.runs.push({
			...run("2000-01-01T00:00:02Z"),
			argv: ["push", "rule1", "--pk", "7", "--expect", "success=true"],
			kind: "push",
			bills: [{ entity: "demo_down", pk: "200", billno: "D-1", status: "A", created: true, what: "下推" }],
		});
		const text = factsText(session);
		expect(text).toContain("造出 2 条（造数探针 0 条，cosmic_run 新建的单 2 张）");
		expect(text).toContain(
			"- demo_bill pk=100 编号=T-1，现在单据状态=C：run op 免界面直接新建：字段只有 --set 给的那些，没走上游下推",
		);
		expect(text).toContain("- demo_down pk=200 编号=D-1，现在单据状态=A：按转换规则 rule1 下推生成（源单 7）");
		const unaudit = text.split("\n").find((line) => line.includes("run op demo_bill unaudit"));
		expect(unaudit).toContain("跑的是本会话 2000-01-01T00:00:00Z 那次运行手工新建、没走上游下推的单 pk=100");
		const save = text.split("\n").find((line) => line.includes("run op demo_bill save"));
		expect(save).not.toContain("跑的是本会话");
	});

	// 真机 2026-11-19：挂在提交、反审核上的额度插件一次没跑过，事实账只列了一串界面运行「断言全过」。
	it("改过的插件逐个报跑到没有，0 也报；不是插件的类只报个数", () => {
		const root = project();
		const src = join(root, "src", "main", "java", "demo");
		mkdirSync(src, { recursive: true });
		const op = join(src, "DemoOccupyOp.java");
		const form = join(src, "DemoFormPlugin.java");
		const service = join(src, "DemoService.java");
		const store = new SessionStore<unknown>();
		edit(
			store,
			"s1",
			root,
			op,
			"package demo;\nimport kd.bos.entity.plugin.AbstractOperationServicePlugIn;\npublic class DemoOccupyOp extends AbstractOperationServicePlugIn {}\n",
		);
		edit(
			store,
			"s1",
			root,
			form,
			"package demo;\nimport kd.bos.form.plugin.AbstractFormPlugin;\npublic class DemoFormPlugin extends AbstractFormPlugin {}\n",
		);
		edit(store, "s1", root, service, "package demo;\npublic class DemoService {}\n");
		const session = store.of("s1");
		session.metaWrites.push({
			at: "2999-01-01T00:00:00Z",
			probe: "FormLayoutWriteProbe",
			kind: "单据布局",
			object: "演示单（demo_bill）",
			purpose: "挂插件",
			outcome: "written",
			undo: "写回备份",
			backup: null,
			outputFile: null,
			form: "元素：submit（操作） 改后：demo.DemoOccupyOp",
		});
		session.runs.push({
			...run("2999-01-01T00:00:01Z"),
			argv: ["form", "demo_bill", "--expect", "demo_qty=1"],
			kind: "form",
			plugins: ["demo.DemoFormPlugin"],
		});
		session.runs.push({ ...run("2999-01-01T00:00:02Z"), argv: ["rule", "form", "demo_bill"], kind: "rule" });
		const lines = factsText(session).split("\n");
		expect(lines).toContain("## 本会话改过的插件类：2 个，有运行跑到 1 个，没跑到 1 个");
		expect(lines).toContain(
			"- DemoOccupyOp（AbstractOperationServicePlugIn）：没跑到，没有一次运行的操作、表单上挂着它；本会话把它挂到了 演示单（demo_bill）",
		);
		expect(lines.find((line) => line.startsWith("- DemoFormPlugin"))).toContain(
			"跑到 1 次，最后一次 2999-01-01T00:00:01Z 断言全过（1 条）：run form demo_bill",
		);
		expect(lines.some((line) => line.startsWith("- 另有 1 个改过的类不是插件"))).toBe(true);
		expect(lines.some((line) => line.startsWith("- run rule 不报挂着哪些插件（本会话 1 次）"))).toBe(true);
	});

	it("没改插件、没新建单时两节照样报 0", () => {
		const text = factsText(new SessionStore<unknown>().of("s1"));
		expect(text).toContain("## 本会话改过的插件类：0 个，有运行跑到 0 个，没跑到 0 个");
		expect(text).toContain("造出 0 条（造数探针 0 条，cosmic_run 新建的单 0 张）");
	});
});

describe("run 记账", () => {
	it("从记录里取出新建的单和挂着的本工程插件，run call 认被调的类", () => {
		const touched = runTouches([
			{ t: "committed", entity: "demo_bill", pk: "100", billno: "T-1", status: "A", what: "新建", created: true },
			{ t: "own-plugins", entity: "demo_bill", where: "op submit", classes: ["demo.A", "demo.B"] },
			{ t: "own-plugins", entity: "demo_bill", where: "form demo_bill", classes: ["demo.A"] },
			{ t: "scenario", adapter: "run call", class: "demo.C" },
			{ t: "assert", pass: true },
		]);
		expect(touched.bills).toEqual([
			{ entity: "demo_bill", pk: "100", billno: "T-1", status: "A", created: true, what: "新建" },
		]);
		expect(touched.plugins).toEqual(["demo.A", "demo.B", "demo.C"]);
	});
});
