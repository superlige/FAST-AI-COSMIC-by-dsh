/**
 * 技能是异步读完再登记的。插件读到一半被卸（`dsh --profile cosmic-web --help` 起来就退），
 * 读完后再登记会抛「inactive context」把进程带崩：卸了以后读完的一律不登记。
 */
import { describe, expect, it } from "vitest";
import { registerWhenLoaded } from "../../src/dsh/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe("技能读完再登记", () => {
	it("没卸：读完全部登记", async () => {
		const loaded = deferred<string[]>();
		const registered: string[] = [];
		registerWhenLoaded(
			() => loaded.promise,
			(item) => registered.push(item),
		);
		loaded.resolve(["cosmic-run", "cosmic-verify"]);
		await loaded.promise;
		await Promise.resolve();
		expect(registered).toEqual(["cosmic-run", "cosmic-verify"]);
	});

	it("读到一半插件被卸：读完一个也不登记，也不抛", async () => {
		const loaded = deferred<string[]>();
		const registered: string[] = [];
		const dispose = registerWhenLoaded(
			() => loaded.promise,
			(item) => {
				registered.push(item);
				throw new Error('cannot get required service "skills" in inactive context');
			},
		);
		dispose();
		loaded.resolve(["cosmic-run"]);
		await loaded.promise;
		await Promise.resolve();
		expect(registered).toEqual([]);
	});
});
