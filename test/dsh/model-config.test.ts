/**
 * 组合包里的模型配置（cordis.patch.yml 的 llm-pi-ai 那一段）：
 *   - codex 的 `models` 整体替换 pi-ai 自带清单，自带清单以后多了模型、这里没列，那个模型就被藏掉了；
 *   - gpt-6.2-sol 是手工补的，自带清单收了它就该删掉手写的字段，改用自带的；
 *   - 无界面配置脚本再写一行 llm-pi-ai 会整个替换这一段（不是合并），清单就没了；
 *   - 第三方网关的密钥只写引用名，不写值。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const patch = readFileSync(new URL("../../cordis.patch.yml", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const setup = readFileSync(new URL("../../scripts/setup-dsh-profiles.mjs", import.meta.url), "utf8");

/**
 * dsh 检出目录里 llm-pi-ai 适配器装的模型目录（codex 那一份）。本仓库不依赖那个包，只读 dsh 装好的数据文件：
 * 在适配器的依赖目录里找带 `pi-ai/dist/providers/data/openai-codex.json` 的那一个，不写死包的作用域名。
 */
function codexCatalogFile(): string {
	const modules = fileURLToPath(new URL("../../../packages/llm/llm-pi-ai/node_modules", import.meta.url));
	for (const scope of readdirSync(modules).filter((name) => name.startsWith("@"))) {
		const file = join(modules, scope, "pi-ai", "dist", "providers", "data", "openai-codex.json");
		if (existsSync(file)) return file;
	}
	throw new Error(`${modules} 下找不到 llm-pi-ai 装的 codex 模型目录（dsh 检出目录 pnpm install 过没有）`);
}
const catalog = JSON.parse(readFileSync(codexCatalogFile(), "utf8")) as Record<
	string,
	Record<string, { id: string; type?: string }>
>;
const shipped = Object.values(catalog)
	.flatMap((models) => Object.values(models))
	.filter((model) => model.type === undefined || model.type === "chat")
	.map((model) => model.id);

/** 组合包里 openai-codex 那一节列出的模型。 */
function listedCodexModels(): string[] {
	const start = patch.indexOf("\n      openai-codex:\n");
	const end = patch.indexOf("\n      commandcode-goat:\n");
	expect(start, "cordis.patch.yml 里找不到 openai-codex 那一节").toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return [...patch.slice(start, end).matchAll(/^ {10}- id: (\S+)$/gm)].map((match) => match[1] as string);
}

describe("组合包的模型配置", () => {
	it("pi-ai 自带的 codex 模型一个不漏地列着", () => {
		expect(shipped.length).toBeGreaterThan(0);
		const listed = listedCodexModels();
		expect(shipped.filter((id) => !listed.includes(id))).toEqual([]);
	});

	it("手工补的 gpt-6.2-sol 自带清单还没有；有了就删掉手写字段改用自带的", () => {
		expect(listedCodexModels()).toContain("gpt-6.2-sol");
		expect(shipped).not.toContain("gpt-6.2-sol");
	});

	it("无界面配置脚本不另写 llm-pi-ai 那一行", () => {
		expect(setup).not.toMatch(/"- id: llm-pi-ai"/);
	});

	it("第三方网关只写密钥引用名，不写值", () => {
		expect(patch).toContain("apiKeyEnv: COMMANDCODE_GOAT_API_KEY");
		expect(patch).not.toMatch(/^\s*apiKey:/m);
	});
});
