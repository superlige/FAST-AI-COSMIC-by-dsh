/**
 * meta -- non-entity metadata: BOTP rules, print templates, workflow models (S5.4).
 *
 * Three families, one command, and almost no logic of its own: every action
 * except `diff` resolves to a released probe plus an env overlay, and then goes
 * through `probe()`. That delegation is the design, not a shortcut. `probe` is
 * where the stale-class gate, the cold-process rule for writes, the project
 * write lock and the confirmed-target admission live; a `meta` that started its
 * own JVM would be a second road to the shared environment with none of them on
 * it, and the model would find that road the first time a write was refused.
 *
 * What this file adds on top of the frozen `meta`:
 *
 *   - `apply` is a typed boolean instead of an `APPLY=1` environment prefix. The
 *     frozen CLI relied on the shell to set it and on `probe` to read
 *     process.env; neither exists here (D9). The flag composes into the same
 *     overlay key, so the probes and IsvGuard see exactly what they saw before.
 *   - dry-run is stated as a field on the result rather than a printed line. A
 *     caller reading results and not stdout would otherwise never learn that
 *     the write it asked for did not happen.
 *   - `diff` reports the comparison as data. The frozen version printed and
 *     returned nothing, so "are these two exports the same" had to be answered
 *     by reading prose.
 *
 * One frozen behaviour is deliberately kept even though it looks loose: output
 * directories (`--out`, backup dirs, `--pdf` / `--png`) are passed to the probe
 * as given and resolved against the project root by the JVM's cwd, with no
 * containment check. Adding one would be a semantic change made in passing
 * during a migration, and D1 already draws the boundary elsewhere -- the agent's
 * ambient file tools are not restricted, so a containment check here would buy
 * no property while breaking the documented `--out D:\somewhere` invocations.
 * Registered in docs/command-parity.md §9.
 */

import { resolve } from "node:path";
import type { KernelContext } from "../context.ts";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import { layoutJson } from "../json-layout.ts";
import {
	type DesignChange,
	diffDesign,
	diffLines,
	formatDesignDiff,
	formatTextDiff,
	type Hunk,
	pairNames,
} from "../meta/diff.ts";
import { loadFieldRows } from "../meta/entity-role.ts";
import { META_FAMILIES, META_HELP, type MetaPlan, parseMeta } from "../meta/parse.ts";
import { isDesign, parseDesignText, stringifyDesign, type TplDesign, type TplLocale } from "../meta/ptpl-design.ts";
import { applyEdit, type EditContext, type FieldOwnershipRow, overview, summarizeChanges } from "../meta/ptpl-edit.ts";
import { placeOutput, resolveInputDir } from "../project/output-paths.ts";
import { probeDidNotRun } from "./impact.ts";
import { type ProbeOutcome, type ProbeProgressStage, probe } from "./probe.ts";

export interface MetaDiffFile {
	name: string;
	/** Differences found in this file. */
	changes: number;
	/** True when a JSON design file could not be parsed and text comparison was used instead. */
	fellBackToText: boolean;
	lines: string[];
}

export interface MetaDiffReport {
	dirA: string;
	dirB: string;
	mode: "text" | "design";
	both: string[];
	onlyA: string[];
	onlyB: string[];
	files: MetaDiffFile[];
	/** Total differences across every paired file. */
	changes: number;
	text: string;
}

export interface MetaReport {
	kind: "help" | "probe" | "diff" | "edit";
	family: string | null;
	action: string | null;
	/** Set for `kind: "probe"`. */
	probe?: ProbeOutcome;
	/** True when this action can write and `apply` was not set -- the probe only simulated. */
	dryRun: boolean;
	/** True when this action has a write channel at all. */
	writes: boolean;
	diff?: MetaDiffReport;
	edit?: MetaEditReport;
	text: string;
	notes: string[];
}

export interface MetaOptions {
	/**
	 * Turns a write channel's dry run into a real one. Composes into APPLY=1, so
	 * it inherits everything that flag already triggers in `probe`: the cold
	 * path, the project write lock and the confirmed-target admission.
	 */
	apply?: boolean;
	/** Force the cold path for a read action. Writes are cold regardless. */
	cold?: boolean;
	/** Return the probe's complete output instead of the `[PROBE…]` channel. */
	raw?: boolean;
	/** S6 interactive authorization: the only admission path for an apply (S14.3.1). */
	writeAuthorization?: {
		targets: readonly string[];
		rollback: string;
		confirmationId: string;
		/** 打印模板整份提交（S32 1.5）：用户确认过的改前快照，作为 -Dcosmic.baseline 交给探针核对。 */
		baseline?: string;
	};
	/**
	 * 交互界面用的进度回调（S31 5.1）；命令行不传，行为与不传时完全一致。
	 *
	 * 直接递给底下那个 `probe`：查元数据的每个动作都是跑一个探针，冷进程那一趟要 30-60 秒，
	 * 自己另编一套阶段名就会和探针报的那套对不上。
	 */
	onProgress?: (stage: ProbeProgressStage) => void;
	/** 直接递给底下那个 `probe`，含义同 `ProbeOptions.countRepeats`；写流程的预演关掉它。 */
	countRepeats?: boolean;
}

function argsInvalid(message: string, remedy: string): KernelError {
	return new KernelError("META_ARGS_INVALID", message, { remedy });
}

/** 一边要比的目录：照给的找，找不到再按名字到本会话导出、备份里找（见 output-paths.ts）。 */
function diffDir(ctx: KernelContext, given: string): KernelResult<string> {
	const dir = resolveInputDir(ctx.layout, ctx.ports.fs, given);
	if (!ctx.ports.fs.exists(dir)) {
		return err(argsInvalid(`目录不存在：${dir}`, "diff 比的是两次 backup / dump 的产物目录，先跑一次导出再比。"));
	}
	return ok(dir);
}

function runDiff(ctx: KernelContext, plan: Extract<MetaPlan, { kind: "diff" }>): KernelResult<MetaDiffReport> {
	const a = diffDir(ctx, plan.a);
	if (!a.ok) return err(a.error);
	const b = diffDir(ctx, plan.b);
	if (!b.ok) return err(b.error);

	const filesIn = (dir: string): string[] =>
		ctx.ports.fs
			.readDir(dir)
			.filter((entry) => !entry.isDirectory)
			.map((entry) => entry.name);
	const { both, onlyA, onlyB } = pairNames(filesIn(a.value), filesIn(b.value));

	const out: string[] = [`[meta] A=${a.value}`, `[meta] B=${b.value}`];
	if (onlyA.length > 0) out.push(`[meta] 只在 A: ${onlyA.join(", ")}`);
	if (onlyB.length > 0) out.push(`[meta] 只在 B: ${onlyB.join(", ")}`);
	if (both.length === 0) {
		out.push("[meta] 两边没有同名文件，无从比较");
		return ok({
			dirA: a.value,
			dirB: b.value,
			mode: plan.mode,
			both,
			onlyA,
			onlyB,
			files: [],
			changes: 0,
			text: out.join("\n"),
		});
	}

	const files: MetaDiffFile[] = [];
	let total = 0;
	for (const name of both) {
		const ta = ctx.ports.fs.read(resolve(a.value, name));
		const tb = ctx.ports.fs.read(resolve(b.value, name));
		let lines: string[] | null = null;
		let changes = 0;
		let fellBack = false;
		if (plan.mode === "design" && name.endsWith(".json")) {
			let ja: unknown;
			let jb: unknown;
			try {
				ja = JSON.parse(ta);
				jb = JSON.parse(tb);
			} catch (error) {
				fellBack = true;
				const hunks: Hunk[] = diffLines(ta, tb);
				changes = hunks.length;
				lines = [
					`  ${name}  不是合法 JSON（${error instanceof Error ? error.message : String(error)}），退回文本比较`,
					...formatTextDiff(name, hunks),
				];
			}
			if (lines === null) {
				const design: DesignChange[] = diffDesign(ja, jb);
				changes = design.length;
				lines = formatDesignDiff(name, design);
			}
		} else {
			const hunks: Hunk[] = diffLines(ta, tb);
			changes = hunks.length;
			lines = formatTextDiff(name, hunks);
		}
		total += changes;
		files.push({ name, changes, fellBackToText: fellBack, lines });
		out.push(...lines);
	}
	out.push(`[meta] 同名文件 ${both.length} 个，共 ${total} 处差异`);
	return ok({
		dirA: a.value,
		dirB: b.value,
		mode: plan.mode,
		both,
		onlyA,
		onlyB,
		files,
		changes: total,
		text: out.join("\n"),
	});
}

// ------------------------------------------------- 本地候选工作区（S32 批 2）

/**
 * 候选工作区就是一个目录：`ptpl dump` 的两份 JSON 原样放进来，再留一份开工那一刻的副本。
 *
 * 为什么要留副本：确认单上「改了什么」必须是**程序比出来的**（S32 §4.4）。
 * 拿库里那份当基准要再跑一次 Java，拿模型自己的说法当基准等于没比。
 */
interface CandidateMeta {
	kind: "PrintTplCandidate";
	/** 模板编码，取自设计数据里的 `key`。 */
	number: string;
	formId: string;
	metaFile: string;
	localeFile: string;
	from: string;
	openedAt: string;
	log: { at: string; said: string }[];
}

export interface MetaEditReport {
	dir: string;
	op: string;
	number: string;
	/** 这次操作改了什么，一句人话。 */
	said: string[];
	/** 候选和开工那一刻比，总共改了什么。 */
	summary: string;
	changed: number;
	text: string;
}

const CANDIDATE_FILE = "candidate.json";

function readJson(ctx: KernelContext, path: string): KernelResult<Record<string, unknown>> {
	const raw = ctx.ports.fs.read(path);
	if (raw === "") {
		return err(argsInvalid(`读不到或者是空文件：${path}`, "候选目录靠 ptpl edit <目录> --open <dump目录> 开。"));
	}
	try {
		//数字要按原样读：JSON.parse 会把 16.0 读成 16，写回去就成了另一种类型（见 parseDesignText）
		const parsed = parseDesignText(raw);
		if (parsed === null || typeof parsed !== "object") throw new Error("不是一个对象");
		return ok(parsed as Record<string, unknown>);
	} catch (error) {
		return err(
			argsInvalid(
				`${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
				"别手改这个文件，重新 --open 一份。",
			),
		);
	}
}

function openCandidate(ctx: KernelContext, dir: string, from: string): KernelResult<MetaEditReport> {
	const fs = ctx.ports.fs;
	const source = resolveInputDir(ctx.layout, fs, from);
	if (!fs.exists(source)) {
		return err(
			argsInvalid(`dump 目录不存在：${source}`, "先跑 meta ptpl dump <模板编码> --out <名字>，再拿那个名字开候选。"),
		);
	}
	const names = fs
		.readDir(source)
		.filter((entry) => !entry.isDirectory)
		.map((entry) => entry.name);
	const metaNames = names.filter((name) => name.endsWith(".meta.json"));
	if (metaNames.length !== 1) {
		return err(
			argsInvalid(
				metaNames.length === 0
					? `${source} 里没有 *.meta.json`
					: `${source} 里有 ${metaNames.length} 份 *.meta.json，说不清开哪一张`,
				"一个 dump 目录放一张模板：meta ptpl dump <模板编码> --out <目录>。",
			),
		);
	}
	const metaName = metaNames[0] as string;
	const localeName = metaName.replace(/\.meta\.json$/, ".locale.json");
	const parsed = readJson(ctx, resolve(source, metaName));
	if (!parsed.ok) return err(parsed.error);
	if (!isDesign(parsed.value)) {
		return err(
			argsInvalid(`${metaName} 里没有 pages，这不像一份模板设计数据`, "这个文件要是 ptpl dump 落下来的那一份。"),
		);
	}
	const design = parsed.value;
	const localePath = resolve(source, localeName);
	const localeRaw = fs.exists(localePath) ? fs.read(localePath) : "{}";

	const candidatePath = resolve(dir, CANDIDATE_FILE);
	if (fs.exists(candidatePath)) {
		const before = readJson(ctx, candidatePath);
		const number = before.ok ? String(before.value.number ?? "") : "";
		return err(
			argsInvalid(
				`${dir} 里已经有一份候选${number === "" ? "" : `（模板 ${number}）`}`,
				"改完了就 meta ptpl apply <编码> --file <候选目录>/<编码>.meta.json；不要了就 --reset，或者换个目录开。",
			),
		);
	}

	const meta: CandidateMeta = {
		kind: "PrintTplCandidate",
		number: String(design.key ?? ""),
		formId: String(design.formId ?? ""),
		metaFile: metaName,
		localeFile: localeName,
		from: source,
		openedAt: new Date().toISOString(),
		log: [],
	};
	//以前的 dump 是一整行；开候选时一并分行，候选和 origin 副本从第一步起就是同一种排法
	const designText = layoutJson(fs.read(resolve(source, metaName)));
	const localeText = layoutJson(localeRaw);
	fs.write(resolve(dir, metaName), designText);
	fs.write(resolve(dir, localeName), localeText);
	fs.write(resolve(dir, "origin", metaName), designText);
	fs.write(resolve(dir, "origin", localeName), localeText);
	fs.write(candidatePath, JSON.stringify(meta, null, 2));

	const lines = [
		`候选已开：${dir}`,
		`模板 ${meta.number}（${String(design.name ?? "")}）挂 ${meta.formId}`,
		...overview(design),
		`改完整份交回：meta ptpl apply ${meta.number} --file ${resolve(dir, metaName)} --locale ${resolve(dir, localeName)} --backup <目录>`,
	];
	return ok({
		dir,
		op: "open",
		number: meta.number,
		said: [],
		summary: "没有差异",
		changed: 0,
		text: lines.map((line) => `[meta] ${line}`).join("\n"),
	});
}

function loadCandidate(
	ctx: KernelContext,
	dir: string,
): KernelResult<{ meta: CandidateMeta; design: TplDesign; locale: TplLocale }> {
	const path = resolve(dir, CANDIDATE_FILE);
	if (!ctx.ports.fs.exists(path)) {
		return err(argsInvalid(`${dir} 里没有候选`, "先开一份：meta ptpl edit <目录> --open <dump目录>。"));
	}
	const raw = readJson(ctx, path);
	if (!raw.ok) return err(raw.error);
	const meta = raw.value as unknown as CandidateMeta;
	const parsed = readJson(ctx, resolve(dir, meta.metaFile));
	if (!parsed.ok) return err(parsed.error);
	if (!isDesign(parsed.value)) return err(argsInvalid(`${meta.metaFile} 里没有 pages`, "重新 --open 一份。"));
	const localePath = resolve(dir, meta.localeFile);
	const locale = ctx.ports.fs.exists(localePath) ? readJson(ctx, localePath) : ok({});
	if (!locale.ok) return err(locale.error);
	return ok({ meta, design: parsed.value, locale: locale.value as TplLocale });
}

/**
 * 一次本地编辑。
 *
 * 每一步都落到候选文件上，并把这句「改了什么」记进候选自己的流水——
 * 模型隔几轮回来还能看见前面做过什么，不必再去读那份 250 KB 的 JSON（S32 §4.2）。
 */
async function runEdit(
	ctx: KernelContext,
	plan: Extract<MetaPlan, { kind: "edit" }>,
): Promise<KernelResult<MetaEditReport>> {
	const fs = ctx.ports.fs;
	// 候选是本会话的导出：只认名字，放进本会话目录；照返回里的完整路径再调也认
	const dir = placeOutput(ctx.layout, "export", plan.dir, "ptpl-candidate", ctx.ports.clock.now());
	if (plan.op.op === "open") return openCandidate(ctx, dir, plan.op.from);

	const loaded = loadCandidate(ctx, dir);
	if (!loaded.ok) return err(loaded.error);
	const { meta, design, locale } = loaded.value;
	const originPath = resolve(dir, "origin", meta.metaFile);
	const origin = readJson(ctx, originPath);
	if (!origin.ok) return err(origin.error);
	const originDesign = origin.value as TplDesign;
	const handback = `改完整份交回：meta ptpl apply ${meta.number} --file ${resolve(dir, meta.metaFile)} --locale ${resolve(dir, meta.localeFile)}`;

	if (plan.op.op === "reset") {
		fs.write(resolve(dir, meta.metaFile), fs.read(originPath));
		fs.write(resolve(dir, meta.localeFile), fs.read(resolve(dir, "origin", meta.localeFile)));
		fs.write(resolve(dir, CANDIDATE_FILE), JSON.stringify({ ...meta, log: [] }, null, 2));
		return ok({
			dir,
			op: "reset",
			number: meta.number,
			said: ["候选退回开工那一刻，之前的改动全丢了"],
			summary: "没有差异",
			changed: 0,
			text: `[meta] 候选已重置：${dir}（模板 ${meta.number}）`,
		});
	}

	if (plan.op.op === "overview" || plan.op.op === "status") {
		const changes = summarizeChanges(originDesign, design);
		const lines =
			plan.op.op === "overview"
				? [
						...overview(design, plan.op.grid === undefined ? {} : { grid: plan.op.grid }),
						`这次改动：${changes.oneLine}`,
					]
				: [
						`候选：${dir}（模板 ${meta.number}，开于 ${meta.openedAt}）`,
						`这次改动：${changes.oneLine}`,
						...changes.added.map((one) => `  新增 ${one}`),
						...changes.removed.map((one) => `  删除 ${one}`),
						...changes.formula.map((one) => `  公式变化 ${one}`),
						...changes.binding.map((one) => `  绑定变化 ${one}`),
						...changes.other.map((one) => `  属性变化 ${one}`),
						...changes.root.map((one) => `  模板级变化 ${one}`),
						`做过 ${meta.log.length} 步：`,
						...meta.log.map((one, i) => `  ${i + 1}. ${one.said}`),
						handback,
					];
		return ok({
			dir,
			op: plan.op.op,
			number: meta.number,
			said: [],
			summary: changes.oneLine,
			changed: changes.total,
			text: lines.map((line) => `[meta] ${line}`).join("\n"),
		});
	}

	const rows = loadFieldRows(ctx);
	const base: EditContext = { design, locale, ...(rows === undefined ? {} : { fields: rows }) };
	// A dry run on copies first: the fields the code relation table does not carry
	// (inherited billno / creator, or ones no code names) are collected, and the
	// platform is asked once for the whole bill before the real edit.
	const unresolved = new Set<string>();
	applyEdit({ ...base, design: structuredClone(design), locale: structuredClone(locale), unresolved }, plan.op);
	const context: EditContext =
		unresolved.size === 0 ? base : { ...base, platform: await platformFields(ctx, String(design.formId ?? "")) };
	const applied = applyEdit(context, plan.op);
	if (!applied.ok) return err(applied.error);

	const changes = summarizeChanges(originDesign, design);
	const at = new Date().toISOString();
	const next: CandidateMeta = { ...meta, log: [...meta.log, ...applied.value.said.map((said) => ({ at, said }))] };
	fs.write(resolve(dir, meta.metaFile), layoutJson(stringifyDesign(design)));
	fs.write(resolve(dir, meta.localeFile), layoutJson(stringifyDesign(locale)));
	fs.write(resolve(dir, CANDIDATE_FILE), JSON.stringify(next, null, 2));

	const lines = [
		...applied.value.said,
		...applied.value.notes.map((note) => `注意：${note}`),
		`这次改动：${changes.oneLine}`,
	];
	return ok({
		dir,
		op: plan.op.op,
		number: meta.number,
		said: applied.value.said,
		summary: changes.oneLine,
		changed: changes.total,
		text: lines.map((line) => `[meta] ${line}`).join("\n"),
	});
}

/** Every field of a bill as the platform's runtime metadata has it, inherited ones included. */
async function platformFields(
	ctx: KernelContext,
	entity: string,
): Promise<{ rows: FieldOwnershipRow[] } | { error: string }> {
	if (entity === "") return { error: "模板没记单据标识（formId）" };
	const run = await probe(ctx, "MetaProbe", {
		env: { META_ENTITY: entity },
		kernelEnv: true,
		// Each bind with an unrecorded field asks again; that is this command's own
		// lookup, not the model repeating itself, and the repeat guard refused the third.
		countRepeats: false,
		invocation: "meta ptpl edit（核字段）",
	});
	if (!run.ok) return { error: `${run.error.code}：${run.error.message}` };
	const notRun = probeDidNotRun(ctx, "MetaProbe", run.value);
	if (notRun !== null) return { error: notRun };
	const rows = (run.value.json.records as Record<string, unknown>[])
		.filter((record) => record.t === "field")
		.map((record) => ({
			entity,
			key: String(record.key ?? ""),
			level: String(record.level ?? ""),
			entry: String(record.entry ?? ""),
			parentEntry: String(record.parentEntry ?? ""),
			kind: "field",
			...(typeof record.textFormat === "string" && record.textFormat !== ""
				? { textFormat: record.textFormat }
				: {}),
		}));
	return rows.length > 0 ? { rows } : { error: `MetaProbe 没报出 ${entity} 的字段` };
}

export async function meta(
	ctx: KernelContext,
	argv: readonly string[],
	options: MetaOptions = {},
): Promise<KernelResult<MetaReport>> {
	const parsed = parseMeta(argv);
	if (!parsed.ok) return err(parsed.error);
	const plan = parsed.value;

	if (plan.kind === "help") {
		return ok({
			kind: "help",
			family: null,
			action: null,
			dryRun: false,
			writes: false,
			text: plan.text,
			notes: [
				`可查询范围：${Object.entries(META_FAMILIES)
					.map(([name, f]) => `${name}=${f.title}`)
					.join("；")}`,
			],
		});
	}

	if (plan.kind === "diff") {
		const report = runDiff(ctx, plan);
		if (!report.ok) return err(report.error);
		return ok({
			kind: "diff",
			family: plan.family,
			action: "diff",
			dryRun: false,
			writes: false,
			diff: report.value,
			text: report.value.text,
			notes:
				plan.mode === "design"
					? ["设计 JSON 按控件 id 对齐比较，不是文本 diff：插一个控件不会把后面的控件全报成改过。"]
					: [],
		});
	}

	if (plan.kind === "edit") {
		if (options.apply === true) {
			//edit 只改本地候选文件。这里默默忽略 apply，就等于教会调用方「apply 是装饰」，
			//而下一次它落在真会写的动作上时，这个习惯已经养成了。
			return err(
				argsInvalid(
					"meta ptpl edit 只改本地候选文件，不落库，不接受 apply",
					"改完用 meta ptpl apply <编码> --file <候选>.meta.json 整份交回，那一条才是写通道。",
				),
			);
		}
		const report = await runEdit(ctx, plan);
		if (!report.ok) return err(report.error);
		return ok({
			kind: "edit",
			family: plan.family,
			action: plan.action,
			dryRun: false,
			writes: false,
			edit: report.value,
			text: report.value.text,
			notes: [
				"本地改候选文件，不落库：改完用 meta ptpl apply <编码> --file <候选>.meta.json 整份交回，那一步才落库。",
			],
		});
	}

	if (options.apply === true && !plan.writes) {
		// Silently ignoring it would teach that apply is decorative, and the next
		// time it is set on an action that DOES write the habit is already formed.
		return err(
			argsInvalid(
				`meta ${plan.family} ${plan.action} 没有写通道，不接受 apply`,
				`有写通道的只有 botp restore、ptpl apply 和 ptpl restore。${plan.action} 是只读动作，去掉 apply 再跑。`,
			),
		);
	}

	const dryRun = plan.writes && options.apply !== true;
	const env = { ...plan.env, ...(plan.writes && options.apply === true ? { APPLY: "1" } : {}) };
	const notes: string[] = [];
	if (dryRun) {
		notes.push(
			"dry-run：只演算不落库。要落库：同样的 argv 加 apply=true 并附 report，工具弹确认单，用户确认后才写；在常驻进程里写，写完直接用只读动作核对。",
		);
	}

	const outcome = await probe(ctx, plan.probe, {
		env,
		kernelEnv: true,
		invocation: `meta ${[plan.family, plan.action, ...argv.slice(2)].join(" ")}`,
		...(plan.family === "ptpl" && plan.action === "measure" ? { timeoutMs: 10 * 60 * 1000 } : {}),
		...(options.cold === undefined ? {} : { cold: options.cold }),
		...(options.raw === undefined ? {} : { raw: options.raw }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options.countRepeats === false ? { countRepeats: false } : {}),
		...(options.writeAuthorization === undefined ? {} : { writeAuthorization: options.writeAuthorization }),
	});
	if (!outcome.ok) return err(outcome.error);

	return ok({
		kind: "probe",
		family: plan.family,
		action: plan.action,
		probe: outcome.value,
		dryRun,
		writes: plan.writes,
		text: outcome.value.output,
		notes: [
			...notes,
			...(plan.family === "formula"
				? [`当前运行环境：${ctx.runtimeKeyId}；函数目录只证明登记与用法，目标字段和规则宿主需另核对。`]
				: []),
			...outcome.value.notes,
		],
	});
}

export { META_HELP };
