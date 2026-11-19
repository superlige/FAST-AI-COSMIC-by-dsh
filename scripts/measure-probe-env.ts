/**
 * S37 2-B.1 的尺子：探针收到它不读的环境变量名，历史上发生过几次、新规则会拦下哪些。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-probe-env.ts [会话目录] [--from 2026-09-01]
 *
 * 三段输出：
 *   1. 每个内置探针按「它自己 + 逐层用到的共用类里的全大写字面量」认出多少个名字；
 *   2. 扫会话里模型发出的每次 `cosmic_probe`（内置探针、带 env 的），按新规则算出不认识的名字，
 *      逐条列出（第几次调用、探针、名字）。改前这些调用都照跑了；
 *      列出来的每一条都要人看一眼是不是真写错——有一条正当的名字被列出来，就是判法漏了共用类；
 *   3. 临时探针的同一件事：按会话里的 write / edit 把每次调用时的源码拼回来，旧规则（只认 req / env 两种写法）
 *      和新规则（和内置探针同一套）各拦下哪些名字，逐条列出。拼不回源码的（文件是会话外写的）单独计数。
 * 只读会话文件和本仓 `resources/probes/`，不连环境。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { probeEnvNames } from "../src/kernel/probe/env-names.ts";

const PROBES = join(import.meta.dirname, "..", "resources", "probes");
const args = process.argv.slice(2);
const fromAt = args.indexOf("--from");
const from = fromAt >= 0 ? (args[fromAt + 1] ?? "") : "";
const dir =
	args.find((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--from") ??
	join(process.env.USERPROFILE ?? "", ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");

const read = (cls: string): string | null => {
	const file = join(PROBES, `${cls}.java`);
	return existsSync(file) ? readFileSync(file, "utf8") : null;
};
const released = readdirSync(PROBES)
	.filter((file) => file.endsWith(".java"))
	.map((file) => file.slice(0, -5))
	.filter((cls) => /public static void run\(/.test(read(cls) ?? ""));
const known = new Map(released.map((cls) => [cls, probeEnvNames(cls, read(cls) ?? "", read)]));

console.log(`== 1. 内置探针 ${released.length} 个，认出的名字数（含共用类）`);
console.log(
	[...known]
		.map(([cls, names]) => `${cls} ${names.size}`)
		.sort()
		.join("，"),
);

const HARNESS = new Set(["APPLY", "ROLLBACK"]);
interface Hit {
	session: string;
	call: number;
	probe: string;
	name: string;
}
const hits: Hit[] = [];
let calls = 0;
let withEnv = 0;
const files = readdirSync(dir)
	.filter((file) => file.endsWith(".jsonl") && file.slice(0, 10) >= from)
	.sort();
for (const file of files) {
	let n = 0;
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		if (line === "") continue;
		let row: { message?: { role?: string; content?: { type?: string; name?: string; arguments?: unknown }[] } };
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.message?.role !== "assistant") continue;
		for (const part of row.message.content ?? []) {
			if (part.type !== "toolCall") continue;
			n++;
			if (part.name !== "cosmic_probe") continue;
			const input = part.arguments as { name?: string; env?: Record<string, string> };
			const names = input.name === undefined ? undefined : known.get(input.name);
			if (names === undefined) continue;
			calls++;
			const env = input.env ?? {};
			if (Object.keys(env).length > 0) withEnv++;
			for (const [key, value] of Object.entries(env)) {
				if (value === "" || HARNESS.has(key) || key.startsWith("COSMIC_") || names.has(key)) continue;
				hits.push({
					session: file.slice(0, 19),
					call: n,
					probe: input.name as string,
					name: key,
				});
			}
		}
	}
}
console.log(
	`\n== 2. 会话 ${files.length} 份，内置探针调用 ${calls} 次（带 env 的 ${withEnv} 次），新规则拦下 ${hits.length} 处`,
);
for (const hit of hits) {
	console.log(`${hit.session} 第 ${hit.call} 次 ${hit.probe} ${hit.name}`);
}

// ---- 3. 临时探针：旧规则和新规则各拦下什么
const OLD_RULE = /\b(?:req|env)\(\s*"([A-Z][A-Z0-9_]*)"/g;
interface AdHoc {
	session: string;
	call: number;
	probe: string;
	old: string[];
	now: string[];
}
const adHoc: AdHoc[] = [];
let adHocCalls = 0;
let unknownSource = 0;
for (const file of files) {
	let n = 0;
	const sources = new Map<string, string>();
	const keyOf = (path: string): string => path.replace(/\\/g, "/").split("/").slice(-2).join("/");
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		if (line === "") continue;
		let row: { message?: { role?: string; content?: { type?: string; name?: string; arguments?: unknown }[] } };
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.message?.role !== "assistant") continue;
		for (const part of row.message.content ?? []) {
			if (part.type !== "toolCall") continue;
			n++;
			const input = (part.arguments ?? {}) as {
				path?: string;
				content?: string;
				edits?: { oldText?: string; newText?: string }[];
				name?: string;
				env?: Record<string, string>;
			};
			if (part.name === "write" && input.path?.endsWith(".java") && input.content !== undefined) {
				sources.set(keyOf(input.path), input.content);
				continue;
			}
			if (part.name === "edit" && input.path?.endsWith(".java")) {
				const key = keyOf(input.path);
				let text = sources.get(key);
				if (text === undefined) continue;
				for (const edit of input.edits ?? []) text = text.replace(edit.oldText ?? "", edit.newText ?? "");
				sources.set(key, text);
				continue;
			}
			if (part.name !== "cosmic_probe" || input.name === undefined || !input.name.endsWith(".java")) continue;
			const env = Object.entries(input.env ?? {}).filter(
				([key, value]) => value !== "" && !HARNESS.has(key) && !key.startsWith("COSMIC_"),
			);
			if (env.length === 0) continue;
			adHocCalls++;
			const text = sources.get(keyOf(input.name));
			if (text === undefined) {
				unknownSource++;
				continue;
			}
			const oldNames = new Set([...text.matchAll(OLD_RULE)].map((match) => match[1] as string));
			const cls = (input.name.split(/[\\/]/).pop() as string).slice(0, -5);
			const nowNames = probeEnvNames(cls, text, read);
			const old = env.map(([key]) => key).filter((key) => !oldNames.has(key));
			const now = env.map(([key]) => key).filter((key) => !nowNames.has(key));
			if (old.length > 0 || now.length > 0)
				adHoc.push({ session: file.slice(0, 19), call: n, probe: cls, old, now });
		}
	}
}
console.log(
	`\n== 3. 临时探针带 env 的调用 ${adHocCalls} 次（源码拼不回来的 ${unknownSource} 次）：` +
		`旧规则拦下 ${adHoc.filter((hit) => hit.old.length > 0).length} 次，新规则拦下 ${adHoc.filter((hit) => hit.now.length > 0).length} 次`,
);
for (const hit of adHoc) {
	console.log(
		`${hit.session} 第 ${hit.call} 次 ${hit.probe}：旧规则拦 ${hit.old.join(" / ") || "（无）"}；新规则拦 ${hit.now.join(" / ") || "（无）"}`,
	);
}
