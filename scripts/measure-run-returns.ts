/**
 * S63 的尺子：运行和探针的返回里，四样东西各占多少、各出现几次。只读历史会话，不连环境。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-run-returns.ts --dir <会话目录> [--from 日期] [--show] [--json]
 *   node --experimental-strip-types scripts/measure-run-returns.ts <会话.jsonl…> [--show] [--json]
 *
 * 1. 验证记录：`cosmic_run` 的返回一共多少字节，其中「留下的验证记录」那一块占多少；
 *    拿当时模型实际收到的结果信封按现在的字段清单再过一遍，报现在会发多少（和 `measure-model-view.ts` 同一种回放）。
 * 2. 探针自己下结论时的调用栈：断言没过、输入不成立的返回几次，其中末尾带调用栈的几次、栈一共多少字节，
 *    这些里同一条返回被裁了中段的几次（栈占掉尾段，结果行就可能落在被省略的中段）。
 * 3. 临时探针的签名说明：临时探针调用几次、跑成几次；跑成了还附着签名说明的几次、多少字节；
 *    只有标题、没有内容的空卡几张、多少字节。
 * 4. 「没有要交付的改动」：答了几次；其中话里说没有写数据、而这场会话在它之前真提交成过的几次。
 *
 * 每一样改之前、改之后用同一批会话各量一遍。第 1 样的「现在会发」是回放；第 2、3、4 样只数历史上发生过的，
 * 改完要拿新跑的会话再量。口径和基线见 `docs/S63-returns-after-acceptance-session.md` §2。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pruneProbeOutcome } from "../src/agent/tools/probe-manifest.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const show = argv.includes("--show");
const dir = one("--dir");
const from = one("--from");
const files = dir
	? readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl") && (!from || name.slice(0, from.length) >= from))
			.map((name) => join(dir, name))
	: argv.filter((arg) => arg.endsWith(".jsonl"));
if (files.length === 0) {
	console.error(
		"用法：measure-run-returns.ts --dir <会话目录> [--from 日期] [--show] [--json] | <会话.jsonl…> [--show] [--json]",
	);
	process.exit(2);
}

const size = (text: string): number => Buffer.byteLength(text, "utf8");
const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
const pct = (part: number, whole: number): string => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

const total = {
	sessions: files.length,
	evidence: { runs: 0, returnBytes: 0, filedBytes: 0, filedNowBytes: 0, returnNowBytes: 0 },
	verdictStacks: { verdicts: 0, withStack: 0, stackBytes: 0, withStackAndCut: 0 },
	adHocCapsules: { calls: 0, ok: 0, failed: 0, okWithCapsule: 0, okCapsuleBytes: 0, emptyCards: 0, emptyCardBytes: 0 },
	nothingToDeliver: { answers: 0, saidNoDataAfterCommit: 0 },
};
const lines: string[] = [];

interface Call {
	name: string;
	arguments?: Record<string, unknown>;
}

/** 结果信封：第一段开头的那份 JSON；后面跟着的正文块不算在内。 */
function envelopeOf(first: string): { json: Record<string, unknown>; text: string } | null {
	const end = first.indexOf("\n# ");
	const text = end < 0 ? first : first.slice(0, end);
	try {
		return { json: JSON.parse(text) as Record<string, unknown>, text };
	} catch {
		return null;
	}
}

/** `[PROBE-ERR]` 那一行后面属于调用栈的行：异常再打一遍的那行、`at …` 行、把 `at …` 折掉的标记。 */
function stackBytesAfter(output: string, at: number): number {
	const rest = output.slice(output.indexOf("\n", at) + 1).split("\n");
	let bytes = 0;
	for (const line of rest) {
		const stackLine =
			/^\s+at \S/.test(line) ||
			/^（\d+ 行与前面发过的相同：at /.test(line) ||
			/^(java\.lang\.IllegalStateException|ProbeAssert\$\w+): /.test(line);
		if (!stackLine) break;
		bytes += size(line) + 1;
	}
	return bytes;
}

for (const file of files) {
	const calls = new Map<string, Call>();
	let committed = false;
	const where = basename(file).slice(0, 19);
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		if (!raw) continue;
		let entry: { message?: { role?: string; content?: unknown; toolCallId?: string } };
		try {
			entry = JSON.parse(raw);
		} catch {
			continue;
		}
		const message = entry.message;
		if (!message || !Array.isArray(message.content)) continue;
		const parts = message.content as {
			type?: string;
			text?: string;
			id?: string;
			name?: string;
			arguments?: never;
		}[];
		if (message.role === "assistant") {
			for (const part of parts) {
				if (part.type === "toolCall" && part.id)
					calls.set(part.id, { name: part.name ?? "", arguments: part.arguments });
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId ?? "");
		if (!call) continue;
		const text = parts.map((part) => part.text ?? "").join("\n");
		const help = Array.isArray(call.arguments?.argv) && (call.arguments.argv as unknown[])[0] === "help";

		if (call.name === "cosmic_run" && !help) {
			const envelope = envelopeOf(parts[0]?.text ?? "");
			const result = envelope?.json.result;
			if (envelope && typeof result === "object" && result !== null) {
				const record = result as Record<string, unknown>;
				const filed = (record.evidence as { filed?: unknown } | undefined)?.filed;
				const now = { ...envelope.json, result: pruneProbeOutcome(record, { adHoc: "src" in record }) };
				const nowFiled = ((now.result as Record<string, unknown>).evidence as { filed?: unknown } | undefined)
					?.filed;
				const before = size(text);
				const after = before - size(envelope.text) + size(JSON.stringify(now));
				total.evidence.runs++;
				total.evidence.returnBytes += before;
				total.evidence.returnNowBytes += after;
				total.evidence.filedBytes += filed === undefined ? 0 : size(JSON.stringify(filed));
				total.evidence.filedNowBytes += nowFiled === undefined ? 0 : size(JSON.stringify(nowFiled));
			}
			if (/"committed":true/.test(text) || /^\[PROBE\]\s+已落库：/m.test(text)) committed = true;
			if (text.includes("（真提交）") && /isSuccess=true/.test(text)) committed = true;
		}

		if (call.name === "cosmic_run" || call.name === "cosmic_probe") {
			const verdict = /\[PROBE-ERR\] (?:java\.lang\.IllegalStateException: 断言失败|ProbeAssert\$\w+: )/.exec(text);
			if (verdict) {
				total.verdictStacks.verdicts++;
				const bytes = stackBytesAfter(text, verdict.index);
				if (bytes > 0) {
					total.verdictStacks.withStack++;
					total.verdictStacks.stackBytes += bytes;
					const cut = text.includes("中间省略");
					if (cut) total.verdictStacks.withStackAndCut++;
					lines.push(`判定带栈 ${String(bytes)} 字节${cut ? "，返回被裁了中段" : ""}  ${where} ${call.name}`);
				}
			}
		}

		const probeName = String(call.arguments?.name ?? "");
		if (call.name === "cosmic_probe" && probeName.endsWith(".java") && call.arguments?.raw === undefined) {
			total.adHocCapsules.calls++;
			const ok = /"exitCode":0/.test(parts[0]?.text ?? "");
			if (ok) total.adHocCapsules.ok++;
			else total.adHocCapsules.failed++;
			const at = text.indexOf("# Knowledge Capsule");
			if (at >= 0) {
				const cards = text.slice(at);
				if (ok) {
					total.adHocCapsules.okWithCapsule++;
					total.adHocCapsules.okCapsuleBytes += size(cards);
					lines.push(`跑成了还附签名说明 ${String(size(cards))} 字节  ${where} ${probeName}`);
				}
				for (const card of cards.split(/\n(?=## Knowledge Capsule)/)) {
					if (card.includes("这里只列新出现的") && !/^(签名|要点):/m.test(card)) {
						total.adHocCapsules.emptyCards++;
						total.adHocCapsules.emptyCardBytes += size(card);
					}
				}
			}
		}

		if (call.name === "cosmic_verify" && text.includes("没有要交付的改动")) {
			total.nothingToDeliver.answers++;
			if (text.includes("没有写元数据或数据") && committed) {
				total.nothingToDeliver.saidNoDataAfterCommit++;
				lines.push(`说没有写数据，之前真提交成过  ${where}`);
			}
		}
	}
}

if (argv.includes("--json")) {
	console.log(JSON.stringify(total, null, 2));
} else {
	const e = total.evidence;
	const v = total.verdictStacks;
	const a = total.adHocCapsules;
	const n = total.nothingToDeliver;
	console.log(`会话 ${String(total.sessions)} 份`);
	console.log(
		`1 验证记录：cosmic_run ${String(e.runs)} 次，返回共 ${kb(e.returnBytes)}；其中验证记录 ${kb(e.filedBytes)}（${pct(e.filedBytes, e.returnBytes)}）。` +
			`按现在的字段清单：验证记录 ${kb(e.filedNowBytes)}，返回共 ${kb(e.returnNowBytes)}，少 ${kb(e.returnBytes - e.returnNowBytes)}（${pct(e.returnBytes - e.returnNowBytes, e.returnBytes)}）`,
	);
	console.log(
		`2 探针自己下结论（断言没过、输入不成立）的返回 ${String(v.verdicts)} 次；末尾带调用栈的 ${String(v.withStack)} 次，栈共 ${kb(v.stackBytes)}；` +
			`其中返回同时被裁了中段的 ${String(v.withStackAndCut)} 次`,
	);
	console.log(
		`3 临时探针 ${String(a.calls)} 次（跑成 ${String(a.ok)}、没跑成 ${String(a.failed)}）；跑成了还附签名说明的 ${String(a.okWithCapsule)} 次、共 ${kb(a.okCapsuleBytes)}；` +
			`只有标题的空卡 ${String(a.emptyCards)} 张、${kb(a.emptyCardBytes)}`,
	);
	console.log(
		`4 「没有要交付的改动」答了 ${String(n.answers)} 次；其中说没有写数据、而之前真提交成过的 ${String(n.saidNoDataAfterCommit)} 次`,
	);
	if (show) for (const line of lines) console.log(`  ${line}`);
}
