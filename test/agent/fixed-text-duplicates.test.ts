/**
 * 同一句话不写在固定文字的两处。
 *
 * 固定文字是系统提示、每轮状态、工具说明和参数说明，每轮都发。同一句写两处，改一处忘一处就是两种说法，模型每轮也多读一遍。
 * 一句话该放哪：工具怎么用放在那个工具的说明或参数上；跨工具的规矩放系统提示；只在某个返回里才用得上的，放进那个返回。
 */
import { describe, expect, it } from "vitest";
import { duplicateSentences, fixedTextPieces } from "../../src/dsh/fixed-text.ts";

describe("固定文字每句只写一处", () => {
	for (const mode of ["dev", "prod"] as const) {
		it(`${mode}：大于 40 字节的句子不在两处出现`, () => {
			const found = duplicateSentences(fixedTextPieces(mode)).map(
				(item) => `${item.places.join("、")}：${item.sentence}`,
			);
			expect(found).toEqual([]);
		});
	}

	it("这道检查能被触发", () => {
		const sentence = "这是一句足够长、会被当成重复来报的固定说明文字";
		const found = duplicateSentences([
			{ where: "系统提示", text: `开头。${sentence}。结尾` },
			{ where: "cosmic_run 说明", text: `${sentence}；另一句` },
		]);
		expect(found).toEqual([{ sentence, places: ["系统提示", "cosmic_run 说明"] }]);
	});
});
