/**
 * 尺子：本机没起调度时提交的单，后来被「单据已在流程中流转」拦了几次，查流程状态又是怎么说的。
 *
 *   node scripts/measure-wf-start-stuck.mjs --dir <会话目录> [--from 日期] [--show]
 *   node scripts/measure-wf-start-stuck.mjs <会话.jsonl…> [--show]
 *
 * 平台提交时先建一条「发起审批流」的后台任务交给调度派发；本机常驻进程默认不起调度，派不出去，
 * 任务留在库里，锁到期（约 10 分钟）后由环境的调度接手。在那之前平台按「在流程中」处理这张单，
 * 审核、撤销这类操作被「单据已在流程中流转」拦下（反编译 `InProcessValidator` → `GetInProcessDataEntityCmd` 核过）。
 *
 * 数四样，按会话分别数再加总：
 * - 「调度服务已停止」：返回里出现这句的运行几次；其中落了库的（有 committed 场景）几次、日志里认得出是发起审批流任务（address-process）的几次；
 * - 「在流程中流转」被拦：几次；其中同一张单（按 --pk）在同一会话里之前出现过「调度服务已停止」的几次，离那次多久；
 * - 「@流程」说不在流程：DataQueryProbe 的 @流程 给出「不在流程」、而同一张单在这前后 15 分钟内被「在流程中流转」拦过的几次（两边打架）；
 * - 照返回那句「加 --schedule 重跑」：之前那次已经落库、后来对同一张单带 --schedule 又跑同一个操作的几次。
 *
 * 只读会话文件。按 --pk 认单；没给 --pk 的（新建单、按编号）认不出是哪张，不算进「同一张单」。`--show` 逐条列出。
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const argv = process.argv.slice(2);
const one = (name) => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const dir = one("--dir");
const from = one("--from");
const show = argv.includes("--show");
const files =
	dir === undefined
		? argv.filter((arg) => arg.endsWith(".jsonl"))
		: readdirSync(dir)
				.filter((name) => name.endsWith(".jsonl") && (from === undefined || name.slice(0, 10) >= from))
				.sort()
				.map((name) => join(dir, name));
if (files.length === 0) {
	console.error("用法：measure-wf-start-stuck.mjs --dir <会话目录> [--from 日期] [--show] | <会话.jsonl…>");
	process.exit(2);
}

const STOPPED = /SCHEDULE_SERVER_STOPED|调度服务已停止/;
const IN_PROCESS = /单据已在流程中流转/;
const NOT_IN_FLOW = /@流程=不在流程/;
const WINDOW_MS = 15 * 60 * 1000;

function textOf(content) {
	return Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : String(content ?? "");
}

/** 调用参数里的 argv（cosmic_run）或 env（cosmic_probe）。 */
function callInfo(name, args) {
	if (name === "cosmic_run") {
		const words = (args?.argv ?? []).map(String);
		const at = words.indexOf("--pk");
		return {
			kind: "run",
			op: words[0] === "op" ? words[2] : words[0],
			entity: words[1],
			pk: at >= 0 ? words[at + 1] : undefined,
			schedule: words.includes("--schedule"),
			words,
		};
	}
	if (name === "cosmic_probe") return { kind: "probe", probe: args?.name, env: args?.env ?? {} };
	return { kind: "other" };
}

function committedPks(text) {
	const out = new Set();
	for (const m of text.matchAll(/"t":"scenario"[^}]*?"pk":"(\d+)"[^}]*?"committed":true/g)) out.add(m[1]);
	return out;
}

const total = {
	files: 0,
	stopped: 0,
	stoppedCommitted: 0,
	stoppedWf: 0,
	blocked: 0,
	blockedAfterStop: 0,
	contradict: 0,
	rerun: 0,
};
const shown = [];
for (const file of files) {
	const lines = readFileSync(file, "utf8").split("\n");
	const calls = new Map();
	const stops = []; // { pk, at, op }
	const blocks = []; // { pk, at }
	const notInFlow = []; // { pks, at }
	let touched = false;
	for (const line of lines) {
		if (!line) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const message = entry.message;
		if (!message) continue;
		const at = Date.parse(entry.timestamp ?? "") || 0;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "toolCall") calls.set(part.id, callInfo(part.name, part.arguments));
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const info = calls.get(message.toolCallId) ?? { kind: "other" };
		const text = textOf(message.content);
		if (STOPPED.test(text) && info.kind !== "other") {
			touched = true;
			total.stopped++;
			const pks = committedPks(text);
			if (pks.size > 0) total.stoppedCommitted++;
			if (/address-process/.test(text)) total.stoppedWf++;
			for (const pk of pks.size > 0 ? pks : info.pk ? [info.pk] : []) {
				stops.push({ pk, at, op: info.op, committed: pks.has(pk) });
			}
		}
		if (info.kind === "run" && info.schedule && info.pk) {
			const earlier = stops.find(
				(stop) => stop.pk === info.pk && stop.op === info.op && stop.committed && stop.at < at,
			);
			if (earlier) {
				total.rerun++;
				shown.push(
					`${basename(file)}  照提示带 --schedule 重跑 ${info.op} --pk ${info.pk}（离上次 ${Math.round((at - earlier.at) / 1000)} 秒）`,
				);
			}
		}
		if (IN_PROCESS.test(text) && info.kind === "run") {
			touched = true;
			total.blocked++;
			blocks.push({ pk: info.pk, at });
			const stop = info.pk ? stops.filter((s) => s.pk === info.pk && s.at <= at).pop() : undefined;
			if (stop) {
				total.blockedAfterStop++;
				shown.push(
					`${basename(file)}  ${info.op} --pk ${info.pk} 被「在流程中流转」拦下，离本机没起调度的那次 ${stop.op} ${Math.round((at - stop.at) / 1000)} 秒`,
				);
			} else
				shown.push(
					`${basename(file)}  ${info.op} --pk ${info.pk ?? "(无)"} 被「在流程中流转」拦下，同会话里没找到同一张单没起调度的那次`,
				);
		}
		if (info.kind === "probe" && info.probe === "DataQueryProbe" && NOT_IN_FLOW.test(text)) {
			const pks = [];
			for (const row of text.split("\n")) {
				const m = /id=(\d+)[^\n]*@流程=不在流程/.exec(row);
				if (m) pks.push(m[1]);
			}
			notInFlow.push({ pks, at });
		}
	}
	for (const query of notInFlow) {
		for (const pk of query.pks) {
			const block = blocks.find((b) => b.pk === pk && Math.abs(b.at - query.at) <= WINDOW_MS);
			if (block) {
				total.contradict++;
				shown.push(
					`${basename(file)}  @流程 说 ${pk} 不在流程，${Math.round((query.at - block.at) / 1000)} 秒前/后审核被「在流程中流转」拦下`,
				);
			}
		}
	}
	if (touched) total.files++;
}

console.log(`会话 ${files.length} 份，涉及的 ${total.files} 份`);
console.log(
	`「调度服务已停止」：${total.stopped} 次运行；其中落了库的 ${total.stoppedCommitted} 次，认得出是发起审批流任务的 ${total.stoppedWf} 次`,
);
console.log(
	`「单据已在流程中流转」被拦：${total.blocked} 次；其中同一张单之前本机没起调度提交过的 ${total.blockedAfterStop} 次`,
);
console.log(`@流程 说「不在流程」、前后 15 分钟内同一张单却被「在流程中流转」拦下：${total.contradict} 次`);
console.log(`已落库又照提示带 --schedule 对同一张单重跑同一操作：${total.rerun} 次`);
if (show) for (const row of shown) console.log(`  ${row}`);
