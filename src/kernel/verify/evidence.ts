/**
 * 验证记录：一次带 `--expect` 的运行留下的一份事实（S22.1.2）。
 *
 * After S22 this is the **only** thing `finish` accepts as proof that a change
 * was verified. The regression case set it replaces tried to turn one-off
 * commands into long-lived assets; this does the opposite on purpose -- a record
 * says 「在这个环境、这份代码上、这条命令、这些断言、这个结果」 and claims
 * nothing about tomorrow.
 *
 * Four facts decide whether a record still counts, and all four are recorded
 * here rather than re-derived at delivery time:
 *
 *   - `runtimeKeyId`  -- which project + Cosmic runtime + tool version.
 *   - `sourceFingerprint` -- which code. Edit anything and old records stop
 *     counting, because they verified code that no longer exists.
 *   - `gates`         -- whether the class-freshness gate was downgraded. A run
 *     made under `COSMIC_STALE` may have exercised stale classes.
 *   - `at`            -- so a record made before the last shared write can be
 *     ruled out. Writing metadata or seeding data changes the environment the
 *     assertion observed.
 *
 * **The digest is what the session state holds.** The model never reports its
 * records back and cannot name one into existence: the agent keeps each id and
 * digest, and a file whose content no longer hashes to its digest is refused.
 * That is the whole answer to 「模型用 write 工具把 FAIL 改成 PASS」 -- the
 * forged file does not match what the session remembers.
 *
 * Records are written for **every** assertion run, including failures and
 * errors. A pool that only keeps the greens cannot answer 「这个场景最后一次是
 * 不是过的」, and that question is exactly what stops a failure being bypassed
 * by running something easier (D19.1).
 */

import { sha256 } from "../../runtime/fingerprint.ts";
import type { KernelContext } from "../context.ts";
import type { ProbeJsonRecord } from "../probe/output.ts";
import { type AssertResult, type GradedAssert, grade } from "./grade.ts";

/** Nothing outside `--expect` / `--show` distinguishes two runs of the same scenario. */
const SCENARIO_NOISE = new Set(["--expect", "--show"]);

/** One assertion as the record keeps it: what was asked, what came back. */
export interface EvidenceAssert {
	kind: string | null;
	target: string | null;
	expect: unknown;
	actual: unknown;
	pass: boolean;
	why: string | null;
}

export interface AssertionEvidence {
	kind: "AssertionEvidence";
	/** `AE-<12 hex>`, derived from the content; stable for identical work. */
	id: string;
	/** sha256 of the record's own facts. The session holds this and checks it back. */
	digest: string;
	at: string;
	runtimeKeyId: string;
	sourceFingerprint: string;
	/** Which gate settings were in force -- the setting, not "it passed". */
	gates: Record<string, string>;
	/** The complete command, as typed. This is what a reader re-runs to check. */
	argv: string[];
	/**
	 * The command with `--expect` / `--show` stripped: 「是不是同一件事又跑了一遍」.
	 *
	 * Expectations are excluded deliberately. Fixing a wrong expected value and
	 * re-running is the normal way to correct a mistake, and if the expectation
	 * were part of the identity that re-run would look like a different scenario
	 * and the failure would linger forever (D19.1).
	 */
	scenarioKey: string;
	/** Batch scenario id when `--case` was used, else null. */
	scenarioId: string | null;
	/** The adapter's own one-line scenario summary, when it emitted one. */
	scenario: string | null;
	result: AssertResult;
	asserts: EvidenceAssert[];
	/** Whether this run paid a cold start or rode a resident JVM -- the reader judges. */
	path: "cold" | "hot";
	/** Pre-flight warnings the run could not refuse, e.g.「插件不在该表单的插件列表里」. */
	warnings: string[];
	/** Relative path of the raw log, so a reader can go back to the full output. */
	log: string;
	/** True when the command pins itself to one row of shared data via `--pk`. */
	usesPk: boolean;
	/**
	 * 这次运行往库里写了哪些表，按运行日志里平台打的写库语句认（见 `writtenTablesOf`）。
	 * 不写这个字段就是确认不了：日志里一条 SQL 都没有，或者是这个字段之前留下的记录。
	 */
	writtenTables?: string[];
	/** 只由下推探针完成数据库回读后产生；缺少它的转换证据不能交付。 */
	persistence?: { rule: string; entity: string; ids: string[]; plugins: string[] };
}

/** The facts the digest covers: everything a forger would want to change. */
function digestOf(input: Omit<AssertionEvidence, "kind" | "id" | "digest">): string {
	return sha256(
		JSON.stringify([
			input.at,
			input.runtimeKeyId,
			input.sourceFingerprint,
			input.gates,
			input.argv,
			input.scenarioKey,
			input.scenarioId,
			input.result,
			input.asserts,
			...(input.persistence === undefined ? [] : [input.persistence]),
		]),
	);
}

/**
 * `run form x --set a=1 --expect b=2` -> `run form x --set a=1`.
 *
 * Drops each noise flag together with the value that follows it, so a scenario
 * keeps its identity across a corrected expectation.
 */
export function scenarioKeyOf(argv: readonly string[]): string {
	const kept: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = String(argv[index] ?? "").trim();
		if (SCENARIO_NOISE.has(arg)) {
			index += 1;
			continue;
		}
		kept.push(arg);
	}
	return kept.join(" ");
}

export interface EvidenceInput {
	argv: readonly string[];
	records: readonly ProbeJsonRecord[];
	exitCode: number;
	at: string;
	runtimeKeyId: string;
	sourceFingerprint: string;
	gates: Record<string, string>;
	path: "cold" | "hot";
	warnings: readonly string[];
	log: string;
	scenarioId?: string | null;
	/** Set for a batch scenario, whose assertions carry its id rather than owning the process. */
	attributeAll?: boolean;
	/** 运行日志里认出的写库表；undefined 是确认不了。 */
	writtenTables?: readonly string[];
}

/** 平台网控锁表：操作开始插一行、结束删掉，不留下任何东西，不算这次运行改了数据。 */
const LOCK_TABLES = new Set(["t_mutex_datalock"]);

/**
 * 一次运行的完整日志里，平台打出的写库语句写了哪些表（小写、按出现先后、去重）。
 *
 * 回执要说「哪些运行改了库」。按命令种类猜（op、call 都不回滚）会把只读的方法调用也说成落了库
 * （2026-10-14 真机：四次只读的 call 被写成「真提交落了库」）；平台本来就把每条 SQL 打进日志，
 * 照它数才是这次真发生的事。日志里一条 SQL 都没有（平台没打 SQL 日志）时答 undefined：确认不了。
 */
export function writtenTablesOf(log: string): string[] | undefined {
	if (!log.includes("----sql@")) return undefined;
	const tables: string[] = [];
	for (const match of log.matchAll(
		/^[ \t]*(?:\/\*[^*]*\*\/[ \t]*)*(?:insert[ \t]+into|update|delete[ \t]+from|merge[ \t]+into)[ \t]+([A-Za-z_][\w.]*)/gimu,
	)) {
		const table = (match[1] ?? "").toLowerCase();
		if (table !== "" && !LOCK_TABLES.has(table) && !tables.includes(table)) tables.push(table);
	}
	return tables;
}

/**
 * Builds the record for one assertion run, or explains why there is none.
 *
 * `EXECUTED` -- a clean run that asserted nothing -- is the one result that
 * produces no record. That is the gate, not an omission: 「跑通了」 is not
 * 「验过了」, and a record for it would be a green line in the pool that proves
 * nothing about the change. The caller is expected to print `why` so the reader
 * is told plainly that this run did not count.
 */
export function evidenceFrom(input: EvidenceInput): { evidence: AssertionEvidence | null; why: string | null } {
	// 探针说「输入不成立」（模板编码、pk 查不到，--set 路径写错）：这次什么都没验，也不留记录。
	// 这几样都在场景键里，改对之后是另一个场景；留一条 FAIL，它在会话里就永远换不掉，交付
	// 一直被一个错字挡着（2026-09-17 真机复验 run print）。不留记录也放不过任何失败：
	// 这次没跑到业务代码，前面留下的记录一条不动。
	const invalid = input.records.filter(
		(record) =>
			record.t === "input-invalid" && (input.attributeAll !== false || record.case === (input.scenarioId ?? "-")),
	);
	if (invalid.length > 0) {
		return {
			evidence: null,
			// 原因探针已经在输出里的「✘ 输入不成立」行说全了（可能带一长串候选），这里只点名是哪几处。
			why:
				`输入不成立，这次没验到东西，不留验证记录：` +
				`${invalid.map((record) => `${String(record.kind ?? "")} ${String(record.target ?? "")}`).join("；")}` +
				"（原因见输出里的「✘ 输入不成立」行）。改对之后照常再跑。",
		};
	}
	const graded = grade(input.scenarioId ?? "-", input.records, input.exitCode, {
		attributeAll: input.attributeAll !== false,
	});
	if (graded.result === "EXECUTED") {
		return {
			evidence: null,
			why: "这次没有业务断言（没带 --expect），不算验证 —— 跑通了不等于验过了，交付要的是断言过了的运行",
		};
	}
	// 探针说「这次有一步没跑完」（某个插件抛错，排在它后面的插件那一步全没收到，探针接着往下跑）：
	// 断言全过也落在一个不完整的现场上，不记成 PASS。也不记 FAIL——断言本身没挂，修好或摘掉那个插件后
	// 命令里多了 --skip，是另一个场景，记 FAIL 就永远换不掉（同 input-invalid）。断言本来就有挂的照常记 FAIL。
	// 2026-10-10 真机：销售订单打开时原厂插件抛 ClassCastException，后面的插件 loadData 全没跑，断言照样 8/8 过。
	const incomplete = input.records.filter(
		(record) =>
			record.t === "run-incomplete" && (input.attributeAll !== false || record.case === (input.scenarioId ?? "-")),
	);
	if (graded.result === "PASS" && incomplete.length > 0) {
		return {
			evidence: null,
			why:
				"断言全过，但这次没跑完整，不算验证、不留验证记录：" +
				incomplete.map((record) => `${String(record.step ?? "")} 一步 ${String(record.why ?? "")}`).join("；"),
		};
	}
	const facts = {
		at: input.at,
		runtimeKeyId: input.runtimeKeyId,
		sourceFingerprint: input.sourceFingerprint,
		gates: input.gates,
		argv: input.argv.map((arg) => String(arg)),
		scenarioKey: scenarioKeyOf(input.argv),
		scenarioId: input.scenarioId ?? null,
		scenario: graded.scenario,
		result:
			input.argv[0] === "push" && input.exitCode !== 0 && graded.result === "PASS"
				? ("ERROR" as const)
				: graded.result,
		asserts: graded.asserts.map(
			(entry: GradedAssert): EvidenceAssert => ({
				kind: entry.kind,
				target: entry.target,
				expect: entry.expect,
				actual: entry.actual,
				pass: entry.pass,
				why: entry.why,
			}),
		),
		path: input.path,
		warnings: [...input.warnings],
		log: input.log,
		// --billno 也是钉在共享库里一张现成单据上，和 --pk 一样
		usesPk: input.argv.includes("--pk") || input.argv.includes("--billno"),
		...(input.writtenTables === undefined ? {} : { writtenTables: [...input.writtenTables] }),
		...pushPersistence(input),
	};
	const digest = digestOf(facts);
	return { evidence: { kind: "AssertionEvidence", id: `AE-${digest.slice(0, 12)}`, digest, ...facts }, why: null };
}

function pushPersistence(input: EvidenceInput): Pick<AssertionEvidence, "persistence"> {
	if (input.argv[0] !== "push" || input.exitCode !== 0) return {};
	const record = input.records.find((item) => item.t === "push-readback" && item.rule === input.argv[1]);
	if (
		record === undefined ||
		typeof record.entity !== "string" ||
		record.entity.trim() === "" ||
		!Array.isArray(record.ids) ||
		record.ids.length === 0 ||
		!record.ids.every((id) => typeof id === "string" && id !== "" && id !== "0")
	)
		return {};
	return {
		persistence: {
			rule: String(record.rule),
			entity: record.entity,
			ids: [...record.ids] as string[],
			plugins: Array.isArray(record.plugins) ? record.plugins.filter((p): p is string => typeof p === "string") : [],
		},
	};
}

/** 每条转换规则必须有成功保存后回读的运行；负例可以保留，但不能独自充当交付证据。 */
export function unconfirmedPush(records: readonly AssertionEvidence[]): AssertionEvidence[] {
	const confirmed = new Set(
		records
			.filter((r) => r.argv[0] === "push" && r.result === "PASS" && r.persistence?.rule === r.argv[1])
			.map((r) => r.argv[1]),
	);
	return records.filter((r) => {
		if (r.argv[0] !== "push") return false;
		if (r.persistence !== undefined && r.asserts.some((a) => a.kind === "field" && a.pass)) return false;
		const negative =
			r.asserts.some((a) => a.kind === "push-success" && a.expect === "false") &&
			r.asserts.every((a) => a.kind === "push-success" || a.kind === "push-message");
		return !(negative && confirmed.has(r.argv[1]));
	});
}

export function missingConversionClasses(records: readonly AssertionEvidence[], classes: readonly string[]): string[] {
	const confirmed = new Set(
		records.filter((r) => r.result === "PASS" && r.argv[0] === "push").flatMap((r) => r.persistence?.plugins ?? []),
	);
	return classes.filter((cls) => !confirmed.has(cls));
}

export const PUSH_READBACK_REQUIRED =
	"转换插件必须保存目标单并从数据库回读确认。用 cosmic_run push <规则id> --pk <源单内码> --expect <目标单字段>=<值>，工具会真实保存并回读；已有写入结果未知时先查日志和数据库，确认后再安排验证，不能直接重推。";

/** Re-computes a record's digest from its own contents. */
export function digestFor(evidence: AssertionEvidence): string {
	const { kind: _kind, id: _id, digest: _digest, ...facts } = evidence;
	return digestOf(facts);
}

/**
 * True when the file still says what it said when it was written.
 *
 * Checked on every read, not only at delivery: a record that fails this is not
 * a record, and the earlier that is discovered the less it can be built on.
 */
export function evidenceIntact(evidence: AssertionEvidence): boolean {
	return digestFor(evidence) === evidence.digest;
}

function fileOf(ctx: KernelContext, id: string): string {
	return `${ctx.layout.assertionEvidence}/${id}.json`.replace(/\\/g, "/");
}

/**
 * Files one record.
 *
 * Not taken under the project write lock, for the same reason the draft pool was
 * not: the probe already holds it for the duration of a rollback run, and taking
 * it again here would deadlock the common case. Each record lives in its own
 * file named by its own digest, so concurrent runs cannot collide -- identical
 * work rewrites identical bytes.
 */
export function writeEvidence(ctx: KernelContext, evidence: AssertionEvidence): string {
	const file = fileOf(ctx, evidence.id);
	ctx.ports.fs.mkdirp(ctx.layout.assertionEvidence);
	ctx.ports.fs.write(file, `${JSON.stringify(evidence, null, "\t")}\n`);
	return file;
}

/**
 * Reads one record back by id, or null.
 *
 * Null covers every way a record can fail to be usable -- missing, unreadable,
 * not JSON, not a record, or tampered with. The caller cannot act differently on
 * those cases and a delivery gate that distinguished them would be inviting the
 * model to pick the branch it likes.
 */
export function readEvidence(ctx: KernelContext, id: string): AssertionEvidence | null {
	const file = fileOf(ctx, id);
	if (!ctx.ports.fs.exists(file)) return null;
	try {
		const parsed = JSON.parse(ctx.ports.fs.read(file)) as AssertionEvidence;
		if (parsed?.kind !== "AssertionEvidence" || parsed.id !== id) return null;
		return evidenceIntact(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
