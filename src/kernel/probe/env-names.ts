/**
 * 探针读哪些环境变量名，从源码查（S37 2-B.1）。内置探针和临时探针用同一套。
 *
 * 以前「传了探针不读的名字就拦下」只管临时探针：内置探针的名字不一定写在它自己这一个文件里
 * （`run op` 的 `OP_*` 在共用类 `OpSandbox` 里读，`DataSeedProbe` 借 `FormSim` 的写法），
 * 只看一个文件会把正当的名字说成写错。于是内置探针干脆不查，名字写错就照跑：
 * 09-22 真机第二份样本把 `QUERY_WHERE` 写成 `QUERY_FILTER`，`DataQueryProbe` 当成没有条件，
 * 查回 20 行不相干的数据。
 *
 * 现在沿着类名把共用类一起算进来：探针和它（逐层）用到的同目录共用类里，代码中出现的全大写字面量
 * （`"QUERY_WHERE"`）都算它读的名字。注释不算：注释里常提到别的探针，算进来就把别人的名字
 * （`MetaProbe` 收到 `DATA_ENTITY`）也当成认得的了。探针读名字的写法很多（`req`、`env`、`flag`、`intEnv`、
 * `System.getenv`），调用处写的都是字面量，所以按字面量认；认多了只会少拦，不会误拦。
 * 拼出来的名字（`env(key + "_FILE")`）把后缀接到每个已知名字上。
 *
 * 临时探针原来另有一套，只认 `req("X")` / `env("X")` 两种写法：09-22 真机基线会话第 112 次，
 * 模型的临时探针用 `System.getenv("PROBE_IDS")` 读，被说成「不是它读取的环境变量」拦下，
 * 只好把 id 写死进源码再跑一次。现在临时探针也按字面量认，它用到的共用类在内置探针目录里找
 * （编译时 `-sourcepath` 指的就是那里）。
 */

import { blankJavaNoise } from "../policy/probe-scan.ts";

/** 按类名读内置探针目录里共用类的源码；不在那里的类返回 null。 */
export type ProbeSourceReader = (cls: string) => string | null;

const NAME_LITERAL = /"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g;
const SUFFIX_LITERAL = /\+\s*"(_[A-Z][A-Z0-9_]*)"/g;
const CLASS_REFERENCE = /\b([A-Z][A-Za-z0-9]*)\b/g;

/** 去掉注释、留下字符串：字符串先填成占位符，再把占位的位置换回原文。 */
function codeOnly(source: string): string {
	const masked = blankJavaNoise(source, "\u0000");
	let out = "";
	for (let i = 0; i < source.length; i++) out += masked[i] === "\u0000" ? source[i] : masked[i];
	return out;
}

/** 探针自己加上它逐层用到的共用类的代码（去掉注释）。读不到的类（平台类、JDK 类）跳过。 */
function sourcesOf(cls: string, text: string, read: ProbeSourceReader): string[] {
	const seen = new Map<string, string>([[cls, codeOnly(text)]]);
	const queue = [seen.get(cls) as string];
	for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
		//类名只在代码里找：字符串里的「见 FormSim」不是依赖
		for (const match of blankJavaNoise(current).matchAll(CLASS_REFERENCE)) {
			const name = match[1] as string;
			if (seen.has(name)) continue;
			const source = read(name);
			const code = source === null ? "" : codeOnly(source);
			seen.set(name, code);
			if (source !== null) queue.push(code);
		}
	}
	return [...seen.values()].filter((source) => source !== "");
}

/** 探针（连同它用到的共用类）读的全部名字。 */
export function probeEnvNames(cls: string, text: string, read: ProbeSourceReader): Set<string> {
	const names = new Set<string>();
	const suffixes = new Set<string>();
	for (const source of sourcesOf(cls, text, read)) {
		for (const match of source.matchAll(NAME_LITERAL)) names.add(match[1] as string);
		for (const match of source.matchAll(SUFFIX_LITERAL)) suffixes.add(match[1] as string);
	}
	for (const suffix of suffixes) for (const name of [...names]) names.add(name + suffix);
	return names;
}
