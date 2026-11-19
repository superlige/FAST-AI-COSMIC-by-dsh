/**
 * 真机验证：原厂插件把发往浏览器的通道强转成平台具体类 ClientViewProxy 时，run form 不再在打开表单那一步断掉；
 * 断掉的话结果标「没跑完整」、不留验证记录（S54）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-client-channel.ts <工程目录>
 *
 * 默认跑 zlgd_ygpt2.0 真机 2026-10-10 会话里那条原命令：销售订单扩展 zlgd_sm_salorder_ext、单据 HLL2500001，
 * 点分录跟踪号超链接，断 8 条弹窗参数；只在内存里改跟踪号，不保存。会真的调 MES 接口查一次。
 * 当时原厂 BillTplPlugin.setDiscountRateScale 抛 ClassCastException（com.sun.proxy.$Proxy44 转不成 ClientViewProxy），
 * 排在它后面的插件 loadData 全没跑，8 条断言照样全过并记成 PASS。单据换了用 CC_PK 覆盖。
 *
 * 判据（同一条命令，前后并排）：
 *   1. 原始输出里没有 ClassCastException、没有「loadData ⚠ 失败」，没有 run-incomplete 记录；
 *   2. 原厂插件那次强转后调的 invokeControlMethod(billentry, setColEditorProp, discountrate…) 进了记账
 *      ——平台类的这个方法是 final，进了记账说明钩子装上了，不是插件碰巧没走到；
 *   3. 断言 8/8 过、留下一条 PASS 验证记录。
 * 常驻进程用的是 JDK 自带换类（默认）才有钩子；挂 JRebel 时第 1、2 条会挂，第 3 条应变成「没跑完整、不留记录」。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-client-channel.ts <工程目录>");
	process.exit(2);
}
const pk = process.env.CC_PK ?? "2329738815318540288";
const expects = [
	"opened=zlgd_mes_info_show",
	"opened.bdMesOrderNo=C226002874",
	'opened.bdMesSalesOrderHeader~="zlgd_customer_name":"重庆东憧铝业有限公司"',
	'opened.bdMesSalesOrderHeader~="zlgd_product_name":"热轧料5052"',
	'opened.bdMesSalesOrderHeader~="zlgd_contract_no":"(2024)ZLGD-GYL-02-XS-00411"',
	'opened.bdMesSalesOrderHeader~="zlgd_salesperson":"李彬"',
	'opened.bdMesSalesOrderHeader~="zlgd_order_no":"C226002874"',
	'opened.bdMesSalesOrderHeader~="zlgd_required_weight":5',
];
const argv = [
	"form",
	"zlgd_sm_salorder_ext",
	"--pk",
	pk,
	"--set",
	"billentry[0].zlgd_dqnbhth=C226002874",
	"--hyperlink",
	"billentry[0].zlgd_dqnbhth",
	"--calls",
	"5000",
	...expects.flatMap((e) => ["--expect", e]),
];

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
let failures = 0;
const check = (ok: boolean, what: string): void => {
	console.log(`   ${ok ? "✔" : "✘"} ${what}`);
	if (!ok) failures++;
};

console.log(`run ${argv.join(" ")}`);
const t0 = Date.now();
const report = await kernel.run(opened.value.handle, argv, {});
const seconds = Math.round((Date.now() - t0) / 1000);
if (!report.ok) {
	console.log(`   ✘ run 被拒：${report.error.code} ${report.error.message}`);
	process.exit(1);
}
// 给模型的那份会裁掉中间，判据按本机的完整输出看
const full = report.value.outputFile ? readFileSync(report.value.outputFile, "utf8") : (report.value.output ?? "");
const records = report.value.json.records;
console.log(`   用时 ${String(seconds)} 秒，路径 ${report.value.path}，原始输出 ${report.value.outputFile ?? "(无)"}`);
for (const line of full.split(/\r?\n/))
	if (/loadData|ClassCastException|没跑完整|通道|断言 \d|setColEditorProp.*discountrate/.test(line))
		console.log(`   | ${line.slice(0, 220)}`);

check(!full.includes("ClassCastException"), "没有 ClassCastException");
check(!/loadData ⚠ 失败/.test(full), "打开表单的 loadData 没断");
check(!records.some((record) => record.t === "run-incomplete"), "没有「没跑完整」记录");
check(/setColEditorProp.*discountrate/.test(full), "原厂插件强转后调的 setColEditorProp(discountrate) 进了记账");
check(/断言 8\/8 通过/.test(full), "断言 8/8 通过");
const filed = report.value.evidence.filed;
check(
	filed.length === 1 && filed[0]?.result === "PASS",
	`留下一条 PASS 验证记录（实际 ${JSON.stringify(filed.map((e) => e.result))}）`,
);
for (const note of report.value.evidence.notes) console.log(`   note: ${note.slice(0, 220)}`);

console.log(failures === 0 ? "全部通过" : `${failures} 项没过`);
process.exit(failures === 0 ? 0 : 1);
