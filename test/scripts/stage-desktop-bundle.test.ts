import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { stageDesktopBundle } from "../../scripts/stage-desktop-bundle.ts";

it("dsh 的构建入口能加载品牌模块及其共用代码", () => {
	const root = mkdtempSync(join(tmpdir(), "cosmic-desktop-bundle-"));
	try {
		const bundle = join(root, "bundle");
		const target = join(root, "target");
		mkdirSync(join(bundle, "chunks"), { recursive: true });
		writeFileSync(join(bundle, "package.json"), '{"type":"module"}\n');
		writeFileSync(join(bundle, "brand.js"), 'export { name } from "./chunks/brand-shared.js";\n');
		writeFileSync(join(bundle, "chunks", "brand-shared.js"), 'export const name = "fast-ai-cosmic-brand";\n');

		stageDesktopBundle(bundle, target);

		const entry = pathToFileURL(join(target, "lib", "types", "index.js")).href;
		const name = execFileSync(
			process.execPath,
			["--input-type=module", "--eval", `console.log((await import(${JSON.stringify(entry)})).name);`],
			{ encoding: "utf8" },
		);
		expect(name.trim()).toBe("fast-ai-cosmic-brand");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
