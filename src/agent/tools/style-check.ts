/**
 * 写法检查接到会话上（S51）：写完就查、编译前兜底、交付时列给人看。
 *
 * 算法在 `kernel/style/plugin-style.ts`；这里管四件事：
 *   1. 本次会话第一次改某个工程 `.java` 之前记下它的原样（写入、修改的调用发出去之前读盘），之后都跟它比——
 *      老代码里本来就有的问题不报，模型这次新加的才报；
 *   2. 写完就查：每次写入、修改之后算一遍，上一次没报过的才附在结果后面（同一处问题不反复念）；
 *   3. 编译前兜底：本次会话改过的文件里，三类该拦、没写豁免的还在，就不让编；
 *   4. 交付时列：要人判断的（类和方法超线、循环查缓存、跨类间接查库、常量类不同的字符串、新建插件类、用过的豁免）。
 *
 * 工程事实（常量索引、代码关系表）缓存一小会儿；算不出来就什么都不附、也不拦——检查是加的，不能因为它让写文件或编译失败。
 */

import { nodeFs } from "../../kernel/ports.ts";
import {
	blockingHits,
	classLengthNote,
	classNameOf,
	METHOD_LINE_LIMIT,
	type StyleDelta,
	type StyleHit,
	styleDelta,
} from "../../kernel/style/plugin-style.ts";
import { billConstClasses, loadStyleProject, type StyleProject, styleEnvFor } from "../../kernel/style/style-env.ts";
import { sourceRootsOf } from "../../knowledge/class-surroundings.ts";
import { pluginBaseOf } from "../../knowledge/plugin-base.ts";

const PROJECT_TTL_MS = 60_000;

export interface StyleLedger {
	/** 比较用的文件名 → 本次会话第一次改之前的原文；`null` 是本次新建的。 */
	originals: Map<string, string | null>;
	/** 比较用的文件名 → 磁盘上的文件。 */
	files: Map<string, string>;
	/** 比较用的文件名 → 上一次写完就查时报过的问题（key）。 */
	reported: Map<string, Set<string>>;
}

export function createStyleLedger(): StyleLedger {
	return { originals: new Map(), files: new Map(), reported: new Map() };
}

let cached: { root: string; at: number; project: StyleProject } | null = null;

const posix = (path: string): string => path.replace(/\\/g, "/").replace(/\/$/, "");

function projectFor(root: string, now: number): StyleProject {
	const base = posix(root);
	if (cached !== null && cached.root === base && now - cached.at < PROJECT_TTL_MS) return cached.project;
	const project = loadStyleProject(nodeFs, sourceRootsOf(base, nodeFs), `${base}/.cosmic-ai/work/impact.json`);
	cached = { root: base, at: now, project };
	return project;
}

/** 代码关系表里这个类挂在哪些单据上；没有关系表或没登记是空数组。 */
export function registeredEntities(root: string, fqcn: string): string[] {
	try {
		return [...new Set((projectFor(root, Date.now()).bindings.get(fqcn) ?? []).map((b) => b.entity))];
	} catch {
		return [];
	}
}

/** 测试和改了大批文件之后用：下次重建。 */
export function forgetStyleProject(): void {
	cached = null;
}

/** 写入、修改发出去之前：这个文件本次会话第一次被改，记下原样。 */
export function rememberOriginal(ledger: StyleLedger, key: string, file: string): void {
	if (ledger.originals.has(key)) return;
	ledger.files.set(key, file);
	ledger.originals.set(key, nodeFs.exists(file) ? nodeFs.read(file).replace(/\r\n/g, "\n") : null);
}

function deltaOf(ledger: StyleLedger, root: string, key: string, now: number): StyleDelta | null {
	const file = ledger.files.get(key);
	if (file === undefined || !ledger.originals.has(key) || !nodeFs.exists(file)) return null;
	try {
		const project = projectFor(root, now);
		return styleDelta(ledger.originals.get(key) ?? null, nodeFs.read(file), styleEnvFor(project, file));
	} catch {
		return null;
	}
}

/** 插件基类 → 代码关系表里的插件类型；校验器挂在操作上，拿操作插件比。 */
const TYPE_OF_BASE: Record<string, string> = {
	AbstractOperationServicePlugIn: "op",
	AbstractValidator: "op",
	AbstractPrintPlugin: "print",
	IWorkflowPlugin: "workflow",
	ApiSavePlugin: "api",
	ApiSerializerPlugin: "api",
	ApiDeserializerPlugin: "api",
	AbstractTreeListPlugin: "list",
	AbstractListPlugin: "list",
	AbstractReportListDataPlugin: "report",
	AbstractReportFormPlugin: "report",
	AbstractConvertPlugIn: "convert",
	AbstractTask: "task",
	AbstractBillPlugIn: "form",
	AbstractFormPlugin: "form",
};
const TYPE_LABEL: Record<string, string> = {
	op: "操作插件",
	print: "打印插件",
	workflow: "工作流插件",
	api: "开放接口插件",
	list: "列表插件",
	report: "报表插件",
	convert: "转换插件",
	task: "调度任务",
	form: "表单插件",
};

/** 新建的插件类：认出插件族，和这张单已经挂的同类插件。不是插件类返回 null。 */
function newPluginFacts(root: string, file: string, now: number): string | null {
	const text = nodeFs.read(file);
	const hit = pluginBaseOf(text, { file, source: nodeFs });
	if (hit === null || hit.tier === "loose") return null;
	const name = classNameOf(file);
	const type = TYPE_OF_BASE[hit.route.base];
	let siblings = "";
	try {
		const project = projectFor(root, now);
		const bills = [
			...new Set(billConstClasses(project, "", text).flatMap((c) => (c.entity === null ? [] : [c.entity]))),
		];
		if (type !== undefined) {
			for (const bill of bills) {
				const list = (project.pluginsOn.get(`${bill}|${type}`) ?? []).filter((cls) => cls !== name);
				if (list.length === 0) continue;
				siblings += `；${bill} 已经挂了 ${String(list.length)} 个${TYPE_LABEL[type] ?? "同类插件"}：${list.slice(0, 8).join("、")}${list.length > 8 ? " 等" : ""}`;
			}
		}
	} catch {
		// 工程事实算不出来，只说新建了什么
	}
	return `新建插件类 ${name}（${hit.route.base}）${siblings}`;
}

const hitLine = (hit: StyleHit): string =>
	`第 ${String(hit.line)} 行 ${hit.text}${hit.exempt === null ? "" : `（已豁免：${hit.exempt}）`}`;

export interface StyleWriteRequest {
	ledger: StyleLedger;
	root: string;
	key: string;
	now?: number;
}

/** 写完就查：这次写入、修改之后要附的那段；没有新问题返回 null。 */
export function styleAfterWrite(request: StyleWriteRequest): string | null {
	const now = request.now ?? Date.now();
	const delta = deltaOf(request.ledger, request.root, request.key, now);
	if (delta === null) return null;
	const previous = request.ledger.reported.get(request.key) ?? new Set<string>();
	const current = new Set<string>();
	const fresh: string[] = [];
	for (const hit of delta.added) {
		const id = `${hit.key}|${hit.exempt === null ? "" : "allowed"}`;
		current.add(id);
		if (!previous.has(id) && hit.exempt === null) fresh.push(hitLine(hit));
	}
	for (const method of delta.newLongMethods) {
		const id = `long|${method.label}`;
		current.add(id);
		if (!previous.has(id))
			fresh.push(
				`方法 ${method.label} ${String(method.lines)} 行（超过 ${String(METHOD_LINE_LIMIT)} 行）——拆成几个小方法`,
			);
	}
	const length = classLengthNote(delta);
	if (length !== null) {
		current.add("class-length");
		if (!previous.has("class-length")) fresh.push(`这个类${length}`);
	}
	request.ledger.reported.set(request.key, current);
	if (fresh.length === 0) return null;
	const blocking = blockingHits(delta).length;
	const file = request.ledger.files.get(request.key) ?? request.key;
	return [
		`${classNameOf(file)} 这次新加的写法问题（和本次会话改之前比；老代码里原有的不算）：`,
		...fresh.map((line) => `  - ${line}`),
		blocking > 0
			? `其中循环里直接查库、已在用常量类还写字符串、重复声明常量这 ${String(blocking)} 处不改编译不过；确实合不了批的，在那一行上面写 \`// cosmic-allow: 理由\`，理由会列在 cosmic_facts 的写法提醒里。`
			: "这些不拦编译，cosmic_facts 的写法提醒里会列出来。",
	].join("\n");
}

export interface StyleBlocked {
	file: string;
	lines: string[];
}

/** 编译前兜底：本次会话改过的文件里还没改掉的三类问题。 */
export function styleBlockers(
	ledger: StyleLedger,
	root: string,
	files: readonly string[],
	now = Date.now(),
): StyleBlocked[] {
	const keys = new Map<string, string>();
	for (const [key, file] of ledger.files) keys.set(posix(file).toLowerCase(), key);
	const out: StyleBlocked[] = [];
	for (const file of files) {
		const key = keys.get(posix(file).toLowerCase());
		if (key === undefined) continue;
		const delta = deltaOf(ledger, root, key, now);
		if (delta === null) continue;
		const hits = blockingHits(delta);
		if (hits.length > 0) out.push({ file: posix(file), lines: hits.map(hitLine) });
	}
	return out;
}

/** 本会话改过的 Java 里新加的写法问题，给人看的，一条一行；没有就空。 */
export function styleDeliveryLines(ledger: StyleLedger, root: string, now = Date.now()): string[] {
	const out: string[] = [];
	for (const [key, file] of ledger.files) {
		const delta = deltaOf(ledger, root, key, now);
		if (delta === null) continue;
		const name = classNameOf(file);
		if (delta.created) {
			const facts = newPluginFacts(root, file, now);
			if (facts !== null) out.push(facts);
		}
		const length = classLengthNote(delta);
		if (length !== null) out.push(`${name}：${length}`);
		for (const method of delta.newLongMethods)
			out.push(`${name}：方法 ${method.label} ${String(method.lines)} 行（超过 ${String(METHOD_LINE_LIMIT)} 行）`);
		for (const hit of delta.added) {
			if (hit.exempt !== null) out.push(`${name} ${hitLine(hit)}`);
			else if (hit.kind !== "db-loop" && hit.kind !== "literal-dup-used" && hit.kind !== "own-const-dup")
				out.push(`${name} ${hitLine(hit)}`);
		}
	}
	return out;
}

/**
 * 类周边里那一句「这张单的常量类」：按插件挂的单据（代码关系表），没挂载记录就按源码里写到的单据标识，
 * 找 `ENTITY` 常量的值是这张单的常量类。找不到返回 null。
 */
export function billConstLine(root: string, file: string, now = Date.now()): string | null {
	try {
		const text = nodeFs.read(file);
		const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(text)?.[1];
		const fqcn = pkg === undefined ? classNameOf(file) : `${pkg}.${classNameOf(file)}`;
		const project = projectFor(root, now);
		const homes = billConstClasses(project, fqcn, text).filter((c) => c.cls !== classNameOf(file));
		if (homes.length === 0) return null;
		const base = `${posix(root)}/`;
		const named = homes
			.slice(0, 3)
			.map((c) => `${c.cls}（${c.entity}，${String(c.codes)} 个标识，${posix(c.file).replace(base, "")}）`);
		return `这张单的常量类：${named.join("；")}。单据和字段标识从这里取，没有的加进去。`;
	} catch {
		return null;
	}
}
