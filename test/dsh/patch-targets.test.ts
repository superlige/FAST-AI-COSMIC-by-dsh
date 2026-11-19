/**
 * 组合包补丁里关掉的行，在 dsh 的组合包里都要真有这个 id：dsh 改了名，`disabled: true` 那一行就悄悄不起作用
 * （比如左下角的 DeepSeek 登录又冒出来），没有任何报错。
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

interface JsYaml {
	Type: new (tag: string, options: { kind: "scalar"; construct: (data: string) => unknown }) => unknown;
	DEFAULT_SCHEMA: { extend(types: unknown[]): unknown };
	load(text: string, options: { schema: unknown }): unknown;
}
const yaml = createRequire(import.meta.url)("js-yaml") as JsYaml;
const schema = yaml.DEFAULT_SCHEMA.extend([
	new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => ({ js: data }) }),
]);
const load = (path: string) => yaml.load(readFileSync(new URL(path, import.meta.url), "utf8"), { schema });

/** 补丁树里所有带 id 的行。 */
function ids(node: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(node)) for (const item of node) ids(item, into);
	else if (typeof node === "object" && node !== null) {
		const id = (node as { id?: unknown }).id;
		if (typeof id === "string") into.add(id);
		for (const value of Object.values(node)) ids(value, into);
	}
	return into;
}

const ours = load("../../cordis.patch.yml") as { id?: string; disabled?: boolean }[];
const disabled = ours.filter((row) => row.disabled === true).map((row) => row.id as string);
// web-app 的四个自带预设各在 presets/ 下一个文件里
const presets = readdirSync(new URL("../../../packages/bundle/web-app/presets/", import.meta.url)).filter((file) =>
	file.endsWith(".yml"),
);
const dsh = ids([
	load("../../../packages/bundle/base/cordis.patch.yml"),
	load("../../../packages/bundle/web-app/cordis.patch.yml"),
	...presets.map((file) => load(`../../../packages/bundle/web-app/presets/${file}`)),
]);

it("关掉的每一行在 dsh 的 base、web-app 组合包里都有", () => {
	expect(disabled.length).toBeGreaterThan(0);
	expect(disabled.filter((id) => !dsh.has(id))).toEqual([]);
});

it("DeepSeek 账号界面关掉，后台账号插件留着（桌面版启动要经它读登录状态）", () => {
	expect(disabled).toEqual(expect.arrayContaining(["ui-settings-account", "ui-account-notifications"]));
	expect(disabled).not.toContain("deepseek-account");
});
