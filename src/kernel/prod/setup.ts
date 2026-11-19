/**
 * 生产排障配置（`<COSMIC_AGENT_DIR>/prod/prod.json`）的读、并、写，给配置向导用。
 *
 * 向导只经这里碰这个文件：先读一份草稿（哪些数据库项缺了或填错了、monitor 配没配），
 * 人答完把答案并进原来的内容（文件里别的键原样留着），写之前核对文件在问人期间没被别处改过。
 * 写进去的东西用 `parseProdConfig` 再过一遍：向导写出来的文件，读的那一侧一定认。
 */
import { dirname } from "node:path";
import { err, KernelError, type KernelResult, ok } from "../errors.ts";
import type { FsPort } from "../ports.ts";
import { describeProdConfig, type ProdConfig, parseProdConfig, prodConfigFile } from "./config.ts";

export const PROD_DB_FIELDS = ["driver", "host", "port", "database", "user", "password"] as const;
export type ProdDbField = (typeof PROD_DB_FIELDS)[number];
export const PROD_DRIVERS = ["opengauss", "gaussdb", "postgresql"] as const;

export interface ProdConfigDraft {
	file: string;
	exists: boolean;
	/** 读到的原文；写之前拿它核对文件没被别处改过 */
	text: string;
	/** JSON 坏了：向导不覆盖，照实报 */
	parseError: string | null;
	/** 缺了或填错、要问人的数据库项 */
	badDb: ProdDbField[];
	monitorConfigured: boolean;
	/** 数据库项齐了时的摘要（不含密码）；不齐是 null */
	summary: string | null;
	/** 现在各项的值（密码不在里面），重填时给人看「现在是什么」 */
	current: Partial<Record<ProdDbField | "monitorUrl" | "monitorUsername", string>>;
}

export interface ProdSetupAnswers {
	db?: Partial<Record<ProdDbField, string>>;
	monitor?: { url: string; username: string; password: string };
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return "";
}

/** 一项数据库配置哪里不对；对了是 null。和 `parseProdConfig` 认的规则一致 */
export function prodDbFieldProblem(field: ProdDbField, raw: string): string | null {
	const value = raw.trim();
	if (field === "driver")
		return (PROD_DRIVERS as readonly string[]).includes(value) ? null : `只认 ${PROD_DRIVERS.join(" / ")}`;
	if (field === "port") {
		const port = Number(value);
		return /^\d+$/.test(value) && port > 0 && port <= 65535 ? null : "要填 1～65535 的端口号";
	}
	if (field === "password") return raw === "" ? "不能为空" : null;
	return value === "" ? "不能为空" : null;
}

export function monitorUrlProblem(raw: string): string | null {
	return /^https?:\/\/\S+$/i.test(raw.trim())
		? null
		: "要以 http:// 或 https:// 开头，形如 https://<主机>/monitor/eye";
}

export function readProdConfigDraft(fs: FsPort, agentConfigDir: string): ProdConfigDraft {
	const file = prodConfigFile(agentConfigDir);
	const exists = fs.exists(file);
	const raw = exists ? fs.read(file) : "";
	let root: Record<string, unknown> = {};
	let parseError: string | null = null;
	if (raw.trim() !== "") {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
				parseError = "文件内容不是一个对象";
			else root = parsed as Record<string, unknown>;
		} catch (error) {
			parseError = (error as Error).message;
		}
	}
	const db = object(root.db);
	const mon = object(root.monitor);
	const badDb = PROD_DB_FIELDS.filter((field) => {
		// driver 空着时读的一侧按 opengauss 算，不算缺；后面别的项要问时再一起问
		if (field === "driver" && text(db.driver) === "") return false;
		const value = field === "password" ? (db.password === undefined ? "" : String(db.password)) : text(db[field]);
		return prodDbFieldProblem(field, value) !== null;
	});
	if (badDb.length > 0 && text(db.driver) === "") badDb.unshift("driver");
	const parsed = parseError === null && badDb.length === 0 ? parseProdConfig(raw, file) : null;
	const current: ProdConfigDraft["current"] = {};
	for (const field of PROD_DB_FIELDS)
		if (field !== "password" && text(db[field]) !== "") current[field] = text(db[field]);
	if (text(mon.url) !== "") current.monitorUrl = text(mon.url);
	if (text(mon.username) !== "") current.monitorUsername = text(mon.username);
	return {
		file,
		exists,
		text: raw,
		parseError,
		badDb,
		monitorConfigured: text(mon.url) !== "" && text(mon.username) !== "" && text(mon.password) !== "",
		summary: parsed?.ok === true ? describeProdConfig(parsed.value) : null,
		current,
	};
}

/** 答案并进原来的内容：答了的项盖掉原值，没问的键原样留着 */
export function mergeProdConfig(draft: ProdConfigDraft, answers: ProdSetupAnswers): Record<string, unknown> {
	const root: Record<string, unknown> =
		draft.parseError === null && draft.text.trim() !== "" ? JSON.parse(draft.text) : {};
	const db = { ...object(root.db) };
	for (const [field, value] of Object.entries(answers.db ?? {})) {
		if (value === undefined) continue;
		db[field] = field === "port" ? Number(value.trim()) : field === "password" ? value : value.trim();
	}
	const next: Record<string, unknown> = { ...root, db };
	if (answers.monitor !== undefined)
		next.monitor = {
			...object(root.monitor),
			url: answers.monitor.url.trim(),
			username: answers.monitor.username.trim(),
			password: answers.monitor.password,
		};
	return next;
}

/** 并好的内容按读的那一侧的规则解析一遍：连接验证用它，写之前也用它把关 */
export function prodConfigFromMerged(
	draft: ProdConfigDraft,
	merged: Record<string, unknown>,
): KernelResult<ProdConfig> {
	return parseProdConfig(JSON.stringify(merged), draft.file);
}

export function writeProdConfig(
	fs: FsPort,
	draft: ProdConfigDraft,
	merged: Record<string, unknown>,
): KernelResult<{ file: string; created: boolean }> {
	type Written = { file: string; created: boolean };
	const conflict = () =>
		err<Written>(
			new KernelError("CONFIG_INIT_CONFLICT", "配置向导运行期间生产排障配置已被别处改过，没有覆盖", {
				detail: { file: draft.file },
				remedy: "重新运行 /cosmic-prod-setup。",
			}),
		);
	if (draft.parseError !== null)
		return err(
			new KernelError("CONFIG_PARSE_FAILED", `生产排障配置不是合法 JSON，没有覆盖：${draft.parseError}`, {
				detail: { file: draft.file },
				remedy: `修好或删掉 ${draft.file} 后重新运行 /cosmic-prod-setup。`,
			}),
		);
	if (fs.exists(draft.file) !== draft.exists || fs.read(draft.file) !== draft.text) return conflict();
	const checked = prodConfigFromMerged(draft, merged);
	if (!checked.ok) return checked;
	const body = `${JSON.stringify(merged, null, 2)}\n`;
	if (!draft.exists) {
		fs.mkdirp(dirname(draft.file));
		if (!fs.tryCreate(draft.file, body)) return conflict();
	} else fs.write(draft.file, body);
	return ok({ file: draft.file, created: !draft.exists });
}
