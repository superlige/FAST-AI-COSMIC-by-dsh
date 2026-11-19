/**
 * 量 dsh 这一层每次请求都要带的文字：常驻系统提示（最坏情况）和每个产品工具的说明加参数。
 *
 * 用法：node --experimental-strip-types scripts/measure-dsh-prompt.ts
 * 输出：系统提示字节数和各部分、两种模式下每个工具的说明字节数和参数字节数（换成 dsh 认的 JSON Schema 之后）、合计。
 */
import { measureL0Budget } from "../src/agent/prompt/system-prompt.ts";
import { toDshSchema } from "../src/dsh/define.ts";
import { mountedToolSpecs } from "../src/dsh/fixed-text.ts";
import { releasedProbes } from "../src/dsh/probes.ts";

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
const probes = releasedProbes();
const budget = measureL0Budget(probes.names, probes.inputs);
console.log(
	`常驻系统提示（最坏情况：${budget.worst.knowledge}）：${String(budget.bytes)} / ${String(budget.limit)} 字节`,
);
for (const part of budget.parts) console.log(`  ${part.name}：${String(part.bytes)}`);

for (const mode of ["dev", "prod"] as const) {
	let total = 0;
	console.log(`\n${mode} 模式挂的产品工具：`);
	for (const spec of mountedToolSpecs(mode)) {
		const description = bytes(spec.description);
		const schema = bytes(JSON.stringify(toDshSchema(spec.parameters)));
		total += description + schema;
		console.log(`  ${spec.name}：说明 ${String(description)}，参数 ${String(schema)}`);
	}
	console.log(`  合计 ${String(total)} 字节`);
}
