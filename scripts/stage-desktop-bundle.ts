import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function stageDesktopBundle(bundle: string, target: string): void {
	cpSync(bundle, target, { recursive: true });
	// dsh 的根构建固定找这个入口。让品牌模块留在原处，它才能找到同级的 chunks/。
	const entryDir = join(target, "lib", "types");
	mkdirSync(entryDir, { recursive: true });
	writeFileSync(join(entryDir, "index.js"), 'export * from "../../brand.js";\n');
}
