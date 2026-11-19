/**
 * 真机重放：把一条验证记录（或手写的一组参数）原样再跑一次 cosmic_run，不经过模型、不花额度。
 * 用来复测「某次运行的结果对不对」：同一组参数，改完 cosmic 再跑，前后对照输出和留没留验证记录。
 *
 * 走 `direct-tools.ts`：和插件同一份工具规格、同一道执行前门槛；常驻 JVM 是组合包自己的，
 * 不和正在跑的 pi 版会话抢进程；跑完停掉。会写什么取决于参数本身：带 --click / --op 就是真提交，和模型调一样。
 *
 * 用法：
 *   node --experimental-strip-types scripts/replay-run.ts <工程目录> <验证记录 AE-xxx.json | argv 的 JSON 数组>
 * 例：
 *   node --experimental-strip-types scripts/replay-run.ts D:/kingdee/demo .cosmic-ai/evidence/assertions/AE-123.json
 *   node --experimental-strip-types scripts/replay-run.ts D:/kingdee/demo '["form","demo_bill","--show","billno"]'
 * 输出：工具返回的全文，最后一行是耗时。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { directTools } from "./direct-tools.ts";

if (!process.argv[2] || !process.argv[3]) {
	console.error("用法: replay-run.ts <工程目录> <AE-xxx.json | argv 的 JSON 数组>");
	process.exit(2);
}
const project = resolve(process.argv[2]);
const source = process.argv[3];
const recordPath = resolve(project, source);
const argv: unknown = existsSync(recordPath)
	? (JSON.parse(readFileSync(recordPath, "utf8")) as { argv?: unknown }).argv
	: JSON.parse(source);
if (!Array.isArray(argv) || !argv.every((arg) => typeof arg === "string")) {
	console.error("取不到 argv：验证记录里没有 argv，或给的不是字符串数组");
	process.exit(2);
}

const tools = await directTools(project);
try {
	const opened = await tools.call("cosmic_open_project", { projectRoot: project });
	if (!opened.ok) {
		console.log(opened.text);
		process.exitCode = 1;
	} else {
		const t0 = Date.now();
		console.log((await tools.call("cosmic_run", { argv })).text);
		console.log(`\n[replay] cosmic_run 耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
	}
} finally {
	await tools.call("cosmic_runtime", { action: "probe-stop" });
}
