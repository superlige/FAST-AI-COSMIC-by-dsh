#!/usr/bin/env node
/**
 * 建（或重建）两个 dsh 配置：无界面的 `cosmic`，和带网页界面的 `cosmic-web`（`dsh --profile cosmic-web` 起网页服务）。
 * 开发和查生产在同一个会话里，不分配置。网页界面的预设「苍穹」写在组合包的 cordis.patch.yml 里，
 * 终端、改文件工具挂在预设里面，顶层关不到，也不用关。
 *
 * 用法：node scripts/setup-dsh-profiles.mjs [--model <模型>] [--provider <供应商>]
 *   默认 provider=openai-codex、model=gpt-6.1-sol，登录用 dsh web 里存的 codex 凭据（或会话里 /cosmic-login）。
 *
 * 每个配置目录在 ~/.dsh/profiles/<名字>/：package.json 以 link: 指向本仓库，cordis.patch.yml 写模式和要关掉的插件，
 * 然后在目录里 pnpm install。看最终挂了哪些插件：dsh --profile cosmic --dump-config。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback;
};
const provider = flag("provider", "openai-codex");
const model = flag("model", "gpt-6.1-sol");

/** 苍穹开发用不上、又会改变模型行为或往外发数据的插件：两个配置都关。 */
const DISABLED = [
	// id 按 dsh --profile cosmic --dump-config 对过；dsh 升级后重跑 dump 再对一遍
	// 子代理、团队：会把任务拆出去，产品工具的会话状态跟不过去
	"subagent",
	"agent-team",
	"tool-agent-team",
	"subagent-spawn-in-process",
	"subagent-fork-in-process",
	"tool-subagent-control",
	"tool-subagent",
	"tool-subagent-fork",
	// 计划模式、目标：另一套推进节奏，和产品路线打架
	"plan-mode",
	"goal",
	"goal-round-driver",
	"command-goal",
	"tool-goal",
	// 代码模式（PTC）、工作流
	"ptc-runtime",
	"workflow-ptc",
	"tool-workflow",
	// 联网搜索（走 DeepSeek 的接口）
	"web",
	"web-search-deepseek",
	"web-deepseek-api",
	"web-fetch-http",
	"tool-web",
	// 会话遥测
	"session-telemetry-otel",
];

const header = `# 由 fast-ai-cosmic/scripts/setup-dsh-profiles.mjs 生成；改这里不如改脚本再重跑。\n`;

function common() {
	return [
		"- id: credentials",
		"  disabled: false",
		"- id: authorization",
		"  disabled: false",
		// 不写 llm-pi-ai 这一行：模型清单（codex 补的 gpt-6.2-sol、Command Code）和 codex 走 SSE 都在组合包的
		// cordis.patch.yml 里，无界面配置也套那一层；这里再写同 id 的一行会整个替换掉它（不是合并），清单就没了。
		"- id: agent-default-model",
		"  config:",
		`    provider: ${provider}`,
		`    model: ${model}`,
		"    reasoningEffort: high",
		...DISABLED.flatMap((id) => [`- id: ${id}`, "  disabled: true"]),
	];
}

/**
 * 无界面没有预设（新建会话时选的那一项），产品工具直接插在顶层；
 * 组合包里的预设行在这里没有注册表可登记，关掉。带界面的配置不插：预设里挂了一份。
 */
const toolsRow = () => [
	"- id: preset-cosmic",
	"  disabled: true",
	"- insert:",
	"    - id: cosmic-tools",
	"      name: fast-ai-cosmic/tools",
];

const HEADLESS = "@deepseek-ai/dsh-headless";
const WEB = "@deepseek-ai/dsh-web-app";
const PROFILES = {
	cosmic: { app: HEADLESS, patch: [...common(), ...toolsRow()] },
	"cosmic-web": { app: WEB, patch: common() },
};

for (const [name, { app, patch }] of Object.entries(PROFILES)) {
	const dir = join(homedir(), ".dsh", "profiles", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		`${JSON.stringify(
			{
				name: `dsh-profile-${name}`,
				private: true,
				dependencies: { "fast-ai-cosmic": `link:${repo.replace(/\\/g, "/")}` },
				dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", app, "fast-ai-cosmic"] } },
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(dir, "cordis.yml"),
		"# dsh profile root — an empty entry list. The tree is composed as patches:\n# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n# --patch overlays. Edit cordis.patch.yml, not this file.\n[]\n",
	);
	writeFileSync(
		join(dir, "pnpm-workspace.yaml"),
		"packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
	);
	writeFileSync(join(dir, "cordis.patch.yml"), `${header}${patch.join("\n")}\n`);
	execFileSync("pnpm", ["install", "--silent"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
	console.log(`profile ${name}: ${dir}`);
}
