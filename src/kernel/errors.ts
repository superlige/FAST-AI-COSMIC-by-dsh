/**
 * Kernel error model (D9). The frozen CLI reports failures by printing to the
 * console and calling process.exit(); inside a resident agent that would kill
 * the whole process and force callers to parse console prose to learn what
 * happened. Every kernel entry point therefore returns a structured result and
 * throws only KernelError, which carries a stable machine-readable code
 * alongside the human-readable text.
 */

/** Stable codes. Callers branch on these; the message is for humans only. */
export type KernelErrorCode =
	| "PROJECT_ROOT_NOT_FOUND"
	| "PROJECT_ROOT_INVALID"
	| "CONFIG_PARSE_FAILED"
	| "CONFIG_INCOMPLETE"
	| "CONFIG_INIT_INVALID"
	| "CONFIG_INIT_CONFLICT"
	| "COSMIC_HOME_CONFLICT"
	| "RUNTIME_FINGERPRINT_UNAVAILABLE"
	| "RUNTIME_KEY_MISMATCH"
	// S3: the fast -> probe slice.
	| "SOURCE_NOT_FOUND"
	| "SOURCE_AMBIGUOUS"
	| "SOURCE_OUTSIDE_MODULES"
	| "MODULE_SCOPE_INVALID"
	| "BUILD_FAILED"
	| "COMPILE_FAILED"
	| "TOOLCHAIN_MISSING"
	| "PROBE_NOT_FOUND"
	| "PROBE_NOT_ALLOWED"
	| "PROBE_RELEASE_SOURCE_CHANGED"
	| "PROBE_WRITES_REFUSED"
	| "PROBE_ARGS_INVALID"
	| "PROBE_INPUT_MISSING"
	| "STALE_CLASSES"
	| "PROBE_SERVER_UNAVAILABLE"
	// 常驻用不上、且调用方关掉了隐式冷降级（`ProbeOptions.coldFallback: false`）。
	// 不复用 PROBE_SERVER_UNAVAILABLE：那条说的是「常驻起不来」，处置是看日志；
	// 这条说的是「这次不替你付冷进程那几十秒」，处置是显式再跑一次或先拉起常驻。
	// 合成一个码，审计里「有多少次是被这条省下的」就没法回答了。
	| "PROBE_RESIDENT_UNAVAILABLE"
	// 落库的请求发给常驻 JVM 后没收到完整答复（超时、半截断开）：可能已写了一部分，不自动冷进程重跑。
	| "PROBE_WRITE_UNCERTAIN"
	| "PROBE_ANSWER_SETTLED"
	| "PROBE_FAILED"
	| "WRITE_TARGETS_UNCONFIRMED"
	// S4.3: cross-window mutation serialization and evidence freshness.
	| "PROJECT_WRITE_LOCKED"
	// S4.4: explicit crash-residue recovery for the project write lock.
	| "WRITE_LOCK_ABSENT"
	| "WRITE_LOCK_OWNER_ALIVE"
	| "WRITE_LOCK_TOKEN_MISMATCH"
	| "WRITE_LOCK_RECOVERY_FAILED"
	// S7.0: the embedded official knowledge snapshot.
	| "KNOWLEDGE_UNAVAILABLE"
	| "KNOWLEDGE_PACK_INVALID"
	// S5.1: read-only knowledge queries and project diagnosis.
	| "KNOWLEDGE_QUERY_INVALID"
	// S5.2: the run/verify domain.
	| "RUN_ARGS_INVALID"
	| "RUN_PRECHECK_FAILED"
	| "FAST_PRECHECK_FAILED"
	/** S22: 本次会话没有可以当证据的断言运行 —— 交付判据不成立。 */
	| "VERIFY_NO_EVIDENCE"
	/** S24: 改的类都没有自动验证方法，可以交用户验收，但人工验收三件事没写。 */
	| "VERIFY_ACCEPTANCE_REQUIRED"
	/** S24: 带了人工验收说明，但改的类里有自动验证路线 —— 不能自己声明「验不了」。 */
	| "VERIFY_ACCEPTANCE_REFUSED"
	/** S24: 人工验收三件事有空着的。 */
	| "VERIFY_ACCEPTANCE_INCOMPLETE"
	/** S70: 交付没带给用户看的报告（`report`）。 */
	| "VERIFY_REPORT_REQUIRED"
	/** S70: 报告里有没对上运行的「验过」、夹了代码名、空着或太长的话。 */
	| "VERIFY_REPORT_INVALID"
	/** S22: 调到了随用例体系一起删掉的动作（run / list / drafts / adopt）。 */
	| "VERIFY_ACTION_RETIRED"
	// S5.3: the ledger and the impact index.
	| "IMPACT_INDEX_MISSING"
	| "IMPACT_TARGET_UNKNOWN"
	| "IMPACT_BUILD_FAILED"
	| "SPEC_ARGS_INVALID"
	| "SPEC_NOT_FOUND"
	| "SPEC_DRAFT_INCOMPLETE"
	// A spec state claiming verification that has no VerifyResult to back it. Its own
	// code because it is the one refusal in this domain that is about evidence rather
	// than about arguments -- merged into SPEC_ARGS_INVALID, "how often did a close get
	// stopped for lack of evidence" would have no answer.
	| "SPEC_EVIDENCE_MISSING"
	| "SPEC_DRAFT_AMBIGUOUS"
	// 启动向导：手机号换用户 id。自己的码而不是 PROBE_FAILED —— 这条失败发生在配置
	// 写盘之前，唯一的出路是「换个关键字，或先直接填 id」，跟一次普通探针失败不是一回事。
	| "USER_LOOKUP_FAILED"
	// S5.4: the shared-environment domain (meta / deploy / debug node).
	| "META_ARGS_INVALID"
	| "DEPLOY_FAILED"
	| "DEBUG_NODE_UNAVAILABLE"
	// S15.3: all source/input/API blockers found before javac or the Cosmic JVM.
	| "PROBE_PRECHECK_FAILED"
	| "PROBE_PRECHECK_STALE"
	// S15.2: a recognised plugin family could not produce a deterministic target
	// Capsule. Deliberately NOT COMPILE_FAILED: no Gradle/JDK process started. This
	// is never used for a missing model-performed knowledge or document check-in.
	| "KNOWLEDGE_GATE_UNSATISFIED"
	// S51: this session's code added a loop that queries the database per row, or
	// spelled an identifier its constants class already has. Found from source
	// before any Gradle/JDK process; the fix is in the same file.
	| "STYLE_GATE_UNSATISFIED"
	// 生产只读排障（cosmic_prod）。
	/** 没有 `<配置目录>/prod/<名字>.json`，或填得不全、格式不对。 */
	| "PROD_CONFIG_MISSING"
	/** 参数不对：缺 sql、缺 number、动作不认识。 */
	| "PROD_ARGS_INVALID"
	/** 语句不是单条只读查询（写、加锁、改会话、调危险函数），执行前就拒。 */
	| "PROD_SQL_REFUSED"
	/** 生产库连不上、读取进程起不来或没答复。 */
	| "PROD_QUERY_FAILED"
	/** 语句到了生产库，库按语句本身报错（语法、类型、列名、超时、没权限）。 */
	| "PROD_SQL_FAILED"
	/** monitor 没登录或登录过期：验证码要人输，只能由用户敲命令登录。 */
	| "PROD_MONITOR_LOGIN_REQUIRED"
	/** monitor 接口报错或连不上。 */
	| "PROD_MONITOR_FAILED"
	/** 诊断报告引用了本次会话里没有的证据编号，或结论为空。 */
	| "PROD_REPORT_INVALID";

export interface KernelErrorDetail {
	/** Machine-readable facts about the failure; never contains credentials. */
	readonly [key: string]: string | number | boolean | readonly string[] | null;
}

export class KernelError extends Error {
	readonly code: KernelErrorCode;
	readonly detail: KernelErrorDetail;
	/** What the caller (or user) can do about it. Empty when there is nothing actionable. */
	readonly remedy: string;

	constructor(code: KernelErrorCode, message: string, options: { detail?: KernelErrorDetail; remedy?: string } = {}) {
		super(message);
		this.name = "KernelError";
		this.code = code;
		this.detail = options.detail ?? {};
		this.remedy = options.remedy ?? "";
	}

	/** Serializable form for tool results and audit logs. */
	toJSON(): { code: KernelErrorCode; message: string; detail: KernelErrorDetail; remedy: string } {
		return { code: this.code, message: this.message, detail: this.detail, remedy: this.remedy };
	}
}

export type KernelResult<T> = { ok: true; value: T } | { ok: false; error: KernelError };

export function ok<T>(value: T): KernelResult<T> {
	return { ok: true, value };
}

export function err<T>(error: KernelError): KernelResult<T> {
	return { ok: false, error };
}

/** Runs fn, converting a thrown KernelError into a result. Other throws propagate. */
export function attempt<T>(fn: () => T): KernelResult<T> {
	try {
		return ok(fn());
	} catch (error) {
		if (error instanceof KernelError) return err(error);
		throw error;
	}
}
