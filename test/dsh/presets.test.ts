/**
 * 组合包预设里挂的 dsh 插件，配置要和 dsh-base 顶层同名行一致（无界面配置跑的就是顶层那一套）。
 *
 * 预设里的插件不继承顶层的配置，必填项漏写，界面新建会话直接失败
 * （"agent-preset/invalid: tool-fs-search: $.sampleOverCapGlobResults missing required value"）。
 * 无界面配置没有预设注册表，命令行验收查不出这一类错，只能在这里对。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

interface YamlType {
	new (tag: string, options: { kind: "scalar"; construct: (data: string) => unknown }): unknown;
}
interface JsYaml {
	Type: YamlType;
	DEFAULT_SCHEMA: { extend(types: unknown[]): unknown };
	load(text: string, options: { schema: unknown }): unknown;
}
// dsh 检出目录根下的 js-yaml（本仓库放在检出目录里，见 docs/packaging-and-usage.md）
const yaml = createRequire(import.meta.url)("js-yaml") as JsYaml;
const schema = yaml.DEFAULT_SCHEMA.extend([
	new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (data) => ({ js: data }) }),
]);
const load = (url: URL) => yaml.load(readFileSync(url, "utf8"), { schema });

interface Row {
	id: string;
	name?: string;
	group?: boolean;
	config?: unknown;
}
const isRow = (value: unknown): value is Row =>
	typeof value === "object" && value !== null && typeof (value as Row).id === "string";

/** 补丁文件里所有带 name 的行（insert 里的、组里的都算）。 */
function rows(node: unknown, into: Row[] = []): Row[] {
	if (Array.isArray(node)) for (const item of node) rows(item, into);
	else if (typeof node === "object" && node !== null) {
		if (isRow(node) && node.name !== undefined) into.push(node);
		for (const value of Object.values(node)) rows(value, into);
	}
	return into;
}

const ours = rows(load(new URL("../../cordis.patch.yml", import.meta.url)));
const base = new Map(
	rows(load(new URL("../../../packages/bundle/base/cordis.patch.yml", import.meta.url))).map((row) => [row.id, row]),
);

function presetPlugins(id: string): Row[] {
	const preset = ours.find((row) => row.id === id);
	const plugins = (preset?.config as { plugins?: unknown } | undefined)?.plugins;
	if (!Array.isArray(plugins)) throw new Error(`没找到预设 ${id}`);
	return rows(plugins).filter((row) => row.group !== true);
}

it("只有一个苍穹预设：开发和查生产在同一个会话里", () => {
	const presets = ours.filter((row) => row.name === "@deepseek-ai/dsh-agent-preset").map((row) => row.id);
	expect(presets).toEqual(["preset-cosmic"]);
});

describe.each(["preset-cosmic"])("预设 %s", (preset) => {
	const plugins = presetPlugins(preset);

	it("挂了 dsh 插件，且大部分在 dsh-base 顶层有同名行可对", () => {
		const matched = plugins.filter((row) => base.get(row.id)?.name === row.name);
		expect(matched.length).toBeGreaterThan(5);
	});

	it.each(plugins.map((row) => [row.id, row] as const))("%s 的配置包含 dsh-base 同名行的全部配置", (_id, row) => {
		const top = base.get(row.id);
		if (top === undefined || top.name !== row.name || top.config === undefined) return;
		expect(row.config ?? {}).toMatchObject(top.config as object);
	});
});
