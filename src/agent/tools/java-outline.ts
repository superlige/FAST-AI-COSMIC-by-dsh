/**
 * 大 Java 文件先给提纲（S34 批 2）。
 *
 * 真机量出来的事（S34 §2.3、批 0 基线 §3）：模型读业务 Java 喜欢先整份读，五份样本 10 次整份读里
 * 6 次超过 20 KiB，占整读载荷的 91%。例如一个 34 KB 的插件整份读完，最后只改了第 60～90 行和
 * 第 245～300 行附近；另有 84 KB 是拿 grep/sed 在 Java 里找某个编码在哪一行。
 *
 * 所以：工程里的 `.java`、没带行号范围、文件超过 20 KiB 时，第一次整份读先回一份提纲——
 * 类型、每个方法的起止行、常量、字符串里出现的编码及其所在行——并告诉模型带行号再读。
 * 编码 → 行号那张表是给「这个字段在哪用到」省一次 grep 的。
 *
 * 三条不跟模型较劲的规矩：
 *
 *   - **同一个文件第二次整份读，直接给全文。** 模型确实需要全文时只多付一轮。这件事记在
 *     读取账（`ReadLedger.outlined`）上，压缩时一起清空——压缩后提纲也不在上文里了。
 *   - **解析没把握就给全文。** 字符串或注释没闭合、大括号不配对、一个类型都没找到，
 *     都退回原样。半截提纲比没有提纲更容易把人带错地方。
 *   - **提纲不划算就给全文。** 提纲超过原文一半（比如几乎全是常量的类），省不下什么。
 *
 * 解析是轻量的：去掉注释和字符串内容后数大括号，只在「类型的成员层」上认方法、常量和嵌套类型。
 * 方法体里的匿名类、lambda 不展开。不接 LSP。
 */

import { readFileSync } from "node:fs";
import { isCode, type JavaOutline, outlineJava } from "../../kernel/impact/java-outline.ts";

export { type JavaOutline, type OutlineEntry, outlineJava } from "../../kernel/impact/java-outline.ts";

/** 文件 UTF-8 字节数超过这个才给提纲。依据见 `docs/S34-batch0-baseline.md` §3。 */
export const OUTLINE_MIN_BYTES = 20_480;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const MAX_METHODS = 120;
const MAX_CONSTANTS = 40;
const MAX_CODES = 60;
const MAX_LINES_PER_CODE = 8;

const span = (from: number, to: number): string =>
	from === to ? `第 ${String(from)} 行` : `第 ${String(from)}–${String(to)} 行`;

function capped<T>(rows: readonly T[], max: number, render: (row: T) => string, noun: string): string[] {
	const shown = rows.slice(0, max).map(render);
	if (rows.length > max) shown.push(`  另有 ${String(rows.length - max)} 个${noun}没列出`);
	return shown;
}

/** 提纲发给模型的文字。 */
export function renderOutline(path: string, outline: JavaOutline, bytes: number): string {
	const example = outline.methods.find((method) => method.to - method.from >= 3) ?? outline.methods[0];
	const hint =
		example === undefined
			? "要看哪段，带 offset 和 limit 再读"
			: `要看哪段，带 offset 和 limit 再读（例如 ${example.label.replace(/\(.*$/, "")}：offset=${String(example.from)}, limit=${String(example.to - example.from + 1)}）`;
	const parts = [
		`${path}：${String(outline.lines)} 行、${(bytes / 1024).toFixed(1)} KiB。这次先给提纲，没有给正文。`,
		`${hint}；确实要全文，再整份读一次这个文件就给。`,
		"",
		"类型：",
		...outline.types.map((type) => `  ${span(type.from, type.to)} ${type.label}`),
	];
	if (outline.methods.length > 0) {
		parts.push(
			"方法：",
			...capped(
				outline.methods,
				MAX_METHODS,
				(method) => `  ${span(method.from, method.to)} ${method.label}`,
				"方法",
			),
		);
	}
	// 值是编码的常量在「编码出现的行」里带着名字和声明行，这里不再列一遍。
	const constants = outline.constants.filter((constant) => constant.value === null || !isCode(constant.value));
	if (constants.length > 0) {
		parts.push(
			"其他常量：",
			...capped(
				constants,
				MAX_CONSTANTS,
				(constant) =>
					`  第 ${String(constant.line)} 行 ${constant.name}` +
					(constant.value !== null
						? ` = "${clip(constant.value, 60)}"`
						: constant.literals > 1
							? `（${String(constant.literals)} 个字符串）`
							: ""),
				"常量",
			),
		);
	}
	if (outline.codes.length > 0) {
		parts.push(
			"编码出现的行（经常量引用的，第一个行号是常量声明）：",
			...capped(
				outline.codes,
				MAX_CODES,
				(row) => {
					const shown = row.lines.slice(0, MAX_LINES_PER_CODE).map(String).join("、");
					const more = row.lines.length > MAX_LINES_PER_CODE ? ` 等 ${String(row.lines.length)} 处` : "";
					const via = row.via.length === 0 ? "" : `（经常量 ${row.via.join("、")}）`;
					return `  ${row.code}：第 ${shown} 行${more}${via}`;
				},
				"编码",
			),
		);
	}
	return parts.join("\n");
}

export interface OutlineRequest {
	/** 模型给的路径原样，出现在提纲第一行。 */
	path: string;
	/** 解析到磁盘上的文件。 */
	file: string;
	offset?: number | undefined;
	limit?: number | undefined;
	/** 已经给过提纲的文件（读取账上那一份）。 */
	outlined: Set<string>;
	/** 比较用的文件名写法（大小写、分隔符归一）。 */
	key: string;
	/** 测试注入；默认读磁盘。 */
	readText?: (file: string) => string;
}

/**
 * 这次整份读该不该换成提纲。该换就返回提纲文字并在账上记一笔；否则返回 null，照常发全文。
 */
export function outlineInsteadOfRead(request: OutlineRequest): string | null {
	if (request.offset !== undefined || request.limit !== undefined) return null;
	if (!request.file.toLowerCase().endsWith(".java")) return null;
	if (request.outlined.has(request.key)) return null;
	let text: string;
	try {
		text = (request.readText ?? ((file: string) => readFileSync(file, "utf8")))(request.file);
	} catch {
		return null;
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= OUTLINE_MIN_BYTES) return null;
	const outline = outlineJava(text);
	if (outline === null) return null;
	const rendered = renderOutline(request.path, outline, bytes);
	if (Buffer.byteLength(rendered, "utf8") * 2 > bytes) return null;
	request.outlined.add(request.key);
	return rendered;
}
