/**
 * S37 工作流参考文档的真机实测，写操作那一半：审批、撤回、终止在真实流程上到底做了什么。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-wf-write.ts <工程目录> [场景字母…，默认全部；`C=<单据id>` 接着用那张已提交的单]
 *   node --experimental-strip-types scripts/verify-wf-write.ts <工程目录> call <方法> '<JSON 参数数组>'   只调一个方法
 *   node --experimental-strip-types scripts/verify-wf-write.ts <工程目录> purge          删掉环境里所有 WFW- 测试单
 *   node --experimental-strip-types scripts/verify-wf-write.ts <工程目录> seed-wtd       给需求 1 复测备两组样本
 *   场景后面加 --keep：场景跑完留着那张单（默认删掉）
 *
 * 临时探针只准读，写方法只能从工程源码里调：把 `scripts/wf-sdk/WfWriteCheck.java` 拷进工程
 * （`zlgd-hhx/src/main/java/zlgd/wfcheck/`，包名写死 zlgd，只适用 zlgd 真机工程；拷之前要征得工程主人同意），
 * `cosmic_fast` 编译，`run call --schedule` 逐个调（常驻进程默认不起调度服务，不带它提交后流程不发起），
 * 跑完删掉源码和编译出的 class。每个动作返回动作之后、流程状态稳住之后的状态。
 *
 * 场景（每个场景新建一张 zlgd_sys_test_bill 草稿，组织 04：这张单据只有 04 的单子提交后进审批流，0101、0102 提交即止）。
 * 04 下不往外发东西：审核推 MES 的插件只管 0101；审核调接口的插件要检验类型 zlgd_jylx1 有值，它又是提交必填，
 * 所以提交后直接存库清掉它（clearTestType），清不掉场景就停；
 * 撤销时删源单、调接口的插件只在最近一条审批是驳回时动手，草稿没有源委托单，它在查源单那步报错，走不到接口。
 * 流程给审批人的待办消息照发。
 *   A 提交 → 同意一次 → 撤回刚处理的任务 → 一路同意到流程结束
 *   B 提交 → canWithdraw → withdraw(obj) → 单据撤销操作
 *   C 提交 → batchWithdraw(obj, "unsubmit")
 *   D 提交 → billUnsubmit(obj, "unsubmit", abandonPks)
 *   E 提交 → 终止 abandonByBusienssKey → 撤销、填回检验类型再提交 → abandonRootProcessInstance
 *   F 提交 → 驳回（RejectToEdit）→ 重新提交 → 回到审批节点后 batchAuditByBusinesskeys(approve)
 *   G 提交 → canWithdraw → 直接跑单据撤销操作（不先撤流程）
 *   H 提交 → 同意到流程结束（已审核）→ canWithdraw → 单据撤销操作
 *   （批量同意 batchAgreeTaskWithUserId 测试类里留着，用 call 单调）
 *
 * 单据编号以 WFW- 开头，场景跑完就删（终止流程、直接删库，见测试类 purge）。以前留在环境里：09-27 需求 1 复测时
 * 西北铝最新的 20 张检测单全是它们，都没有上游委托单，模型据此以为「西北铝的检测单没有关联」，多绕了 4.7 分钟（S37 批 6）。
 *
 * seed-wtd：挑两张西北铝已审核、没有任何下游的委托单，按真实转换规则各下推一张检测单——一张留暂存，一张提交进流程、
 * 停在第一个审批节点（还能撤回）。复测前跑一次，每轮复测起点一样；复测会删掉用到的样本，下一轮再跑。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const [projectRoot, ...picked] = process.argv.slice(2);
if (projectRoot === undefined) {
	console.error("用法：verify-wf-write.ts <工程目录> [场景字母…]");
	process.exit(2);
}
// `call <方法> <JSON 参数数组>`：只调测试类的一个方法，排查用
const single =
	picked[0] === "call" ? { method: picked[1] ?? "", args: JSON.parse(picked[2] ?? "[]") as unknown[] } : null;
const mode = picked[0] === "purge" || picked[0] === "seed-wtd" ? picked[0] : null;
const keep = picked.includes("--keep");
// 场景字母，或 `字母=单据id`：接着用那张已提交的单
const letters = picked.filter((arg) => arg !== "--keep");
const scenarioArgs = (letters.length === 0 ? ["A", "B", "C", "D", "E", "F", "G", "H"] : letters).map((s) =>
	s.split("="),
);
const scenarios = new Set(scenarioArgs.map(([letter]) => (letter ?? "").toUpperCase()));
const reuse = new Map(scenarioArgs.map(([letter, id]) => [(letter ?? "").toUpperCase(), id]));
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

const CLASS = "zlgd.wfcheck.WfWriteCheck";
const source = join(dirname(fileURLToPath(import.meta.url)), "wf-sdk", "WfWriteCheck.java");
const packageDir = join(projectRoot, "zlgd-hhx", "src", "main", "java", "zlgd", "wfcheck");
const target = join(packageDir, "WfWriteCheck.java");
if (existsSync(packageDir)) {
	console.error(`${packageDir} 已经存在，不覆盖`);
	process.exit(1);
}

/** 编译产物里的 zlgd/wfcheck 目录：删源码时一起删，不在工程里留下测试类。 */
function compiledDirs(root: string, depth = 0, found: string[] = []): string[] {
	if (depth > 8) return found;
	for (const name of readdirSync(root)) {
		if (name === "node_modules" || name === ".git" || name === "src") continue;
		const path = join(root, name);
		if (!statSync(path).isDirectory()) continue;
		if (name === "wfcheck" && root.endsWith(join("zlgd"))) found.push(path);
		else compiledDirs(path, depth + 1, found);
	}
	return found;
}

interface Called {
	lines: string[];
	ok: boolean;
}

async function call(method: string, args: unknown[]): Promise<Called> {
	const started = Date.now();
	// 调度服务默认不起：没有它，提交照样成功、流程却不发起
	const report = await kernel.run(
		project,
		["call", `${CLASS}#${method}`, "--args", JSON.stringify(args), "--schedule"],
		{},
	);
	console.log(`-- ${method}(${args.map((a) => JSON.stringify(a)).join(", ")})（${Date.now() - started} ms）`);
	if (!report.ok) {
		console.log(`   ${JSON.stringify(report.error.toJSON()).slice(0, 2000)}`);
		return { lines: [], ok: false };
	}
	if (process.env.WF_VERBOSE === "1") {
		console.log(report.value.output);
		for (const note of report.value.notes) console.log(`   · ${note.slice(0, 600)}`);
	}
	const lines = (report.value.output ?? "")
		.split("\n")
		.filter((line) => line.includes("[WF]") || /\[PROBE\] (抛异常|✘)/.test(line));
	for (const line of lines) console.log(`   ${line.replace("[PROBE] [WF] ", "")}`);
	return { lines, ok: !lines.some((line) => line.startsWith("[PROBE] 抛异常")) };
}

function stateOf(called: Called, key: string): string | null {
	const line = called.lines.find((l) => l.includes(`state.${key} `));
	return line === undefined ? null : line.slice(line.indexOf(`state.${key} `) + `state.${key} `.length).trim();
}

/**
 * 新建一张草稿并提交，清掉检验类型，等第一个审批任务出来；没进流程就返回 null，这个场景不往下走。
 * 场景写成 `C=<单据id>` 时不新建，接着用那张已提交的单（上一轮跑到一半停下留下的）。
 */
async function submitted(label: string, existing: string | undefined): Promise<string | null> {
	console.log(`\n==== 场景 ${label}`);
	let id = existing;
	if (id === undefined) {
		const created = await call("newBill", ["04"]);
		id = created.lines.map((l) => /id=(\d+)/.exec(l)?.[1]).find((v) => v !== undefined);
		if (id === undefined) {
			console.log("   !! 草稿没建成，场景跳过");
			return null;
		}
		made.push(id);
		if (!(await submitInto(id))) return null;
	}
	return (await readyForAction(id)) ? id : null;
}

/** 这次跑场景新建的单，跑完删掉。 */
const made: string[] = [];

/** 删掉环境里所有 WFW- 测试单（本脚本以前留下的）。 */
async function purgeAll(): Promise<void> {
	const listed = await call("wfwBills", []);
	const ids = listed.lines.map((l) => /id=(\d+)/.exec(l)?.[1]).filter((v) => v !== undefined);
	console.log(`共 ${ids.length} 张`);
	for (const id of ids) await call("purge", [id]);
	await call("wfwBills", []);
}

/** 给需求 1 复测备样本：一组暂存、一组停在审批节点。 */
async function seedWtd(): Promise<void> {
	const clean = await call("cleanEntrusts", [2]);
	const entrusts = clean.lines.map((l) => /cleanEntrust (\S+)/.exec(l)?.[1]).filter((v) => v !== undefined);
	if (entrusts.length < 2) {
		console.log(`   !! 干净的委托单只剩 ${entrusts.length} 张，不够两组`);
		process.exitCode = 1;
		return;
	}
	const pushedId = (called: Called) =>
		called.lines.map((l) => /pushTestBill .* id=(\d+)/.exec(l)?.[1]).find((v) => v !== undefined);
	const draft = pushedId(await call("pushTestBill", [entrusts[0]]));
	const inFlow = pushedId(await call("pushTestBill", [entrusts[1]]));
	if (draft === undefined || inFlow === undefined) {
		console.log("   !! 下推没成");
		process.exitCode = 1;
		return;
	}
	if (!((await submitInto(inFlow)) && (await readyForAction(inFlow)))) process.exitCode = 1;
	await call("canWithdraw", [inFlow]);
	console.log(`\n样本：${entrusts[0]} → 暂存检测单 id=${draft}；${entrusts[1]} → 审批中检测单 id=${inFlow}`);
}

/** 提交并确认进了流程。 */
async function submitInto(id: string): Promise<boolean> {
	const submit = await call("op", [id, "submit"]);
	if (stateOf(submit, "inProcess") === "true") return true;
	console.log("   !! 提交后没在流程里，场景跳过");
	return false;
}

/** 清掉检验类型，等审批任务出来；不成就返回 false，场景不往下走。 */
async function readyForAction(id: string): Promise<boolean> {
	const cleared = await call("clearTestType", [id]);
	if (!cleared.lines.some((l) => /zlgd_jylx1=(null|)\}/.test(l))) {
		console.log("   !! 检验类型没清掉，审批走完会把测试单推给外部系统，场景停在这里");
		return false;
	}
	// 第一个审批任务是后台派出来的，慢时一分半以上；一次调用只等 80 秒，不够就再调
	for (let i = 0; i < 3; i++) {
		const waited = await call("waitTask", [id]);
		if (stateOf(waited, "inProcess") !== "true") {
			console.log("   !! 等任务时流程已不在了，场景跳过");
			return false;
		}
		if (stateOf(waited, "wf_task") !== "[]") return true;
	}
	console.log("   !! 等了 4 分钟还没有审批任务，场景跳过");
	return false;
}

/** 同意到流程结束，最多 8 个节点。 */
async function approveAll(id: string): Promise<void> {
	for (let i = 0; i < 8; i++) {
		const step = await call("complete", [id, "Consent"]);
		if (stateOf(step, "inProcess") !== "true") return;
	}
	console.log("   !! 同意了 8 次还在流程里，停");
}

const leftover = compiledDirs(projectRoot);
if (leftover.length > 0) {
	console.error(`工程里已有 zlgd/wfcheck 编译产物，不是这次放的，不动：${leftover.join("、")}`);
	process.exit(1);
}
mkdirSync(packageDir, { recursive: true });
copyFileSync(source, target);
try {
	const compiled = await kernel.fast(project, [target]);
	if (!compiled.ok) {
		console.log(`编译失败：${JSON.stringify(compiled.error.toJSON()).slice(0, 3000)}`);
		process.exitCode = 1;
	} else if (single !== null) {
		await call(single.method, single.args);
	} else if (mode === "purge") {
		await purgeAll();
	} else if (mode === "seed-wtd") {
		await seedWtd();
	} else {
		if (scenarios.has("A")) {
			const id = await submitted("A 同意、撤回已处理的任务、同意到结束", reuse.get("A"));
			if (id !== null) {
				const first = await call("complete", [id, "Consent"]);
				const user = first.lines.map((l) => /completeTask\(\d+,(\d+),/.exec(l)?.[1]).find((v) => v !== undefined);
				if (stateOf(first, "inProcess") === "true" && user !== undefined) {
					// 字符串传：19 位的用户 id 过 Number 会丢掉末几位
					await call("withdrawTask", [id, user]);
				}
				await approveAll(id);
			}
		}
		if (scenarios.has("B")) {
			const id = await submitted("B canWithdraw、withdraw(obj)、单据撤销", reuse.get("B"));
			if (id !== null) {
				await call("canWithdraw", [id]);
				await call("withdraw", [id]);
				await call("op", [id, "unsubmit"]);
			}
		}
		if (scenarios.has("C")) {
			const id = await submitted("C batchWithdraw", reuse.get("C"));
			if (id !== null) await call("batchWithdraw", [id, "unsubmit"]);
		}
		if (scenarios.has("D")) {
			const id = await submitted("D billUnsubmit", reuse.get("D"));
			if (id !== null) await call("billUnsubmit", [id, "unsubmit"]);
		}
		if (scenarios.has("E")) {
			const id = await submitted("E 终止、再提交、终止根流程", reuse.get("E"));
			if (id !== null) {
				await call("abandon", [id]);
				// 终止后单据还是已提交，要先撤销回暂存；检验类型是提交必填：填回去再提交，进了流程再清掉
				await call("op", [id, "unsubmit"]);
				await call("restoreTestType", [id]);
				if ((await submitInto(id)) && (await readyForAction(id))) await call("abandonRoot", [id]);
			}
		}
		if (scenarios.has("F")) {
			const id = await submitted("F 驳回、批量同意、batchAuditByBusinesskeys", reuse.get("F"));
			if (id !== null) {
				// 决策项编码按节点配置：这个节点的驳回是 RejectToEdit（驳回至提交节点），传 Reject 会被拒
				await call("complete", [id, "RejectToEdit"]);
				// 驳回至提交节点：流程挂在提交节点上、没有待办，看重新提交能不能接上。
				// 提交不了就停：最近一条是驳回时撤销会触发删源单、调接口的插件，不走那条路
				const resumed = await call("op", [id, "submit"]);
				if (resumed.lines.some((l) => l.includes("submit {success=true")) && (await readyForAction(id))) {
					await call("batchAudit", [id, "approve"]);
				}
			}
		}
		if (scenarios.has("G")) {
			const id = await submitted("G 流程中直接跑单据撤销操作", reuse.get("G"));
			if (id !== null) {
				await call("canWithdraw", [id]);
				await call("op", [id, "unsubmit"]);
			}
		}
		if (scenarios.has("H")) {
			const id = await submitted("H 审批完（已审核）后 canWithdraw、单据撤销操作", reuse.get("H"));
			if (id !== null) {
				await approveAll(id);
				await call("canWithdraw", [id]);
				await call("op", [id, "unsubmit"]);
			}
		}
		if (!keep) for (const id of made) await call("purge", [id]);
	}
} finally {
	rmSync(packageDir, { recursive: true, force: true });
	for (const dir of compiledDirs(projectRoot)) {
		rmSync(dir, { recursive: true, force: true });
		console.log(`已删编译产物 ${dir}`);
	}
	console.log(`已删测试类 ${packageDir}`);
}
