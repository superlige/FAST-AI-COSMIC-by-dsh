/**
 * S15 batch-0 baseline for model round trips and expensive execution.
 *
 * This module is deliberately pure. It does not observe a live session, start a
 * process, or call a model. Batch 0 freezes the counting vocabulary and the
 * current paths; later batches feed the same vocabulary with post-change traces
 * so the comparison cannot move its goalposts after the implementation changes.
 */

export type RoundSampleKind = "plugin" | "probe" | "run";
export type BaselineProcessKind = "javac" | "gradle" | "jvm";

export type RoundEvent =
	| {
			type: "tool-call";
			tool: string;
			/** Stable, redacted identity of the material input, not the raw arguments. */
			inputKey: string;
			/** A Skill read or cosmic_knowledge call made to clear a knowledge gate. */
			documentAccess?: boolean;
	  }
	| { type: "blocker"; code: string }
	| { type: "fact-change"; key: string }
	| { type: "process"; kind: BaselineProcessKind; coldStart: boolean }
	| { type: "target-execution"; tool: string; succeeded: boolean };

export interface RoundTraceSummary {
	accessRounds: number;
	documentAccessRounds: number;
	processStarts: number;
	coldStarts: number;
	blockerResponses: number;
	serialBlockers: number;
	unchangedRetries: number;
	firstTargetExecutionSucceeded: boolean | null;
	toolSequence: string[];
	blockerCodes: string[];
}

/**
 * Count only model-visible calls as access rounds. Internal prepare work is not
 * a model round, while `read` and `cosmic_knowledge` are. A retry is unchanged
 * only when tool + normalised input repeat without an intervening fact change.
 */
export function summarizeRoundTrace(events: readonly RoundEvent[]): RoundTraceSummary {
	let factRevision = 0;
	let accessRounds = 0;
	let documentAccessRounds = 0;
	let processStarts = 0;
	let coldStarts = 0;
	let unchangedRetries = 0;
	let currentCall = -1;
	let firstTargetExecutionSucceeded: boolean | null = null;
	const seenAtRevision = new Map<string, number>();
	const blockerCalls = new Set<number>();
	const toolSequence: string[] = [];
	const blockerCodes: string[] = [];

	for (const event of events) {
		if (event.type === "tool-call") {
			accessRounds += 1;
			currentCall = accessRounds;
			toolSequence.push(event.tool);
			if (event.documentAccess === true) documentAccessRounds += 1;
			const identity = `${event.tool}\0${event.inputKey}`;
			if (seenAtRevision.get(identity) === factRevision) unchangedRetries += 1;
			seenAtRevision.set(identity, factRevision);
			continue;
		}
		if (event.type === "fact-change") {
			factRevision += 1;
			continue;
		}
		if (event.type === "blocker") {
			blockerCodes.push(event.code);
			blockerCalls.add(currentCall);
			continue;
		}
		if (event.type === "process") {
			processStarts += 1;
			if (event.coldStart) coldStarts += 1;
			continue;
		}
		if (firstTargetExecutionSucceeded === null) firstTargetExecutionSucceeded = event.succeeded;
	}

	return {
		accessRounds,
		documentAccessRounds,
		processStarts,
		coldStarts,
		blockerResponses: blockerCalls.size,
		serialBlockers: Math.max(0, blockerCalls.size - 1),
		unchangedRetries,
		firstTargetExecutionSucceeded,
		toolSequence,
		blockerCodes,
	};
}

export interface RoundBaselineSample {
	id: string;
	kind: RoundSampleKind;
	intent: string;
	/** Existing retrospective/test evidence from which this path was frozen. */
	sourceRefs: string[];
	/** All samples begin after the target source or run intent is already known. */
	scope: "target-known";
	events: RoundEvent[];
}

const tool = (name: string, inputKey: string, documentAccess = false): RoundEvent => ({
	type: "tool-call",
	tool: name,
	inputKey,
	...(documentAccess ? { documentAccess: true } : {}),
});
const blocked = (code: string): RoundEvent => ({ type: "blocker", code });
const changed = (key: string): RoundEvent => ({ type: "fact-change", key });
const process = (kind: BaselineProcessKind, coldStart = false): RoundEvent => ({
	type: "process",
	kind,
	coldStart,
});
const executed = (name: string, succeeded = true): RoundEvent => ({
	type: "target-execution",
	tool: name,
	succeeded,
});

const pluginSample = (id: string, family: string, intent: string, sourceRef: string): RoundBaselineSample => ({
	id,
	kind: "plugin",
	intent,
	sourceRefs: [sourceRef, "test/kernel/fast.test.ts"],
	scope: "target-known",
	events: [
		tool("cosmic_lint", `${id}:source`),
		process("javac"),
		tool("cosmic_fast", `${id}:source`),
		blocked("KNOWLEDGE_GATE_UNSATISFIED"),
		tool("cosmic_knowledge", `${family}:guide-and-table`, true),
		tool("cosmic_knowledge", `${family}:selected-scenes`, true),
		changed(`plugin-brief:${family}`),
		tool("cosmic_fast", `${id}:source`),
		process("javac"),
		executed("cosmic_fast"),
	],
});

const probeSample = (id: string, api: string, intent: string, sourceRef: string): RoundBaselineSample => ({
	id,
	kind: "probe",
	intent,
	sourceRefs: [sourceRef, "test/kernel/api-precheck.test.ts"],
	scope: "target-known",
	events: [
		tool("cosmic_probe", `${id}:probe`),
		blocked("PROBE_API_UNCHECKED"),
		tool("cosmic_knowledge", `api:${api}`, true),
		changed(`consulted-api:${api}`),
		tool("cosmic_probe", `${id}:probe`),
		process("jvm", true),
		executed("cosmic_probe"),
	],
});

const runSample = (id: string, adapter: string, intent: string, sourceRef: string): RoundBaselineSample => ({
	id,
	kind: "run",
	intent,
	sourceRefs: [sourceRef, "test/security/agent-tools.test.ts"],
	scope: "target-known",
	events: [
		tool("cosmic_run", `${id}:argv`),
		blocked("COSMIC_REFERENCE_UNREAD"),
		tool("read", "reference:cosmic-run", true),
		changed("reference-page:cosmic-run"),
		tool("cosmic_run", `${id}:argv`),
		process("jvm", true),
		executed(`cosmic_run:${adapter}`),
	],
});

/**
 * Current-path corpus. Cold-start counts assume an empty RuntimeKey resident
 * server, which is the expensive first-use case S15 is intended to improve.
 */
export const ROUND_BASELINE_SAMPLES: readonly RoundBaselineSample[] = [
	pluginSample("plugin-form", "AbstractFormPlugin", "表单字段联动插件", "docs/S7-knowledge-design.md"),
	pluginSample("plugin-bill", "AbstractBillPlugIn", "单据按钮与保存校验", "docs/knowledge-injection.md"),
	pluginSample("plugin-list", "AbstractListPlugin", "列表过滤与按钮插件", "test/knowledge/plugin-gate.test.ts"),
	pluginSample(
		"plugin-operation",
		"AbstractOperationServicePlugIn",
		"操作事务前后处理",
		"src/knowledge/plugin-gate.ts",
	),
	pluginSample("plugin-print", "AbstractPrintPlugin", "打印插件数据准备", "docs/S7-l1-l3-gate.md"),
	pluginSample("plugin-task", "AbstractTask", "后台任务生命周期插件", "docs/S7-eval-budget.md"),
	probeSample("probe-qfilter", "kd.bos.orm.query.QFilter", "按条件读取单据", "scripts/verify-efficiency-gates.ts"),
	probeSample(
		"probe-query-helper",
		"kd.bos.servicehelper.QueryServiceHelper",
		"查询一条业务数据",
		"test/kernel/api-precheck.test.ts",
	),
	probeSample(
		"probe-business-data",
		"kd.bos.dataentity.entity.DynamicObject",
		"读取动态对象字段",
		"test/kernel/probe.test.ts",
	),
	probeSample(
		"probe-metadata",
		"kd.bos.metadata.entity.EntityMetadata",
		"读取实体元数据",
		"test/kernel/probe-scan.test.ts",
	),
	probeSample(
		"probe-operate-option",
		"kd.bos.dataentity.OperateOption",
		"构造只读操作选项",
		"test/kernel/api-precheck.test.ts",
	),
	probeSample("probe-qcp", "kd.bos.orm.query.QCP", "构造查询比较符", "test/kernel/api-precheck.test.ts"),
	runSample("run-op", "op", "操作插件保存断言", "test/kernel/run.test.ts"),
	runSample("run-form", "form", "表单当前行与选中行断言", "test/kernel/run.test.ts"),
	runSample("run-list", "list", "列表选择主键断言", "test/kernel/run.test.ts"),
	runSample("run-callback", "callback", "父子页面回调断言", "test/kernel/run.test.ts"),
	runSample("run-flow", "flow", "父子流程断言", "test/kernel/run.test.ts"),
	runSample("run-rule", "rule", "规则层计算断言", "test/kernel/run.test.ts"),
];

export interface GateGolden {
	path: RoundSampleKind;
	code: string;
	clearedBy: string;
	beforeTargetExecution: true;
	testRefs: string[];
}

/**
 * The knowledge gates a model meets before its first target execution. Pi had a
 * third one on `run` (read cosmic-run/SKILL.md first); the dsh layer does not
 * carry it, so only these two remain to be counted.
 */
export const ROUND_GATE_GOLDENS: readonly GateGolden[] = [
	{
		path: "plugin",
		code: "KNOWLEDGE_GATE_UNSATISFIED",
		clearedBy: "cosmic_knowledge action=plugin（首次指南与场景表，随后选择场景记戳）",
		beforeTargetExecution: true,
		testRefs: ["test/kernel/fast.test.ts", "test/knowledge/plugin-gate.test.ts"],
	},
	{
		path: "probe",
		code: "PROBE_API_UNCHECKED",
		clearedBy: "cosmic_knowledge action=api，一次批量查询所有精确 import",
		beforeTargetExecution: true,
		testRefs: ["test/kernel/api-precheck.test.ts", "scripts/verify-efficiency-gates.ts"],
	},
];

export interface SafetyBaselineRow {
	id: string;
	boundary: string;
	testRefs: string[];
}

/**
 * Controls that must survive any change made to save rounds. Every `testRefs`
 * entry is a file that exists (`test/eval/round-efficiency.test.ts` checks), and
 * `scripts/verify-round-efficiency.ts` runs them all.
 */
export const ROUND_SAFETY_BASELINE: readonly SafetyBaselineRow[] = [
	{
		id: "moved-facts",
		boundary: "运行时身份变了、编译之后源码被改了的调用不进内核，之前的编译和验证记录作废",
		testRefs: ["test/security/bypass-matrix.test.ts"],
	},
	{
		id: "ad-hoc-path",
		boundary: "临时探针不能越出工程或混入发布探针目录",
		testRefs: ["test/security/bypass-matrix.test.ts"],
	},
	{
		id: "freshness",
		boundary: "外部替换源码或 class 认得出",
		testRefs: ["test/security/bypass-matrix.test.ts", "test/kernel/freshness.test.ts"],
	},
	{
		id: "dangerous-probe",
		boundary: "反射、动态加载、进程、JDBC 写、文件和网络能力继续拒绝；临时探针带 APPLY 在进内核前拒",
		testRefs: ["test/security/bypass-matrix.test.ts", "test/kernel/probe-scan.test.ts", "test/dsh/gates.test.ts"],
	},
	{
		id: "project-write-lock",
		boundary: "跨进程写入由工程锁串行，残留锁不能自动删除，只能点名回收",
		testRefs: ["test/security/bypass-matrix.test.ts", "test/kernel/write-lock-recovery.test.ts"],
	},
	{
		id: "runtime-isolation",
		boundary: "不同工程和 RuntimeKey 的缓存、JVM、PID 不能串用",
		testRefs: ["test/security/bypass-matrix.test.ts", "test/kernel/resident-ownership.test.ts"],
	},
	{
		id: "shared-write-authorization",
		boundary: "写元数据必须由用户点确认；落库范围就是确认单上的范围；弹不了确认就不写",
		testRefs: ["test/dsh/write.test.ts", "test/kernel/write-targets.test.ts"],
	},
	{
		id: "prod-readonly",
		boundary: "生产查询只读；修复在测试环境编译、真跑验证",
		testRefs: ["test/kernel/prod-sql-guard.test.ts", "test/security/prod-readonly.test.ts"],
	},
];

export interface RoundBaselineTotals {
	samples: number;
	accessRounds: number;
	documentAccessRounds: number;
	processStarts: number;
	coldStarts: number;
	blockerResponses: number;
	serialBlockers: number;
	unchangedRetries: number;
	firstTargetSuccesses: number;
}

export function roundBaselineTotals(samples: readonly RoundBaselineSample[]): RoundBaselineTotals {
	return samples.reduce<RoundBaselineTotals>(
		(total, sample) => {
			const summary = summarizeRoundTrace(sample.events);
			return {
				samples: total.samples + 1,
				accessRounds: total.accessRounds + summary.accessRounds,
				documentAccessRounds: total.documentAccessRounds + summary.documentAccessRounds,
				processStarts: total.processStarts + summary.processStarts,
				coldStarts: total.coldStarts + summary.coldStarts,
				blockerResponses: total.blockerResponses + summary.blockerResponses,
				serialBlockers: total.serialBlockers + summary.serialBlockers,
				unchangedRetries: total.unchangedRetries + summary.unchangedRetries,
				firstTargetSuccesses: total.firstTargetSuccesses + (summary.firstTargetExecutionSucceeded === true ? 1 : 0),
			};
		},
		{
			samples: 0,
			accessRounds: 0,
			documentAccessRounds: 0,
			processStarts: 0,
			coldStarts: 0,
			blockerResponses: 0,
			serialBlockers: 0,
			unchangedRetries: 0,
			firstTargetSuccesses: 0,
		},
	);
}
