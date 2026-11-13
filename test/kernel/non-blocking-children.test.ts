import { describe, expect, it } from "vitest";
import { nodeProcess } from "../../src/kernel/ports.ts";

/**
 * 「界面卡住」这件事的验收判据。
 *
 * 内核起的每一个前台子进程都是 javac、gradle 或苍穹 JVM，几十秒到几分钟。spawnSync
 * 期间整条 Node 事件循环停住：转圈停在某一帧、按键不回显、Esc 收不到，对着屏幕的人
 * 分不出「在编译」和「agent 挂了」，分不出就去杀进程——被杀掉的常常是一次已经等了
 * 两分钟的构建。
 *
 * 查的是「有没有同步那扇门」，不是「这一次走没走异步」：真正会复发的形式是有人在新代码里
 * 顺手选了同步版本，而那种复发没有任何测试会红。
 */
describe("内核不给同步子进程留门", () => {
	it("ProcessPort 的实现上没有同步 run", () => {
		expect("run" in nodeProcess).toBe(false);
		expect(typeof nodeProcess.runAsync).toBe("function");
	});

	it("源码里没有 spawnSync（Windows 上收进程树的 taskkill 也走异步）", async () => {
		const { readFileSync, readdirSync, statSync } = await import("node:fs");
		const hits: string[] = [];
		const walk = (dir: string): void => {
			for (const name of readdirSync(dir)) {
				const full = `${dir}/${name}`;
				if (statSync(full).isDirectory()) {
					walk(full);
					continue;
				}
				if (!name.endsWith(".ts")) continue;
				// 带括号才算。这个名字还留在几处注释里，说明当初为什么把它摘掉——
				// 那是记录，不是实现。
				if (readFileSync(full, "utf8").includes("spawnSync(")) hits.push(full);
			}
		};
		walk("src");
		expect(hits).toEqual([]);
	});
});
