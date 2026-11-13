/**
 * 一件要扫全工程的活，写成「一步一步往下走」的生成器，再按调用方选一种走法：
 *
 * - `drain`：一口气走完。给本身是同步的调用方，结果和以前一模一样；
 * - `drainSliced`：每占住主线程 `SLICE_MS` 就让出一次。给工具调用路上的异步调用方。
 *
 * 为什么要第二种：界面和工具跑在同一条主线程上。五六百个 Java 文件各读一遍、查一遍时间，
 * 一口气做完要 0.2～0.5 秒，界面在这段时间里画不了帧、收不到按键，看起来就是工具一跑就卡一下。
 * 切成小段以后总耗时基本不变，中间界面照常重画。两种走法跑的是同一个生成器，做的事逐字相同。
 */

/** 分段走法每段最多占住主线程多久。一帧 16 毫秒，留一半给界面。 */
export const SLICE_MS = 8;

export function drain<T>(steps: Generator<void, T, void>): T {
	let step = steps.next();
	while (step.done !== true) step = steps.next();
	return step.value;
}

export async function drainSliced<T>(steps: Generator<void, T, void>): Promise<T> {
	let sliceStart = performance.now();
	let step = steps.next();
	while (step.done !== true) {
		if (performance.now() - sliceStart >= SLICE_MS) {
			await new Promise<void>((resolve) => setImmediate(resolve));
			sliceStart = performance.now();
		}
		step = steps.next();
	}
	return step.value;
}
