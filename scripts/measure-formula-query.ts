/** S36 batch 2: fixed read-only questions, old probe path and the domain query path. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { meta } from "../src/kernel/commands/meta.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const projectRoot = process.argv[2];
if (!projectRoot) throw new Error("用法：node --experimental-strip-types scripts/measure-formula-query.ts <真机工程>");
const scratch = mkdtempSync(join(tmpdir(), "cosmic-formula-ruler-"));
const opened = await openProject({
	projectRoot: resolve(projectRoot),
	agentConfigDir: join(scratch, "agent"),
	cacheRoot: join(scratch, "cache"),
	agentVersion: "s36-ruler",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const questions = [
	{ id: "print-concat", argv: ["formula", "print", "--name", "CONCAT"], expected: "CONCAT" },
	{ id: "form-multi", argv: ["formula", "form", "--name", "MulBasedataInclude"], expected: "MulBasedataInclude" },
	{ id: "biz-if", argv: ["formula", "biz", "--name", "if"], expected: "if" },
	{ id: "form-actions", argv: ["formula", "form", "--actions", "--q", "显示"], expected: null },
	{ id: "biz-actions", argv: ["formula", "biz", "--actions", "--q", "计算"], expected: null },
	{ id: "print-summary", argv: ["formula", "print"], expected: null },
	{ id: "form-summary", argv: ["formula", "form"], expected: null },
	{ id: "biz-summary", argv: ["formula", "biz"], expected: null },
] as const;
console.log(JSON.stringify({ kind: "ruler", version: "s36-formula-v1", runtimeKeyId: ctx.runtimeKeyId }));
try {
	for (const question of questions) {
		const started = Date.now();
		const result = await meta(ctx, question.argv);
		if (!result.ok || result.value.kind !== "probe" || !result.value.probe || result.value.probe.exitCode !== 0)
			throw new Error(`${question.id}: ${result.ok ? "探针未成功" : result.error.message}`);
		const records = result.value.probe.json.records;
		const summary = records.find((record) => record.t === "formula-summary");
		const items = records.filter((record) => record.t === "formula-item");
		if (!summary) throw new Error(`${question.id}: 缺目录摘要`);
		if (question.expected && !items.some((item) => String(item.id).toLowerCase() === question.expected.toLowerCase()))
			throw new Error(`${question.id}: 未查到 ${question.expected}`);
		if (question.id.endsWith("summary") && items.length) throw new Error(`${question.id}: 无筛选却发了详情`);
		if (items.some((item) => item.domain !== question.argv[1])) throw new Error(`${question.id}: 公式领域混用`);
		console.log(
			JSON.stringify({
				kind: "new",
				id: question.id,
				argv: question.argv,
				ms: Date.now() - started,
				outputBytes: Buffer.byteLength(result.value.text, "utf8"),
				recordBytes: size(records),
				total: summary.total,
				matched: summary.matched,
				shown: summary.shown,
				groups: summary.groups,
				status: summary.status,
				source: summary.source,
				coverage: summary.coverage,
				items: items.map((item) => ({ id: item.id, group: item.group, usage: item.usage, source: item.source })),
			}),
		);
	}
	for (const question of [
		{
			id: "old-form-multi",
			env: { RULE_FUNC_SCOPE: "all", RULE_FUNC_FILTER: "MulBasedataInclude", RULE_FUNC_DETAIL: "1" },
		},
		{ id: "old-biz-if", env: { RULE_FUNC_SCOPE: "all", RULE_FUNC_FILTER: "if", RULE_FUNC_DETAIL: "1" } },
		{ id: "old-form-actions", env: { RULE_FUNC_SCOPE: "action", RULE_FUNC_FILTER: "显示", RULE_FUNC_DETAIL: "1" } },
		{ id: "old-actions", env: { RULE_FUNC_SCOPE: "action", RULE_FUNC_FILTER: "计算", RULE_FUNC_DETAIL: "1" } },
	]) {
		const started = Date.now();
		const result = await probe(ctx, "RuleFunctionProbe", { env: question.env });
		if (!result.ok || result.value.exitCode !== 0)
			throw new Error(`${question.id}: ${result.ok ? "探针未成功" : result.error.message}`);
		console.log(
			JSON.stringify({
				kind: "old",
				id: question.id,
				env: question.env,
				ms: Date.now() - started,
				outputBytes: Buffer.byteLength(result.value.output, "utf8"),
				recordBytes: size(result.value.json.records),
				lines: result.value.output
					.split(/\r?\n/)
					.filter((line) => line.includes("[PROBE] 命中"))
					.slice(-1),
			}),
		);
	}
	const checked = await probe(ctx, "FormulaFunctionProbe", {
		env: { FORMULA_DOMAIN: "print", FORMULA_NAME: "CONCAT", FORMULA_SELF_CHECK: "1" },
	});
	if (
		!checked.ok ||
		checked.value.exitCode !== 0 ||
		!checked.value.json.records.some((record) => record.t === "formula-check")
	)
		throw new Error("打印设计器目录与平台校验器交叉核对失败");
	console.log(
		JSON.stringify({
			kind: "check",
			id: "print-concat-validator",
			records: checked.value.json.records.filter((record) => record.t === "formula-check"),
		}),
	);
	const category = await meta(ctx, ["formula", "print", "--group", "字符串函数"]);
	const summary =
		category.ok && category.value.kind === "probe"
			? category.value.probe?.json.records.find((record) => record.t === "formula-summary")
			: undefined;
	if (
		!category.ok ||
		category.value.kind !== "probe" ||
		category.value.probe?.exitCode !== 0 ||
		summary?.status !== "loaded"
	)
		throw new Error("打印分类查询或自定义函数登记表读取失败");
	console.log(
		JSON.stringify({
			kind: "check",
			id: "print-category-after-validator",
			total: summary.total,
			matched: summary.matched,
			status: summary.status,
			coverage: summary.coverage,
		}),
	);
} finally {
	await stopServer(ctx);
}
