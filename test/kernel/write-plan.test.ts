/**
 * S18: the one declaration of which released probes write shared metadata, and
 * the claims made about them -- checked against the probe sources themselves,
 * because a list that drifts from the Java is silent in both directions.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kernelLayout } from "../../src/kernel/layout.ts";
import { metaOperationDigest, metaWritePlan } from "../../src/kernel/meta/parse.ts";
import {
	DATA_WRITERS,
	declaredTargets,
	deniedTargets,
	isAppliedWrite,
	isBlockedWrite,
	isMetadataWriter,
	isPlannedDryRun,
	METADATA_WRITERS,
	requiredTargets,
	writePlanDigest,
	writerKind,
} from "../../src/kernel/policy/write-plan.ts";
import { normTarget } from "../../src/kernel/policy/write-targets.ts";
import { placeProbeOutputs } from "../../src/kernel/project/output-paths.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";

const PROBE_SOURCES = new Map(
	EMBEDDED_RESOURCES.filter((file) => file.relativePath.startsWith("probes/")).map((file) => [
		file.relativePath.slice("probes/".length).replace(/\.java$/, ""),
		file.content,
	]),
);

const WRITERS = Object.keys(METADATA_WRITERS);

/** The APIs IsvGuard stands in front of -- the same list the platform lane is checked against. */
const WRITE_API =
	/\bMetadataWriter\b|\bSaveServiceHelper\.|\bDeleteServiceHelper\.|\bConvertRuleWriter\.save\b|\bDB\s*\.\s*update\b|\bupdatePrintMeta\b/;

describe("S18 metadata writers, proved from source", () => {
	it("names probes that exist", () => {
		expect(WRITERS.filter((name) => !PROBE_SOURCES.has(name))).toEqual([]);
	});

	it("is exactly the released probes that read APPLY and call a write API", () => {
		// A new write probe that is not declared here would be refused APPLY with
		// 「不是元数据写探针」 and never advance the phase: loud, but only in use.
		const found = [...PROBE_SOURCES.entries()]
			.filter(([, source]) => /"APPLY"/.test(source) && WRITE_API.test(source))
			.map(([name]) => name)
			.sort();
		// Data writers are declared apart (S21/S23); the one that saves directly (DataUpdateProbe's
		// UPD_OP=direct) shows up here too. DataSeedProbe only goes through the operation chain.
		expect(found).toEqual(
			[...WRITERS, ...Object.keys(DATA_WRITERS).filter((name) => name !== "DataSeedProbe")].sort(),
		);
	});

	it("loads no business class and enters no engine -- the reason they may skip the stale gate", () => {
		const loaders =
			/kd\.bos\.form\.|kd\.bos\.print\.core\.ExecuteService|BosPrintServiceImpl|OperationServiceHelper|kd\.bos\.entity\.plugin|Class\.forName|\.newInstance\s*\(|loadClass\s*\(/;
		const helpers = ["MetaResolve", "IsvGuard", "RuntimeMeta"];
		const offenders = [...WRITERS, ...helpers].filter((name) => loaders.test(PROBE_SOURCES.get(name) ?? ""));
		expect(offenders).toEqual([]);
	});

	// S36 batch 5: the rule writers' dry-run evaluates the candidate with RuleSim, and the print
	// writer can preview it on a real bill with PrintSim. Both reach engines the writers never did
	// themselves -- and the check above only reads the writers' own source -- so each path is pinned
	// here: the rule trial runs nothing loaded from outside a platform JAR, and the print preview
	// runs only with PRINT_PK, which puts the whole call in the strict lane (probe-freshness.test).
	it("reaches an engine only through the guarded dry-run trial", () => {
		const trialOf: Record<string, RegExp> = {
			FormRuleProbe: /^RuleSim\.tryForm$/,
			BizRuleProbe: /^RuleSim\.tryBiz$/,
			PrintTplWriteProbe: /^PrintSim\.(tryCandidate|latestBill)$/,
		};
		for (const name of WRITERS) {
			const source = PROBE_SOURCES.get(name) ?? "";
			const reached = [...source.matchAll(/\b(RuleSim|PrintSim)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`);
			const allowed = trialOf[name];
			if (allowed === undefined) expect(reached, name).toEqual([]);
			else for (const call of reached) expect(call, name).toMatch(allowed);
		}
		const ruleSim = PROBE_SOURCES.get("RuleSim") ?? "";
		// tryForm and tryBiz both switch the guard on before evaluating anything
		expect(ruleSim.match(/UNSAFE_FUNCS = unsafeFunctions\(\);/g)?.length).toBe(2);
		expect(ruleSim.indexOf("if (!fromJar(Class.forName(cls)))")).toBeGreaterThan(0);
		expect(ruleSim.indexOf("if (!fromJar(Class.forName(cls)))")).toBeLessThan(
			ruleSim.indexOf("(BRAction) Class.forName(cls).newInstance()"),
		);
		expect(PROBE_SOURCES.get("PrintTplWriteProbe")).toMatch(/if \(!pk\.isEmpty\(\)\) \{\s*PrintSim\.tryCandidate/);
	});

	it("tries the candidate before every rule writer's 「dry-run 结束」 line, never on APPLY", () => {
		const form = PROBE_SOURCES.get("FormRuleProbe") ?? "";
		const ends = form.match(
			/if \(!apply\) \{\s*tryCandidate\(form, fm, changedRules\);\s*IsvGuard\.reportTargets\(\);/g,
		);
		expect(ends?.length).toBe(3);
		expect(form.match(/dry-run 结束，未写入/g)?.length).toBe(3);
		const biz = PROBE_SOURCES.get("BizRuleProbe") ?? "";
		const trial = biz.indexOf("RuleSim.tryBiz(");
		expect(trial).toBeGreaterThan(biz.indexOf("if (!apply) {"));
		expect(trial).toBeLessThan(biz.indexOf("dry-run 结束，未写入"));
	});

	// 真机 2026-09-28：既有的携带/赋值规则在仿真里都报 TakeValueId 转不成 Map——仿真的限制，
	// 不是规则写错。只有公式动作的失败拦写入，别的动作失败记成「试算没执行」
	// 真机 2026-09-28：候选布局的顶层容器 parentId 是空的，按原样建树从根走不到任何控件，
	// 试算把被候选规则隐藏的 zlgd_bz 报成「可见(默认)」。空父 id 挂到根下，终态初值留空让树外收尾生效
	it("builds the rule-evaluation tree so a candidate layout's controls are reached from the root", () => {
		const ruleSim = PROBE_SOURCES.get("RuleSim") ?? "";
		expect(ruleSim).toMatch(/\(parent == null \|\| pid\.trim\(\)\.isEmpty\(\)\)\) \{\s*pid = rootId;/);
		expect(ruleSim.match(/childrenOf\(apById, rootId\)/g)?.length).toBe(2);
		expect(ruleSim).not.toMatch(/childrenOf\(apById\)/);
		expect(ruleSim).toMatch(/s\.effBy = null;\s*s\.effEnabledBy = null;\s*states\.put/);
	});

	it("blocks a candidate business rule only on a failed formula action, not on any action", () => {
		const ruleSim = PROBE_SOURCES.get("RuleSim") ?? "";
		expect(ruleSim).toMatch(
			/if \(isFormula\(one\)\) \{\s*FOCUS_FAILED\.add\(label \+ " 的动作：" \+ LAST_ERROR\);\s*\} else \{\s*SKIPPED\.add\(/,
		);
		expect(ruleSim.match(/FOCUS_FAILED\.add\(label \+ " 的动作：/g)?.length).toBe(1);
	});

	it("prints a 「dry-run 结束」 line that the plan check recognises, in every writer", () => {
		for (const name of WRITERS) {
			const source = PROBE_SOURCES.get(name) ?? "";
			const lines = [...source.matchAll(/System\.out\.println\("(\[PROBE\] dry-run[^"]*)"/g)].map(
				(match) => match[1] as string,
			);
			expect(lines.length, `${name} 没有 dry-run 结束行`).toBeGreaterThan(0);
			for (const line of lines) {
				expect(isPlannedDryRun({ cls: name, adHoc: false, env: {}, exitCode: 0, output: `x\n${line}\n` })).toBe(
					true,
				);
			}
		}
	});

	it("gives every writer a plain-language kind, and nothing else one", () => {
		for (const name of WRITERS) expect(writerKind(name)).not.toBeNull();
		expect(writerKind("MetaProbe")).toBeNull();
		expect(isMetadataWriter("toString")).toBe(false);
	});
});

describe("S18 what counts as a planned dry-run", () => {
	const done = "[PROBE] 模式=dry-run 只校验\n[PROBE] dry-run 结束，未写入。确认无误后加 APPLY=1";
	const base = { cls: "FormLayoutWriteProbe", adHoc: false, env: { LAYOUT_FORM: "e" }, exitCode: 0, output: done };

	it("a writer, no APPLY, exit 0, and the probe's own end line", () => {
		expect(isPlannedDryRun(base)).toBe(true);
		expect(isPlannedDryRun({ ...base, output: "[PROBE] dry-run：没有写回。要真还原加 APPLY=1" })).toBe(true);
	});

	it("not an APPLY, not a failure, not an abort, not a read probe, not an ad-hoc probe", () => {
		expect(isPlannedDryRun({ ...base, env: { ...base.env, APPLY: "1" } })).toBe(false);
		expect(isPlannedDryRun({ ...base, exitCode: 1 })).toBe(false);
		expect(isPlannedDryRun({ ...base, output: "[PROBE] 没选中任何目标规则，中止" })).toBe(false);
		// The mode line mentions dry-run too; only the end line counts.
		expect(isPlannedDryRun({ ...base, output: "[PROBE] 模式=dry-run 只校验" })).toBe(false);
		expect(isPlannedDryRun({ ...base, cls: "MetaProbe" })).toBe(false);
		expect(isPlannedDryRun({ ...base, adHoc: true })).toBe(false);
	});
});

describe("S18 operation digest", () => {
	it("ignores APPLY and empty inputs, and not the order the inputs came in", () => {
		const env = { TPL_NUMBER: "zlgd_t", TPL_SET: "a.b=1" };
		expect(writePlanDigest("PrintTplWriteProbe", { ...env, APPLY: "1" })).toBe(
			writePlanDigest("PrintTplWriteProbe", env),
		);
		expect(writePlanDigest("PrintTplWriteProbe", { ...env, TPL_BACKUP: "" })).toBe(
			writePlanDigest("PrintTplWriteProbe", env),
		);
		expect(writePlanDigest("PrintTplWriteProbe", { TPL_SET: "a.b=1", TPL_NUMBER: "zlgd_t" })).toBe(
			writePlanDigest("PrintTplWriteProbe", env),
		);
	});

	it("changes with any value, and with the probe", () => {
		const env = { TPL_NUMBER: "zlgd_t", TPL_SET: "a.b=1" };
		expect(writePlanDigest("PrintTplWriteProbe", { ...env, TPL_SET: "a.b=0" })).not.toBe(
			writePlanDigest("PrintTplWriteProbe", env),
		);
		expect(writePlanDigest("FormRuleProbe", env)).not.toBe(writePlanDigest("PrintTplWriteProbe", env));
	});

	it("leaves out the backup directory of the two writers that take one: where the before-image goes is not the change", () => {
		// The probes' own dry-run end line says 「确认无误后加 APPLY=1 和 TPL_BACKUP=<目录>」. Counting
		// the directory made following that advice an operation drift.
		const env = { TPL_NUMBER: "zlgd_t", TPL_SET: "a.b=1" };
		expect(writePlanDigest("PrintTplWriteProbe", { ...env, TPL_BACKUP: "build/tpl" })).toBe(
			writePlanDigest("PrintTplWriteProbe", env),
		);
		const sync = { SYNC_TARGETS: "rule-1", SYNC_FIELDMAP: "zlgd_a=zlgd_b" };
		expect(writePlanDigest("BotpRuleSyncProbe", { ...sync, SYNC_BACKUP: "build/botp" })).toBe(
			writePlanDigest("BotpRuleSyncProbe", sync),
		);
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "a.b=1", "--backup", "build/tpl"])).toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "a.b=1"]),
		);
		// Only for the probe that reads it as a backup; anywhere else it is an input like any other.
		expect(writePlanDigest("FormRuleProbe", { ...env, TPL_BACKUP: "x" })).not.toBe(
			writePlanDigest("FormRuleProbe", env),
		);
	});

	// S36 批 5：预演时拿来试一次的字段值、要看的控件、打哪张单，不是写进去的东西。
	// 预演带着它们试过、APPLY 时不带，必须还是同一个写操作，不然照着试过再写的人被当成改了入参。
	it("leaves out the dry-run trial inputs of the writers that try a candidate, and only theirs", () => {
		const rule = { RULE_FORM: "zlgd_f", RULE_TAG: "t-", RULE_GROUPS: "g|a = '1'|b" };
		expect(
			writePlanDigest("FormRuleProbe", {
				...rule,
				RULE_SET: "a=1",
				RULE_SHOW: "b",
				RULE_ROW: "1",
				RULE_BRANCH: "both",
			}),
		).toBe(writePlanDigest("FormRuleProbe", rule));
		const biz = { BIZ_ENTITY: "zlgd_e", BIZ_TAG: "t-", BIZ_CONDITION: "a = '1'", BIZ_TRUE: "clear:b" };
		expect(writePlanDigest("BizRuleProbe", { ...biz, RULE_SET: "a=1", RULE_SHOW: "b" })).toBe(
			writePlanDigest("BizRuleProbe", biz),
		);
		const tpl = { TPL_NUMBER: "zlgd_t", TPL_SET: "a.b=1" };
		expect(writePlanDigest("PrintTplWriteProbe", { ...tpl, PRINT_PK: "123", PRINT_SHOW: "c" })).toBe(
			writePlanDigest("PrintTplWriteProbe", tpl),
		);
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "a.b=1", "--pk", "123"])).toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "a.b=1"]),
		);
		// What the rule writers write stays in; elsewhere RULE_SET is an input like any other.
		expect(writePlanDigest("FormRuleProbe", { ...rule, RULE_GROUPS: "g|a = '2'|b" })).not.toBe(
			writePlanDigest("FormRuleProbe", rule),
		);
		expect(writePlanDigest("PrintTplWriteProbe", { ...tpl, RULE_SET: "a=1" })).not.toBe(
			writePlanDigest("PrintTplWriteProbe", tpl),
		);
	});

	// S32 1.4：路径入参的内容进指纹。预演一份、拿到确认、把文件换掉再执行，
	// 指纹必须跟着变，否则门禁放行的是用户没看过的那份东西。
	it("follows the CONTENT behind a path input, not just the path (S32 1.4)", () => {
		const dir = mkdtempSync(join(tmpdir(), "cosmic-digest-"));
		const file = join(dir, "zlgd_t.meta.json");
		const env = { TPL_NUMBER: "zlgd_t", TPL_FILE: file };
		writeFileSync(file, '{"key":"zlgd_t","pages":[]}', "utf8");
		const before = writePlanDigest("PrintTplWriteProbe", env);
		expect(writePlanDigest("PrintTplWriteProbe", env)).toBe(before);
		writeFileSync(file, '{"key":"zlgd_t","pages":[[]]}', "utf8");
		expect(writePlanDigest("PrintTplWriteProbe", env)).not.toBe(before);
		// 同样的洞 botp restore 上早就有：目录里换个文件，指纹以前一个字不变。
		const botp = mkdtempSync(join(tmpdir(), "cosmic-digest-botp-"));
		const sync = { SYNC_RESTORE: botp };
		writeFileSync(join(botp, "rule-1.xml"), "<rule a='1'/>", "utf8");
		const botpBefore = writePlanDigest("BotpRuleSyncProbe", sync);
		writeFileSync(join(botp, "rule-1.xml"), "<rule a='2'/>", "utf8");
		expect(writePlanDigest("BotpRuleSyncProbe", sync)).not.toBe(botpBefore);
		// 多一个文件也是另一份内容。
		const twoFiles = writePlanDigest("BotpRuleSyncProbe", sync);
		writeFileSync(join(botp, "rule-2.xml"), "<rule a='2'/>", "utf8");
		expect(writePlanDigest("BotpRuleSyncProbe", sync)).not.toBe(twoFiles);
		rmSync(dir, { recursive: true, force: true });
		rmSync(botp, { recursive: true, force: true });
	});

	it("keeps a path input that reads as nothing stable, and apart from a path that reads", () => {
		const missing = { TPL_NUMBER: "zlgd_t", TPL_FILE: join(tmpdir(), "cosmic-no-such-file.json") };
		expect(writePlanDigest("PrintTplWriteProbe", missing)).toBe(writePlanDigest("PrintTplWriteProbe", missing));
		const dir = mkdtempSync(join(tmpdir(), "cosmic-digest-"));
		const file = join(dir, "zlgd_t.meta.json");
		writeFileSync(file, "{}", "utf8");
		expect(writePlanDigest("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_FILE: file })).not.toBe(
			writePlanDigest("PrintTplWriteProbe", missing),
		);
		rmSync(dir, { recursive: true, force: true });
	});

	it("is the same for a cosmic_meta write channel and a direct call to the probe underneath", () => {
		for (const argv of [
			["ptpl", "apply", "zlgd_t", "--set", "a.b=1", "--backup", "build/tpl"],
			["botp", "restore", "build/botp"],
		]) {
			const channel = metaWritePlan(argv);
			expect(channel).not.toBeNull();
			expect(metaOperationDigest(argv)).toBe(writePlanDigest(channel?.probe ?? "", channel?.env ?? {}));
		}
		expect(metaWritePlan(["ptpl", "dump", "zlgd_t"])).toBeNull();
	});
});

describe("S18 the backup directory an APPLY needs", () => {
	it("the tool places one for every writer that aborts without it, so an APPLY never lands without a backup", () => {
		const layout = kernelLayout({
			root: "D:/proj",
			sessionId: "s1",
			cacheRoot: "D:/cache/k",
			runtimeKeyId: "k",
			resourcesDir: "D:/cache/k/res",
			codeModules: [],
		});
		for (const [name, key, env] of [
			["PrintTplWriteProbe", "TPL_BACKUP", { TPL_NUMBER: "t" }],
			["BotpRuleSyncProbe", "SYNC_BACKUP", { SYNC_TARGETS: "rule-1" }],
			["FormLayoutWriteProbe", "LAYOUT_BACKUP", { LAYOUT_FORM: "f", LAYOUT_EDIT: "set a.B=1" }],
		] as const) {
			const placed = placeProbeOutputs(layout, name, false, { ...env, APPLY: "1" }, 0).env[key] ?? "";
			expect(placed.replace(/\\/g, "/")).toContain("/.cosmic-ai/evidence/backups/");
			// 预演不落库，不用备份
			expect(placeProbeOutputs(layout, name, false, env, 0).env[key]).toBeUndefined();
		}
	});

	it("is what the probes themselves refuse with an exit-0 abort", () => {
		for (const [name, key] of [
			["PrintTplWriteProbe", "TPL_BACKUP"],
			["BotpRuleSyncProbe", "SYNC_BACKUP"],
			["FormLayoutWriteProbe", "LAYOUT_BACKUP"],
		] as const) {
			expect(PROBE_SOURCES.get(name)).toContain(`APPLY=1 必须同时给 ${key}=<目录>，中止`);
		}
	});
});

describe("S18 what counts as a write that landed", () => {
	/** Each writer's success line: the literal as it stands in the source, and a line it prints. */
	const APPLIED_SAMPLES: Readonly<Record<string, { literal: string; line: string }>> = {
		BizRuleProbe: {
			literal: '"[PROBE] rebuildRuntimeMetaById(" + metaId + ") 完成',
			line: "[PROBE] rebuildRuntimeMetaById(m1) 完成；请另起冷读复核",
		},
		BotpRuleSyncProbe: {
			literal: '"[PROBE] 已写入 " + changed.size() + " 条并清缓存',
			line: "[PROBE] 已写入 2 条并清缓存；备份在 build/botp",
		},
		FormLayoutWriteProbe: {
			literal: '"[PROBE] 布局已落库：" + shown',
			line: "[PROBE] 布局已落库：3 处，备份在 D:/p/.cosmic-ai/layout，要退回用 LAYOUT_RESTORE=<这个目录>",
		},
		FormRegisterProbe: { literal: '"[PROBE] 登记行已写入"', line: "[PROBE] 登记行已写入" },
		FormRuleProbe: {
			literal: '"[PROBE] rebuildRuntimeMetaById(" + formId + ") 完成"',
			line: "[PROBE] rebuildRuntimeMetaById(f1) 完成",
		},
		PrintTplWriteProbe: {
			literal: '"[PROBE] 已落库。modifyVersion "',
			line: "[PROBE] 已落库。modifyVersion 3 -> 4，dataSha256=ab12",
		},
	};

	it("recognises the success line every writer really prints", () => {
		expect(Object.keys(APPLIED_SAMPLES).sort()).toEqual([...WRITERS].sort());
		for (const [name, sample] of Object.entries(APPLIED_SAMPLES)) {
			expect(PROBE_SOURCES.get(name), `${name} 源码里没有这一行`).toContain(sample.literal);
			expect(isAppliedWrite({ cls: name, exitCode: 0, output: `[PROBE] 模式=APPLY\n${sample.line}\n` })).toBe(true);
		}
	});

	it("does not take any abort line or dry-run line for one", () => {
		for (const name of WRITERS) {
			const source = PROBE_SOURCES.get(name) ?? "";
			const lines = [...source.matchAll(/"(\[PROBE\][^"]*)"/g)]
				.map((match) => match[1] as string)
				.filter((line) => line.includes("中止") || line.includes("dry-run"));
			for (const line of lines) {
				expect(isAppliedWrite({ cls: name, exitCode: 0, output: line }), `${name}: ${line}`).toBe(false);
			}
		}
	});

	it("needs exit 0, this writer's own line, a count above zero, and no save that said success=false", () => {
		const tpl = "[PROBE] 已落库。modifyVersion 3 -> 4";
		expect(isAppliedWrite({ cls: "PrintTplWriteProbe", exitCode: 1, output: tpl })).toBe(false);
		expect(isAppliedWrite({ cls: "FormRuleProbe", exitCode: 0, output: tpl })).toBe(false);
		expect(isAppliedWrite({ cls: "MetaProbe", exitCode: 0, output: tpl })).toBe(false);
		expect(
			isAppliedWrite({ cls: "BotpRuleSyncProbe", exitCode: 0, output: "[PROBE] 已写入 0 条并清缓存；备份在 d" }),
		).toBe(false);
		expect(
			isAppliedWrite({
				cls: "FormRuleProbe",
				exitCode: 0,
				output: "[PROBE] save -> {message=列名冲突, success=false}\n[PROBE] rebuildRuntimeMetaById(f1) 完成",
			}),
		).toBe(false);
		expect(
			isAppliedWrite({
				cls: "FormRuleProbe",
				exitCode: 0,
				output: "[PROBE] save -> {success=true}\n[PROBE] rebuildRuntimeMetaById(f1) 完成",
			}),
		).toBe(true);
	});
});

describe("S18 write targets knowable from the inputs", () => {
	it("a print template needs tpl:<number>, spelled the way cosmic_authorize normalises it", () => {
		expect(requiredTargets("PrintTplWriteProbe", { TPL_NUMBER: " ZLGD_T ", TPL_SET: "a.b=1" })).toEqual([
			"tpl:zlgd_t",
		]);
		expect(normTarget("tpl:zlgd_t")).toBe("tpl:zlgd_t");
		// The bare number also passes the syntax check -- as an entity. That is the trap.
		expect(normTarget("zlgd_t")).toBe("zlgd_t");
		expect(PROBE_SOURCES.get("IsvGuard")).toContain('assertConfirmedTagged("tpl", number');
	});

	it("claims nothing it cannot know from the inputs", () => {
		expect(requiredTargets("PrintTplWriteProbe", { TPL_SET: "a.b=1" })).toEqual([]);
		expect(
			requiredTargets("FormLayoutWriteProbe", { LAYOUT_FORM: "zlgd_e", LAYOUT_EDIT: "remove field zlgd_f" }),
		).toEqual([]);
		expect(requiredTargets("BotpRuleSyncProbe", { SYNC_SOURCE_ENTITY: "zlgd_a" })).toEqual([]);
	});
});

describe("S15.6.8 the target list the probe itself reports", () => {
	const line =
		"[PROBE] 写入目标清单（cosmic_authorize 的 targets 照抄这一行，少一个 APPLY 会被拦下、整份授权作废）：" +
		"zlgd_bill.zlgd_layout, zlgd_bill.zlgd_f1, zlgd_bill.zlgd_f2";

	it("reads every target off the one line, lower-cased and de-duplicated", () => {
		expect(
			declaredTargets(`前面几行
${line}
[PROBE] dry-run 结束，未写入。`),
		).toEqual(["zlgd_bill.zlgd_layout", "zlgd_bill.zlgd_f1", "zlgd_bill.zlgd_f2"]);
		expect(declaredTargets("[PROBE] 写入目标清单：TPL:ZLGD_T, tpl:zlgd_t")).toEqual(["tpl:zlgd_t"]);
	});

	it("claims nothing when the probe did not print one", () => {
		expect(declaredTargets("[PROBE] dry-run 结束，未写入。")).toEqual([]);
		// 旧的那一行只说布局，正是这次要修掉的东西：它不该被当成清单。
		expect(declaredTargets("[PROBE] 写入目标 zlgd_bill.zlgd_layout（cosmic_authorize targets 可直接使用）")).toEqual(
			[],
		);
	});

	it("every writer really prints the line it is read from", () => {
		for (const name of WRITERS) {
			expect(PROBE_SOURCES.get(name) ?? "", `${name} 没有报写入目标清单`).toContain("IsvGuard.reportTargets()");
		}
		expect(PROBE_SOURCES.get("IsvGuard") ?? "").toContain("写入目标清单");
	});
});

/**
 * S32 批 1：打印模板的整份提交，和它多出来的那几道关。
 *
 * 读的是探针源码本身 —— 这几道关是判据，不是「注意事项」，源码里删掉一道不能悄无声息。
 */
describe("S32 print template whole-file submit", () => {
	const source = PROBE_SOURCES.get("PrintTplWriteProbe") ?? "";

	it("takes exactly one of a scalar set, a whole file and a restore directory", () => {
		expect(source).toContain('String file = env("TPL_FILE", "")');
		expect(source).toContain('String restoreDir = env("TPL_RESTORE", "")');
		expect(source).toContain("if (given != 1)");
	});

	it("checks the candidate is the same template before anything else looks at it", () => {
		// 交错文件是整份提交最容易犯、后果最重的错，而 beforeSave 不会拦：那份候选自己是合法的。
		expect(source).toContain("assertSameTemplate");
		expect(source).toContain("候选文件不是这张模板");
		expect(source).toContain("候选文件挂靠的单据对不上");
	});

	it("computes the change list itself instead of letting the model say what changed (S23 的规矩)", () => {
		expect(source).toContain("PrintTplDiff.summarize");
		expect(source).toContain("PrintTplDiff.diff");
		expect(source).toContain('ProbeJson.emit("tpl-change"');
		// 比出来没差异就不写：空提交也会把 modifyVersion 推上去，白白作废别人手里的基线。
		expect(source).toContain("候选和库里那份一模一样");
	});

	it("runs the platform's own loader and the topology audit before the save chain", () => {
		expect(source).toContain("PrintMetadataUtil.parseMetadata");
		expect(source).toContain("PrintTplDesignProbe.audit");
		expect(source).toContain("未落库：候选平台解析不过");
		expect(source).toContain("未落库：候选拓扑审计有");
		// 复用的两个方法必须留在包内可见，改回 private 就是悄悄断掉这道关。
		const design = PROBE_SOURCES.get("PrintTplDesignProbe") ?? "";
		expect(design).toContain("static List<String> audit(");
		expect(design).toContain("static List<Map<String, Object>> controls(");
	});

	it("carries the before-image across the user's confirmation (S32 1.5)", () => {
		// 原来那两次版本核对都在同一次执行里，盖不住「用户看确认单」那段时间。
		expect(source).toContain("[PROBE] 改前快照=");
		expect(source).toContain('System.getProperty("cosmic.baseline"');
		expect(source).toContain("未落库：没拿到用户确认过的改前快照");
		expect(source).toContain("未落库：改前数据和预演时不一样了");
	});

	it("says 未落库 on every road that writes nothing, so the confirmation is not burned", () => {
		// isBlockedWrite 认的就是这四个字；少了它，一次什么都没写的中止会把清单里那一项用掉。
		for (const abort of ["平台校验不通过", "候选平台解析不过", "候选拓扑审计有", "改前数据和预演时不一样了"]) {
			expect(source, `${abort} 这条中止没说「未落库」`).toContain(`未落库：${abort}`);
		}
	});

	it("is reachable from cosmic_meta and is a different operation from a --set", () => {
		const whole = metaWritePlan(["ptpl", "apply", "zlgd_t", "--file", "build/a.meta.json"]);
		expect(whole?.probe).toBe("PrintTplWriteProbe");
		expect(whole?.env.TPL_FILE).toBe("build/a.meta.json");
		expect(whole?.env.TPL_SET).toBeUndefined();
		expect(metaOperationDigest(["ptpl", "apply", "zlgd_t", "--file", "build/a.meta.json"])).not.toBe(
			metaOperationDigest(["ptpl", "apply", "zlgd_t", "--set", "a.b=1"]),
		);
	});
});

/**
 * S32 批 3：一次往返里把公式验完、落库后回读核对、整份恢复。
 *
 * 和批 1 那组一样读探针源码：这几关是判据，删掉一道不能悄无声息。
 */
describe("S32 一次往返验完", () => {
	const source = PROBE_SOURCES.get("PrintTplWriteProbe") ?? "";
	const trial = PROBE_SOURCES.get("PrintTplFormulaTry") ?? "";

	it("公式写坏了停在落库之前，而不是等打印时才发现那一格是空的", () => {
		expect(source).toContain("PrintTplFormulaTry.changed");
		expect(source).toContain("未落库：公式试算不过");
		// 试算在落库之前、在平台解析这一关之前跑完：顺序错了就成了「先存再说」。
		expect(source.indexOf("tryFormulas(metadata, candidate)")).toBeLessThan(
			source.indexOf("validateCandidate(candidate, lang)"),
		);
	});

	it("判对错用校验器、看显示成什么用执行器，两个都要", () => {
		// 2026-09-21 真机实测：Execute 对写坏的公式只返回空串、不抛，光看它分不出对错。
		expect(trial).toContain("new PrintFormulaValidate().executeExp(");
		// 显示走执行器同一套算法：字段值读操作数上的 value、换值调执行器自己的方法，和真打印同一条路。
		expect(trial).toContain("extends AbstractPrintFormulaParser");
		expect(trial).toContain('fieldItem.get("value")');
		expect(trial).toContain("platform.transferVariableValueProcess(");
		// 样例值是打印取数同种的字段对象：日期给 DateField，TO_CHAR 才拿得到日期。
		expect(trial).toContain("new DateField(");
		expect(trial).toContain("NullField.get()");
		// 执行器算崩一行只记警告、那一行当空串：这里记下来，写进那一档的显示。
		expect(trial).toContain("failures.add(");
		expect(trial).toContain("（算不出来：");
		expect(source).toContain("条有一档算不出来");
		expect(trial).toContain("字段都空");
		expect(trial).toContain("只有第一个字段有值");
		expect(trial).toContain("字段都有值");
		expect(trial).toContain("_enter_");
	});

	it("落库之后回读核对，不只看接口有没有报错", () => {
		expect(source).toContain("readBack(service, after, lang, toSave)");
		expect(source).toContain("回读核对：库里那份和交上去的一模一样");
		expect(source).toContain('ProbeJson.emit("tpl-readback"');
		// 这时已经写进去了：它报的是「库里以什么为准」，不是一次中止，所以不能说「未落库」。
		const readBack = source.slice(source.indexOf("private static void readBack("));
		expect(readBack.slice(0, readBack.indexOf("// ── 公式试算"))).not.toContain("未落库");
	});

	it("出 PDF 是可选的一步，而且说清楚文字对不等于排版对", () => {
		expect(source).toContain("排版复核（可选");
		expect(source).toContain("格子里的文字对，不等于分页和排版对");
	});

	it("整份恢复和整份提交同一条路：照样比差异、照样核版本", () => {
		const back = metaWritePlan(["ptpl", "restore", "zlgd_t", "build/before", "--backup", "build/now"]);
		expect(back?.probe).toBe("PrintTplWriteProbe");
		expect(back?.env.TPL_RESTORE).toBe("build/before");
		// 编码在入参里给，授权确认单上的目标才对得上（到 JVM 里才知道，那一项已经用掉了）。
		expect(requiredTargets("PrintTplWriteProbe", back?.env ?? {})).toEqual(["tpl:zlgd_t"]);
		// 恢复本身也会盖掉现在那份：APPLY 时工具照样先存一份改前备份。
		const layout = kernelLayout({
			root: "D:/proj",
			cacheRoot: "D:/cache/k",
			runtimeKeyId: "k",
			resourcesDir: "D:/cache/k/res",
			codeModules: [],
		});
		const restoring = { TPL_NUMBER: "zlgd_t", TPL_RESTORE: "build/before", APPLY: "1" };
		expect(placeProbeOutputs(layout, "PrintTplWriteProbe", false, restoring, 0).env.TPL_BACKUP).toContain("backups");
		expect(source).toContain('String restoreDir = env("TPL_RESTORE", "")');
		expect(source).toContain("备份目录里没有这张模板的设计数据");
	});

	it("恢复目录的内容进指纹：确认的是那份内容，不是那条路径", () => {
		const dir = mkdtempSync(join(tmpdir(), "cosmic-restore-"));
		writeFileSync(join(dir, "zlgd_t.meta.json"), '{"key":"zlgd_t"}');
		const before = writePlanDigest("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_RESTORE: dir });
		writeFileSync(join(dir, "zlgd_t.meta.json"), '{"key":"zlgd_t","pages":[]}');
		expect(writePlanDigest("PrintTplWriteProbe", { TPL_NUMBER: "zlgd_t", TPL_RESTORE: dir })).not.toBe(before);
	});
});

describe("S15.6.8 blocked before the write, not failed halfway through", () => {
	const denial = [
		"[PROBE] !! 拒绝：字段 「zlgd_f1」 缺少匹配的完整写入目标",
		"[PROBE] 未落库：这次在写入之前就被拦下（IsvGuard），共享环境没有任何改动",
		"[PROBE] !! 需要确认的目标：<实体>.zlgd_f1",
	].join("\n");

	it("is the gate's own marker, and only for a writer", () => {
		expect(isBlockedWrite({ cls: "FormRuleProbe", output: denial })).toBe(true);
		expect(isBlockedWrite({ cls: "MetaProbe", output: denial })).toBe(false);
		expect(isBlockedWrite({ cls: "FormRuleProbe", output: "[PROBE] !! 落库失败：连接超时" })).toBe(false);
	});

	it("is not claimed once the platform save has been reached", () => {
		// 走到 save 就不再是前置拦截：成没成都可能已经落了一部分库。
		expect(
			isBlockedWrite({
				cls: "FormLayoutWriteProbe",
				output: `[PROBE] save -> {success=false}
${denial}`,
			}),
		).toBe(false);
	});

	it("hands back the exact targets the retry has to confirm", () => {
		expect(deniedTargets(denial)).toEqual(["<实体>.zlgd_f1"]);
		expect(deniedTargets("[PROBE] dry-run 结束")).toEqual([]);
	});
});

it("批量清单的每个操作和原条件都绑定授权", () => {
	const env = { RULE_FORM: "demo_form", RULE_BATCH: "update|r1|a=1|a=2;delete|r2|b=1" };
	const digest = writePlanDigest("FormRuleProbe", env);
	expect(writePlanDigest("FormRuleProbe", { ...env, APPLY: "1" })).toBe(digest);
	for (const batch of [
		"update|r1|a=1|a=3;delete|r2|b=1",
		"update|r1|a=0|a=2;delete|r2|b=1",
		"update|r1|a=1|a=2;delete|r3|b=1",
		"update|r1|a=1|a=2",
	]) {
		expect(writePlanDigest("FormRuleProbe", { ...env, RULE_BATCH: batch })).not.toBe(digest);
	}
});

/**
 * 2026-11-16 真机：疲劳流程改四张单。三张改的是派生布局（布局 id ≠ 实体 id），字段进了实体、控件只进派生布局，
 * 开发平台打开主单据大纲里找不到字段；检测单保存回「成功」后加列撞上行大小上限，探针只留下一句「保存成功」和一段堆栈；
 * 另两张报「回读一致」，比的只是设计态，没核对运行态和业务表的列。
 */
describe("布局写探针：派生布局、写一半、分层回读", () => {
	const source = PROBE_SOURCES.get("FormLayoutWriteProbe") ?? "";

	it("派生布局上加删字段、加分录会被拒，指回主单据布局", () => {
		expect(source).toContain("if (!layoutOnly && !formId.equals(em.getId())) editor.derivedOf = entity;");
		for (const what of ["加字段", "照搬字段", "删字段", "加分录"]) {
			expect(source).toContain(`fieldHome(where, "${what}")`);
		}
		expect(source).toContain("的派生布局，");
	});

	it("保存报错或报失败时重新读设计态，存进去了就说写了一半、探针以失败结束", () => {
		expect(source).toContain("designUnchanged(formId, em.getId(), fser, eser, baseline)");
		expect(source).toContain("throw halfWritten(");
		expect(source).toContain("!! 写了一半：设计态");
		expect(source).not.toContain("平台没有存上，库里还是改前那份");
	});

	it("刷新运行态、加列失败不再只留一句保存成功", () => {
		const save = source.slice(source.indexOf("MetadataDao.rebuildRuntimeMetaById(formId);") - 200);
		expect(save.slice(0, 600)).toContain("} catch (Throwable e) {");
		expect(save.slice(0, 800)).toContain('throw halfWritten("刷新运行态、给业务表加列"');
		// 真机那次的输出形状：保存成功之后堆栈退出，没有落库成功那一行，不能算写成。
		const output = [
			"[PROBE] save -> {success=true, message=保存成功。}",
			"[PROBE] !! 写了一半：设计态（开发平台里看到的布局、实体）已经存进库，刷新运行态、给业务表加列没成：KDException: Row size too large",
		].join("\n");
		expect(isAppliedWrite({ cls: "FormLayoutWriteProbe", exitCode: 1, output })).toBe(false);
	});

	it("回读分三层报数：设计态、运行态、业务表", () => {
		expect(source).toContain("回读核对 设计态（开发平台里看到的布局");
		expect(source).toContain("回读核对 运行态：");
		expect(source).toContain("回读核对 业务表：要加 ");
		expect(source).toContain('ProbeJson.emit("layout-landed"');
		expect(source).not.toContain('p("回读核对：库里那份');
	});

	// 2026-11-16 真机：四张单加 37 个字段，全部 into 扔到容器最后，没有一个设过可见性、锁定性，内码字段摆在界面上。
	it("加字段、照搬字段、加分录、加控件必须写明可见性和锁定性，看得见的必须指到具体控件旁边", () => {
		expect(source).toContain('String[] show = showSpec(where, opts.get("visible"), opts.get("lock"), true, true);');
		// 照搬字段、加分录各一处；普通控件有没有锁定性按设计器的属性清单判。
		expect(source.match(/String\[\] show = showSpec\(where, visibleSpec, lockSpec, true, true\);/g)?.length).toBe(2);
		expect(source).toContain(
			'String[] show = showSpec(where, visibleSpec, lockSpec, lockable, has(ap, key, "Visible"));',
		);
		expect(source).toContain('bad.add("少了 visible=")');
		expect(source).toContain('bad.add("少了 lock=")');
		expect(source).toContain('Arrays.asList("init", "new", "edit", "view", "submit", "audit")');
		expect(source.match(/!positioned\(where, (at\.how, at\.parent|how, parent), show\)/g)?.length).toBe(4);
		expect(source.match(/applyShow\(ap, show\);/g)?.length).toBe(3);
		expect(source).toContain("grid.setLock(show[2]);");
	});

	it("预演逐个报新字段的落点：上级容器、位置、可见性、锁定性和前后邻居", () => {
		expect(source).toContain("新加的字段、分录、控件在界面上的落点（上级容器、位置、可见性、锁定性）：");
		expect(source).toContain('ProbeJson.emit("layout-placement"');
		expect(source).toContain("是隐藏元素，里面的控件界面上都不出现");
	});

	it("必录条件和操作上的合法性校验走同一份清单，表达式先拿平台判据核过", () => {
		expect(source).toContain('if ("mustinputcondition".equalsIgnoreCase(name)) {');
		expect(source).toContain('if (billOnly(where, "加校验")) addCheck(where, line.substring(10).trim());');
		expect(source).toContain('if (billOnly(where, "删校验")) removeCheck(where, line.substring(13).trim());');
		// 必录条件、校验表达式、前置条件三处都过 FormulaCheck：写错了平台照样存，到运行时才报错。
		expect(source.match(/exprVars\(where, "(必录条件|表达式|前置条件)", /g)?.length).toBe(3);
		expect(source).toContain("FormulaCheck.Result r = FormulaCheck.rule(expr, runtimeType);");
		// pass / fail 必须写明：平台的 TrueThrow 默认是「不成立才报错」，两种方向真实单据上都有，不替调用方定。
		expect(source).toContain('v.setTrueThrow(head[1].equals("fail"));');
		expect(source).toContain("平台一条校验只能用表头和一个分录的字段：拆成几条");
		// 加在别人的操作上要过操作宿主那道核对；模板带来的校验不删。
		expect(source.match(/opHosts\.add\(/g)?.length).toBe(3);
		expect(source).toContain("是模板或标准产品带来的校验，删不了");
		expect(source).toContain("checks(scope, key, list(x0), list(y0), out);");
	});
});

// 真机 zlgd：主单据布局 zlgd_sys_test_bill 加字段后只重建了它自己的运行态，31 张派生布局的运行态里没有新字段，
// 写探针却报「派生布局 31 张跟着变」；表单验证打开派生布局拿不到控件，按默认把隐藏又锁定的字段判成显示、可编辑。
describe("改了表单，派生布局的运行态跟着重建；运行态没有的控件不按默认答", () => {
	const heirsHelper = PROBE_SOURCES.get("RuntimeMeta") ?? "";

	it("helper finds heirs by inherit path, parents first, and reports every one rebuilt or failed", () => {
		expect(heirsHelper).toContain("FINHERITPATH like ? or FPARENTID = ?");
		expect(heirsHelper).toContain("Integer.compare(depth(a[2]), depth(b[2]))");
		expect(heirsHelper).toContain("MetadataDao.rebuildRuntimeMetaById(h[0]);");
		// 一张失败不挡后面的，0 张也报数
		expect(heirsHelper).toMatch(/catch \(Throwable e\) \{\s*String msg/);
		expect(heirsHelper).toContain('"[PROBE] 派生布局运行态重建 " + r[0] + "/" + heirs.size() + " 张"');
		// 不加载业务类：写探针跳过编译新鲜度检查的前提
		expect(heirsHelper).not.toMatch(/kd\.bos\.form\.|Class\.forName|loadClass\s*\(/);
	});

	it("every form-rule rebuild is followed by the heirs", () => {
		const source = PROBE_SOURCES.get("FormRuleProbe") ?? "";
		const rebuilds = source.match(/MetadataDao\.rebuildRuntimeMetaById\(formId\);/g)?.length ?? 0;
		expect(rebuilds).toBeGreaterThan(0);
		expect(
			source.match(
				/MetadataDao\.rebuildRuntimeMetaById\(formId\);\s*System\.out\.println\("\[PROBE\] rebuildRuntimeMetaById\(" \+ formId \+ "\) 完成"\);\s*RuntimeMeta\.rebuildHeirsAndReport\(formId\);/g,
			)?.length,
		).toBe(rebuilds);
	});

	it("the layout writer rebuilds the heirs before saying the runtime is refreshed", () => {
		const source = PROBE_SOURCES.get("FormLayoutWriteProbe") ?? "";
		const own = source.indexOf("MetadataDao.rebuildRuntimeMetaById(formId);");
		const heirs = source.indexOf("rebuilt = RuntimeMeta.rebuildHeirs(heirList);");
		const landed = source.indexOf('"[PROBE] 布局已落库：');
		expect(own).toBeGreaterThan(0);
		expect(heirs).toBeGreaterThan(own);
		expect(landed).toBeGreaterThan(heirs);
		expect(source).toContain('"，运行态已刷新：这张 + 派生布局 "');
		expect(source).toContain("!! 派生布局运行态没重建成");
	});

	// 一种类型专用的字段、控件不能露到别的类型的布局上：加的时候说清在哪几张显示，工具按清单落到每张布局
	it("visible new fields, entries and controls on a layout with heirs must say layouts=, and only the listed ones show them", () => {
		const source = PROBE_SOURCES.get("FormLayoutWriteProbe") ?? "";
		// 四种加法共用 showSpec：没写 layouts= 就拒
		expect(source.match(/showSpec\(where, /g)?.length).toBe(4);
		expect(source).toContain("if (!none && lineLayouts == null && onBill() && !heirs().isEmpty()) {");
		// 没列这张布局时设成隐藏元素：字段、控件、分录面板都走同一个判断
		expect(source).toContain("ap.setInvisible(hiddenHere(show));");
		expect(source).toContain("adv.setInvisible(hiddenHere(show));");
		expect(source).not.toMatch(/setInvisible\(!show\[0\]\.isEmpty\(\)\)/);
		// 列出的派生布局进写入目标、落库前先过 ISV
		expect(source).toContain(
			"for (String layout : editor.showOn.keySet()) IsvGuard.assertOwnLayout(entity, layout);",
		);
		// 改回显示在「布局已落库」之前：没成就是写了一半，不打落库成功那一行
		const shownAt = source.indexOf(
			"if (editor != null && !editor.showOn.isEmpty()) showOnHeirs(editor, backupDir, undo);",
		);
		expect(shownAt).toBeGreaterThan(0);
		expect(shownAt).toBeLessThan(source.indexOf('System.out.println("[PROBE] 布局已落库：'));
		expect(source).toMatch(/throw halfWritten\(step, why, undo/);
		// 只在部分布局显示的字段不能单纯必录
		expect(source).toContain("editor.checkScopedMustInput();");
	});

	it("a field the design layout has but the opened view lacks is unresolved with the reason, not judged by default", () => {
		const ui = PROBE_SOURCES.get("UiState") ?? "";
		expect(ui).toContain("static String notInRuntime(String path)");
		expect(ui).toMatch(/!ap\.getClass\(\)\.getSimpleName\(\)\.endsWith\("FieldAp"\) \|\| control\(t\.key\) != null/);
		expect(ui).toContain("if (t == null || !PROPS.contains(prop) || notInRuntime(path) != null) {");
		expect(ui).toContain("运行态里没有这个控件（设计态有），显示、锁定判不了");
		const sim = PROBE_SOURCES.get("FormSim") ?? "";
		expect(sim).toMatch(
			/String stale = UiState\.notInRuntime\(up\[0\]\);\s*if \(got == null\) \{\s*ProbeAssert\.unresolved\("ui", kv\[0\], kv\[1\], stale != null \? stale :/,
		);
	});
});
