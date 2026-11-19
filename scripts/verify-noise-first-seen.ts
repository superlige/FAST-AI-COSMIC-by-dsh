/**
 * S37 2-C.1 真机验证：一次运行里打印两遍的全新异常，返回里不说成"老面孔"；下一次运行才说"此前 1 次"。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-noise-first-seen.ts <工程目录>
 *
 * 写一个临时探针到工程的 `.cosmic-ai/probes/`，按平台日志的样子把同一条异常打两遍（异常文字里带一个每次不同的字母串，
 * 保证账本里从没见过），同一个探针连跑两次，看两次返回里的异常说明。跑完删掉临时探针。
 * 账本（`.cosmic-ai/` 下 cosmic 自己的缓存）会多记这一条，不删别的记录。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-noise-first-seen.ts <工程目录>");
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

// 只用字母：数字会被账本的指纹抹平
const marker = Array.from({ length: 12 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
const PROBE = `/** S37 2-C.1 真机验证：同一条全新异常按平台日志的样子打两遍。不读写业务数据。 */
public class NoiseFirstSeen {
    public static void run() throws Exception {
        for (int i = 0; i < 2; i++) {
            System.out.println("2026-09-26 10:00:00 ERROR --- [main] kd.bos.verify.NoiseFirstSeen");
            new IllegalStateException("s37 verify ${marker}").printStackTrace(System.out);
        }
        System.out.println("[PROBE] 打印完两遍");
    }
}
`;
const probeDir = join(projectRoot, ".cosmic-ai", "probes");
const probeFile = join(probeDir, "NoiseFirstSeen.java");
if (existsSync(probeFile)) {
	console.error(`${probeFile} 已经存在，不覆盖`);
	process.exit(1);
}
mkdirSync(probeDir, { recursive: true });
writeFileSync(probeFile, PROBE);
try {
	for (const title of ["第一次运行（账本里从没见过）", "第二次运行（上一次记过一次）"]) {
		const started = Date.now();
		const result = await kernel.probe(project, ".cosmic-ai/probes/NoiseFirstSeen.java", {});
		console.log(`== ${title}（${Date.now() - started} ms）`);
		if (!result.ok) {
			console.log(`   ${JSON.stringify(result.error.toJSON()).slice(0, 1500)}`);
			continue;
		}
		const notes = result.value.notes.filter((note) => /异常|老面孔|此前|RUNTIME-WARN|s37 verify/.test(note));
		for (const note of notes) console.log(`   ${note.slice(0, 300)}`);
		console.log(`   说成老面孔了吗：${notes.some((note) => note.includes("老面孔")) ? "是" : "否"}`);
	}
} finally {
	rmSync(probeFile, { force: true });
}
