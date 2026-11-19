/** Offline measurements, versioned independently of the agent's runtime policy. */
/** s37-v1: category counts no longer match the S36 batch-0 table (S37 2-A.0 counts tool exports
 * such as outputs/print-tpl-json as internal reads), but the label had stayed s36-v1. Progress,
 * first progress and no-progress runs are unchanged. */
export const METRIC_VERSION = "s37-v1";
export const INTAKE_VERSION = "s34-v1";
/** Breakdown of calls inside a no-progress run; `s36-v1` counts above are unchanged by it. */
export const STALL_VERSION = "s36-stall-v1";
export const STALL_LABELS = {
	investigate: "正常调查",
	reference: "读说明",
	verify: "无断言试跑",
	wait: "等环境",
	auxiliary: "临时探针",
	toolOutput: "翻工具产物",
	history: "翻旧产物",
	internals: "翻工具源码",
	platformJar: "翻平台 JAR",
	broad: "大范围搜索",
	repeat: "原样重查",
	retry: "同一操作再失败",
	failure: "其他失败",
};
export const CATEGORY_LABELS = {
	action: "动手",
	verify: "验证",
	inspect: "查看",
	internal: "翻 cosmic 自己的文件",
	broad: "大范围搜索",
	failure: "失败",
	question: "问用户",
	help: "问用法",
};
const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value ?? null), "utf8");
const normalized = (value) => String(value ?? "").replaceAll("\\", "/");
const textOf = (parts) =>
	typeof parts === "string"
		? parts
		: (parts ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n");
const ms = (at) => {
	const n = typeof at === "number" ? at : Date.parse(at);
	return Number.isFinite(n) ? n : null;
};
const elapsed = (start, end) => (start === null || end === null || end < start ? null : end - start);

function resultState(message, tool) {
	if (!message) return { state: "missing", code: null };
	const text = textOf(message.content);
	let envelope;
	for (const part of message.content ?? []) {
		if (part.type !== "text") continue;
		try {
			envelope = JSON.parse(part.text);
			break;
		} catch {
			/* prose is not an envelope */
		}
	}
	// Never scan arbitrary source/log text for ok:false: only the returned envelope is authoritative.
	if (message.isError || (tool.startsWith("cosmic_") && envelope?.ok === false)) {
		// OBSERVED_* are offline buckets, not invented runtime error codes. Only inspect
		// diagnostic lines after the structured envelope, not incidental notes or source.
		const diagnostic = text
			.split("\n")
			.filter((line) => !line.startsWith("{"))
			.join("\n");
		const patterns = [
			["OBSERVED_ASSERTION", /\[PROBE-ERR\].*断言失败/],
			["OBSERVED_ENTITY", /\[PROBE-ERR\].*(?:既不是实体也不是表单布局|元数据不存在|Table .*doesn't exist)/],
			["OBSERVED_QUERY_FIELD", /NoSuchPropertyException|\[PROBE-ERR\].*(?:字段元数据里没有|Unknown column)/],
			["OBSERVED_QUERY_ARGS", /\[PROBE-ERR\].*QUERY_.*入参/],
			["OBSERVED_EXPECT_SYNTAX", /\[PROBE-ERR\].*--expect 不是/],
			["OBSERVED_CONTROL", /\[PROBE-ERR\].*找不到表格/],
			["OBSERVED_SCALAR_WRITE", /\[PROBE-ERR\].*(?:只改标量|TPL_SET 要写成)/],
			["OBSERVED_WRITE_NOT_APPLIED", /\[PROBE-ERR\].*没改成/],
			["OBSERVED_TOOL_SCHEMA", /^Validation failed for tool/m],
			["OBSERVED_TOOL_MISSING", /^Tool \w+ not found/m],
			["OBSERVED_SCRIPT_SHAPE", /(?:AttributeError|IndexError|PatternError):/],
			["OBSERVED_FILE_MISSING", /No such file or directory/],
			["OBSERVED_ABORTED", /Command aborted/],
			["OBSERVED_SHELL_EXIT", /(?:Command|Process) exited with code [1-9]/],
		];
		return {
			state: "failure",
			code:
				envelope?.error?.code ??
				patterns.find(([, pattern]) => pattern.test(diagnostic))?.[0] ??
				"UNCLASSIFIED_FAILURE",
		};
	}
	return { state: "success", code: null };
}

function fileIntent(source) {
	if (/formula|Formula|bindField|bindText|refDs|customDs/.test(source)) return "公式、绑定和数据源写法";
	if (/locale|多语言/.test(source)) return "多语言内容与公式显示名";
	if (/candidate\.json|--status/.test(source)) return "候选状态与来源";
	if (/ExpectSpec|--expect|assert|断言/i.test(source)) return "断言语法与失败原因";
	if (/PrintSim|FormSim|DataQueryProbe|run\.md|help|SKILL\.md/i.test(source)) return "工具用法与能力边界";
	if (/height|width|rowSpan|colSpan|parentId|rowId|columnId|LayoutGrid|DataRow/.test(source))
		return "控件层级、布局与尺寸";
	if (/plugins|Plugin|register|注册/.test(source)) return "插件注册与执行入口";
	if (/work\/out|last-probe|\.out\b|\.log\b/.test(source)) return "运行结果与历史输出";
	if (/probes\/|\.java\b/.test(source)) return "探针实现与平台 API";
	if (/json\.load|JSON\.parse|\.meta\.json|\.json\b/.test(source)) return "导出结构与字段内容";
	return "目录定位与其他（待人工判断）";
}

export function classifyCall(tool, args = {}) {
	const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
	const path = normalized(args.path ?? args.filePath ?? args.file);
	const command = normalized(args.command ?? "");
	const source = tool === "bash" ? command : path;
	const filesystem = ["read", "bash"].includes(tool);
	const cache = /(?:\.?fast-ai-cosmic|cosmic-agent)\/cache(?:\/|\b)/i.test(source);
	const artifact = /\.cosmic-ai(?:\/|\b)/.test(source);
	// Files the tools themselves wrote: raw probe output (cache probe-runs, the project's work/out)
	// and the default export directories of the dump probes. A custom OUT_DIR elsewhere is not
	// recognized and stays in "other".
	const probeRun = cache && /\/probe-runs(?:\/|\b)/i.test(source);
	const runOutput = /\.cosmic-ai\/work\/out(?:\/|\b)/.test(source);
	const exported = /(?:^|[\s"'/=(])outputs\/(?:print-tpl-json|print-template-backups|wf-model)(?:\/|\b)/.test(source);
	const reference = cache && /\/cache\/(?:knowledge|reference)\//i.test(source);
	const internal = filesystem && (cache || artifact || exported);
	const broad =
		tool === "bash" &&
		/\bfind\s+["']?(?:\.|\/)["']?(?=\s|$)|\bgrep\s+-[a-zA-Z]*[rR][a-zA-Z]*\s+[^\n]*\s\.(?=\s|$|[;|])|\brg\s+--files\b|\bls\s+-[a-zA-Z]*R\s+\.(?=\s|$)|\.cosmic-ai\/\*\*\//.test(
			command,
		);
	const shellWrite =
		tool === "bash" &&
		/\b(?:writeFileSync|writeFile|write_text|write_bytes)\s*\(|\bopen\([^\n]*,[\s]*['"](?:w|a)|\b(?:sed\s+-i|Set-Content|Add-Content|Out-File)\b|(?:^|[;&\n])\s*(?:cat|echo|printf)[^\n]*\s>{1,2}\s*(?!\/dev\/null)[^&]/i.test(
			command,
		);
	const fileWrite = ["write", "edit"].includes(tool) || shellWrite;
	const writeTarget = tool === "bash" ? command : path;
	const auxiliaryWrite = fileWrite && /\.cosmic-ai\/probes\/|(?:^|\/)scratchpad\/|\/tmp\/|\.md\b/i.test(writeTarget);
	const codeOrCandidate =
		fileWrite &&
		!auxiliaryWrite &&
		/\.java\b|\.kt\b|\.ts\b|\.js\b|\.json\b|\.xml\b|\.cosmic-ai\/work\//i.test(writeTarget);
	const asserted =
		argv.some((v) => /^--expect(?:-|$)/.test(v)) || Object.keys(args.env ?? {}).some((k) => /EXPECT|ASSERT/.test(k));
	const help =
		(tool.startsWith("cosmic_") && (argv.includes("help") || argv.includes("--help"))) ||
		(tool === "cosmic_meta" && argv.length === 0) ||
		(tool === "cosmic_knowledge" && ["probes", "help"].includes(args.action));
	const metaEdit =
		tool === "cosmic_meta" &&
		argv[1] === "edit" &&
		argv.some((v) =>
			["--open", "--formula", "--bind", "--text", "--clone", "--delete", "--move", "--grid", "--reset"].includes(v),
		);
	const sharedWrite =
		tool === "cosmic_authorize" ||
		args.apply === true ||
		(tool === "cosmic_meta" && ["apply", "restore", "add-field", "del-field", "set", "sync"].includes(argv[1])) ||
		(tool === "cosmic_probe" &&
			/^(?:DataUpdate|DataSeed|AddField|DelField|CopyField|PrintTplWrite|BotpRuleSync)Probe$/.test(args.name ?? ""));
	const question = tool === "ask_question";
	const verify =
		["cosmic_run", "cosmic_verify", "cosmic_build", "cosmic_fast"].includes(tool) ||
		(tool === "cosmic_probe" && asserted);
	const progress = question || codeOrCandidate || metaEdit || sharedWrite || (verify && asserted);
	let category = "inspect";
	if (question) category = "question";
	else if (help) category = "help";
	else if (codeOrCandidate || metaEdit || sharedWrite) category = "action";
	else if (verify) category = "verify";
	else if (internal && !fileWrite) category = "internal";
	else if (broad && !fileWrite) category = "broad";
	const internalRead = internal && !fileWrite;
	// Counted even when the same shell call also writes (a python script that reads an export and
	// saves a candidate): the read is the point here. Such calls are flagged via toolOutputWrite.
	const toolOutput = filesystem && !["write", "edit"].includes(tool) && (probeRun || runOutput || exported);
	let readKind = "other";
	if (internalRead)
		readKind = probeRun
			? "probe-run"
			: runOutput
				? "run-output"
				: exported
					? "export"
					: reference
						? "reference"
						: cache
							? "cache"
							: /\.cosmic-ai\/probes\//.test(source)
								? "temporary-probe"
								: "artifact";
	else if (filesystem && !fileWrite && /\.java\b/.test(source))
		readKind =
			tool === "read" ? (args.offset != null || args.limit != null ? "java-range" : "java-full") : "java-search";
	// Stall-breakdown signals. A temporary probe is written, edited, read or run from
	// `.cosmic-ai/probes/`; the tool's own source is a cached probe/runtime file or the cosmic
	// repository itself; a platform JAR is opened with javap/jar/unzip or searched for by name.
	const tempProbe =
		/\.cosmic-ai\/probes\//.test(tool === "cosmic_probe" ? normalized(args.name) : source) &&
		(tool !== "bash" || /\.java\b/.test(command) || shellWrite || /\bls\b/.test(command));
	const platformJar =
		tool === "bash" &&
		/\b(?:javap|jar\s+-?t|unzip\s+-l)\b|-name\s+["']?[^\s"']*\.jar\b|\.jar\b[^\n]*\|\s*grep/.test(command);
	const internals =
		filesystem &&
		!fileWrite &&
		((cache && /\/cache\/v[^/\s"']*/i.test(source) && !probeRun) ||
			/\/claudecode\/pi\/cosmic(?:\/|\b)/i.test(source));
	return {
		category,
		progress: progress && !help,
		tempProbe,
		platformJar,
		internals,
		internalRead,
		broad,
		readKind,
		fileIntent: internalRead ? fileIntent(source) : null,
		toolOutput,
		toolOutputWrite: toolOutput && fileWrite,
		python: tool === "bash" && /\bpython(?:3)?\b/.test(command),
		pythonJson: internalRead && /\bpython(?:3)?\b/.test(command) && /json\.load/.test(command),
		showControl: tool === "bash" && /\bcat\s+-[a-zA-Z]*[AvET]/.test(command),
		auxiliaryWrite,
		uncertain:
			(tool === "bash" && !internalRead && readKind === "other" && !broad && !codeOrCandidate) ||
			(fileWrite && !codeOrCandidate && !auxiliaryWrite),
	};
}

/** Where this call told a tool to write its output (`--out`, `OUT_DIR`, `PDF_OUT`), normalized
 * and relative when given relative. Later reads of those paths reread this session's output. */
function outputTargets(tool, args) {
	const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
	const values = [
		...argv.flatMap((v, i) => (v === "--out" && argv[i + 1] ? [argv[i + 1]] : [])),
		...Object.entries(args.env ?? {})
			.filter(([k]) => /^(?:OUT_DIR|PDF_OUT)$/.test(k))
			.map(([, v]) => String(v)),
	];
	return tool.startsWith("cosmic_") ? values.map((v) => normalized(v).replace(/^\.\//, "")).filter(Boolean) : [];
}

/** One kind per call that did not advance the task. Priority: failures first, then the most
 * specific detour signal, then a plain look. It describes what the call did, not whether it was
 * needed: a long run of "investigate" can be real work, and a temporary probe can be the only way
 * to learn a fact. Manual review decides that. */
function stallKindOf(c, state, context) {
	if (state.state === "failure") {
		if (/STALE|LOCK|BUSY/.test(state.code ?? "")) return "wait";
		return context.failedBefore ? "retry" : "failure";
	}
	if (c.category === "help") return "reference";
	if (c.tempProbe) return "auxiliary";
	if (c.platformJar) return "platformJar";
	if (c.internals) return "internals";
	if (c.toolOutput || context.ownOutput) return "toolOutput";
	if (c.readKind === "reference") return "reference";
	if (c.internalRead) return "history";
	if (c.broad) return "broad";
	if (c.category === "verify") return "verify";
	if (context.seenBefore) return "repeat";
	return "investigate";
}

function operationKey(tool, args) {
	const argv = args.argv ?? [];
	// A success on another entity or another probe cannot clear this failure. Even a matched
	// operation only proves that it ran successfully, not that the business requirement recovered.
	if (tool === "cosmic_probe")
		return JSON.stringify([
			tool,
			args.name,
			Object.entries(args.env ?? {})
				.filter(([k]) => /(?:ENTITY|FORM|NUMBER|TPL|PK)$/.test(k))
				.sort(),
		]);
	if (tool === "cosmic_meta") return JSON.stringify([tool, ...argv.slice(0, 3)]);
	if (tool === "cosmic_run")
		return JSON.stringify([
			tool,
			...argv.slice(0, 2),
			...argv.flatMap((v, i) => (["--pk", "--billno"].includes(v) ? [v, argv[i + 1]] : [])),
		]);
	if (["read", "write", "edit"].includes(tool)) return JSON.stringify([tool, args.path ?? args.filePath ?? args.file]);
	return JSON.stringify([tool, args]);
}

/** Partition payload values in a cosmic result, with no double counting. JSON punctuation is
 * counted as result overhead. Paths inside an ordinary prose sentence remain in result. */
function cosmicPayload(parts) {
	const rows = { result: 0, internalPath: 0, budget: 0, notes: 0 };
	function walk(value, key = "", inherited = "result") {
		let group = inherited;
		if (group === "result") {
			if (/^(outputBudget|budget|recordBudget)$/.test(key)) group = "budget";
			else if (/^(notes|stale|apiPrecheck)$/.test(key)) group = "notes";
			else if (
				typeof value === "string" &&
				/^(?:[A-Za-z]:[\\/]|\/|\.cosmic-ai[\\/])/.test(value) &&
				/(?:fast-ai-cosmic[\\/]cache|\.cosmic-ai|last-probe)/.test(value)
			)
				group = "internalPath";
		}
		if (group !== "result" || value === null || typeof value !== "object") {
			rows[group] += bytes(JSON.stringify(value));
			return;
		}
		const values = Object.entries(value);
		rows.result += bytes(JSON.stringify(value)) - values.reduce((n, [, v]) => n + bytes(JSON.stringify(v)), 0);
		for (const [k, v] of values) walk(v, k);
	}
	for (const p of parts ?? []) {
		if (p.type !== "text") {
			rows.result += bytes(p);
			continue;
		}
		try {
			const parsed = JSON.parse(p.text);
			const canonicalBytes = bytes(JSON.stringify(parsed));
			walk(parsed);
			rows.result += bytes(p.text) - canonicalBytes;
		} catch {
			rows.result += bytes(p.text);
		}
	}
	return rows;
}

/** Exact text-line repetition is a measurement, never permission to suppress results.
 * Scope is one session, including within-result repeats; CRLF is normalized, whitespace is not.
 */
export function measureIntake(records) {
	const row = () => ({ textBytes: 0, eligibleBytes: 0, repeatedBytes: 0, repeatedLines: 0, withinResultBytes: 0 });
	const total = row(),
		byTool = {},
		bySource = {},
		byCategory = {};
	const seen = new Map();
	const prompt = { notes: 0, usage: 0, budget: 0, capsule: 0, precheck: 0, other: 0 };
	const promptByTool = {};
	let resultNumber = 0,
		nonTextBytes = 0,
		unparsedCosmicBytes = 0,
		compactions = 0;
	const categoryOf = (line) => {
		// Compact JSON may contain results and reminders on one line; don't label it all as notes.
		if (/^\s*\{/.test(line)) return "mixedJson";
		if (/Knowledge Capsule|cosmic\.knowledge-capsule/.test(line)) return "capsule";
		if (/"(?:notes|remedy|warnings?)"\s*:|验证记录：|没带.*--expect|打印走的是预览/.test(line)) return "notes";
		if (/"(?:usage|help|description)"\s*:/.test(line)) return "usage";
		if (/"(?:outputBudget|recordBudget|budget)"\s*:/.test(line)) return "budget";
		if (/fast-ai-cosmic[\\/]+cache|last-probe\.json/.test(line)) return "internalPath";
		if (/Exception|\bat [\w.$]+\(/.test(line)) return "stack";
		return "other";
	};
	const fieldGroup = (key) => {
		if (/^(notes?|warnings?|remedy)$/.test(key)) return "notes";
		if (/^(usage|help|description)$/.test(key)) return "usage";
		if (/^(outputBudget|recordBudget|budget)$/.test(key)) return "budget";
		if (/^(capsules?|knowledgeCapsules?)$/i.test(key)) return "capsule";
		if (/^(stale|apiPrecheck)$/.test(key)) return "precheck";
		return null;
	};
	for (const entry of records) {
		if (entry.type === "compaction") compactions++;
		const message = entry.message;
		if (entry.type !== "message" || message?.role !== "toolResult") continue;
		resultNumber++;
		const tool = message.toolName ?? "unknown";
		const source = tool.startsWith("cosmic_") ? "cosmic" : ["read", "bash"].includes(tool) ? tool : "other";
		byTool[tool] ??= row();
		bySource[source] ??= row();
		const targets = [total, byTool[tool], bySource[source]];
		for (const part of message.content ?? []) {
			if (part.type !== "text") {
				nonTextBytes += bytes(part);
				continue;
			}
			const text = part.text;
			for (const target of targets) target.textBytes += bytes(text);
			for (const line of text.split(/\r?\n/)) {
				const size = bytes(line);
				if (size <= 40) continue;
				const category = categoryOf(line);
				byCategory[category] ??= row();
				byCategory[category].textBytes += size;
				const previous = seen.get(line);
				for (const target of [...targets, byCategory[category]]) {
					target.eligibleBytes += size;
					if (previous !== undefined) {
						target.repeatedBytes += size;
						target.repeatedLines++;
						if (previous === resultNumber) target.withinResultBytes += size;
					}
				}
				seen.set(line, resultNumber);
			}
			if (source !== "cosmic") continue;
			promptByTool[tool] ??= { ...Object.fromEntries(Object.keys(prompt).map((k) => [k, 0])) };
			const add = (group, n) => {
				prompt[group] += n;
				promptByTool[tool][group] += n;
			};
			const walk = (value) => {
				if (value === null || typeof value !== "object") return;
				for (const [key, child] of Object.entries(value)) {
					const group = fieldGroup(key);
					if (group) add(group, bytes(JSON.stringify(child)));
					else walk(child);
				}
			};
			// A capsule is its own rendered text block. Do not count arbitrary prose as a reminder.
			if (/^#{1,2} Knowledge Capsule\b/.test(text)) add("capsule", bytes(text));
			else {
				try {
					walk(JSON.parse(text));
				} catch {
					unparsedCosmicBytes += bytes(text);
				}
			}
		}
	}
	return {
		version: INTAKE_VERSION,
		minimumLineBytesExclusive: 40,
		total,
		byTool,
		bySource,
		byCategory,
		nonTextBytes,
		compactions,
		prompt: {
			fields: prompt,
			byTool: promptByTool,
			measuredBytes: Object.values(prompt).reduce((n, v) => n + v, 0),
			unparsedCosmicBytes,
		},
		// Session logs do not retain the complete model request. Current-source snapshots are separate.
		resident: { system: null, tools: null, skills: null },
	};
}

export function summarizeIntake(intakes) {
	const merge = (objects) => {
		const out = {};
		for (const object of objects)
			for (const [key, value] of Object.entries(object)) {
				if (typeof value === "number") out[key] = (out[key] ?? 0) + value;
				else out[key] = merge([out[key] ?? {}, value]);
			}
		return out;
	};
	return {
		version: INTAKE_VERSION,
		...merge(
			intakes.map((m) => ({
				total: m.total,
				byTool: m.byTool,
				bySource: m.bySource,
				byCategory: m.byCategory,
				nonTextBytes: m.nonTextBytes,
				compactions: m.compactions,
				prompt: m.prompt,
			})),
		),
	};
}

export function measureSession(records) {
	const calls = [],
		results = new Map(),
		modelCalls = [];
	let userAt = null,
		boundary = 0,
		lastAt = null;
	let branched = false;
	const children = new Map();
	for (const entry of records) {
		if (entry.parentId) {
			const n = (children.get(entry.parentId) ?? 0) + 1;
			children.set(entry.parentId, n);
			if (n > 1) branched = true;
		}
		lastAt = ms(entry.timestamp) ?? lastAt;
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "user") {
			userAt ??= ms(entry.timestamp);
			boundary++;
		}
		if (message.role === "toolResult") results.set(message.toolCallId, { message, at: ms(entry.timestamp) });
		if (message.role !== "assistant") continue;
		if (message.usage) {
			const u = message.usage;
			const known = [u.input, u.cacheRead, u.cacheWrite].every((v) => typeof v === "number");
			const input = known ? u.input + u.cacheRead + u.cacheWrite : null;
			modelCalls.push({
				at: entry.timestamp,
				model: message.model ?? null,
				inputTokens: input,
				cacheRead: u.cacheRead ?? null,
				cacheHitRate: input > 0 ? u.cacheRead / input : null,
				contextTokens: input === null || typeof u.output !== "number" ? null : input + u.output,
			});
		}
		for (const p of Array.isArray(message.content) ? message.content : []) {
			if (p.type !== "toolCall") continue;
			calls.push({
				seq: calls.length + 1,
				id: p.id,
				tool: p.name,
				args: p.arguments ?? {},
				at: ms(entry.timestamp),
				boundary,
			});
		}
	}
	const counts = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((k) => [k, 0]));
	const reads = {},
		intents = {},
		failures = {};
	const cosmic = { result: 0, internalPath: 0, budget: 0, notes: 0 };
	const cosmicByTool = {};
	let firstProgress = null,
		firstAction = null,
		run = null;
	let longest = { calls: 0, elapsedMs: 0, from: null, to: null };
	const stallRuns = [];
	const closeRun = (end) => {
		if (!run) return;
		const candidate = { calls: run.calls, elapsedMs: elapsed(run.at, end), from: run.from, to: run.to };
		if (candidate.calls > longest.calls) longest = candidate;
		stallRuns.push({ ...candidate, boundary: run.boundary });
		run = null;
	};
	// Stall context lives as long as one no-progress run: a repeat or a retry means "again since
	// the last step forward". Output targets live for the whole session.
	const outputs = [];
	let seen = new Set(),
		failedOps = new Set(),
		stallBoundary = null;
	const details = calls.map((call) => {
		const result = results.get(call.id),
			state = resultState(result?.message, call.tool);
		const classification = classifyCall(call.tool, call.args);
		const category = state.state === "failure" ? "failure" : classification.category;
		counts[category]++;
		const payloadBytes = result
			? (result.message.content ?? []).reduce((n, p) => n + (p.type === "text" ? bytes(p.text) : bytes(p)), 0)
			: 0;
		if (["read", "bash"].includes(call.tool)) {
			reads[classification.readKind] ??= { calls: 0, bytes: 0 };
			const row = reads[classification.readKind];
			row.calls++;
			row.bytes += payloadBytes;
		}
		if (classification.internalRead) {
			intents[classification.fileIntent] ??= { calls: 0, sequences: [] };
			const row = intents[classification.fileIntent];
			row.calls++;
			row.sequences.push(call.seq);
		}
		if (state.state === "failure") {
			failures[state.code] ??= { calls: 0, sequences: [] };
			const row = failures[state.code];
			row.calls++;
			row.sequences.push(call.seq);
		}
		if (call.tool.startsWith("cosmic_")) {
			cosmicByTool[call.tool] ??= { calls: 0, bytes: 0 };
			cosmicByTool[call.tool].calls++;
			cosmicByTool[call.tool].bytes += payloadBytes;
		}
		if (call.tool.startsWith("cosmic_") && result) {
			const partition = cosmicPayload(result.message.content);
			for (const k of Object.keys(cosmic)) cosmic[k] += partition[k];
		}
		const progress = classification.progress && state.state === "success";
		if (stallBoundary !== call.boundary) {
			seen = new Set();
			failedOps = new Set();
			stallBoundary = call.boundary;
		}
		const exact = JSON.stringify([call.tool, call.args]),
			op = operationKey(call.tool, call.args);
		const where = normalized(
			call.tool === "bash" ? call.args.command : (call.args.path ?? call.args.filePath ?? call.args.file),
		);
		const stallKind = progress
			? null
			: stallKindOf(classification, state, {
					failedBefore: failedOps.has(op),
					seenBefore: seen.has(exact),
					ownOutput: ["read", "bash"].includes(call.tool) && outputs.some((dir) => where.includes(dir)),
				});
		if (progress) {
			seen = new Set();
			failedOps = new Set();
		} else {
			seen.add(exact);
			if (state.state === "failure") failedOps.add(op);
		}
		if (state.state !== "failure") outputs.push(...outputTargets(call.tool, call.args));
		if (progress && firstProgress === null) firstProgress = { seq: call.seq, elapsedMs: elapsed(userAt, call.at) };
		if (progress && classification.category === "action" && firstAction === null)
			firstAction = { seq: call.seq, elapsedMs: elapsed(userAt, call.at) };
		// User turns bound an episode but do not themselves count as agent progress.
		if (run && run.boundary !== call.boundary) closeRun(run.end);
		if (progress) closeRun(call.at);
		else {
			run ??= { calls: 0, at: call.at, from: call.seq, boundary: call.boundary };
			run.calls++;
			run.to = call.seq;
			run.end = result?.at ?? call.at;
		}
		return {
			seq: call.seq,
			tool: call.tool,
			at: call.at,
			end: result?.at ?? null,
			boundary: call.boundary,
			category,
			activity: classification.category,
			progress,
			stallKind,
			state: state.state,
			code: state.code,
			...Object.fromEntries(Object.entries(classification).filter(([k]) => !["category", "progress"].includes(k))),
			payloadBytes,
			operation: operationKey(call.tool, call.args),
		};
	});
	closeRun(run?.end ?? lastAt);
	const stall = stallBreakdown(details, stallRuns);
	const recovery = details
		.filter((c) => c.state === "failure")
		.map((failed) => {
			const match = details.find(
				(c) =>
					c.seq > failed.seq &&
					c.at >= failed.end &&
					c.boundary === failed.boundary &&
					c.operation === failed.operation &&
					c.state === "success",
			);
			return {
				seq: failed.seq,
				code: failed.code,
				recoveredAt: match?.seq ?? null,
				callsUntilSuccess: match ? match.seq - failed.seq : null,
				elapsedMs: match ? elapsed(failed.end, match.end) : null,
			};
		});
	const knownUsage = modelCalls.filter((c) => c.inputTokens !== null);
	const knownContext = modelCalls.filter((c) => c.contextTokens !== null);
	const inputTotal = knownUsage.reduce((n, c) => n + c.inputTokens, 0);
	return {
		version: METRIC_VERSION,
		intake: measureIntake(records),
		unit: "UTF-8 payload bytes (text content, no message wrapper)",
		startedAt: userAt,
		elapsedMs: elapsed(userAt, lastAt),
		calls: calls.length,
		counts,
		firstProgress,
		firstAction,
		longestNoProgress: longest,
		stall,
		recovery,
		reads,
		cosmic,
		intents,
		failures,
		internalReads: details.filter((c) => c.internalRead).length,
		pythonJsonReads: details.filter((c) => c.pythonJson).length,
		toolOutputReads: toolOutputReads(details),
		cosmicByTool,
		broadSearches: details.filter((c) => c.broad).length,
		uncertainCalls: details.filter((c) => c.uncertain).map((c) => c.seq),
		missingResults: details.filter((c) => c.state === "missing").map((c) => c.seq),
		branched,
		modelUsage: {
			calls: modelCalls,
			cacheHitRate: inputTotal ? knownUsage.reduce((n, c) => n + c.cacheRead, 0) / inputTotal : null,
			peakContextTokens: knownContext.length ? Math.max(...knownContext.map((c) => c.contextTokens)) : null,
		},
		details: details.map(({ operation, ...rest }) => rest),
	};
}

/** Kinds per no-progress call, overall and for each run of at least STALL_RUN_MIN calls. */
export const STALL_RUN_MIN = 15;
function stallBreakdown(details, runs) {
	const tally = (rows) => {
		const out = Object.fromEntries(Object.keys(STALL_LABELS).map((k) => [k, 0]));
		for (const row of rows) if (row.stallKind) out[row.stallKind]++;
		return out;
	};
	return {
		version: STALL_VERSION,
		runMin: STALL_RUN_MIN,
		kinds: tally(details),
		runs: runs
			.filter((r) => r.calls >= STALL_RUN_MIN)
			.map((r) => ({ ...r, kinds: tally(details.filter((d) => d.seq >= r.from && d.seq <= r.to)) })),
	};
}

/** The model going around the tools to reread what they already wrote (raw output, exports). */
function toolOutputReads(details) {
	const rows = details.filter((c) => c.toolOutput);
	return {
		calls: rows.length,
		bytes: rows.reduce((n, c) => n + c.payloadBytes, 0),
		python: rows.filter((c) => c.python).length,
		showControl: rows.filter((c) => c.showControl).length,
		withWrite: rows.filter((c) => c.toolOutputWrite).length,
		sequences: rows.map((c) => c.seq),
	};
}

export function summarizeMetrics(sessions) {
	const sum = (pick) => sessions.reduce((n, s) => n + pick(s), 0);
	const ranking = (key) => {
		const map = new Map();
		for (const [index, session] of sessions.entries())
			for (const [name, value] of Object.entries(session[key])) {
				const row = map.get(name) ?? { name, calls: 0, sessions: 0, examples: [] };
				row.calls += value.calls;
				row.sessions++;
				row.examples.push({ session: index + 1, sequences: value.sequences.slice(0, 4) });
				map.set(name, row);
			}
		return [...map.values()].sort((a, b) => b.calls - a.calls);
	};
	const median = (values) => {
		const sorted = values.filter((v) => v !== null).sort((a, b) => a - b),
			mid = Math.floor(sorted.length / 2);
		return !sorted.length ? null : sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	};
	const recovery = sessions.flatMap((s) => s.recovery);
	return {
		version: METRIC_VERSION,
		intake: summarizeIntake(sessions.map((s) => s.intake)),
		sessions: sessions.length,
		calls: sum((s) => s.calls),
		counts: Object.fromEntries(Object.keys(CATEGORY_LABELS).map((k) => [k, sum((s) => s.counts[k])])),
		filesystemCalls: sum((s) => Object.values(s.reads).reduce((n, v) => n + v.calls, 0)),
		internalReads: sum((s) => s.internalReads),
		pythonJsonReads: sum((s) => s.pythonJsonReads),
		toolOutputReads: Object.fromEntries(
			["calls", "bytes", "python", "showControl", "withWrite"].map((k) => [k, sum((s) => s.toolOutputReads[k])]),
		),
		broadSearches: sum((s) => s.broadSearches),
		medianFirstProgressMs: median(sessions.map((s) => s.firstProgress?.elapsedMs ?? null)),
		medianLongestNoProgress: median(sessions.map((s) => s.longestNoProgress.calls)),
		maxLongestNoProgress: Math.max(0, ...sessions.map((s) => s.longestNoProgress.calls)),
		stall: {
			version: STALL_VERSION,
			runMin: STALL_RUN_MIN,
			kinds: Object.fromEntries(Object.keys(STALL_LABELS).map((k) => [k, sum((s) => s.stall.kinds[k])])),
			runs: sum((s) => s.stall.runs.length),
			runCalls: sum((s) => s.stall.runs.reduce((n, r) => n + r.calls, 0)),
		},
		recovery: {
			failures: recovery.length,
			matched: recovery.filter((r) => r.recoveredAt !== null).length,
			unknown: recovery.filter((r) => r.recoveredAt === null).length,
			medianCalls: median(recovery.map((r) => r.callsUntilSuccess)),
		},
		intents: ranking("intents"),
		failures: ranking("failures"),
		uncertainCalls: sum((s) => s.uncertainCalls.length),
		missingResults: sum((s) => s.missingResults.length),
	};
}
