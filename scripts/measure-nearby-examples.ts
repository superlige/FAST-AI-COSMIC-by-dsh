/** Fixed selector ruler; --project additionally runs only the reviewed read probes. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadIndex, queryImpact, queryReport } from "../src/kernel/commands/impact.ts";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const audit = process.argv.includes("--audit");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const javaHome = process.env.JAVA_HOME;
if (!javaHome) throw new Error("需要 JAVA_HOME 指向 JDK 8");
const work = mkdtempSync(join(tmpdir(), "cosmic-nearby-"));
const fixture = join(root, "test/fixtures/NearbyExamplesFixture.java");
execFileSync(join(javaHome, "bin/javac"), [
	"-encoding",
	"UTF-8",
	"-d",
	work,
	join(root, "resources/probes/ProbeJson.java"),
	join(root, "resources/probes/NearbyExamples.java"),
	fixture,
]);
const output = execFileSync(
	join(javaHome, "bin/java"),
	["-Dfile.encoding=UTF-8", "-cp", work, "NearbyExamplesFixture"],
	{ encoding: "utf8" },
);
console.log(
	JSON.stringify({
		kind: "offline",
		fixtureSha256: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
		...(audit ? { outputBytes: Buffer.byteLength(output, "utf8") } : { output }),
	}),
);

const at = process.argv.indexOf("--project");
if (at >= 0) {
	const projectRoot = process.argv[at + 1];
	if (!projectRoot) throw new Error("--project 缺工程路径");
	const opened = await openProject({
		projectRoot: resolve(projectRoot),
		agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
		cacheRoot: process.argv.includes("--cache")
			? resolve(process.argv[process.argv.indexOf("--cache") + 1] as string)
			: join(work, "cache"),
		agentVersion: "dev",
		resources: EMBEDDED_RESOURCES,
	});
	try {
		const inputs: { name: string; env: Record<string, string> }[] = [
			{ name: "MetaProbe", env: { META_ENTITY: "zlgd_sys_test_bill", META_FILTER: "billno" } },
			{ name: "FormRuleProbe", env: { RULE_FORM: "zlgd_wtd_xnl" } },
			{
				name: "PrintTplDesignProbe",
				env: { TPL_NUMBER: "zlgd_sys_test_bill_prtpl_20", TPL_CONTROL_KEY: "LayoutCell13" },
			},
		];
		for (const input of inputs) {
			const start = Date.now();
			const result = await probe(opened.ctx, input.name, { env: input.env });
			const records = result.ok ? result.value.json.records.filter((record) => record.t === "nearby-examples") : [];
			const core = result.ok
				? {
						output: result.value.output
							.split(/\r?\n/)
							.filter((line) => !line.includes("[PROBE] 样板 ") && !line.includes('"t":"nearby-examples"'))
							.join("\n"),
						records: result.value.json.records.filter((record) => record.t !== "nearby-examples"),
					}
				: null;
			console.log(
				JSON.stringify({
					kind: "live",
					input,
					ms: Date.now() - start,
					ok: result.ok,
					exitCode: result.ok ? result.value.exitCode : null,
					...(audit
						? {
								nearbyBytes: bytes(records),
								nearbyRefs: records.flatMap((record) =>
									Array.isArray(record.items)
										? record.items.map((item: { reference: string }) => item.reference)
										: [],
								),
								coreBytes: bytes(core),
								coreSha256: digest(core),
								recordTypes: result.ok ? result.value.json.records.map((record) => record.t) : [],
							}
						: { records }),
					...(result.ok ? (audit ? {} : { outputFile: result.value.json.file }) : { error: result.error.message }),
				}),
			);
			if (!result.ok || result.value.exitCode !== 0) throw new Error("只读验证失败，停止后续运行");
			if (!audit && !records.length) throw new Error("返回里缺样板记录");
		}
		const index = loadIndex(opened.ctx);
		if (!index.ok) throw index.error;
		const cls = index.value.classes.find(
			(item) =>
				item.class === "zlgd.qty.inspection.plugin.systestbill.form.DdlSysTestBillFormPlugin" &&
				item.bindings.some(
					(binding) => binding.enabled && binding.kind === "form" && binding.entity === "zlgd_sys_test_bill",
				),
		);
		if (!cls) throw new Error("固定样本的插件登记不在关系表中");
		const result = queryImpact(opened.ctx, { terms: [cls.class], event: "afterDoOperation" });
		console.log(
			JSON.stringify({
				kind: "live-index",
				target: cls.class,
				ok: result.ok,
				...(audit
					? {
							reportBytes: result.ok ? bytes(queryReport(result.value)) : null,
							reportCoreSha256: result.ok
								? digest({ ...queryReport(result.value), examples: undefined, eventLocations: undefined })
								: null,
							refs: result.ok
								? (queryReport(result.value).eventLocations?.items.map((item) => item.reference) ?? [])
								: [],
						}
					: { eventLocations: result.ok ? queryReport(result.value).eventLocations : undefined }),
				...(result.ok ? {} : { error: result.error.message }),
			}),
		);
	} finally {
		await stopServer(opened.ctx);
	}
}
