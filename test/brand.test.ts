import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRODUCT_BINARY_BASENAME, PRODUCT_DISPLAY_NAME, PRODUCT_ID } from "../src/brand.ts";

describe("public product identity", () => {
	it("uses fast-ai-cosmic consistently for package, display and binary names", () => {
		const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
			name?: unknown;
			description?: unknown;
		};
		expect(PRODUCT_ID).toBe("fast-ai-cosmic");
		expect(PRODUCT_DISPLAY_NAME).toBe(PRODUCT_ID);
		expect(PRODUCT_BINARY_BASENAME).toBe(PRODUCT_ID);
		expect(packageJson.name).toBe(PRODUCT_ID);
		expect(packageJson.description).toContain(PRODUCT_DISPLAY_NAME);
	});

	it("keeps the internal cosmic protocol separate from the public brand", () => {
		expect(PRODUCT_ID).not.toBe("cosmic");
	});
});
