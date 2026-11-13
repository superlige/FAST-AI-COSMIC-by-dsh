/**
 * 本仓库接的是 deepseek-harness，不再依赖 pi：源码、脚本、测试、包清单里都不许出现 pi 的包名。
 *
 * 包名拆成两段拼起来写，免得这个测试自己搜到自己。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PI_SCOPE = ["@earendil", "works"].join("-");
const SCANNED_DIRS = ["src", "scripts", "test"];
const SCANNED_FILES = ["package.json", "tsconfig.json", "vitest.config.ts"];
const TEXT_FILE = /\.(ts|mts|mjs|js|json|md)$/;

function textFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) out.push(...textFilesUnder(full));
		else if (TEXT_FILE.test(name)) out.push(full);
	}
	return out;
}

describe("不依赖 pi", () => {
	it(`源码、脚本、测试、包清单里搜不到 ${PI_SCOPE}`, () => {
		const files = [
			...SCANNED_DIRS.flatMap((dir) => textFilesUnder(join(ROOT, dir))),
			...SCANNED_FILES.map((file) => join(ROOT, file)),
		];
		expect(files.length).toBeGreaterThan(100);
		const hits = files
			.filter((file) => readFileSync(file, "utf8").includes(PI_SCOPE))
			.map((file) => relative(ROOT, file).replaceAll("\\", "/"));
		expect(hits).toEqual([]);
	});
});
