/**
 * 内核适配器和 JVM 状态板：一个进程各一份，所有会话共用。
 *
 * 内核共用是安全的：它手里只有按工程根目录记的缓存（运行时扫描、影响面重建、元数据快照核对），
 * 不记哪个会话做了什么——那些在 `session.ts` 里按会话分开。
 * 状态板（`jvm-board.ts`）要一个进程一份，是因为写它的（开发预设里的产品插件）和读它的
 * （顶层品牌行挂的请求路径）是两个插件；两个入口编在同一个包里，共用这一个模块。
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CosmicAgentKernel, createKernelAdapter } from "../agent/tools/kernel-adapter.ts";
import { KNOWLEDGE_PACK_FILENAME } from "../knowledge/embedded.ts";
import { REFERENCE_PACK_FILENAME } from "../knowledge/reference.ts";
import { EMBEDDED_RESOURCES } from "../resources/embedded.generated.ts";
import { JvmBoard } from "./jvm-board.ts";

export type CosmicKernel = ReturnType<typeof createKernelAdapter>;
export type ProjectHandle = CosmicKernel extends CosmicAgentKernel<infer H> ? H : never;

/**
 * 进 RuntimeKey 的版本号：和 pi 版不同，各自编宿主、各自起常驻 JVM，两边同时用也不互相顶掉。
 * 打包时由构建脚本换成真版本号；直接从源码跑时用这个。
 */
export const AGENT_VERSION = "dsh-0.1.0";

/**
 * 知识包在组合包根目录的 `knowledge/` 下，根目录 = 从这个文件往上最近一个有 `package.json` 的目录。
 * 不能按固定层数猜：从源码跑时这个文件在 `src/dsh/`；打包后它和 `brand.js` 共用，被拆进
 * `chunks/kernel-<hash>.js`，层数随打包方式变。按固定层数猜过，打包后两处都落空，知识查询全挂。
 */
export function packageRootOf(startDir: string): string | undefined {
	let dir = startDir;
	for (;;) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

const PACKAGE_ROOT = packageRootOf(dirname(fileURLToPath(import.meta.url)));

export function packFile(root: string | undefined, name: string, override: string | undefined): string | undefined {
	if (override !== undefined && override !== "") return override;
	if (root === undefined) return undefined;
	const file = join(root, "knowledge", name);
	return existsSync(file) ? file : undefined;
}

/** 这个进程实际用的两个知识包路径；打包脚本编完拿它核对产物里找得到包。 */
export function cosmicPackFiles(): { knowledgePackFile: string | undefined; referencePackFile: string | undefined } {
	return {
		knowledgePackFile: packFile(PACKAGE_ROOT, KNOWLEDGE_PACK_FILENAME, process.env.COSMIC_KB_PACK),
		referencePackFile: packFile(PACKAGE_ROOT, REFERENCE_PACK_FILENAME, process.env.COSMIC_REFERENCE_PACK),
	};
}

let shared: CosmicKernel | undefined;

export function cosmicKernel(): CosmicKernel {
	if (shared !== undefined) return shared;
	const agentConfigDir = join(homedir(), ".fast-ai-cosmic");
	const { knowledgePackFile, referencePackFile } = cosmicPackFiles();
	shared = createKernelAdapter({
		agentConfigDir,
		cacheRoot: join(agentConfigDir, "cache"),
		agentVersion: AGENT_VERSION,
		resources: EMBEDDED_RESOURCES,
		...(knowledgePackFile === undefined ? {} : { knowledgePackFile }),
		...(referencePackFile === undefined ? {} : { referencePackFile }),
	});
	return shared;
}

let board: JvmBoard<ProjectHandle> | undefined;

export function cosmicJvmBoard(): JvmBoard<ProjectHandle> {
	board ??= new JvmBoard<ProjectHandle>(cosmicKernel());
	return board;
}
