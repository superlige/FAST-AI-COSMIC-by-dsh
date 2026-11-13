/**
 * 保存回读的尺子：真实 SDK 编译及对象/外键分离；历史记录只读重判。
 * node --experimental-strip-types scripts/measure-conversion-readback.ts <工程目录> [--before <ISO时刻>]
 * 不启动苍穹，不连接数据库，不重放历史业务操作。
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { baseChildEnv } from "../src/kernel/context.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { classpathOf, runJava, runJavac } from "../src/kernel/toolchain.ts";
import { type AssertionEvidence, evidenceIntact, unconfirmedPush } from "../src/kernel/verify/evidence.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const root = process.argv[2];
const beforeAt = process.argv.includes("--before") ? process.argv[process.argv.indexOf("--before") + 1] : undefined;
if (root === undefined) throw new Error("用法：measure-conversion-readback.ts <工程目录>");
const opened = await openProject({
	projectRoot: resolve(root),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: mkdtempSync(join(tmpdir(), "cosmic-readback-")),
	agentVersion: "conversion-readback-check",
	resources: EMBEDDED_RESOURCES,
});
const ctx = opened.ctx;
const classes = mkdtempSync(join(tmpdir(), "cosmic-reference-classes-"));
const sources = ["PushSim", "MetaProbe", "FormSim", "WfSim"].map((name) => join(ctx.layout.probesDir, `${name}.java`));
const compiled = await runJavac(ctx, [
	"-encoding",
	"UTF-8",
	`@${ctx.layout.javacArgs}`,
	"-implicit:class",
	"-sourcepath",
	ctx.layout.probesDir,
	"-d",
	classes,
	ctx.layout.hostSrc,
	ctx.layout.bridgeSrc,
	ctx.layout.viewsSrc,
	ctx.layout.bootStubSrc,
	...sources,
	join(import.meta.dirname, "checklists", "ReferenceIdCheck.java"),
]);
console.log(`SDK_COMPILE status=${compiled.status} seconds=${compiled.seconds}`);
if (compiled.status !== 0) {
	console.log(compiled.out);
	process.exit(1);
}
const ran = await runJava(
	ctx,
	[
		"-Dfile.encoding=UTF-8",
		"-Dlogfactory.className=ReferenceIdCheck$LocalLogFactory",
		"-cp",
		classpathOf(classes, ctx.layout.pathingJar),
		"ReferenceIdCheck",
	],
	baseChildEnv(ctx),
);
console.log(ran.out);
if (ran.status !== 0 || !ran.out.includes("REFERENCE_ID_CHECK_OK")) process.exitCode = 1;
const records: AssertionEvidence[] = [];
for (const name of readdirSync(ctx.layout.assertionEvidence)) {
	if (!name.endsWith(".json")) continue;
	const record = JSON.parse(readFileSync(join(ctx.layout.assertionEvidence, name), "utf8")) as AssertionEvidence;
	if (record.argv?.[0] === "push" && evidenceIntact(record) && (beforeAt === undefined || record.at < beforeAt))
		records.push(record);
}
const green = records.filter((r) => r.result === "PASS");
const missing = green.filter((r) => unconfirmedPush([r]).length > 0);
console.log(
	JSON.stringify(
		{
			historicalPush: records.length,
			historicalPass: green.length,
			passWithoutDatabaseConfirmation: missing.length,
			nowPreventedFromDelivery: missing.length,
			records: missing.map((r) => r.id),
		},
		null,
		2,
	),
);
console.log(`临时编译目录：${classes}`);
