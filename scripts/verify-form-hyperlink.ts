/**
 * 真机验证：`run form --hyperlink` 点分录超链接、`--expect opened= / opened.参数= / message=` 断动作效果，
 * 扩展单据开原单，整类名编译，API 查询给泛型签名（S52）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-form-hyperlink.ts <工程目录>
 *
 * 默认按 zlgd_ygpt2.0 的销售订单扩展 zlgd_sm_salorder_ext、插件 SxddShowMesDataFormPlugin 和下面几张现成单据跑，
 * 点超链接不提交；0301 那条会真的调 MES 接口、写一条接口日志（本机连不上 MES 时插件把错误放进 showmessage 照样开页面）。
 * 单据换了用环境变量覆盖：HL_PK_0301、HL_PK_OTHER_HIT、HL_PK_OTHER_MISS、HL_PK_0301_EMPTY。
 *
 * 每个 run form 约 2 分钟；0301 那条连 MES 超时约 25 秒，排第一个跑（刚编译完）时两次碰了探针 120 秒上限，所以放最后。
 * 对照：真机 2026-10-09 会话 01a11e4e 改的就是这个超链接，run form 点不了、断不了，代码编过了交不了。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-form-hyperlink.ts <工程目录>");
	process.exit(2);
}
const form = "zlgd_sm_salorder_ext";
const cell = "billentry[0].zlgd_dqnbhth";
const pks = {
	org0301: process.env.HL_PK_0301 ?? "2360875085595688960",
	otherHit: process.env.HL_PK_OTHER_HIT ?? "2519674990228459520",
	otherMiss: process.env.HL_PK_OTHER_MISS ?? "2575660919623301120",
	org0301Empty: process.env.HL_PK_0301_EMPTY ?? "2214692569638549504",
};
const agentConfigDir = process.env.COSMIC_AGENT_DIR ?? join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: process.env.COSMIC_CACHE_ROOT ?? join(agentConfigDir, "cache"),
	agentVersion: "0.1.0",
	knowledgePackFile: join(import.meta.dirname, "..", "knowledge", "cosmic-kb.pack"),
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(projectRoot);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const project = opened.value.handle;
let failures = 0;
const check = (ok: boolean, what: string): void => {
	console.log(`   ${ok ? "✔" : "✘"} ${what}`);
	if (!ok) failures++;
};

console.log("1. cosmic_fast 给整类名");
const built = await kernel.fast(project, ["zlgd.ygpt.form.SxddShowMesDataFormPlugin"], {});
check(built.ok, built.ok ? "编译通过" : `被拒：${built.error.code} ${built.error.message}`);

console.log("2. API 查询带泛型");
const api = await kernel.knowledge(
	{ action: "api", query: "kd.bos.custom.zlgd.mes.common.SendMesInfoBuilder" },
	projectRoot,
	project,
);
check(api.ok && JSON.stringify(api.value).includes("List<List<Object>>"), "buildJSON 的参数写成 List<List<Object>>");

const RELEVANT = /扩展|【点超链接】|捕获 showForm|PASS|FAIL|没法判断|断言 \d|提示:|错误:|PROBE-ERR/;
async function scenario(title: string, pk: string, expects: string[]): Promise<void> {
	console.log(title);
	const argv = ["form", form, "--pk", pk, "--hyperlink", cell, ...expects.flatMap((e) => ["--expect", e])];
	const t0 = Date.now();
	const report = await kernel.run(project, argv, {});
	if (!report.ok) {
		check(false, `run 被拒：${report.error.code} ${report.error.message}`);
		return;
	}
	const output = report.value.output ?? "";
	for (const line of output.split(/\r?\n/)) if (RELEVANT.test(line)) console.log(`   ${line.slice(0, 200)}`);
	const total = expects.length;
	check(
		new RegExp(`断言 ${total}/${total} 通过`).test(output),
		`断言全过（${Math.round((Date.now() - t0) / 1000)} 秒）`,
	);
}

await scenario("3. 别的组织、跟踪表里有记录：照旧开 MES 信息页", pks.otherHit, [
	"opened=zlgd_mes_info_show",
	"message=",
]);
await scenario("4. 别的组织、跟踪表里没有：照旧报没查到", pks.otherMiss, ["opened=", "message=尚未查询到"]);
await scenario("5. 0301 组织、合同号为空：提示、不开页面", pks.org0301Empty, [
	"opened=",
	"message=该分录的内部合同号为空",
]);

// 0301 这条放最后：刚编译完的第一个场景要重新装业务类，再加 MES 连不上的约 25 秒超时，会碰探针 120 秒上限
await scenario("6. 0301 组织：查 MES、开订单生产进度页并带 showmessage", pks.org0301, [
	"opened=zlgd_salorder_progress",
	"opened.showmessage~=rx_",
	"message=",
]);

console.log(failures === 0 ? "全部通过" : `${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
