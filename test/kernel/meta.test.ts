/**
 * S5.4 `meta`: parsing, the offline diff, and the fact that every probing action
 * goes through `probe()` rather than around it.
 *
 * The parsing block is a port of the frozen tools/metacmd.test.mjs assertions --
 * same invocations, same expected env keys. That is deliberate: the probes read
 * those keys by name, so a "tidier" name here is a probe that silently receives
 * no input at all, which is invisible in a passing test that only checked the
 * shape of the plan.
 */

import { describe, expect, it } from "vitest";
import { meta } from "../../src/kernel/commands/meta.ts";
import { diffDesign, diffLines, pairNames } from "../../src/kernel/meta/diff.ts";
import { META_FAMILIES, metaOperationDigest, parseMeta, splitArgs } from "../../src/kernel/meta/parse.ts";
import { type FakeContext, makeContext } from "./fake-context.ts";

/**
 * Every fake probe declares its input as optional, because the real ones do: of
 * the ten probes the meta families name, only PrintGridDumpProbe uses `req(…)`.
 * Giving them all a required input made the fixture refuse at the input
 * preflight (`PROBE_INPUT_MISSING`) for families that legitimately pass a
 * different key -- a fixture artefact, not a defect these tests are about.
 */
const PROBE_SRC = 'class BotpRuleProbe { void run() { env("BOTP_SOURCE", ""); } }';

/** A context whose released set contains every probe the meta families name. */
function metaFake(): FakeContext {
	const probes = [
		"BotpRuleProbe",
		"BotpRuleSyncProbe",
		"PrintTplProbe",
		"PrintTplJsonProbe",
		"PrintTplDesignProbe",
		"PrintGridDumpProbe",
		"PrintTplBackupProbe",
		"PrintTplWriteProbe",
		"PrintMeasureProbe",
		"WfModelProbe",
		"FormulaFunctionProbe",
	];
	const fake = makeContext({ probes });
	for (const name of probes) {
		fake.fs.put(
			`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/${name}.java`,
			PROBE_SRC.replace("BotpRuleProbe", name),
		);
	}
	return fake;
}

const plan = (argv: readonly string[]) => {
	const parsed = parseMeta(argv);
	if (!parsed.ok) throw new Error(`expected a plan, got ${parsed.error.message}`);
	return parsed.value;
};

const refusal = (argv: readonly string[]) => {
	const parsed = parseMeta(argv);
	if (parsed.ok) throw new Error("expected a refusal");
	return parsed.error;
};

describe("S5.4 meta argument parsing", () => {
	it("no arguments is help, not an error", () => {
		const help = plan([]);
		expect(help.kind).toBe("help");
		expect(help.kind === "help" && help.text).toContain("wf list");
	});

	it("refuses an unknown family and an unknown action by name", () => {
		expect(refusal(["botq", "list"]).message).toContain("只有 botp / formula / ptpl / wf");
		expect(refusal(["wf", "apply"]).message).toContain("list | dump | backup | diff");
		// wf has no write channel at all; the refusal has to say so rather than
		// running a read action and reporting success.
		expect(META_FAMILIES.wf?.actions).not.toContain("restore");
	});

	it("collects repeated --set and splits --k=v", () => {
		const { opts, pos } = splitArgs(["ptpl", "apply", "t1", "--set", "a.b=1", "--set=c.d=2", "--backup", "out"]);
		expect(pos).toEqual(["ptpl", "apply", "t1"]);
		expect(opts.set).toEqual(["a.b=1", "c.d=2"]);
		expect(opts.backup).toBe("out");
	});

	it("routes each formula domain through the same read probe with bounded, explicit filters", () => {
		for (const domain of ["print", "form", "biz"]) {
			const summary = plan(["formula", domain]);
			expect(summary).toMatchObject({
				kind: "probe",
				probe: "FormulaFunctionProbe",
				writes: false,
				env: { FORMULA_DOMAIN: domain, FORMULA_MODE: "function", FORMULA_PAGE: "1", FORMULA_LIMIT: "3" },
			});
		}
		expect(plan(["formula", "print", "--name", "CONCAT"])).toMatchObject({
			env: { FORMULA_NAME: "CONCAT", FORMULA_QUERY: "" },
		});
		expect(plan(["formula", "form", "--actions", "--q", "显示"])).toMatchObject({
			env: { FORMULA_MODE: "action", FORMULA_QUERY: "显示" },
		});
		expect(plan(["formula", "biz", "--group", "计算", "--page", "2", "--limit", "2"])).toMatchObject({
			env: { FORMULA_GROUP: "计算", FORMULA_PAGE: "2", FORMULA_LIMIT: "2" },
		});
		for (const argv of [
			["formula", "print", "--actions"],
			["formula", "print", "--name", "IF", "--q", "判断"],
			["formula", "form", "--limit", "50"],
			["formula", "biz", "--page", "2"],
			["formula", "biz", "--unknown"],
		])
			expect(refusal(argv).code).toBe("META_ARGS_INVALID");
	});

	it("botp list passes the source bill through and leaves the probe's default alone", () => {
		const listed = plan(["botp", "list"]);
		expect(listed.kind === "probe" && listed.probe).toBe("BotpRuleProbe");
		expect(listed.kind === "probe" && listed.env.BOTP_SOURCE).toBeUndefined();
		const filtered = plan(["botp", "list", "zlgd_po", "--target", "zlgd_in", "--plugin", "Foo"]);
		expect(filtered.kind === "probe" && filtered.env).toMatchObject({
			BOTP_SOURCE: "zlgd_po",
			BOTP_TARGET: "zlgd_in",
			BOTP_PLUGIN: "Foo",
			BOTP_DETAIL: "0",
		});
	});

	it("botp dump clears the source default, because it would filter an id lookup to nothing", () => {
		const dumped = plan(["botp", "dump", "123456"]);
		expect(dumped.kind === "probe" && dumped.env).toMatchObject({
			BOTP_RULE: "123456",
			BOTP_SOURCE: "",
			BOTP_DETAIL: "1",
		});
		expect(plan(["botp", "dump", "123", "--fields"]).kind === "probe").toBe(true);
		const fields = plan(["botp", "dump", "123", "--fields"]);
		expect(fields.kind === "probe" && fields.env.BOTP_DETAIL).toBe("2");
	});

	it("botp backup with no filter is refused: no filter means every rule in the library", () => {
		expect(refusal(["botp", "backup", "out/"]).message).toContain("不给条件等于备份全部规则");
		const scoped = plan(["botp", "backup", "out/", "--rule", "a,b"]);
		expect(scoped.kind === "probe" && scoped.env).toMatchObject({ SYNC_BACKUP: "out/", SYNC_TARGETS: "a,b" });
	});

	it("marks exactly the two write channels", () => {
		expect(
			plan(["botp", "restore", "out/"]).kind === "probe" &&
				(plan(["botp", "restore", "out/"]) as { writes: boolean }).writes,
		).toBe(true);
		const applied = plan(["ptpl", "apply", "t1", "--set", "head.visible=false"]);
		expect(applied.kind === "probe" && applied.writes).toBe(true);
		expect(applied.kind === "probe" && applied.env.TPL_SET).toBe("head.visible=false");
		for (const readonlyArgv of [
			["botp", "list"],
			["ptpl", "dump", "t1"],
			["wf", "list"],
			["ptpl", "measure", "t1", "--bill", "1"],
		]) {
			const p = plan(readonlyArgv);
			expect(p.kind === "probe" && p.writes, readonlyArgv.join(" ")).toBe(false);
		}
	});

	// S32 1.1：整份提交。--set 改标量属性，--file 交回一整份设计数据（加控件、加表格、改公式走这条）。
	it("ptpl apply takes either --set or --file, never both and never neither", () => {
		const whole = plan(["ptpl", "apply", "t1", "--file", "out/t1.meta.json", "--locale", "out/t1.locale.json"]);
		expect(whole.kind === "probe" && whole.writes).toBe(true);
		expect(whole.kind === "probe" && whole.env).toMatchObject({
			TPL_NUMBER: "t1",
			TPL_FILE: "out/t1.meta.json",
			TPL_LOCALE: "out/t1.locale.json",
		});
		expect(whole.kind === "probe" && whole.env.TPL_SET).toBeUndefined();
		expect(() => plan(["ptpl", "apply", "t1", "--set", "a.b=1", "--file", "out/t1.meta.json"])).toThrow(/只能给一个/);
		expect(() => plan(["ptpl", "apply", "t1"])).toThrow(/--file/);
		// --locale 只跟整份提交一起走；单给 --set 时它不该被带进入参。
		const scalar = plan(["ptpl", "apply", "t1", "--set", "a.b=1", "--locale", "out/x.json"]);
		expect(scalar.kind === "probe" && scalar.env.TPL_LOCALE).toBeUndefined();
		// S36 批 5：--pk 是预演时在哪张单上看候选，交给探针的 PRINT_PK（写法同 run print，认 billno:编号）
		const preview = plan(["ptpl", "apply", "t1", "--file", "out/t1.meta.json", "--pk", "billno:SYSJC-1"]);
		expect(preview.kind === "probe" && preview.env.PRINT_PK).toBe("billno:SYSJC-1");
		expect(whole.kind === "probe" && whole.env.PRINT_PK).toBeUndefined();
	});

	// S32 3.4：整份恢复。走的和整份提交同一个探针、同一组关卡，只是那份候选来自备份目录。
	it("ptpl restore 要模板编码和备份目录，走的是同一个写探针", () => {
		const back = plan(["ptpl", "restore", "t1", "build/before", "--backup", "build/now"]);
		expect(back).toMatchObject({
			probe: "PrintTplWriteProbe",
			writes: true,
			env: { TPL_NUMBER: "t1", TPL_RESTORE: "build/before", TPL_BACKUP: "build/now" },
		});
		expect(() => plan(["ptpl", "restore", "t1"])).toThrow(/备份目录/);
		expect(() => plan(["ptpl", "restore"])).toThrow(/模板编码/);
	});

	it("ptpl dump picks a different probe per flag", () => {
		expect((plan(["ptpl", "dump", "zlgd_t"]) as { probe: string }).probe).toBe("PrintTplJsonProbe");
		expect((plan(["ptpl", "dump", "zlgd_t", "--audit"]) as { probe: string }).probe).toBe("PrintTplDesignProbe");
		expect((plan(["ptpl", "dump", "zlgd_t", "--grid", "DataGrid"]) as { probe: string }).probe).toBe(
			"PrintGridDumpProbe",
		);
		// S26：不点名表格就是整张模板的结构概览，同一个探针、不传 GRID
		expect(plan(["ptpl", "dump", "zlgd_t", "--overview"])).toMatchObject({
			probe: "PrintGridDumpProbe",
			env: { TPL_NUMBER: "zlgd_t" },
		});
		expect(
			(plan(["ptpl", "dump", "zlgd_t", "--overview"]) as { env: Record<string, string> }).env.GRID,
		).toBeUndefined();
	});

	it("ptpl locate is a read-only key lookup with a dedicated probe mode", () => {
		const located = plan(["ptpl", "locate", "zlgd_t", "amount"]);
		expect(located).toMatchObject({
			kind: "probe",
			family: "ptpl",
			action: "locate",
			probe: "PrintTplDesignProbe",
			env: { TPL_NUMBER: "zlgd_t", TPL_CONTROL_KEY: "amount" },
			writes: false,
		});
		expect(refusal(["ptpl", "locate", "zlgd_t"]).message).toContain("控件 key");
		expect(refusal(["ptpl", "locate", "zlgd_t"]).remedy).toContain("ptpl locate <模板编码> <控件key>");
	});

	it("diff is offline, and ptpl's is the structural one", () => {
		expect(plan(["botp", "diff", "a", "b"])).toMatchObject({ kind: "diff", mode: "text" });
		expect(plan(["ptpl", "diff", "a", "b"])).toMatchObject({ kind: "diff", mode: "design" });
		expect(refusal(["wf", "diff", "a"]).message).toContain("两个目录");
	});
});

describe("S5.4 meta offline diff", () => {
	it("trims the shared head and tail before comparing", () => {
		const hunks = diffLines("a\nb\nc\nd", "a\nB\nc\nd");
		expect(hunks).toHaveLength(1);
		expect(hunks[0]?.line).toBe(2);
	});

	it("gives up rather than stalling on a huge middle", () => {
		const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join("\n");
		const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join("\n");
		const [hunk] = diffLines(a, b, 10);
		expect(hunk).toMatchObject({ big: true, removed: 50, added: 50 });
	});

	it("aligns design arrays by control id, so inserting one control reports one change", () => {
		const before = {
			controls: [
				{ id: "c1", visible: true },
				{ id: "c2", visible: true },
			],
		};
		const after = {
			controls: [
				{ id: "c0", visible: true },
				{ id: "c1", visible: true },
				{ id: "c2", visible: true },
			],
		};
		const changes = diffDesign(before, after);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.path).toBe(".controls[id=c0]");
	});

	it("reports a leaf change with the control that owns it", () => {
		const changes = diffDesign(
			{ controls: [{ key: "head", type: "Label", visible: true }] },
			{ controls: [{ key: "head", type: "Label", visible: false }] },
		);
		expect(changes).toEqual([
			{ path: ".controls[key=head].visible", owner: "head(Label)", from: "true", to: "false" },
		]);
	});

	it("pairs directory listings by name", () => {
		expect(pairNames(["a", "b"], ["b", "c"])).toEqual({ both: ["b"], onlyA: ["a"], onlyB: ["c"] });
	});
});

describe("S5.4 meta command", () => {
	it("runs the family's probe with the composed overlay, never its own JVM", async () => {
		const fake = metaFake();
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n[PROBE] 3 条规则\n" });
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(321);
		const result = await meta(fake.ctx, ["botp", "list", "zlgd_po"]);
		expect(result.ok && result.value.kind).toBe("probe");
		expect(result.ok && result.value.probe?.probe).toBe("BotpRuleProbe");
		// The line protocol base64s each value, so decode rather than matching text.
		const request = fake.net.requests.at(-1);
		const env = Object.fromEntries(
			(request?.lines ?? [])
				.filter((line) => line.startsWith("env="))
				.map((line) => line.slice(4).split("="))
				.map(([key, value]) => [key, Buffer.from(value ?? "", "base64").toString("utf8")]),
		);
		expect(env).toMatchObject({ BOTP_SOURCE: "zlgd_po", BOTP_DETAIL: "0" });
	});

	it("returns the ptpl locator record without parsing the human line", async () => {
		const fake = metaFake();
		fake.net.handler = () => ({
			ok: true,
			text:
				'RESULT OK 0\n[PROBE] CONTROL-LOCATE key=amount path=$["pages"][0][3] type=Text bindField=amount formulaData=[]\n' +
				'[PROBE-JSON] {"t":"ptpl-control","template":"zlgd_t","key":"amount","path":"$[\\"pages\\"][0][3]","controlType":"Text","bindField":"amount","formulaData":[]}\n',
		});
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(321);

		const result = await meta(fake.ctx, ["ptpl", "locate", "zlgd_t", "amount"]);
		expect(result.ok && result.value.probe?.json.records).toEqual([
			{
				t: "ptpl-control",
				template: "zlgd_t",
				key: "amount",
				path: '$["pages"][0][3]',
				controlType: "Text",
				bindField: "amount",
				formulaData: [],
			},
		]);
		const request = fake.net.requests.at(-1);
		const env = Object.fromEntries(
			(request?.lines ?? [])
				.filter((line) => line.startsWith("env="))
				.map((line) => line.slice(4).split("="))
				.map(([key, value]) => [key, Buffer.from(value ?? "", "base64").toString("utf8")]),
		);
		expect(env).toMatchObject({ TPL_NUMBER: "zlgd_t", TPL_CONTROL_KEY: "amount" });
	});

	it("a write channel without apply is a dry run, and says so", async () => {
		const fake = metaFake();
		const result = await meta(fake.ctx, ["botp", "restore", "out/"]);
		expect(result.ok && result.value.dryRun).toBe(true);
		expect(result.ok && result.value.writes).toBe(true);
		// APPLY never reaches the JVM, so the cold-path/target gate is not triggered.
		const java = fake.proc.runsOf("java").at(-1);
		expect(java?.env.APPLY).toBeUndefined();
		expect(result.ok && result.value.notes.join("\n")).toContain("dry-run");
	});

	it("apply on a write channel goes through the confirmed-target gate", async () => {
		const fake = metaFake();
		const result = await meta(fake.ctx, ["ptpl", "apply", "zlgd_t", "--set", "head.visible=false"], { apply: true });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("WRITE_TARGETS_UNCONFIRMED");
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	// S27 1.14：写元数据改在常驻进程里写（写入进程自己的缓存跟着清，写完同一进程马上读到新的）。
	it("apply with a one-shot authorization runs on the resident and hands IsvGuard the list", async () => {
		const fake = metaFake();
		fake.net.handler = () => ({ ok: true, text: "RESULT OK 0\n[PROBE] 已写入\n" });
		fake.fs.write(
			fake.ctx.layout.serverPid,
			JSON.stringify({
				pid: 321,
				keyId: fake.ctx.runtimeKeyId,
				port: 1,
				startedAt: "",
				account: fake.ctx.config.account,
				user: fake.ctx.config.user,
			}),
		);
		fake.proc.livePids.add(321);
		const result = await meta(fake.ctx, ["ptpl", "apply", "zlgd_t", "--set", "head.visible=false"], {
			apply: true,
			writeAuthorization: { targets: ["tpl:zlgd_t"], rollback: "从 backup 还原", confirmationId: "confirm-1" },
		});
		expect(result.ok && result.value.dryRun).toBe(false);
		expect(result.ok && result.value.probe?.path).toBe("hot");
		const request = fake.net.requests.find((r) => r.lines[0] === "PROBE");
		expect(request?.lines).toContain(`prop=cosmic.targets=${Buffer.from("tpl:zlgd_t").toString("base64")}`);
		expect(request?.lines).toContain(`env=APPLY=${Buffer.from("1").toString("base64")}`);
		expect(fake.proc.runsOf("java")).toHaveLength(0);
	});

	// 「meta ptpl dump 要给模板编码」 说的是缺了什么，不是那行该怎么写；而
	// 「完整用法见 argv=[]」 是又一个来回。用法从 META_HELP 里取，不另写一份——
	// 另写的那份迟早和帮助对不上。
	it("a refusal carries the help for that exact action, read out of META_HELP", () => {
		const result = parseMeta(["ptpl", "dump"]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.remedy).toContain("ptpl dump  <模板编码> [--out 目录]");
		// 续行也带上：可选形态就住在那几行里。
		expect(result.error.remedy).toContain("[--grid 表格id]");
		expect(result.error.remedy).toBe(
			[
				"用法：",
				"ptpl dump  <模板编码> [--out 目录]           设计 JSON + 多语言映射落本地，diff 的输入",
				"  [--audit [--control 控件] [--detail] [--strict]]   改成拓扑审计",
				"  [--grid 表格id]                   改成网格摊平（行列下标表）",
				"  [--overview]                      改成整张模板的结构概览：绑了哪些字段、每格绑什么（先看这个）",
			].join("\n"),
		);
		expect(result.error.remedy).not.toContain("argv=[]");
		// 认不出动作的错（家族本身就写错了）仍然只给帮助入口，不硬凑一行用法。
		const unknown = parseMeta(["nope", "list"]);
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.remedy).toBe("完整用法见 cosmic_meta argv=[]（不给参数就是帮助）。");
	});

	it("refuses apply on a read-only action instead of ignoring it", async () => {
		const fake = metaFake();
		const result = await meta(fake.ctx, ["botp", "list"], { apply: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("META_ARGS_INVALID");
			expect(result.error.message).toContain("没有写通道");
		}
	});

	it("diff compares two export directories without starting anything", async () => {
		const fake = metaFake();
		fake.fs.put("D:/proj/a/rule.xml", "<r>\n<x>1</x>\n</r>");
		fake.fs.put("D:/proj/b/rule.xml", "<r>\n<x>2</x>\n</r>");
		fake.fs.put("D:/proj/b/extra.xml", "<r/>");
		const result = await meta(fake.ctx, ["botp", "diff", "a", "b"]);
		expect(result.ok && result.value.diff?.changes).toBe(1);
		expect(result.ok && result.value.diff?.onlyB).toEqual(["extra.xml"]);
		expect(fake.proc.runs).toHaveLength(0);
		expect(fake.net.requests).toHaveLength(0);
	});

	it("refuses a diff whose directory does not exist rather than reporting no differences", async () => {
		const fake = metaFake();
		fake.fs.put("D:/proj/a/rule.xml", "<r/>");
		const result = await meta(fake.ctx, ["botp", "diff", "a", "gone"]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("META_ARGS_INVALID");
	});

	it("a design file that is not valid JSON falls back to text and says it fell back", async () => {
		const fake = metaFake();
		fake.fs.put("D:/proj/a/tpl.json", "{oops");
		fake.fs.put("D:/proj/b/tpl.json", "{oops!");
		const result = await meta(fake.ctx, ["ptpl", "diff", "a", "b"]);
		expect(result.ok && result.value.diff?.files[0]?.fellBackToText).toBe(true);
	});
});

/**
 * The operation digest (S10).
 *
 * Hashed over the PLAN and not over the argv, which is the whole point: the
 * agent layer binds one of these into a write authorization, and a grant that
 * changed meaning when the caller wrote `--set=x` instead of `--set x` would be
 * a gate that refuses correct calls, while one that ignored the VALUE would be a
 * gate that admits the wrong change.
 */
describe("metaOperationDigest", () => {
	it("同一个操作换种写法仍是同一个摘要", () => {
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "head.visible=1"])).toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set=head.visible=1"]),
		);
	});

	it("--set 的值变了摘要就变了 —— 值才是改动本身", () => {
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "head.visible=1"])).not.toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "head.visible=0"]),
		);
	});

	it("目标模板、多个 --set 都进摘要；备份目录不进", () => {
		const base = ["ptpl", "apply", "zlgd_t", "--set", "head.visible=1"];
		expect(metaOperationDigest(base)).not.toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_u", "--set", "head.visible=1"]),
		);
		expect(metaOperationDigest(base)).not.toBe(metaOperationDigest([...base, "--set", "foot.visible=1"]));
		// S18 修正：备份目录只决定改前快照存在本机哪里，不改写进去的内容。探针自己教的就是
		// 「dry-run 不带、落库时再加 --backup」，算进摘要就永远对不上确认过的那一项。
		expect(metaOperationDigest(base)).toBe(metaOperationDigest([...base, "--backup", "build/tpl"]));
	});

	it("botp restore 认目录", () => {
		expect(metaOperationDigest(["botp", "restore", "build/a"])).not.toBe(
			metaOperationDigest(["botp", "restore", "build/b"]),
		);
	});

	// 没有计划就没有可绑的操作。调用方必须把 undefined 当「没有证据」，
	// 绝不能当「对得上」—— 那会让一个解析不了的 argv 配上一份空授权就过关。
	it("帮助、离线 diff 和解析不了的 argv 都没有摘要", () => {
		expect(metaOperationDigest([])).toBeUndefined();
		expect(metaOperationDigest(["ptpl", "diff", "a", "b"])).toBeUndefined();
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t"])).toBeUndefined();
		expect(metaOperationDigest(["nope", "list"])).toBeUndefined();
	});
});
