#!/usr/bin/env node

/**
 * 收敛提醒的离线判据（S36 批 4）：几种"只查不动到一定程度就提醒"的触发规则，放到批 0 的 19 份
 * 真机会话上各会在哪里触发，触发那一刻模型实际在干什么。
 *
 * 只读会话，不改任何东西，也不代表运行期真有这条提醒。每个触发点的"当时在干什么"是人工看了
 * 触发点前后的调用和模型思考后标的（下面 LABELS），脚本只负责把规则算出来、把标注对上；
 * 没标注的触发点照实报"未标注"，不猜。
 *
 * 用法：
 *   node scripts/measure-stall-trigger.mjs [--dir 会话目录] [--json]
 *
 * 样本口径同批 0：文件名 UTC 日期 2026-09-17～2026-09-21、大于 200,000 字节，按文件名排序。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { measureSession } from "./session-metrics.mjs";

const DEFAULT_DIR = "C:/Users/Lige/.pi/agent/sessions/--D--kingdee-zlgd_ygpt2.0--";
const FROM = "2026-09-17",
	TO = "2026-09-21",
	MIN_BYTES = 200000;

/** 触发那一刻模型在干什么。只有 decision 一类是提醒"该问用户了"能帮上的；其余要么提醒是噪声，
 * 要么缺的是工具没给的事实或能力，提醒补不上。 */
const LABEL_TEXT = {
	normal: "正常推进中（调查、设计、动手前核对）",
	toolFact: "在挖工具没直接给的事实（自己解析导出、翻旧产物、量渲染）",
	toolLimit: "撞到工具限制或拒绝后在绕、在查工具",
	testData: "找或凑验证用的数据",
	wait: "等环境（写锁）",
	decision: "已发现待定业务口径，还没问用户",
};

/** 键是会话文件名前缀（UTC 时间戳），值是 { 调用序号: [类别, 依据] }。 */
const LABELS = {
	"2026-09-17T02-25-41-984": {
		15: ["normal", "方案已定，#18 自己提问"],
		33: ["normal", "学 SDK 用法、读说明"],
		53: ["toolLimit", "run 前检拒绝后翻 cosmic 源码取证"],
		90: ["testData", "为提交路径凑 5 个必填值"],
		94: ["testData", "为提交路径凑必填值，查量具基础资料"],
		108: ["testData", "写临时探针找量具编码，#107 已自认钻牛角尖"],
		123: ["toolLimit", "--set 多选基础资料撞主键冲突"],
		127: ["toolLimit", "提交路径反复失败，已在考虑熔断"],
	},
	"2026-09-17T07-13-37-289": {
		15: ["decision", "已看出占位符与现有写法不一致，#16 自己说要问，#28 才问"],
		44: ["testData", "写临时探针找有分录的单据"],
	},
	"2026-09-17T08-01-42-228": {
		15: ["toolFact", "python 解析自己导出的模板找字段与插件"],
		80: ["normal", "已掌握样板；下一步撞到插件登记不支持"],
		85: ["toolLimit", "改模板探针不能登记插件，翻探针源码确认"],
	},
	"2026-09-18T01-51-17-328": {
		15: ["toolFact", "python 解析导出看表格结构"],
		21: ["toolFact", "python 解析导出看表格结构"],
		107: ["normal", "比对前后两次导出，发现用户正在改模板"],
	},
	"2026-09-18T03-42-29-395": {
		15: ["normal", "导出、查 git 看改了什么"],
		26: ["toolFact", "python 解析导出找格子"],
	},
	"2026-09-18T04-25-49-684": {
		15: ["normal", "备份、导出，任务本身的步骤"],
		28: ["toolFact", "python 解析旧导出看表格结构"],
	},
	"2026-09-18T04-41-18-447": {
		15: ["toolFact", "翻上次会话留下的产物和临时探针"],
		20: ["normal", "找被改坏前的备份，恢复模板本身要用"],
		147: ["normal", "改完代码后核对线上状态"],
	},
	"2026-09-18T05-56-01-446": {
		15: ["toolFact", "python 解析导出"],
		22: ["toolFact", "python 解析导出找备注格"],
		78: ["normal", "事实已齐，准备写实现"],
		80: ["normal", "事实已齐，查现有插件写法后动手"],
		91: ["normal", "开写前查仿真器常量，3 次后动手"],
	},
	"2026-09-18T07-03-49-911": {
		15: ["normal", "排查：找测试单据"],
		82: ["normal", "读插件厘清需求含义"],
	},
	"2026-09-18T08-42-47-155": {
		15: ["normal", "下一次调用就找到根因（插件没登记）"],
		33: ["toolLimit", "找 cosmic_run 怎么传表单事件参数"],
	},
	"2026-09-18T09-35-04-150": {
		15: ["normal", "读插件和元数据"],
		82: ["toolLimit", "查不到分录列填充情况，翻探针源码"],
		86: ["toolLimit", "临时探针编译失败（断言接口）"],
	},
	"2026-09-20T08-03-15-705": {
		27: ["toolFact", "python 翻旧导出找现成公式，#30 找到"],
		29: ["toolFact", "python 翻旧导出找现成公式，#30 找到"],
	},
	"2026-09-20T08-55-24-803": {
		15: ["toolFact", "翻旧导出目录找插件登记"],
		27: ["toolFact", "python 翻导出找公式先例"],
	},
	"2026-09-21T02-21-07-487": {
		15: ["toolLimit", "分录不能直接查，连续查询失败"],
		31: ["normal", "试印已拿到证据，下一次断言通过"],
	},
	"2026-09-21T06-41-56-856": {
		25: ["normal", "找到先例插件，下一步去读"],
		194: ["toolFact", "用截图量渲染行高，平台渲染事实拿不到"],
		195: ["toolFact", "查知识库找行高自动调整的平台行为"],
	},
	"2026-09-21T07-54-27-396": { 15: ["normal", "找到命名先例，#18 自己提问"] },
	"2026-09-21T08-32-54-542": { 15: ["wait", "写锁被别的进程占着"] },
	"2026-09-21T10-23-34-887": {
		15: ["toolFact", "python 解析导出；业务冲突要到 #59 试印两个值后才看得出"],
		17: ["toolFact", "翻旧候选目录"],
	},
};

/** 批 0 公式样本里真正卡在业务口径上的一段：#59 试印看到引擎默认用分号、需求写逗号，
 * #60～#62 去找替换函数，#63 用户打断纠偏。检查各规则在这一段里有没有触发。 */
const DECISION_EPISODE = { session: "2026-09-21T10-23-34-887", from: 59, to: 62 };

/** 最近 15 次里算"绕路类"的细分：翻产物、翻工具源码和 JAR、临时探针、原样重查、同一操作再失败。 */
const DETOUR = new Set(["toolOutput", "history", "internals", "platformJar", "auxiliary", "retry", "repeat"]);

/** 每条规则在一段连续未推进里最多触发一次；推进或用户新消息后重新计。 */
const RULES = {
	count15: { text: "连续 15 次未推进", fires: (run) => run.length >= 15 },
	count15or5min: {
		text: "连续 15 次或 5 分钟未推进（批 0 暂定的试验阈值）",
		fires: (run, d) => run.length >= 15 || (d.at - run[0].at) / 60000 >= 5,
	},
	detour8of15: {
		text: "连续 15 次未推进，且最近 15 次里至少 8 次是绕路类",
		fires: (run) => run.length >= 15 && run.slice(-15).filter((x) => DETOUR.has(x.stallKind)).length >= 8,
	},
};

function sessions(dir) {
	return readdirSync(dir)
		.sort()
		.filter((name) => {
			const date = name.slice(0, 10);
			return (
				name.endsWith(".jsonl") &&
				date >= FROM &&
				date <= TO &&
				statSync(join(dir, name)).isFile() &&
				statSync(join(dir, name)).size > MIN_BYTES
			);
		})
		.map((name) => {
			const records = readFileSync(join(dir, name), "utf8")
				.split(/\r?\n/)
				.filter(Boolean)
				.flatMap((line) => {
					try {
						return [JSON.parse(line)];
					} catch {
						return [];
					}
				});
			return { name, key: name.slice(0, 23), metrics: measureSession(records) };
		});
}

export function firePoints(details, rule) {
	const points = [];
	let run = [],
		fired = false;
	for (const d of details) {
		if (run.length && run[0].boundary !== d.boundary) {
			run = [];
			fired = false;
		}
		if (d.progress) {
			run = [];
			fired = false;
			continue;
		}
		run.push(d);
		if (!fired && rule.fires(run, d)) {
			fired = true;
			points.push({ seq: d.seq, runFrom: run[0].seq, calls: run.length, minutes: (d.at - run[0].at) / 60000 });
		}
	}
	return points;
}

function main() {
	const argv = process.argv.slice(2);
	const dirAt = argv.indexOf("--dir");
	const rows = sessions(dirAt >= 0 ? argv[dirAt + 1] : DEFAULT_DIR);
	const report = { sessions: rows.length, calls: rows.reduce((n, s) => n + s.metrics.calls, 0), rules: {} };
	for (const [id, rule] of Object.entries(RULES)) {
		const fires = rows.flatMap((s, i) =>
			firePoints(s.metrics.details, rule).map((p) => {
				const label = LABELS[s.key]?.[p.seq];
				return {
					session: `S${String(i + 1).padStart(2, "0")}`,
					key: s.key,
					...p,
					label: label?.[0] ?? null,
					why: label?.[1] ?? null,
				};
			}),
		);
		const byLabel = Object.fromEntries(
			Object.keys(LABEL_TEXT).map((k) => [k, fires.filter((f) => f.label === k).length]),
		);
		const episode = fires.filter(
			(f) => f.key === DECISION_EPISODE.session && f.seq >= DECISION_EPISODE.from && f.seq <= DECISION_EPISODE.to,
		);
		report.rules[id] = {
			text: rule.text,
			fires: fires.length,
			byLabel,
			unlabeled: fires.filter((f) => f.label === null).map((f) => `${f.session}#${f.seq}`),
			firesInDecisionEpisode: episode.length,
			points: fires,
		};
	}
	if (argv.includes("--json")) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(`会话 ${report.sessions} 份、工具调用 ${report.calls} 次（只读历史会话，不是重跑）`);
	for (const r of Object.values(report.rules)) {
		console.log(`\n── ${r.text}：触发 ${r.fires} 次`);
		for (const [k, n] of Object.entries(r.byLabel)) if (n) console.log(`  ${LABEL_TEXT[k]}：${n}`);
		if (r.unlabeled.length) console.log(`  未标注：${r.unlabeled.join("、")}`);
		console.log(
			`  S19 #${DECISION_EPISODE.from}～#${DECISION_EPISODE.to}（真正卡在业务口径的一段）内触发：${r.firesInDecisionEpisode} 次`,
		);
		for (const p of r.points)
			console.log(
				`    ${p.session}#${p.seq}（段首 #${p.runFrom}，${p.calls} 次，${p.minutes.toFixed(1)} 分钟）${p.label ?? "未标注"}：${p.why ?? ""}`,
			);
	}
}

if (import.meta.url === `file:///${process.argv[1].replaceAll("\\", "/").replace(/^\//, "")}`) main();
