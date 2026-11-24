#!/usr/bin/env node --experimental-strip-types
/**
 * 真机验 JVM 状态板的宿主半边（界面上 JVM 小标签背后的那份账），不经模型、不经界面。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-jvm-board.ts <工程目录> [--keep]
 *
 * 走一遍界面进到会话时的路：登记会话 → ensure（认工程、后台起常驻 JVM）→ 每秒看一次状态，打印走到哪一步、
 * 已等几秒，直到这一趟走完；再按同一工程登记第二个会话，确认它搭同一个 JVM、不重起；最后打印详情（本机进程清单）。
 * 用的是产品自己的内核单例（和桌面、网页同一个运行时版本号），起的就是界面会起的那一个 JVM。
 * 不带 --keep 时结束前停掉它。
 */

import { cosmicJvmBoard } from "../src/dsh/kernel.ts";

const [root, ...flags] = process.argv.slice(2);
if (root === undefined) {
	console.error("用法：node --experimental-strip-types scripts/verify-jvm-board.ts <工程目录> [--keep]");
	process.exit(2);
}
const keep = flags.includes("--keep");
const board = cosmicJvmBoard();
const began = Date.now();
const elapsed = () => `${((Date.now() - began) / 1000).toFixed(1)}s`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

board.track("verify-1", root);
console.log(`[${elapsed()}] ensure:`, await board.act("verify-1", "ensure"));

let last = "";
for (;;) {
	const view = await board.view("verify-1");
	const boot = view.boot;
	const running = boot?.steps.find((step) => step.state === "run");
	const line = `phase=${boot?.phase ?? "-"} step=${running?.label ?? "-"} live=${view.live?.kind ?? "-"}`;
	if (line !== last) console.log(`[${elapsed()}] ${line}`);
	last = line;
	if (boot !== null && boot.done) break;
	await sleep(1000);
}

const done = await board.view("verify-1");
console.log(
	`[${elapsed()}] 这一趟：${done.boot?.phase}，用了 ${String(done.boot?.seconds)} 秒；${done.boot?.detail ?? ""}`,
);
for (const step of done.boot?.steps ?? [])
	console.log(`    ${step.state.padEnd(4)} ${step.label}${step.seconds === null ? "" : ` ${String(step.seconds)}s`}`);
console.log("  project:", done.project);
console.log("  live:", done.live);

board.track("verify-2", root);
await board.act("verify-2", "ensure");
await sleep(3000);
const second = await board.view("verify-2");
console.log(
	`[${elapsed()}] 第二个会话：phase=${second.boot?.phase} live=${second.live?.kind} pid=${String(second.live?.pid)} 共用=${String(second.sharedWith)}`,
);

const detail = await board.view("verify-1", { detail: true });
console.log(`[${elapsed()}] 本机 cosmic 进程（进程清单${detail.machine?.processesListed ? "查到了" : "没查到"}）：`);
for (const jvm of detail.machine?.jvms ?? [])
	console.log(
		`    ${jvm.mine ? "【本会话】" : ""}${jvm.kind} pid ${String(jvm.pid)} ${jvm.projectRoot ?? "?"} ${jvm.state} ${
			jvm.memoryBytes === null ? "内存未知" : `${Math.round(jvm.memoryBytes / 1024 ** 2)} MB`
		} 版本 ${jvm.keyId ?? "?"}`,
	);

if (!keep) console.log(`[${elapsed()}] stop:`, await board.act("verify-1", "stop"));
process.exit(0);
