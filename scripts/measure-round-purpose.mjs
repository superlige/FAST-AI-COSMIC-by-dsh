#!/usr/bin/env node
import { basename } from "node:path";
/**
 * 一次会话的「轮」花在哪类事上（2026-10-08 分析「一个简单需求为什么要四五十次调用」时写的）。
 *
 * 用法：
 *   node scripts/measure-round-purpose.mjs <会话.jsonl> [更多会话…] [--rounds] [--json]
 *   --rounds 逐轮列出：第几轮、用途、调用数、参数前 100 字，给人对着复核分类。
 *
 * 口径：
 *   - 轮 = 一条带工具调用的模型消息。每轮之间模型要想一次，轮数比调用数更接近耗时。
 *     同一轮并行发的几次调用按调用数平均摊这一轮，所以各用途的轮数可以是小数，加起来等于总轮数。
 *   - 时间 = 这一轮的模型时间（上一批返回 → 这条消息）+ 工具时间（这条消息 → 它最后一个返回），
 *     和 measure-session-time.mjs 同一口径，同样按调用数摊。
 *   - 用途按调用本身分（purposeOf）：
 *       开工程；
 *       查元数据 = 只读探针（字段、操作、布局、规则、插件登记、库表列）、cosmic_meta、cosmic_impact、cosmic_runtime；
 *       读要改的代码 = read/bash 里提到本会话后来 edit/write 的那几个文件名；
 *       翻工程找写法 = 其余 read/bash 里看 .java 或 grep/find 工程（基类、常量类、别处怎么写）；
 *       查工具用法 = cosmic_run help、cosmic_knowledge probes、命令带 --help；
 *       读技能文档 = read/bash 进 fast-ai-cosmic 缓存里的技能原文（skills/、families/），技能本来就这么加载；
 *       翻工具源码 = read/bash 进缓存里的探针源码或本仓库：工具的结果没说清，模型去看工具是怎么判的；
 *       查平台知识 = cosmic_knowledge 的 api / search / show / findclass，bash 里用 javap 读平台 jar；
 *       翻工具产物 = read/bash 进工程 .cosmic-ai/（验证记录、落盘输出、备份）或缓存里的 probe-runs/（探针原始输出）；
 *       找测试数据 = DataQueryProbe / DataProbe（查平台配置表的除外，那算查元数据）；
 *       造改数据 = DataSeedProbe / DataUpdateProbe；
 *       临时探针 = 名字不在开工程回执 releasedProbes 里的探针，或写进 .cosmic-ai/probes/ 的文件；
 *       写代码编译 = 其余 edit / write、cosmic_fast；
 *       跑验证 = cosmic_run（help 以外）；交付 = cosmic_verify；问用户 = ask_question / cosmic_authorize；
 *       其他 = 剩下的。
 *   - 动手前 / 动手后 以第一次「写代码编译」为界。
 *   - 验证来回 = 动手后「造改数据」「找测试数据」和「跑验证」之间切换的次数：改一下数据、跑一次、再改回，
 *     每切一次就是模型要等上一步的结果才能发下一步。
 *   - 失败 = 工具返回标了 isError 的调用；原样重发 = 工具名和参数和本会话更早的某次一字不差。
 *   - 模型 / 工具时间分开记：模型 = 上一批返回 → 这条消息，工具 = 这条消息 → 它最后一个返回。
 * 只读会话记录，不改任何东西。
 */
import { readSessionRecords } from "./session-reader.mjs";

const argv = process.argv.slice(2);
const files = argv.filter((arg) => !arg.startsWith("--"));
const asJson = argv.includes("--json");
const listRounds = argv.includes("--rounds");
if (files.length === 0) {
	console.error("用法：node scripts/measure-round-purpose.mjs <会话.jsonl>… [--rounds] [--json]");
	process.exit(2);
}

const PURPOSES = [
	"开工程",
	"查元数据",
	"读要改的代码",
	"翻工程找写法",
	"查工具用法",
	"读技能文档",
	"翻工具源码",
	"查平台知识",
	"翻工具产物",
	"找测试数据",
	"造改数据",
	"临时探针",
	"写代码编译",
	"跑验证",
	"交付",
	"问用户",
	"其他",
];
const VERIFY_LOOP = new Set(["造改数据", "找测试数据", "跑验证"]);

const textOf = (content) =>
	Array.isArray(content) ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "";

function measure(file) {
	// 早期会话里偶有半截写坏的行（进程被杀时正在写），跳过并在结果里报行数
	const { records: entries, broken: badLines } = readSessionRecords(file);
	const at = (entry) => Date.parse(entry.timestamp);
	const results = new Map();
	const released = new Set();
	const edited = new Set();
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "toolResult") {
			results.set(message.toolCallId, entry);
			if (message.toolName === "cosmic_open_project") {
				const match = /"releasedProbes":\[([^\]]*)\]/.exec(textOf(message.content));
				for (const name of match?.[1].match(/[A-Za-z0-9_]+/g) ?? []) released.add(name);
			}
		}
		if (message?.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (part.type !== "toolCall" || !["edit", "write"].includes(part.name)) continue;
			const path = String(part.arguments?.path ?? "").replace(/\\/g, "/");
			if (!path.includes(".cosmic-ai/")) edited.add(basename(path));
		}
	}

	const purposeOf = (name, args) => {
		const text = String(args.command ?? args.path ?? "").replace(/\\/g, "/");
		const argList = Array.isArray(args.argv) ? args.argv.map(String) : [];
		switch (name) {
			case "cosmic_open_project":
				return "开工程";
			case "ask_question":
			case "cosmic_authorize":
				return "问用户";
			case "cosmic_verify":
			case "cosmic_facts":
				return "交付";
			case "cosmic_fast":
				return "写代码编译";
			case "cosmic_run":
				return argList[0] === "help" || argList.includes("--help") ? "查工具用法" : "跑验证";
			case "cosmic_meta":
				return argList[0] === "help" || argList.includes("--help") ? "查工具用法" : "查元数据";
			case "cosmic_impact":
			case "cosmic_runtime":
				return "查元数据";
			case "cosmic_knowledge":
				return args.action === "probes" ? "查工具用法" : "查平台知识";
			case "edit":
			case "write":
				return text.includes(".cosmic-ai/probes/") ? "临时探针" : "写代码编译";
			case "cosmic_probe": {
				const probe = String(args.name ?? "");
				if (/^Data(Query|)Probe$/.test(probe)) {
					const entity = String(args.env?.QUERY_ENTITY ?? args.env?.DATA_ENTITY ?? "");
					return /^(openapi_|bos_devportal_|bos_formmeta|wf_model)/.test(entity) ? "查元数据" : "找测试数据";
				}
				if (/^Data(Seed|Update)Probe$/.test(probe)) return "造改数据";
				if (probe.includes("/") || (released.size > 0 && !released.has(probe))) return "临时探针";
				return "查元数据";
			}
			case "read":
			case "bash": {
				if (/\.fast-ai-cosmic/.test(text) && /\/(skills|families)\/|SKILL\.md/.test(text)) return "读技能文档";
				if (/\.fast-ai-cosmic/.test(text) && /probe-runs/.test(text)) return "翻工具产物";
				if (/\.fast-ai-cosmic|claudecode\/pi/.test(text)) return "翻工具源码";
				if (/\.cosmic-ai\//.test(text)) return "翻工具产物";
				if (/javap|\.jar\b/.test(text)) return "查平台知识";
				for (const file of edited) if (text.includes(file)) return "读要改的代码";
				if (/\.java\b|grep|find |\bls\b|sed -n|cat /.test(text)) return "翻工程找写法";
				return "其他";
			}
			default:
				return "其他";
		}
	};

	const purposes = Object.fromEntries(
		PURPOSES.map((p) => [p, { rounds: 0, calls: 0, seconds: 0, failed: 0, repeated: 0 }]),
	);
	const listing = [];
	const seenCalls = new Set();
	let modelTotal = 0;
	let toolTotal = 0;
	let previousEnd = null;
	let rounds = 0;
	let parallelRounds = 0;
	let calls = 0;
	let wrote = false;
	const phase = { 动手前: { rounds: 0, calls: 0, seconds: 0 }, 动手后: { rounds: 0, calls: 0, seconds: 0 } };
	let lastLoopSide = null;
	let loopSwitches = 0;
	const start = at(entries[0]);
	let end = start;
	for (const entry of entries) {
		const message = entry.message;
		if (message === undefined) continue;
		end = Math.max(end, at(entry));
		if (message.role === "user") {
			previousEnd = at(entry);
			continue;
		}
		if (message.role !== "assistant") continue;
		const parts = (message.content ?? []).filter((part) => part.type === "toolCall");
		let lastResult = at(entry);
		for (const part of parts) {
			const result = results.get(part.id);
			if (result !== undefined) lastResult = Math.max(lastResult, at(result));
		}
		const modelSeconds = previousEnd === null ? 0 : (at(entry) - previousEnd) / 1000;
		const seconds = modelSeconds + (lastResult - at(entry)) / 1000;
		previousEnd = lastResult;
		if (parts.length === 0) continue;
		modelTotal += modelSeconds;
		toolTotal += seconds - modelSeconds;
		rounds++;
		calls += parts.length;
		if (parts.length > 1) parallelRounds++;
		const names = parts.map((part) => purposeOf(part.name, part.arguments ?? {}));
		const side = phase[wrote || names.includes("写代码编译") ? "动手后" : "动手前"];
		side.rounds++;
		side.calls += parts.length;
		side.seconds += seconds;
		if (names.includes("写代码编译")) wrote = true;
		names.forEach((name, i) => {
			const slot = purposes[name];
			slot.rounds += 1 / names.length;
			slot.calls++;
			slot.seconds += seconds / names.length;
			if (results.get(parts[i].id)?.message.isError === true) slot.failed++;
			const key = `${parts[i].name} ${JSON.stringify(parts[i].arguments ?? {})}`;
			if (seenCalls.has(key)) slot.repeated++;
			seenCalls.add(key);
		});
		if (wrote) {
			const loop = names.filter((name) => VERIFY_LOOP.has(name));
			if (loop.length > 0) {
				const now = loop.includes("跑验证") ? "跑" : "备数据";
				if (lastLoopSide !== null && now !== lastLoopSide) loopSwitches++;
				lastLoopSide = now;
			}
		}
		if (listRounds) {
			listing.push(
				`${String(rounds).padStart(3)}  ${Math.round(seconds).toString().padStart(4)}s  ${names.join("+")}  | ` +
					parts
						.map((part) => {
							const args = part.arguments ?? {};
							return String(args.command ?? args.path ?? JSON.stringify(args))
								.replace(/\s+/g, " ")
								.slice(0, 100);
						})
						.join(" ‖ "),
			);
		}
	}
	return {
		session: basename(file).slice(0, 19),
		minutes: Number(((end - start) / 60000).toFixed(1)),
		rounds,
		calls,
		parallelRounds,
		badLines,
		modelMinutes: Number((modelTotal / 60).toFixed(1)),
		toolMinutes: Number((toolTotal / 60).toFixed(1)),
		phase,
		purposes,
		verifyLoopSwitches: loopSwitches,
		listing,
	};
}

const sessions = files.map(measure);
if (asJson) {
	console.log(JSON.stringify(sessions, null, 2));
	process.exit(0);
}
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const total = Object.fromEntries(PURPOSES.map((p) => [p, { rounds: 0, calls: 0, seconds: 0, failed: 0, repeated: 0 }]));
for (const s of sessions) {
	console.log(
		`${s.session}  ${s.minutes} 分钟（模型 ${s.modelMinutes} 工具 ${s.toolMinutes}） ${s.rounds} 轮 ${s.calls} 次（并发发了几次的轮 ${s.parallelRounds}）${s.badLines > 0 ? `（跳过坏行 ${s.badLines}）` : ""}` +
			` | 动手前 ${s.phase.动手前.rounds} 轮 动手后 ${s.phase.动手后.rounds} 轮 | 验证来回 ${s.verifyLoopSwitches}`,
	);
	const parts = PURPOSES.filter((p) => s.purposes[p].calls > 0).map(
		(p) => `${p} ${fmt(s.purposes[p].rounds)}轮/${s.purposes[p].calls}次`,
	);
	console.log(`    ${parts.join("  ")}`);
	for (const line of s.listing) console.log(`    ${line}`);
	for (const p of PURPOSES) {
		total[p].rounds += s.purposes[p].rounds;
		total[p].calls += s.purposes[p].calls;
		total[p].seconds += s.purposes[p].seconds;
		total[p].failed += s.purposes[p].failed;
		total[p].repeated += s.purposes[p].repeated;
	}
}
if (sessions.length > 1) {
	const rounds = sessions.reduce((sum, s) => sum + s.rounds, 0);
	const calls = sessions.reduce((sum, s) => sum + s.calls, 0);
	const seconds = PURPOSES.reduce((sum, p) => sum + total[p].seconds, 0);
	const model = sessions.reduce((sum, s) => sum + s.modelMinutes, 0);
	console.log(
		`\n合计 ${sessions.length} 份：${rounds} 轮、${calls} 次、${(seconds / 60).toFixed(1)} 分钟（有调用的轮；其中模型想 ${model.toFixed(1)} 分钟）`,
	);
	for (const p of PURPOSES) {
		if (total[p].calls === 0) continue;
		console.log(
			`  ${p.padEnd(8, "　")} ${fmt(total[p].rounds).padStart(6)} 轮（${((total[p].rounds / rounds) * 100).toFixed(0).padStart(2)}%）` +
				` ${String(total[p].calls).padStart(4)} 次  ${(total[p].seconds / 60).toFixed(1).padStart(5)} 分钟（${((total[p].seconds / seconds) * 100).toFixed(0).padStart(2)}%）` +
				`  失败 ${total[p].failed}  原样重发 ${total[p].repeated}`,
		);
	}
}
