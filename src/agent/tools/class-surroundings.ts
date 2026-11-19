/**
 * 读到工程里的插件类时，在读取结果后面附上它的周边（父类链、用到的常量、同类写法）。
 *
 * 算法在 `knowledge/class-surroundings.ts`；这里只管三件事：同一个文件一个会话只附一次（记在读取账上，
 * 压缩时清空），工程类索引缓存一小会儿（建一次约 0.3 秒、五百多个类），算不出来就什么都不附——
 * 周边是顺手给的，不能因为它让一次读取失败。
 */

import { nodeFs } from "../../kernel/ports.ts";
import {
	buildJavaIndex,
	classSurroundings,
	type ProjectJavaIndex,
	sourceRootsOf,
} from "../../knowledge/class-surroundings.ts";
import type { ReadLedger } from "./read-ledger.ts";
import { billConstLine } from "./style-check.ts";

/**
 * 索引多久重建一次。模型这一分钟里新写的类进不了同类写法的统计，没关系；
 * 读到的那个类本身总是现读现算。
 */
const INDEX_TTL_MS = 60_000;

let cached: { root: string; at: number; index: ProjectJavaIndex } | null = null;

function indexFor(root: string, now: number): ProjectJavaIndex {
	if (cached !== null && cached.root === root && now - cached.at < INDEX_TTL_MS) return cached.index;
	const index = buildJavaIndex(root, sourceRootsOf(root, nodeFs), nodeFs);
	cached = { root, at: now, index };
	return index;
}

export interface SurroundingsReadRequest {
	root: string;
	/** 解析到磁盘上的文件。 */
	file: string;
	/** 比较用的文件名写法，记在读取账上。 */
	key: string;
	ledger: ReadLedger;
	now?: number;
}

/** 这次读取要附的周边文字；不该附（不是 Java、附过了、不是插件类、没什么可说）返回 null。 */
export function surroundingsForRead(request: SurroundingsReadRequest): string | null {
	if (!request.file.toLowerCase().endsWith(".java")) return null;
	if (request.ledger.surrounded.has(request.key)) return null;
	request.ledger.surrounded.add(request.key);
	try {
		const index = indexFor(request.root.replace(/\\/g, "/").replace(/\/$/, ""), request.now ?? Date.now());
		const text =
			classSurroundings({ index, file: request.file, source: nodeFs, seen: request.ledger.surroundings })?.text ??
			null;
		if (text === null) return null;
		const consts = billConstLine(request.root, request.file, request.now ?? Date.now());
		return consts === null ? text : `${text}\n${consts}`;
	} catch {
		return null;
	}
}
