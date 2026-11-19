import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DESKTOP_ISOLATION, dshSourceFiles, findSharedDshPaths } from "../../scripts/desktop-isolation.ts";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it("认得出读 dsh 默认数据目录、环境变量、协议名的写法", () => {
	const text = [
		"export const DSH_HOME_DIR_NAME = '.dsh'",
		"const home = process.env.DSH_HOME ?? x",
		"export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'",
		"app.setAsDefaultProtocolClient('dsh')",
		"if (url === 'dsh://open') focus()",
		"join(projectRoot, '.dsh/skills')",
		"url: 'dsh://host',",
		`export const DSH_HOME_DIR_NAME = '${DESKTOP_ISOLATION.homeDir}'`,
		`app.setAsDefaultProtocolClient('${DESKTOP_ISOLATION.scheme}')`,
	].join("\n");
	expect(findSharedDshPaths([{ path: "a.ts", text }])).toEqual([
		"a.ts:1: export const DSH_HOME_DIR_NAME = '.dsh'",
		"a.ts:2: const home = process.env.DSH_HOME ?? x",
		"a.ts:3: export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'",
		"a.ts:4: app.setAsDefaultProtocolClient('dsh')",
		"a.ts:5: if (url === 'dsh://open') focus()",
	]);
});

// 打包补丁（scripts/package-desktop.mjs 的「隔离」组）改的正是这几个文件；dsh 升级后多出别的文件，
// 装好的桌面版就会有一处又读回 ~/.dsh，回去给它加补丁，再把文件加到这里。
it("dsh 检出目录里读默认数据目录的地方，正好是打包补丁改的那几个文件", () => {
	const files = new Set(findSharedDshPaths(dshSourceFiles(checkout)).map((hit) => hit.split(":")[0]));
	expect([...files].sort()).toEqual([
		"apps/desktop/src/main.ts",
		"packages/experimental/liveshare/src/host/share-host.ts",
		"packages/util/home-paths/src/index.ts",
	]);
	// 单跑约 0.6 秒；全量并行、机器忙时会翻好几倍，默认 5 秒不够
}, 30_000);
