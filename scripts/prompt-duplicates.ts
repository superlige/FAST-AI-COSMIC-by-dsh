/**
 * 发给模型的固定文字里，同一句话写在两处的地方。
 *
 * 固定文字是系统提示、每轮状态、每个工具的说明和参数说明（`src/dsh/fixed-text.ts` 拼的那份）。按「。」「；」和换行切句，
 * 大于 40 UTF-8 字节的句子在同一个模式里出现在两处以上就报出来。`test/agent/fixed-text-duplicates.test.ts` 拦同一件事。
 *
 * 离线：不开工程、不调模型。
 *
 *   node --experimental-strip-types scripts/prompt-duplicates.ts
 */
import { duplicateSentences, fixedTextPieces } from "../src/dsh/fixed-text.ts";

let total = 0;
for (const mode of ["dev", "prod"] as const) {
	const found = duplicateSentences(fixedTextPieces(mode));
	total += found.length;
	for (const item of found) console.log(`[${mode}] ${item.places.join("、")}\n  ${item.sentence}`);
	console.log(`${mode}：同一句写在两处以上 ${String(found.length)} 句`);
}
process.exitCode = total > 0 ? 1 : 0;
