/**
 * 探针和 `meta` 命令往本机写的目录、文件，位置由工具定，不由调用方定。
 *
 * 以前这些入参（备份目录、导出目录、候选目录）要模型自己给，工具只举个「例如」：每个会话各起各的名字，
 * 真机工程里改前备份散在 `backup/`、`backups/`、`s42-layout-backup/`、`work/` 下十几处；不给时探针
 * 默认写到工程根下的 `outputs/`，又多一处。备份混进 `work/`（按约定删了能重建）之后，清 `work/` 就会把
 * 回滚用的原文一起删掉。
 *
 * 现在只有两个去处：
 *   - **备份**（写元数据前的改前原文、导出的备份）→ `evidence/backups/<时间>-<名字>/`，一直留。
 *     每次一个新目录，不会盖掉以前的备份。给了目录的只取最后一段当名字。
 *   - **导出**（打印模板 dump 和候选、工作流 dump、打印测量的 pdf 和图）→ 本会话目录 `exports/<名字>`，
 *     跟会话一起清。同一会话里同名的就是同一份（先 dump 再拿它开候选）。
 *
 * 已经在对应位置里的路径原样用（模型照返回里给的路径再调一次）。
 */

import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { KernelLayout } from "../layout.ts";
import type { FsPort } from "../ports.ts";

type Role = "backup" | "export";

interface OutputRule {
	key: string;
	role: Role;
	/** 这次运行要不要给它定位置（不给值时探针会用自己的默认位置的，也要定）。 */
	when(env: Readonly<Record<string, string>>): boolean;
	/** 没给名字时用的名字。 */
	label(env: Readonly<Record<string, string>>): string;
	/** 值是一个文件（或文件名前缀）而不是目录。 */
	file?: boolean;
}

const v = (env: Readonly<Record<string, string>>, key: string): string => (env[key] ?? "").trim();
const given = (key: string) => (env: Readonly<Record<string, string>>) => v(env, key) !== "";
const applying = (env: Readonly<Record<string, string>>) => v(env, "APPLY") === "1";

/** 每个探针哪几个入参是本机输出位置。 */
const OUTPUT_RULES: Readonly<Record<string, readonly OutputRule[]>> = {
	PrintTplWriteProbe: [
		{ key: "TPL_BACKUP", role: "backup", when: applying, label: (e) => `ptpl-${v(e, "TPL_NUMBER")}` },
	],
	BotpRuleSyncProbe: [
		{
			key: "SYNC_BACKUP",
			role: "backup",
			when: (e) => applying(e) || v(e, "SYNC_BACKUP_ONLY") === "1",
			label: () => "botp",
		},
	],
	FormLayoutWriteProbe: [
		{ key: "LAYOUT_BACKUP", role: "backup", when: applying, label: (e) => `layout-${v(e, "LAYOUT_FORM")}` },
	],
	PrintTplBackupProbe: [
		{ key: "BACKUP_DIR", role: "backup", when: () => true, label: (e) => `ptpl-${v(e, "TPL_NUMBER")}` },
	],
	PrintTplJsonProbe: [
		{ key: "OUT_DIR", role: "export", when: () => true, label: (e) => `ptpl-${v(e, "TPL_NUMBER")}` },
	],
	WfModelProbe: [
		{
			key: "WF_OUT",
			role: "export",
			when: (e) => v(e, "WF_ACTION") === "dump",
			label: (e) => `wf-${v(e, "WF_MODEL")}`,
		},
		{ key: "WF_OUT", role: "backup", when: (e) => v(e, "WF_ACTION") === "backup", label: () => "wf" },
	],
	PrintMeasureProbe: [
		{ key: "PDF_OUT", role: "export", when: given("PDF_OUT"), label: () => "measure.pdf", file: true },
		{ key: "PNG_OUT", role: "export", when: given("PNG_OUT"), label: () => "measure", file: true },
	],
	FormRuleProbe: [{ key: "OUT", role: "export", when: given("OUT"), label: () => "form-rules" }],
};

export interface PlacedOutput {
	key: string;
	role: Role;
	/** 调用方给的值；没给是 null。 */
	given: string | null;
	/** 实际用的绝对路径。 */
	path: string;
}

/** 名字只留一段，去掉会让路径出岔子的字符。 */
function nameOf(value: string, fallback: string): string {
	const last = basename(value.replace(/[\\/]+$/, ""));
	const safe = last.replace(/[^\w.\-一-鿿]/g, "_").replace(/^\.+/, "");
	const fallbackSafe = fallback.replace(/[^\w.\-一-鿿]/g, "_").replace(/-+$/, "");
	return safe === "" ? fallbackSafe || "out" : safe;
}

function within(dir: string, path: string): boolean {
	const rel = relative(resolve(dir), resolve(path));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** `20261123-140501`：本机时间，排序就是时间顺序。 */
export function stampOf(now: number): string {
	const d = new Date(now);
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 一个输出位置：已经在对应目录里就原样用，否则放进去。 */
export function placeOutput(
	layout: KernelLayout,
	role: Role,
	value: string | null,
	fallback: string,
	now: number,
): string {
	const base = role === "backup" ? layout.backupsDir : layout.exportsDir;
	const raw = (value ?? "").trim();
	if (raw !== "") {
		const absolute = isAbsolute(raw) ? resolve(raw) : resolve(layout.root, raw);
		if (within(base, absolute)) return absolute;
	}
	const name = nameOf(raw, fallback);
	return join(base, role === "backup" ? `${stampOf(now)}-${name}` : name);
}

/** 给一次探针运行的入参定好输出位置。返回改过的入参和定了哪些。 */
export function placeProbeOutputs(
	layout: KernelLayout,
	cls: string,
	adHoc: boolean,
	env: Readonly<Record<string, string>>,
	now: number,
): { env: Record<string, string>; placed: PlacedOutput[] } {
	const next: Record<string, string> = { ...env };
	const placed: PlacedOutput[] = [];
	if (adHoc) return { env: next, placed };
	for (const rule of OUTPUT_RULES[cls] ?? []) {
		if (!rule.when(env)) continue;
		const value = v(env, rule.key);
		const path = placeOutput(layout, rule.role, value === "" ? null : value, rule.label(env), now);
		next[rule.key] = path;
		placed.push({ key: rule.key, role: rule.role, given: value === "" ? null : value, path });
	}
	return { env: next, placed };
}

/** 给模型看的一行：每个定了位置的入参落在哪（相对工程根）。 */
export function placedNote(layout: KernelLayout, placed: readonly PlacedOutput[]): string | null {
	if (placed.length === 0) return null;
	const shown = placed.map((one) => {
		const rel = relative(layout.root, one.path).replace(/\\/g, "/");
		const was =
			one.given !== null && resolve(layout.root, one.given) !== one.path ? `（给的 ${one.given} 没用）` : "";
		return `${one.key} → ${rel}${was}`;
	});
	return `本机输出位置由工具定：${shown.join("；")}。备份在 evidence/backups/ 下一直留，导出在本会话目录里跟会话一起清。`;
}

/**
 * 一个要读的目录（diff 的两边、开候选用的 dump）：照给的找，找不到再按名字到本会话导出、备份里找
 * （备份取最新的那份）。都找不到原样返回，让调用方照常报「不存在」。
 */
export function resolveInputDir(layout: KernelLayout, fs: FsPort, value: string): string {
	const absolute = isAbsolute(value) ? resolve(value) : resolve(layout.root, value);
	if (fs.exists(absolute)) return absolute;
	const name = nameOf(value, "");
	const exported = join(layout.exportsDir, name);
	if (fs.exists(exported)) return exported;
	if (fs.exists(layout.backupsDir)) {
		const hits = fs
			.readDir(layout.backupsDir)
			.filter((entry) => entry.isDirectory && entry.name.replace(/^\d{8}-\d{6}-/, "") === name)
			.map((entry) => entry.name)
			.sort();
		const newest = hits.at(-1);
		if (newest !== undefined) return join(layout.backupsDir, newest);
	}
	return absolute;
}
