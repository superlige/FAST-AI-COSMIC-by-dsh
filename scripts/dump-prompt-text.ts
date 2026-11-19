/**
 * 把发给模型的固定文字原样导出成一份可读文本：两个模式各一份系统提示（最坏情况）、每轮状态、挂上的每个工具的说明和参数说明，
 * 再加技能清单（每个技能族的名字和说明）。
 *
 * 给人逐条审读用（比如排查「针对某种情况补的特殊语句」），不做统计；统计用 `measure-dsh-prompt.ts`。
 * 用法：node --experimental-strip-types scripts/dump-prompt-text.ts > 输出.txt
 */
import { fixedTextPieces } from "../src/dsh/fixed-text.ts";
import { REFERENCE_FAMILIES } from "../src/knowledge/reference.ts";

const out: string[] = [];
for (const mode of ["dev", "prod"] as const) {
	out.push(`\n########## ${mode} 模式 ##########`);
	for (const piece of fixedTextPieces(mode)) out.push(`\n=== ${piece.where} ===\n${piece.text}`);
}
out.push("\n########## 技能清单 ##########");
for (const family of REFERENCE_FAMILIES) out.push(`- ${family.name}：${family.description}`);
console.log(out.join("\n"));
