/**
 * 知识包找路径：组合包根目录是往上最近一个有 package.json 的目录，知识包在它的 knowledge/ 下。
 * 打包后找包的代码被拆进 chunks/kernel-<hash>.js；按固定层数猜根目录时，这个布局下两处都落空，
 * 知识查询全部报 KNOWLEDGE_UNAVAILABLE。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cosmicPackFiles, packageRootOf, packFile } from "../../src/dsh/kernel.ts";

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function bundleLayout(): string {
	const pkg = join(mkdtempSync(join(tmpdir(), "cosmic-pack-")), "node_modules", "fast-ai-cosmic");
	temps.push(resolve(pkg, "..", ".."));
	mkdirSync(join(pkg, "chunks"), { recursive: true });
	mkdirSync(join(pkg, "knowledge"), { recursive: true });
	writeFileSync(join(pkg, "package.json"), "{}");
	writeFileSync(join(pkg, "chunks", "kernel-abc.js"), "");
	writeFileSync(join(pkg, "knowledge", "cosmic-kb.pack"), "");
	writeFileSync(join(pkg, "knowledge", "reference.pack"), "");
	return pkg;
}

describe("知识包路径", () => {
	it("打包布局：代码在 chunks/ 下也能找到包根目录的 knowledge/", () => {
		const pkg = bundleLayout();
		const root = packageRootOf(join(pkg, "chunks"));
		expect(root).toBe(pkg);
		expect(packFile(root, "cosmic-kb.pack", undefined)).toBe(join(pkg, "knowledge", "cosmic-kb.pack"));
		expect(packFile(root, "reference.pack", undefined)).toBe(join(pkg, "knowledge", "reference.pack"));
	});

	it("包根目录下缺包时报没有，不去更上层乱找", () => {
		const pkg = bundleLayout();
		rmSync(join(pkg, "knowledge", "cosmic-kb.pack"));
		expect(packFile(packageRootOf(join(pkg, "chunks")), "cosmic-kb.pack", undefined)).toBeUndefined();
	});

	it("环境变量指定的路径优先", () => {
		expect(packFile(undefined, "cosmic-kb.pack", "D:/x/kb.pack")).toBe("D:/x/kb.pack");
	});

	it("源码布局：本仓库自己的两个包都找得到", () => {
		const repo = resolve(fileURLToPath(new URL("../..", import.meta.url)));
		const saved = [process.env.COSMIC_KB_PACK, process.env.COSMIC_REFERENCE_PACK];
		delete process.env.COSMIC_KB_PACK;
		delete process.env.COSMIC_REFERENCE_PACK;
		try {
			expect(cosmicPackFiles()).toEqual({
				knowledgePackFile: join(repo, "knowledge", "cosmic-kb.pack"),
				referencePackFile: join(repo, "knowledge", "reference.pack"),
			});
		} finally {
			if (saved[0] !== undefined) process.env.COSMIC_KB_PACK = saved[0];
			if (saved[1] !== undefined) process.env.COSMIC_REFERENCE_PACK = saved[1];
		}
	});
});
