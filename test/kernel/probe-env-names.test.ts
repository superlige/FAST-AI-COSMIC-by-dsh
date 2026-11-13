/**
 * S37 2-B.1：内置探针和临时探针一个标准——传了探针不读的环境变量名，启动前拦下。
 *
 * 用的是本仓 `resources/probes/` 里的真探针源码（连同共用类），不是空壳：
 * 「探针读哪些名字」要从真源码里查得出来，这条规矩才站得住。
 * 内核自己拼的名字（`run`、`meta`、代码关系表重建、用户查询）运行时不查，由这里逐个对真源码核。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probe } from "../../src/kernel/commands/probe.ts";
import { parseMeta } from "../../src/kernel/meta/parse.ts";
import { probeEnvNames } from "../../src/kernel/probe/env-names.ts";
import { makeContext } from "./fake-context.ts";

const PROBES = fileURLToPath(new URL("../../resources/probes/", import.meta.url));
const read = (cls: string): string | null => {
	const file = join(PROBES, `${cls}.java`);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const known = (cls: string): Set<string> => probeEnvNames(cls, read(cls) ?? "", read);
const kernelSource = (path: string): string =>
	readFileSync(fileURLToPath(new URL(`../../src/kernel/${path}`, import.meta.url)), "utf8");

/** 内置探针连同全部共用类放进假工程的探针目录。 */
function realProbes(name: string) {
	const fake = makeContext({ probes: [name] });
	const dir = fake.ctx.layout.probesDir.replace(/\\/g, "/");
	for (const file of readdirSync(PROBES)) {
		if (file.endsWith(".java")) fake.fs.put(`${dir}/${file}`, readFileSync(join(PROBES, file), "utf8"));
	}
	return fake;
}

describe("S37 2-B.1 内置探针的变量名写错就拦", () => {
	it("DataQueryProbe 传 QUERY_FILTER 时不执行，报错里有 QUERY_WHERE", async () => {
		// 09-22 真机第二份样本第 33、34 次：条件写成 QUERY_FILTER，探针当成没有条件，查回 20 行不相干的数据
		const fake = realProbes("DataQueryProbe");
		const result = await probe(fake.ctx, "DataQueryProbe", {
			env: { QUERY_ENTITY: "zlgd_sys_test_bill", QUERY_FILTER: "billno = SYSJC-001" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("PROBE_PRECHECK_FAILED");
		const unknown = (result.error.detail.blockers as string[]).find((line) => line.includes("PROBE_ENV_UNKNOWN"));
		expect(unknown).toContain("QUERY_FILTER 不是 DataQueryProbe 读取的环境变量");
		expect(unknown).toContain("QUERY_WHERE");
		// 删掉写错的名字不是对的调用（等于去掉条件），所以不代写下一次调用
		expect(result.error.detail.nextCall ?? null).toBeNull();
		expect(fake.proc.runs).toEqual([]);
		expect(fake.proc.detached).toEqual([]);
	});

	it("写对的名字照常放行，读名字的写法再多也认得", async () => {
		for (const [name, env] of [
			["DataQueryProbe", { QUERY_ENTITY: "e", QUERY_WHERE: "billno = 1", QUERY_FIELDS: "billno", QUERY_LIMIT: "5" }],
			// OP_* 在共用类 OpSandbox 里读；RULE_ALLOW_OVERLAP 用 System.getenv 读；IDX_*_FILE 是拼出来的
			["FormRuleProbe", { RULE_FORM: "f", RULE_ALLOW_OVERLAP: "1" }],
			["EntityFieldIndexProbe", { IDX_FIELDS_FILE: "a.txt", IDX_ENTITIES_FILE: "b.txt" }],
		] as const) {
			const fake = realProbes(name);
			const result = await probe(fake.ctx, name, { env });
			if (!result.ok) {
				expect(String(result.error.detail.blockers ?? ""), name).not.toContain("PROBE_ENV_UNKNOWN");
			}
		}
		expect(known("OpSandbox")).toContain("OP_PKGS");
		expect(known("DataSeedProbe").size).toBeGreaterThan(known("DbColumnProbe").size);
		// S36 批 5：写入预演的试算入参在仿真器里读，沿着类名一起认得（改前 TRY_SET 这类名字进 JVM 前就被拦）
		expect(known("FormRuleProbe")).toContain("RULE_SET");
		expect(known("FormRuleProbe")).toContain("RULE_SHOW");
		expect(known("BizRuleProbe")).toContain("RULE_SET");
		expect(known("PrintTplWriteProbe")).toContain("PRINT_PK");
	});

	it("别的探针的名字不算认得：注释里提到别的探针不是依赖", () => {
		// DataProbe 收到 DataQueryProbe 的名字（真机 09-18 第 83 次），MetaProbe 收到 DataProbe 的
		expect(known("DataProbe").has("QUERY_WHERE")).toBe(false);
		expect(known("MetaProbe").has("DATA_ENTITY")).toBe(false);
		// DbColumnProbe 的注释里提到 ColumnProbe
		expect(known("DbColumnProbe")).toEqual(new Set(["DB_ENTITY", "DB_TABLE", "DB_FILTER"]));
	});

	it("不猜相近的名字，给探针自己的入参表", async () => {
		// 按拼写挑的候选一给就是五个，QUERY_FILTER 该写的 QUERY_WHERE 排第四（用户 2026-09-26 定去掉）
		const fake = realProbes("DataQueryProbe");
		const result = await probe(fake.ctx, "DataQueryProbe", {
			env: { QUERY_ENTITY: "zlgd_sys_test_bill", QUERY_FILTER: "billno = SYSJC-001" },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		const unknown = (result.error.detail.blockers as string[]).find((line) => line.includes("PROBE_ENV_UNKNOWN"));
		expect(unknown).not.toContain("相近");
		expect(unknown).toContain("DataQueryProbe 的入参：");
		expect(unknown).toContain("QUERY_WHERE=");
	});

	it("run 拼给探针的名字，目标探针都读", () => {
		const PREFIX: [string, string][] = [
			["CALLBACK_", "FormCallbackSim"],
			["CALL_", "CallSim"],
			["OP_", "OpSandbox"],
			["FORM_", "FormSim"],
			["LIST_", "ListSim"],
			["RULE_", "RuleSim"],
			["PRINT_", "PrintSim"],
			["FLOW_", "FormFlowSim"],
		];
		const run = kernelSource("commands/run.ts");
		const keys = new Set<string>();
		for (const match of run.matchAll(
			/\b((?:CALLBACK|CALL|OP|FORM|LIST|RULE|PRINT|FLOW)_[A-Z0-9_]+)\s*:|"((?:CALLBACK|CALL|OP|FORM|LIST|RULE|PRINT|FLOW)_[A-Z0-9_]+)"/g,
		)) {
			keys.add((match[1] ?? match[2]) as string);
		}
		expect(keys.size).toBeGreaterThan(60);
		const missing = [...keys].filter((key) => {
			const target = PREFIX.find(([prefix]) => key.startsWith(prefix))?.[1] as string;
			return !known(target).has(key);
		});
		expect(missing).toEqual([]);
		// 必填字段预检、代码关系表重建、启动向导查用户
		expect(known("MustInputProbe")).toContain("META_ENTITY");
		for (const key of ["IDX_FIELDS_FILE", "IDX_ENTITIES_FILE"]) expect(known("EntityFieldIndexProbe")).toContain(key);
		expect(known("PluginIndexProbe")).toContain("IDX_PKGS");
		expect(known("UserProbe")).toContain("USER_KEY");
		expect(kernelSource("commands/impact.ts")).toContain("IDX_PKGS:");
		expect(kernelSource("commands/user-lookup.ts")).toContain("USER_KEY:");
	});

	it("meta 每个动作拼给探针的名字，目标探针都读", () => {
		const commands = [
			"botp list zlgd_%",
			"botp list --target t --rule r --plugin p",
			"botp backup d --rule 1,2",
			"botp backup d --source s --target t --name n --enabled 1",
			"botp restore d",
			"ptpl list --form f",
			"ptpl list --numbers a,b",
			"ptpl locate n LayoutCell1",
			"ptpl dump n --out d",
			"ptpl dump n --audit --control c --detail --strict",
			"ptpl dump n --grid g",
			"ptpl dump n --overview",
			"ptpl backup n d",
			"ptpl apply n --set c.fontSize=12 --backup d",
			"ptpl apply n --file f.meta.json --locale f.locale.json --backup d",
			"ptpl restore n d --backup b",
			"ptpl measure n --bill 1,2 --text --pages 1,2 --png p.png --pdf p.pdf",
			"wf list --bill b --key k --max 3",
			"wf dump k --out d",
			"wf backup d --bill b --key k --max 3",
			"formula print --name IF",
			"formula print --q q --group g --page 2 --limit 2",
			"formula form --actions --name n",
			"formula biz --q q",
		];
		const problems: string[] = [];
		for (const command of commands) {
			const plan = parseMeta(command.split(" "));
			if (!plan.ok || plan.value.kind !== "probe") {
				problems.push(`${command}：没解析成探针调用`);
				continue;
			}
			const names = known(plan.value.probe);
			for (const key of Object.keys(plan.value.env)) {
				if (!names.has(key)) problems.push(`${command}：${plan.value.probe} 不读 ${key}`);
			}
		}
		expect(problems).toEqual([]);
	});
});
