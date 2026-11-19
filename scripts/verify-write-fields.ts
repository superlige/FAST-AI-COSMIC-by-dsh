/**
 * S37 2-B.2 真机验证：会保存的四条写入路（造数、改数、run op、run print --set）字段写错时，一条都不保存，并给出相近的真名；
 * 写对的照常放行。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-write-fields.ts <工程目录> [会话目录]
 *
 * 三步：
 *   1. 同一批样本重放：`measure-write-fields.ts --tsv` 取出会话里全部写入调用（实体 + 字段路径），
 *      写一个临时探针在真机上逐条过 OpSandbox.wrongPaths（和四条写入路同一个函数，只读元数据、不建对象、不保存），
 *      拦下的应当正好是尺子认出的那几处写错，没有误拦；临时探针跑完就删。
 *   2. 基线原样重来：09-22 第 119 次造数（zlgd_org、zlgd_wtdw 写错，APPLY=1），看是不是在保存之前停下、用了多久。
 *   3. 另外三条路各写错一个字段跑一次：改数（预演）、run op、run print --set。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, sessionArg] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-write-fields.ts <工程目录> [会话目录]");
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

/** 输出里和这次验证有关的行：写错的、保存的、结论。 */
const RELEVANT = /✗|✘|没有字段|没有分录|最接近|执行 save|跑之前行数|--- 执行|改值、保存|重放|PROBE-ERR|整批|没有保存/;
function show(output: string): void {
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 300)}`);
	console.log(`   走到保存了吗：${/执行 save|跑之前行数|--- 执行 |改值、保存/.test(output) ? "是" : "否"}`);
}

// ---- 1. 同一批样本重放
const tsv = join(tmpdir(), `s37-write-fields-${process.pid}.tsv`);
const ruler = spawnSync(
	process.execPath,
	[
		"--experimental-strip-types",
		fileURLToPath(new URL("./measure-write-fields.ts", import.meta.url)),
		sessions,
		join(projectRoot, ".cosmic-ai", "work", "impact.json"),
		"--tsv",
		tsv,
	],
	{ encoding: "utf8" },
);
console.log(ruler.stdout.trim().split("\n").slice(-12).join("\n"));

const REPLAY = `import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

import kd.bos.entity.MainEntityType;

/** S37 2-B.2 真机重放：历史写入的字段路径逐条过 OpSandbox.wrongPaths。只读元数据，不建对象、不保存。 */
public class WritePathReplay {
    public static void run() throws Exception {
        List<String> lines = Files.readAllLines(Paths.get(System.getenv("REPLAY_FILE")), StandardCharsets.UTF_8);
        int calls = 0;
        int fields = 0;
        int blocked = 0;
        for (String line : lines) {
            String[] cols = line.split("\\t");
            if (cols.length < 3) {
                continue;
            }
            calls++;
            fields += cols[2].split(";").length;
            MainEntityType met = MetaResolve.type(cols[1]);
            List<String[]> wrong = OpSandbox.wrongPaths(met, cols[2]);
            if (wrong.isEmpty()) {
                continue;
            }
            blocked++;
            for (String[] w : wrong) {
                System.out.println("[PROBE] ✗ " + cols[0] + " " + cols[1] + " " + w[0] + " —— " + w[1]);
            }
        }
        System.out.println("[PROBE] 重放 " + calls + " 次写入、" + fields + " 个字段，拦下 " + blocked + " 次");
    }
}
`;
const probeDir = join(projectRoot, ".cosmic-ai", "probes");
const probeFile = join(probeDir, "WritePathReplay.java");
if (existsSync(probeFile)) {
	console.error(`${probeFile} 已经存在，不覆盖`);
	process.exit(1);
}
mkdirSync(probeDir, { recursive: true });
writeFileSync(probeFile, REPLAY);
try {
	const started = Date.now();
	const replay = await kernel.probe(project, ".cosmic-ai/probes/WritePathReplay.java", { env: { REPLAY_FILE: tsv } });
	console.log(`== 1. 同一批样本在真机上过 wrongPaths（${Date.now() - started} ms）`);
	if (replay.ok) show(replay.value.output);
	else console.log(JSON.stringify(replay.error.toJSON()).slice(0, 2000));
} finally {
	rmSync(probeFile, { force: true });
	rmSync(tsv, { force: true });
}

// ---- 2. 基线原样重来
async function probe(title: string, name: string, env: Record<string, string>): Promise<void> {
	const started = Date.now();
	const result = await kernel.probe(project, name, { env });
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!result.ok) {
		console.log(`   ${JSON.stringify(result.error.toJSON()).slice(0, 1500)}`);
		return;
	}
	console.log(`   exit ${result.value.exitCode}`);
	show(result.value.output);
}
await probe("2. 09-22 第 119 次造数原样重来", "DataSeedProbe", {
	SEED_ENTITY: "zlgd_qty_wtd",
	SEED_SET: "billno=ZLGDTESTWD01;zlgd_org=04;zlgd_request_name=熔铸厂;zlgd_wtdw=熔铸厂",
	SEED_OPS: "save,submit,audit",
	APPLY: "1",
});

// ---- 3. 另外三条路
await probe("3a. 改数写错一个字段（预演）", "DataUpdateProbe", {
	UPD_ENTITY: "zlgd_sys_test_bill",
	UPD_NUMBERS: "SYSJC-20260831-0001",
	UPD_SET: "zlgd_wtdhh=1",
});
async function run(title: string, argv: string[]): Promise<void> {
	const started = Date.now();
	const report = await kernel.run(project, argv, {});
	console.log(`== ${title}（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 1500)}`);
		return;
	}
	show(report.value.output ?? "");
}
await run("3b. run op 写错一个字段", [
	"op",
	"zlgd_qty_wtd",
	"save",
	"--set",
	"billno=T-S37-2B2",
	"--set",
	"zlgd_wtdw=熔铸厂",
]);
await run("3c. run print --set 写错一个字段", [
	"print",
	"zlgd_sys_test_bill_prtpl_jjfswl",
	"--pk",
	"2560941241403458560",
	"--set",
	"zlgd_wtdhh=1",
	"--show",
	"LayoutCell19",
]);
process.exit(0);
