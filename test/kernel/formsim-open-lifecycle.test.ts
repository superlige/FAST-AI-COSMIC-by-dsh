/**
 * 仿真打开表单走平台控制器的 loadData，不自己 createNewData 再手工派发绑定事件。
 *
 * 真机：run flow 打开子页 zlgd_typechoose，它的插件在 afterCreateNewData 里边遍历
 * getCustomParams().keySet() 边 setValue。FormCallbackSim.start 直接 createNewData，
 * 没有 loadData 的 beginInit，setValue 当场绑定控件，FieldEdit.canRead 往同一份打开参数里
 * 补 skipCheckFieldRule，遍历抛 ConcurrentModificationException；真页面里这一步在建完数据后的
 * 统一 updateView 里，插件的遍历早结束了。打开已有单据那一支则在 loadData 之后又手工派发了
 * beforeBindData / afterBindData，插件这两个回调各跑两遍。
 *
 * 仿真要连平台才编得过，这里查源码。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROBES = fileURLToPath(new URL("../../resources/probes/", import.meta.url));

function source(name: string): string {
	return readFileSync(`${PROBES}${name}`, "utf8").replace(/\r\n/g, "\n");
}

/** 去掉注释，只看代码：注释里解释为什么不能 createNewData 时会写到这个词。 */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("仿真打开表单的生命周期", () => {
	it("父子流程共用的 start 走 registerListener → loadData，不自己建数据、不手工派发绑定事件", () => {
		const sim = code(source("FormCallbackSim.java"));
		const start = sim.indexOf("static void start(FormView view)");
		expect(start, "FormCallbackSim 里没有 start(FormView)").toBeGreaterThan(-1);
		const body = sim.slice(start, sim.indexOf("\n    static ", start + 1));
		const register = body.indexOf("controller.registerListener();");
		const load = body.indexOf("controller.loadData();");
		expect(register).toBeGreaterThan(-1);
		expect(load).toBeGreaterThan(register);
		expect(body).not.toContain("createNewData");
		expect(body).not.toMatch(/fire(Before|After)BindData/);
	});

	it("没有哪个探针在视图的模型上直接 createNewData 或手工派发绑定事件", () => {
		const offenders: string[] = [];
		for (const file of readdirSync(PROBES).filter((name) => name.endsWith(".java"))) {
			const text = code(source(file));
			if (/getModel\(\)\s*\.\s*createNewData\(/.test(text) || /fire(Before|After)BindData\(/.test(text)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
