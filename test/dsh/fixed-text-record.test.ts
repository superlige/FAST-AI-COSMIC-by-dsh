/**
 * 发给模型的固定文字改动必须是有意的。
 *
 * 系统提示有 10 KB 的上限（`prompt-budget.test.ts`），但线下面的余量谁都能用：出一次事补一句，不超线就一直过。
 * 这里记精确字节数（`fixed-text-record.json`）：
 *   - 比记录多：失败。要加，同时改记录，并在提交说明写明它想改善交付用时、轮数、试错或质量里的哪一个、怎么量；
 *   - 比记录少：也失败，提示把记录改成新数——不改的话，省下来的余量下次又能被悄悄补回去。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type FixedTextBytes, fixedTextBytes } from "../../src/dsh/fixed-text.ts";

const record = JSON.parse(readFileSync(new URL("./fixed-text-record.json", import.meta.url), "utf8")) as Record<
	string,
	Partial<Record<keyof FixedTextBytes, number>>
>;

describe("固定文字改动必须有意", () => {
	for (const mode of ["dev", "prod"] as const) {
		it(`${mode}：系统提示、工具说明的字节数和记录一致`, () => {
			const current = fixedTextBytes(mode);
			const drift = Object.entries(current).flatMap(([key, bytes]) => {
				const recorded = record[mode]?.[key as keyof FixedTextBytes];
				if (typeof recorded !== "number") return [`${mode}.${key}：记录里没有这一项，补上 ${bytes}`];
				if (bytes > recorded)
					return [
						`${mode}.${key}：${bytes} 比记录 ${recorded} 多 ${bytes - recorded} 字节——要加就改记录，并在提交说明写明想改善哪个数（用时、轮数、试错、质量）、怎么量`,
					];
				if (bytes < recorded)
					return [
						`${mode}.${key}：${bytes} 比记录 ${recorded} 少 ${recorded - bytes} 字节——把 fixed-text-record.json 里这一项改成 ${bytes}`,
					];
				return [];
			});
			expect(drift).toEqual([]);
		});
	}
});
