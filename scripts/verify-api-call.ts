/**
 * 自定义 API 插件走 `run call` 的真机实测（S39）：四种接口插件各挑真机工程里现成的类，照验证路线表给的命令跑一遍。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-api-call.ts <工程目录> [样本名…，默认全部]
 *
 * 只调方法、不改工程源码。样本写死的是 zlgd 真机工程的类名（`zlgd_ygpt2.0`），换工程要换样本。
 * 这些方法本身只读（查单据、拼过滤条件、转报文），不写库、不往外发。
 * 每条都带 `--expect`，全过的那次会在工程的 `.cosmic-ai/evidence/` 下留一条验证记录。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...picked] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-api-call.ts <工程目录> [样本名…]");
	process.exit(2);
}

interface Sample {
	name: string;
	/** 验证路线表里这一族给的方法。 */
	kind: "ApiDeserializerPlugin" | "ApiSavePlugin" | "ApiQueryPlugin" | "ApiSerializerPlugin";
	target: string;
	args: unknown[];
	expect: string[];
}

const SAMPLES: Sample[] = [
	{
		name: "deserial",
		kind: "ApiDeserializerPlugin",
		target: "zlgd.ygpt.api.webservice.ProjectDeserialPlugin#deserializer",
		args: [
			JSON.stringify({ batchId: "B-001", items: [{ pkId: "P-1", XMZSJ: { number: "XM-1", name: "项目一" } }] }),
			"application/json",
		],
		expect: ["batchId=B-001", "data[0].pkId=P-1", "data[0].number=XM-1", "size=2"],
	},
	{
		name: "save",
		kind: "ApiSavePlugin",
		target: "zlgd.ygpt.api.webservice.ProductInWebApi#preHandleRequestData",
		// 第一行是真机现成的销售订单（2026-09-29 查的），插件按订单号补物料；第二行查不到，原样留着、不补 material 键
		args: [[{ billentry: [{ zlgd_ddh: "XSDD-0602-202609-0006" }, { zlgd_ddh: "NO-SUCH-DDH-0001" }] }]],
		expect: ["size=1", "[0].billentry[0].material.number=62031058013", "[0].billentry[1].zlgd_ddh=NO-SUCH-DDH-0001"],
	},
	{
		name: "query",
		kind: "ApiQueryPlugin",
		target: "zlgd.ygwc.api.receivable.ReceivableQueryApi#getFilter",
		args: [["billno", "=", "X-1"], {}],
		expect: ["$~=billstatus", "$~=fjp"],
	},
	{
		name: "query-and",
		kind: "ApiQueryPlugin",
		target: "zlgd.ygwc.api.materialreqou.MaterialreqouQueryApi#getFilter",
		args: [
			[
				["billstatus", "=", "C"],
				["org.number", "in", ["01", "04"]],
			],
			{},
		],
		expect: ["$~=billstatus", "error="],
	},
	{
		name: "serialize",
		kind: "ApiSerializerPlugin",
		target: "zlgd.ygwc.api.pay.PayQueryApi#serialize",
		// 插件按 contentType.contains(nacos MediaType.APPLICATION_JSON) 判断，那个常量带 charset；只写 application/json 它返回 null
		args: [{ data: { rows: [{ pricetaxtotal: 123.456 }] } }, "application/json", "application/json;charset=UTF-8"],
		expect: ["result~=123.46", "contentType~=application/json"],
	},
	{
		name: "serialize-model",
		kind: "ApiSerializerPlugin",
		target: "zlgd.ygpt.api.webservice.CommonApiSerializerPlugin#serializeByModel",
		args: [
			{
				response: { data: { result: [{ billIndex: 0, billStatus: false, id: "0" }] } },
				accept: "application/json",
				contentType: "application/json",
				reqData: { data: [{ formid: "pm_purapplybill" }] },
			},
		],
		expect: ["result~=billIndex", "contentType=application/json"],
	},
];

const chosen = picked.length === 0 ? SAMPLES : SAMPLES.filter((sample) => picked.includes(sample.name));
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

const results: { name: string; kind: string; ms: number; verdict: string }[] = [];
for (const sample of chosen) {
	const argv = ["call", sample.target, "--args", JSON.stringify(sample.args)];
	for (const expect of sample.expect) argv.push("--expect", expect);
	const started = Date.now();
	const report = await kernel.run(project, argv, {});
	const ms = Date.now() - started;
	console.log(`\n==== ${sample.name}（${sample.kind}）${ms} ms`);
	console.log(`run ${argv.map((arg) => (/[\s"[{]/.test(arg) ? `'${arg}'` : arg)).join(" ")}`);
	if (!report.ok) {
		console.log(JSON.stringify(report.error.toJSON()).slice(0, 3000));
		results.push({ name: sample.name, kind: sample.kind, ms, verdict: "工具报错" });
		continue;
	}
	const output = report.value.output ?? "";
	const lines = output.split("\n").filter((line) => line.includes("[PROBE]"));
	for (const line of (lines.length > 0 ? lines : output.split("\n")).slice(0, 30))
		console.log(`  ${line.slice(0, 600)}`);
	for (const note of new Set([...report.value.notes, ...report.value.evidence.notes]))
		console.log(`  · ${note.slice(0, 600)}`);
	// 判定只看工具留下的验证记录：没留记录（输入不成立、没跑起来）就是没验到，不能因为输出里没有 ✘ 就算过
	const filed = report.value.evidence.filed;
	const verdict =
		filed.length === 0 ? "没留记录" : filed.every((record) => record.result === "PASS") ? "全过" : "没过";
	console.log(`  验证记录：${filed.map((record) => `${record.id} ${record.result}`).join("，") || "无"}`);
	results.push({ name: sample.name, kind: sample.kind, ms, verdict });
}
console.log("\n==== 汇总");
for (const row of results) console.log(`  ${row.verdict}  ${row.name}（${row.kind}）${row.ms} ms`);
process.exit(results.every((row) => row.verdict === "全过") ? 0 : 1);
