/** 界面品牌（client/brand.js，浏览器端直接执行、不经编译）里的名字和标语跟 src/brand.ts 一致。 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	PRODUCT_LOGO_MARK,
	PRODUCT_LOGO_NAME,
	PRODUCT_LOGO_TAG,
	PRODUCT_SUBTITLE,
	PRODUCT_TAGLINE,
} from "../../src/brand.ts";

const client = readFileSync(new URL("../../client/brand.js", import.meta.url), "utf8");

describe("界面品牌", () => {
	it("名字、字标、标语和 src/brand.ts 一致", () => {
		for (const [key, value] of Object.entries({
			PRODUCT_LOGO_NAME,
			PRODUCT_LOGO_MARK,
			PRODUCT_LOGO_TAG,
			PRODUCT_SUBTITLE,
			PRODUCT_TAGLINE,
		}))
			expect(client, key).toContain(`const ${key} = "${value}";`);
	});

	it("模块编号是包名：dsh 按包名把它送进界面", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			name: string;
			exports: Record<string, string>;
		};
		expect(client).toContain(`id: "${manifest.name}"`);
		expect(manifest.exports["./client"]).toBe("./client/brand.js");
	});
});
