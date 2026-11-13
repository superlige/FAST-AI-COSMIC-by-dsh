import { describe, expect, it } from "vitest";
import { staleSources, staleSourcesAsync } from "../../src/kernel/commands/sources.ts";
import { captureFreshness, captureFreshnessAsync } from "../../src/kernel/freshness.ts";
import { drain, drainSliced, SLICE_MS } from "../../src/kernel/slices.ts";
import { addSource, makeContext } from "./fake-context.ts";

/**
 * 扫全工程的活分段走：界面在中间照常画帧，结果和一口气走完逐字相同。
 *
 * 结果相同是硬要求——新鲜度指纹是交付证据，分段版要是少读一个文件、换了顺序，
 * 证据就对不上了。
 */
describe("分段扫全工程", () => {
	function project() {
		const fake = makeContext();
		for (let i = 0; i < 120; i++) {
			addSource(fake, "demo-biz", `com/demo/p${String(i % 7)}/Bill${String(i)}.java`, { compiled: i % 5 !== 0 });
		}
		return fake;
	}

	it("新鲜度指纹：分段版和同步版一模一样", async () => {
		const fake = project();
		const sync = captureFreshness(fake.ctx);
		const sliced = await captureFreshnessAsync(fake.ctx);
		// 记录时刻各取各的（测试时钟每读一次走一步），其余逐字段相同。
		expect({ ...sliced, capturedAt: "" }).toEqual({ ...sync, capturedAt: "" });
		expect(sync.sourceCount).toBe(120);
		expect(sync.staleFiles.length).toBe(24);
	});

	it("过期源码名单：分段版和同步版一模一样", async () => {
		const fake = project();
		expect(await staleSourcesAsync(fake.ctx)).toEqual(staleSources(fake.ctx));
		expect(staleSources(fake.ctx).length).toBe(24);
	});

	it("一件超过一段的活，中间会让出主线程", async () => {
		const busy = (ms: number): void => {
			const until = performance.now() + ms;
			while (performance.now() < until) {
				// 占住主线程
			}
		};
		function* work(state: { ticked: boolean; seenTick: boolean }): Generator<void, number, void> {
			for (let i = 0; i < 10; i++) {
				busy(SLICE_MS / 2);
				yield;
			}
			state.seenTick = state.ticked;
			return 10;
		}
		const sliced = { ticked: false, seenTick: false };
		setTimeout(() => {
			sliced.ticked = true;
		}, 0);
		expect(await drainSliced(work(sliced))).toBe(10);
		expect(sliced.seenTick).toBe(true);

		const whole = { ticked: false, seenTick: false };
		setTimeout(() => {
			whole.ticked = true;
		}, 0);
		expect(drain(work(whole))).toBe(10);
		expect(whole.seenTick).toBe(false);
	});
});
