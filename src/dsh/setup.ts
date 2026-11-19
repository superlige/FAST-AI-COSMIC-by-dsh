/**
 * 工程配置向导：`/cosmic-env` 发现工程的 `config.json` 缺必填项时，一项一项问人，问完弹确认单再写。
 *
 * 只补空字段；`user` 不问 id，问手机号（也认用户名、姓名），连一次环境查出候选让人选——
 * 用户 id 填错了完全没有症状，只是从此每次写入的修改人都记在别人头上，而没有人记得自己的 id。
 * 纯数字一律当关键字查（手机号也是纯数字），要直接给 id 写 `id:1234567`。
 *
 * 问人的事交给 `Ask`（命令里接 dsh 的提问窗），这里只管流程，测试用假的 `Ask`。
 */

import type { ProjectConfigAnswers } from "../kernel/config/initialize.ts";
import { validateProjectConfigAnswers } from "../kernel/config/initialize.ts";
import type { CosmicKernel } from "./kernel.ts";

export interface Ask {
	/** 问一段文字。人点了「不填了」或界面弹不了：undefined。 */
	text(question: string, detail: string): Promise<string | undefined>;
	/** 从几项里选一项，返回选中的那一项；没选：undefined。 */
	choose(question: string, detail: string, options: readonly string[]): Promise<string | undefined>;
	/** 确认单，点了确认才是 true。 */
	approve(question: string, detail: string): Promise<boolean>;
}

export type SetupOutcome = { kind: "ready"; root: string; text: string } | { kind: "stopped"; text: string };

type ConfigField = keyof ProjectConfigAnswers;
type Kernel = Pick<CosmicKernel, "doctor" | "discover" | "initializeConfig" | "lookupUsers">;

/** 同一项填错这么多次就停下：问到天荒地老不如让人去改文件。 */
const MAX_TRIES = 3;

const DIRECT_USER_ID = /^id[:：]\s*(\S+)$/i;

function fieldQuestion(field: ConfigField, declared: readonly string[]): [string, string] {
	const modules = declared.join(", ");
	const prompts: Record<ConfigField, [string, string]> = {
		isv: ["ISV 标识", "例如 demo，小写字母和数字"],
		debugModule: ["调试模块", modules ? `填一个；可选：${modules}` : "settings.gradle 中的模块名"],
		codeModules: ["代码模块", modules ? `逗号分隔；可选：${modules}` : "逗号分隔的模块名"],
		appClass: ["启动类", "全限定名，例如 com.example.DebugApplication"],
		appMethod: ["配置方法", "只配置不启动的方法名，例如 devRemote；配置写在 main 里的填 main"],
		account: ["账套", "账套编码或账套 ID"],
		user: ["用户", "手机号（也认用户名或姓名）；已知 id 就写 id:1234567"],
	};
	return prompts[field];
}

/** settings.gradle 里照抄来的 `':demo-biz'` 和 `demo-biz` 是同一个模块。 */
function moduleAnswer(item: string): string {
	return item
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.replace(/^:+/, "");
}

export function oneAnswer(field: ConfigField, raw: string): ProjectConfigAnswers {
	const value = raw.trim();
	if (field === "codeModules")
		return { codeModules: [...new Set(value.split(/[,，]/).map(moduleAnswer).filter(Boolean))] };
	if (field === "debugModule") return { debugModule: moduleAnswer(value) };
	return { [field]: value };
}

function errorLine(error: { message: string; remedy?: string }): string {
	return error.remedy ? `${error.message}（${error.remedy}）` : error.message;
}

async function askField(
	ask: Ask,
	field: ConfigField,
	declared: readonly string[],
): Promise<ProjectConfigAnswers | undefined> {
	const [question, hint] = fieldQuestion(field, declared);
	let problem = "";
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const raw = await ask.text(`工程配置 · ${question}`, problem === "" ? hint : `${problem}\n${hint}`);
		if (raw === undefined || raw.trim() === "") return undefined;
		const candidate = oneAnswer(field, raw);
		const problems = validateProjectConfigAnswers(candidate, declared);
		if (problems.length === 0) return candidate;
		problem = `上次填的「${raw.trim()}」不行：${problems.join("；")}`;
	}
	return undefined;
}

async function askUser(
	ask: Ask,
	kernel: Kernel,
	root: string,
	declared: readonly string[],
	answers: ProjectConfigAnswers,
): Promise<{ id: string; note: string } | undefined> {
	const [question, hint] = fieldQuestion("user", declared);
	let problem = "";
	for (let tries = 0; tries < MAX_TRIES; tries += 1) {
		const raw = await ask.text(`工程配置 · ${question}`, problem === "" ? hint : `${problem}\n${hint}`);
		if (raw === undefined || raw.trim() === "") return undefined;
		const keyword = raw.trim();
		const direct = DIRECT_USER_ID.exec(keyword)?.[1];
		if (direct !== undefined || kernel.lookupUsers === undefined) {
			const id = direct ?? keyword;
			const problems = validateProjectConfigAnswers({ user: id }, declared);
			if (problems.length === 0) return { id, note: "" };
			problem = problems.join("；");
			continue;
		}
		// 这一步连真实环境，第一次是冷启动（约 30～40 秒）；账套和 ISV 还没落盘，作为本次查询的覆盖传进去
		const found = await kernel.lookupUsers(root, keyword, {
			...(answers.isv === undefined ? {} : { isv: answers.isv }),
			...(answers.account === undefined ? {} : { account: answers.account }),
		});
		if (!found.ok) {
			problem = `查用户没做成：${errorLine(found.error)}`;
			continue;
		}
		const candidates = found.value.candidates;
		if (candidates.length === 0) {
			problem = `没有匹配「${keyword}」的可用用户，换个关键字，或用 id:1234567 直接指定`;
			continue;
		}
		const retry = "重新输入关键字";
		const labels = candidates.map(
			(one, index) =>
				`${String(index + 1)}) ${one.name || "(无姓名)"} · ${one.username || one.number || "(无用户名)"} · ${one.phoneMask || "无手机号"} · id=${one.id}`,
		);
		const chosen = await ask.choose(
			"工程配置 · 选一个用户",
			found.value.truncated
				? "命中已达上限，还有没列出来的；换更准的关键字可缩小。选中的人写进 config.json 的 user"
				: "选中的人写进 config.json 的 user，以后写入的修改人记在这个人名下",
			[...labels, retry],
		);
		if (chosen === undefined) return undefined;
		const picked = candidates[labels.indexOf(chosen)];
		if (chosen === retry || picked === undefined) {
			problem = "";
			tries -= 1;
			continue;
		}
		return { id: picked.id, note: `\n\nuser = ${picked.name || picked.number || picked.id}（${picked.id}）` };
	}
	return undefined;
}

/**
 * 认工程 → 诊断 → 缺什么问什么 → 确认 → 写 → 再诊断。
 * 配置本来就齐的直接 ready，不问人。
 */
export async function configureProject(kernel: Kernel, ask: Ask, cwd: string): Promise<SetupOutcome> {
	if (kernel.discover === undefined || kernel.initializeConfig === undefined)
		return { kind: "stopped", text: "这个宿主不支持工程配置向导" };
	const discovered = await kernel.discover(cwd);
	if (!discovered.ok) return { kind: "stopped", text: `没认出苍穹工程：${errorLine(discovered.error)}` };
	const root = discovered.value.root;
	const diagnosed = await kernel.doctor(root);
	if (!diagnosed.ok) return { kind: "stopped", text: `环境诊断没做成：${errorLine(diagnosed.error)}` };
	const report = diagnosed.value;
	if (report.parseError !== null)
		return {
			kind: "stopped",
			text: `配置 JSON 已损坏，没有覆盖：${report.parseErrorFile ?? report.projectConfigFile}\n${report.parseError}`,
		};
	if (report.ok) return { kind: "ready", root, text: "" };

	const declared = report.modules.declared;
	const missing = report.missingRequired.map((item) => item.field as ConfigField);
	const answers: ProjectConfigAnswers = {};
	for (const field of missing) {
		if (field === "user") continue; // 放最后：查用户要用前面填的账套和 ISV 连环境
		const answer = await askField(ask, field, declared);
		if (answer === undefined)
			return { kind: "stopped", text: `工程配置没填完（停在「${fieldQuestion(field, declared)[0]}」），没写。` };
		Object.assign(answers, answer);
	}
	let note = "";
	if (missing.includes("user")) {
		const picked = await askUser(ask, kernel, root, declared, answers);
		if (picked === undefined) return { kind: "stopped", text: "工程配置没填完（停在「用户」），没写。" };
		answers.user = picked.id;
		note = picked.note;
	}
	const confirmed = await ask.approve(
		"写入工程配置？",
		`${report.projectConfigFile}\n\n${JSON.stringify(answers, null, 2)}${note}\n\n只补空字段，并确保 /config.json 被 .gitignore 忽略。`,
	);
	if (!confirmed) return { kind: "stopped", text: "没确认，工程配置没写。" };
	const written = await kernel.initializeConfig(root, answers, declared);
	if (!written.ok) return { kind: "stopped", text: `工程配置没写成：${errorLine(written.error)}` };
	const again = await kernel.doctor(root);
	if (!again.ok)
		return { kind: "stopped", text: `配置已写入 ${written.value.file}，但再诊断没做成：${errorLine(again.error)}` };
	if (!again.value.ok)
		return {
			kind: "stopped",
			text: `配置已写入 ${written.value.file}，环境还没好：${again.value.nextActions.join("；")}`,
		};
	return {
		kind: "ready",
		root,
		text: `工程配置已写入 ${written.value.file}（补了 ${written.value.writtenFields.join("、")}）`,
	};
}

/** 一个会话里工程配置向导自动弹到哪一步了 */
export interface SetupPromptState {
	/** 人不填了或没确认：本会话不再自动弹，要配就自己敲 /cosmic-env */
	stopAsking: boolean;
	/** 同一轮并行的几个调用只弹一个向导，其余的等它 */
	flight: Promise<SetupOutcome> | undefined;
}

export function initialSetupPromptState(): SetupPromptState {
	return { stopAsking: false, flight: undefined };
}

/**
 * 工具调用要打开工程、内核说配置不全时调：直接在这次调用里弹向导。
 * 桌面版新建会话不经过任何命令，不在这里补，人就得先知道要敲 /cosmic-env；
 * 提问框要挂在一个正在跑的会话上，工具执行中弹是确认能弹出来的时机（写元数据确认单走的同一条路）。
 * 返回 null：本会话人已经不填过了，不再问。
 */
export async function configureInCall(
	kernel: Kernel,
	state: SetupPromptState,
	ask: Ask,
	root: string,
	signal: AbortSignal,
): Promise<SetupOutcome | null> {
	if (state.flight !== undefined) return state.flight;
	if (state.stopAsking) return null;
	state.flight = configureProject(kernel, ask, root);
	try {
		const outcome = await state.flight;
		// 这次调用被中途取消（人停了这一轮）不算人不填，下次照样问
		if (outcome.kind === "stopped" && !signal.aborted) state.stopAsking = true;
		return outcome;
	} finally {
		state.flight = undefined;
	}
}
