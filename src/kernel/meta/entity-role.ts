/**
 * 探针发起之前，拿代码关系表在本地核一眼「实体」填的是不是实体（S33 批 1）。
 *
 * 模型的标识多半是从插件代码里抄的，代码里分录和字段就是那么写的：真机 2026-09-21 一次会话里
 * `QUERY_ENTITY=zlgd_entryentity_jxsy`（实验室检测单的一条分录）、`QUERY_ENTITY=zlgd_jyxm`（分录上的字段）
 * 连着两次，每次都要进一趟 Java 才换回「不是实体」。代码关系表里早就记着它们属于谁。
 *
 * **只挡有把握的那一种**：表里明确记着「这是某张单的分录」、而且表里没有同名的单。
 * 字段那一种不挡——基础资料字段常和它指向的基础资料同名（真机表里 10 个），表只收了
 * 代码里用到的字段、也可能旧了，挡错了就是把一次正当的查询拦死。字段那种交给 Java 侧：
 * 平台元数据反查归属，约 1 秒，说得比这里准（MetaResolve.owners）。
 * 表里查不到的一律放行：「没记着」不等于「不存在」。
 */

import type { KernelContext } from "../context.ts";
import type { PrepareBlocker } from "../prepare/model.ts";
import type { FieldOwnershipRow } from "./ptpl-edit.ts";

/** 按文件系统各记一份：同一进程里换了工程（或测试里换了假文件系统）不会读到别人的表。 */
const cache = new WeakMap<object, { path: string; mtime: number; rows: FieldOwnershipRow[] | undefined }>();

/**
 * 代码关系表里的字段归属；没有表或读不了就返回 undefined（调用方照常放行）。
 * 表有几 MB，每次探针都要问一句，所以按修改时间缓存：表重建了才重读。
 */
export function loadFieldRows(ctx: KernelContext): FieldOwnershipRow[] | undefined {
	const path = ctx.layout.impactIndex;
	const mtime = ctx.ports.fs.mtimeMs(path);
	if (mtime === null) return undefined;
	const hit = cache.get(ctx.ports.fs);
	if (hit !== undefined && hit.path === path && hit.mtime === mtime) return hit.rows;
	let rows: FieldOwnershipRow[] | undefined;
	try {
		const parsed = JSON.parse(ctx.ports.fs.read(path)) as { fields?: FieldOwnershipRow[] };
		rows = Array.isArray(parsed.fields) && parsed.fields.length > 0 ? parsed.fields : undefined;
	} catch {
		rows = undefined;
	}
	cache.set(ctx.ports.fs, { path, mtime, rows });
	return rows;
}

/** 探针入参里填实体的那些：META_ENTITY、QUERY_ENTITY、DATA_ENTITY…… */
const ENTITY_INPUT = /_ENTITY$/;

export function entryAsEntityBlockers(
	rows: readonly FieldOwnershipRow[],
	overlay: Readonly<Record<string, string>>,
): PrepareBlocker[] {
	const entities = new Set(rows.map((row) => row.entity));
	const blockers: PrepareBlocker[] = [];
	for (const [input, raw] of Object.entries(overlay)) {
		if (!ENTITY_INPUT.test(input)) continue;
		const value = raw.trim();
		if (value === "" || entities.has(value)) continue;
		const owners = rows.filter((row) => row.kind === "container" && row.key === value);
		if (owners.length === 0) continue;
		const where = owners.map((row) => describe(row)).join("；");
		const first = owners[0] as FieldOwnershipRow;
		const path = containerPath(first);
		blockers.push({
			code: "PROBE_ENTITY_IS_ENTRY",
			message: `${input}=${value} 不是实体，是${where}`,
			remedy:
				`${input} 填 ${first.entity}；这条分录上的字段写成 ${path}.字段` +
				`（例：查数据 QUERY_ENTITY=${first.entity}，QUERY_FIELDS=billno,${path}.<字段>）。` +
				"分录上有哪些字段不确定的话，用 MetaProbe META_ENTITY=" +
				`${first.entity} META_FILTER=${value} 看一眼。这是按本地代码关系表核的，没有进 Java 进程。`,
		});
	}
	return blockers;
}

function describe(row: FieldOwnershipRow): string {
	return row.level === "subentry" && row.parentEntry
		? ` ${row.entity} 分录 ${row.parentEntry} 下的子分录`
		: ` ${row.entity} 上的分录`;
}

/** 子分录要连着父分录写：entry.subentry.字段。 */
function containerPath(row: FieldOwnershipRow): string {
	return row.level === "subentry" && row.parentEntry ? `${row.parentEntry}.${row.key}` : row.key;
}
