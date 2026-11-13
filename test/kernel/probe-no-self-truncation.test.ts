/**
 * S44 批 1：探针把算好的清单一条不少地打出来，太长由工具那一层裁。
 *
 * 工具那一层裁的时候说清省了哪几行、是什么，模型在同一次调用里按行号或关键字取回；
 * 探针自己先截掉的，全文里就没有，哪里都取不回。真机一次布局预演 96 处差异只列了 60 处，
 * 模型为找剩下 36 处翻了四次落盘文件；打印模板写入只发前 40 条差异记录，确认单跟着少报。
 *
 * 这里扫 `resources/probes/` 的真源码，认出「只打前几条」的四种写法。确实该少列的
 * （查库条数有上限、按远近排的候选、全量在同一份输出别处的摘要），紧挨着的上面几行写
 * 「不全列：原因」，这条检查就放过。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROBES = fileURLToPath(new URL("../../resources/probes/", import.meta.url));

/** 「只打前几条」的写法：双条件的 for、截头的 subList、数到上限就跳过、文字里的「没列」。 */
const CAPPED = [
	/\b[a-z]\w* < [\w.()]+ && [a-z]\w* < (?:\d+|[A-Z_]+)\b/,
	/subList\(0, Math\.min\(/,
	/\+\+ >= (?:\d+|[A-Z_]+)\b/,
	/"[^"]*(?:没列|只列前)/,
];
const REASON = /不全列：/;
const REASON_REACH = 3;

/** 源码里写不了原因的例外（按「文件:行号」登记）。现在没有。 */
const EXEMPT = new Set<string>();

function cappedLines(source: string): number[] {
	const lines = source.split("\n");
	const found: number[] = [];
	lines.forEach((line, i) => {
		if (/^\s*(?:\*|\/\/)/.test(line) || !CAPPED.some((re) => re.test(line))) return;
		const above = lines.slice(Math.max(0, i - REASON_REACH), i + 1);
		if (!above.some((l) => REASON.test(l))) found.push(i + 1);
	});
	return found;
}

describe("S44 批 1 探针不自己截断", () => {
	it("已发布探针里没有不写原因的「只打前几条」", () => {
		const offenders = readdirSync(PROBES)
			.filter((file) => file.endsWith(".java"))
			.flatMap((file) =>
				cappedLines(readFileSync(join(PROBES, file), "utf8")).map((line) => `${file}:${String(line)}`),
			)
			.filter((at) => !EXEMPT.has(at));
		expect(offenders).toEqual([]);
	});

	it("认得出几种写法，写了原因的放过", () => {
		const source = [
			"for (int i = 0; i < rows.size() && i < 60; i++) {",
			"for (int i = 0; i < found.size() && i < USES_SHOWN; i++) {",
			'String some = String.join("、", names.subList(0, Math.min(10, names.size())));',
			"if (shown++ >= 30) continue;",
			'System.out.println("[PROBE]   …还有 " + n + " 处没列");',
			"for (int i = 0; i < rows.size(); i++) {",
			"//不全列：按名字远近排的候选，给最像的几个",
			"return hits.subList(0, Math.min(6, hits.size())).toString();",
		].join("\n");
		expect(cappedLines(source)).toEqual([1, 2, 3, 4, 5]);
	});
});
