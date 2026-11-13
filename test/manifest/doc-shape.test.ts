/**
 * 文档规矩（`AGENTS.md` 第二节）做成检查：活的文档只有 `AGENTS.md` 和 `IMPLEMENTATION.md`，
 * 修 bug、加功能不另写文档。
 *
 * 写成测试而不是只写成一句话，是因为规矩只写在文档里时，文档照样被撑成了几十 KB 的流水账：
 * 每轮往"最近更新"里插一段、每个阶段往下堆完成史，没人拦就没人守。
 *
 * 超了上限不是"把句子压短"，是有东西放错了地方：历史和理由进代码注释或提交说明，
 * 过程不写。真有内容该这么长，就调这里的数并在提交说明里说清为什么。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 架构 + 功能表 + 改哪里 + 怎么排查。 */
const IMPLEMENTATION_LIMIT = 32 * 1024;
/** 规矩。 */
const AGENTS_LIMIT = 16 * 1024;

/** `docs/` 下只许有给用户看的打包安装手册，别的内容进 `IMPLEMENTATION.md`、代码注释或提交说明。 */
const DOCS_ALLOWED = new Set(["packaging-and-usage.md"]);

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

function filesUnder(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...filesUnder(full, `${prefix}${name}/`));
		else out.push(`${prefix}${name}`);
	}
	return out;
}

describe("文档规矩（AGENTS.md 第二节）", () => {
	it("IMPLEMENTATION.md 不超过 32 KB——超了是有东西放错了地方", () => {
		expect(bytes(read("IMPLEMENTATION.md"))).toBeLessThanOrEqual(IMPLEMENTATION_LIMIT);
	});

	it("AGENTS.md 不超过 16 KB", () => {
		expect(bytes(read("AGENTS.md"))).toBeLessThanOrEqual(AGENTS_LIMIT);
	});

	it("IMPLEMENTATION.md 只写现在：不带日期（带日期的多半是历史或流水）", () => {
		const dated = read("IMPLEMENTATION.md")
			.split("\n")
			.filter((line) => /20\d\d-\d\d-\d\d/.test(line));
		expect(dated).toEqual([]);
	});

	it("docs/ 下只有打包安装手册：修 bug、加功能不另写文档", () => {
		const docs = join(ROOT, "docs");
		const extra = existsSync(docs) ? filesUnder(docs).filter((file) => !DOCS_ALLOWED.has(file)) : [];
		expect(extra, "要写的内容放进 IMPLEMENTATION.md、代码注释或提交说明").toEqual([]);
	});
});
