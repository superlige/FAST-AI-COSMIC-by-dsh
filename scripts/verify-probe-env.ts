/**
 * S37 2-B.1 真机验证：内置探针收到它不读的变量名，在真机工程上启动前就被拦下；写对的照常跑。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-probe-env.ts <工程目录> [会话目录]
 *
 * 两步：
 *   1. 把会话里模型发给内置探针的每一次 cosmic_probe（带 env 的）原样交给预检（不编译、不起 JVM），
 *      数出被 PROBE_ENV_UNKNOWN 拦下的，逐条列出——应当正好是 `measure-probe-env.ts` 列出的那几处；
 *   2. 真跑一次只读的 DataQueryProbe：先带写错的 QUERY_FILTER（应当拦下、不跑），再换成 QUERY_WHERE（应当跑通）。
 * 探针用的是工程打开时释放到缓存里的那一份（和模型用的是同一份），只读，不写库。
 */
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";
import { releasedProbeNames } from "../src/runtime/resources.ts";

const [projectRoot, sessionArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-probe-env.ts <工程目录> [会话目录]");
	process.exit(2);
}
const sessions = sessionArg ?? join(homedir(), ".pi", "agent", "sessions", "--D--kingdee-zlgd_ygpt2.0--");
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
const released = new Set(releasedProbeNames(EMBEDDED_RESOURCES));

let replayed = 0;
const refused: string[] = [];
for (const file of readdirSync(sessions)
	.filter((name) => name.endsWith(".jsonl"))
	.sort()) {
	let n = 0;
	for (const line of readFileSync(join(sessions, file), "utf8").split("\n")) {
		if (line === "") continue;
		let row: { message?: { role?: string; content?: { type?: string; name?: string; arguments?: unknown }[] } };
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (row.message?.role !== "assistant") continue;
		for (const part of row.message.content ?? []) {
			if (part.type !== "toolCall") continue;
			n++;
			const input = part.arguments as { name?: string; env?: Record<string, string>; positional?: string[] };
			if (part.name !== "cosmic_probe" || input.name === undefined || !released.has(input.name)) continue;
			if (Object.keys(input.env ?? {}).length === 0) continue;
			replayed++;
			const prepared = await kernel.prepareProbe(project, input.name, {
				positional: input.positional ?? [],
				env: input.env ?? {},
			});
			if (!prepared.ok) continue;
			const unknown = prepared.value.blockers.find((blocker) => blocker.code === "PROBE_ENV_UNKNOWN");
			if (unknown !== undefined) refused.push(`${file.slice(0, 19)} 第 ${n} 次 ${unknown.message}`);
		}
	}
}
console.log(`== 1. 历史调用 ${replayed} 次原样预检，因变量名拦下 ${refused.length} 次`);
for (const line of refused) console.log(`   ${line}`);

const ENTITY = "zlgd_sys_test_bill";
const queries: Record<string, string>[] = [
	{ QUERY_ENTITY: ENTITY, QUERY_FILTER: "billno like SYSJC%", QUERY_LIMIT: "3" },
	{ QUERY_ENTITY: ENTITY, QUERY_WHERE: "billno like SYSJC%", QUERY_LIMIT: "3" },
];
for (const env of queries) {
	const started = Date.now();
	const result = await kernel.probe(project, "DataQueryProbe", { env });
	console.log(`== 2. DataQueryProbe ${JSON.stringify(env)}（${Date.now() - started} ms）`);
	if (!result.ok) {
		const error = result.error.toJSON() as { code: string; detail?: { blockers?: string[] } };
		console.log(`   拦下：${error.code}`);
		for (const blocker of error.detail?.blockers ?? []) console.log(`   ${blocker}`);
		continue;
	}
	console.log(`   跑了：exit ${result.value.exitCode}`);
	for (const line of result.value.output.split(/\r?\n/).slice(0, 6)) console.log(`   ${line}`);
}
process.exit(0);
