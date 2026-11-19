/**
 * S37 批 4 真机复测的现场还原与恢复：打印模板 zlgd_sys_test_bill_prtpl_jjfswl 写回某一份导出，外加刷新影响面索引。
 *
 * 三个基线需求（09-22 撤回委托单接口、金相打印分录拼接、晶间腐蚀深度法跨单取值）的改动都已提交，
 * 照原样重跑模型会发现「已经做完了」。用户 2026-09-26 定：逐文件还原（只动那几个 Java 文件，工程里别的
 * 未提交改动不碰），模板用 09-22 17:32 会话自己 dump 出的那份写回；跑完文件逐个恢复到 HEAD，模板用跑前现导出的那份写回。
 * Java 文件用 git 处理，这个脚本只管模板（写元数据）和索引。
 *
 * 用法：
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> dump <输出目录>
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> restore <dump目录> <备份目录> [--apply <改前快照>]
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> fast <源码…>
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> build            （重建 pathing jar 和 javac argfile）
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> reindex          （连环境完整重建代码关系表）
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> probe <探针名> KEY=值…   （跑一个已发布探针看输出）
 *   node --experimental-strip-types scripts/s37-retest-scene.ts <工程目录> run <cosmic_run 参数…>     （跑一次 cosmic_run 看输出）
 *
 * restore 不带 --apply 只预演，预演打出「改前快照=…」；带 --apply 真写，要把那个快照原样交回（预演之后模板被人改过就不写），
 * 授权来自用户在对话里的确认（目标只有这一张模板）。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const TEMPLATE = "zlgd_sys_test_bill_prtpl_jjfswl";
const [projectRoot, action, ...rest] = process.argv.slice(2);
if (projectRoot === undefined || action === undefined) {
	console.error(
		"用法：s37-retest-scene.ts <工程目录> dump <输出目录> | restore <dump目录> <备份目录> [--apply] | reindex",
	);
	process.exit(2);
}
const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;

function print(result: unknown): void {
	console.log(JSON.stringify(result, null, 1).slice(0, 6000));
}

if (action === "dump") {
	const [out] = rest;
	if (out === undefined) process.exit(2);
	const result = await kernel.meta(project, ["ptpl", "dump", TEMPLATE, "--out", out], {});
	print(result.ok ? result.value : result.error.toJSON());
	process.exit(result.ok ? 0 : 1);
}
if (action === "restore") {
	const [from, backup] = rest;
	if (from === undefined || backup === undefined) process.exit(2);
	const at = rest.indexOf("--apply");
	const apply = at >= 0;
	const baseline = at >= 0 ? rest[at + 1] : undefined;
	if (apply && baseline === undefined) {
		console.error("--apply 后面要跟预演打出的改前快照");
		process.exit(2);
	}
	const argv = ["ptpl", "restore", TEMPLATE, from, "--backup", backup];
	const result = await kernel.meta(
		project,
		argv,
		apply
			? {
					apply: true,
					writeAuthorization: {
						targets: [`tpl:${TEMPLATE}`],
						rollback: backup,
						confirmationId: "user-2026-09-26-s37-batch4",
						...(baseline === undefined ? {} : { baseline }),
					},
				}
			: {},
	);
	print(result.ok ? result.value : result.error.toJSON());
	process.exit(result.ok ? 0 : 1);
}
if (action === "fast") {
	// 还原过的 Java 按现在的源码编一次，场景和基线开始时一样是「编译新鲜」的
	const result = await kernel.fast(project, rest);
	print(result.ok ? { ok: true, compiled: result.value } : result.error.toJSON());
	process.exit(result.ok ? 0 : 1);
}
if (action === "build") {
	// 重建 pathing jar 和 javac argfile（和 cosmic_doctor action=rebuild force=true 一样）
	const built = await kernel.build(project, { force: true });
	print(built.ok ? built.value : built.error.toJSON());
	process.exit(built.ok ? 0 : 1);
}
if (action === "probe") {
	// 跑一个已发布探针看输出，复核探针改动用：probe <探针名> KEY=值…
	const [name, ...pairs] = rest;
	if (name === undefined) process.exit(2);
	const env = Object.fromEntries(
		pairs.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
	);
	const ran = await kernel.probe(project, name, { env });
	console.log(ran.ok ? ran.value.output : JSON.stringify(ran.error.toJSON()).slice(0, 3000));
	process.exit(ran.ok ? 0 : 1);
}
if (action === "run") {
	// 跑一次 cosmic_run 看输出，复核 run 的探针改动用：run call 类名#方法 --args '[…]'
	const ran = await kernel.run(project, rest, {});
	console.log(ran.ok ? ran.value.output : JSON.stringify(ran.error.toJSON()).slice(0, 3000));
	process.exit(ran.ok ? 0 : 1);
}
if (action === "reindex") {
	// 连环境的完整重建（代码侧 + 元数据侧），和 cosmic_doctor action=reindex 不带 srcOnly 一样。
	// 单独的测试副本一开始没有代码关系表，只刷新代码侧的话，插件挂在哪张单据上查不到，和基线的现场不一样。
	const built = await kernel.impact(project, { action: "build" });
	print(built.ok ? built.value : built.error.toJSON());
	process.exit(built.ok ? 0 : 1);
}
console.error(`不认识的动作：${action}`);
process.exit(2);
