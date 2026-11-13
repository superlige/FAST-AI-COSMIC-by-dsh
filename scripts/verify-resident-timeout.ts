/**
 * 真机只读复测：使用独立缓存和版本，不停用户现有 JVM，不调用业务操作。
 * node --experimental-strip-types scripts/verify-resident-timeout.ts <工程目录>
 * 先让只读探针超过普通两分钟上限，再验自动恢复、125 秒运行和后续复用；约五分钟。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { probe } from "../src/kernel/commands/probe.ts";
import { openProject } from "../src/kernel/open-project.ts";
import { localServiceHealth } from "../src/kernel/probe/health.ts";
import { readManifest, stopServer } from "../src/kernel/probe/server.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const project = process.argv[2];
if (!project) throw new Error("用法：verify-resident-timeout.ts <工程目录>");
const { ctx } = await openProject({
	projectRoot: resolve(project),
	agentConfigDir: join(homedir(), ".fast-ai-cosmic"),
	cacheRoot: join(homedir(), ".fast-ai-cosmic", "verification", "resident-timeout"),
	agentVersion: "0.0.0-resident-timeout-ruler",
	resources: EMBEDDED_RESOURCES,
});
const relative = ".cosmic-ai/probes/ResidentTimeoutRuler.java";
const file = join(ctx.projectRoot, relative);
const source = `/** WAIT_MS=毫秒  只等待和打印，不访问业务数据。 */
public class ResidentTimeoutRuler {
    public static void run() throws Exception {
        long ms = Long.parseLong(System.getenv("WAIT_MS"));
        System.out.println("[PROBE] wait=" + ms);
        Thread.sleep(ms);
        System.out.println("[PROBE] waited=" + ms);
    }
}
`;
if (existsSync(file) && readFileSync(file, "utf8") !== source) throw new Error(`已有其他内容，未覆盖：${file}`);
mkdirSync(join(ctx.projectRoot, ".cosmic-ai", "probes"), { recursive: true });
writeFileSync(file, source);
const started = performance.now();
const rows: object[] = [];
async function ask(label: string, wait: number, timeoutMs?: number) {
	console.log(`${label}：开始`);
	const at = performance.now();
	const result = await probe(ctx, relative, {
		env: { WAIT_MS: String(wait) },
		countRepeats: false,
		coldFallback: false,
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		onProgress: (phase) => console.log(`${label}：${phase}`),
	});
	assert(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
	const row = {
		label,
		seconds: Math.round((performance.now() - at) / 100) / 10,
		pid: readManifest(ctx)?.pid,
		path: result.value.path,
		exitCode: result.value.exitCode,
		output: result.value.output,
		notes: result.value.notes,
	};
	rows.push(row);
	console.log(JSON.stringify(row));
	return row;
}
const ticker = setInterval(
	() => console.log(`复测已运行 ${Math.round((performance.now() - started) / 1000)} 秒`),
	20_000,
);
try {
	const timeout = await ask("普通上限超时", 125_000);
	assert.equal(timeout.exitCode, 1);
	assert.match(timeout.output, /探针超过 120 秒未结束/);
	assert.equal((await localServiceHealth(ctx)).kind, "unhealthy");
	const recovered = await ask("下一次自动恢复", 0);
	assert.equal(recovered.exitCode, 0);
	assert.equal(recovered.path, "hot");
	assert.notEqual(recovered.pid, timeout.pid);
	const long = await ask("操作等待额度125秒", 125_000, 300_000);
	assert.equal(long.exitCode, 0);
	assert.equal(long.pid, recovered.pid);
	const reused = await ask("后续复用", 0);
	assert.equal(reused.exitCode, 0);
	assert.equal(reused.pid, recovered.pid);
	assert.equal((await localServiceHealth(ctx)).kind, "ready");
	console.log(JSON.stringify({ pass: true, seconds: Math.round((performance.now() - started) / 1000), rows }));
} finally {
	clearInterval(ticker);
	console.log(JSON.stringify({ cleanup: await stopServer(ctx) }));
}
