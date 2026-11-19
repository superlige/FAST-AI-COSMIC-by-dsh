/**
 * 表单仿真按浏览器的请求边界跑：打开、每一条 --set、动作各一次请求，请求之间从真实缓存重建页面。
 *
 * 真机：疲劳试验单的表单插件在 propertyChanged 里用 `getModel().getDataEntity().getDynamicObjectCollection(分录)`
 * 取分录。仿真一个视图从打开跑到断言，模型一直拿着 loadData 那份完整数据，取得到分录，断言全过；
 * 部署上去改应力比不重算、退出重进才算对 —— 线上改值那次请求的模型是从缓存重建的，
 * ModelCache 表头、分录分开存，getDataEntity() 只有表头。连 `--real-cache` 也一样，它只是把数据写进
 * Redis，改值、点按钮仍在同一个视图上做。
 *
 * 表单仿真要连平台才编得过，这里查源码：每个用户动作之前都换了一次请求，终值从重建的页面读。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FORM_SIM = readFileSync(
	fileURLToPath(new URL("../../resources/probes/FormSim.java", import.meta.url)),
	"utf8",
).replace(/\r\n/g, "\n");

function methodBody(signature: string): string {
	const start = FORM_SIM.indexOf(`\n    ${signature}`);
	expect(start, `FormSim 里没有 ${signature}`).toBeGreaterThan(-1);
	const next = FORM_SIM.indexOf("\n    static ", start + 1);
	return FORM_SIM.slice(start, next < 0 ? undefined : next);
}

/** 按出现顺序返回各片段的位置；缺一个就失败。 */
function order(body: string, parts: string[]): number[] {
	return parts.map((part) => {
		const at = body.indexOf(part);
		expect(at, `缺少：${part}`).toBeGreaterThan(-1);
		return at;
	});
}

describe("run form 的请求边界", () => {
	const run = methodBody("public static void run()");

	it("总是用真实缓存，不再有内存模式的开关", () => {
		expect(run).toContain("REAL_CACHE = true;");
		expect(FORM_SIM).not.toContain("FORM_REAL_CACHE");
	});

	it("每条 --set 都在新请求重建的页面上改，动作再换一次请求，终值从最后一次重建的页面读", () => {
		const at = order(run, [
			"open(openView(",
			'view = nextRequest(view, "改值 " + one.trim(), skip, views, true);',
			"applySets(view, one);",
			'view = nextRequest(view, "动作", skip, views, true);',
			"clickItem(view, click, before, ENTITY);",
			'view = nextRequest(view, "读结果", skip, views, false);',
			"dumpShow(view, shows);",
			"ExpectSpec.model(view.getModel(), valueExpects);",
		]);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		// --set 按 ; 逐条拆开，一条一次请求：不能把整串交给 applySets 在同一个视图上连着改
		expect(run).toContain('for (String one : env("FORM_SET", "").split(";"))');
		expect(run).not.toContain('applySets(view, env("FORM_SET", ""))');
	});

	it("换请求照平台的收尾和开头做：先提交缓存，再换 SessionManager、按 pageId 读回参数重建、registerListener", () => {
		const body = methodBody("static FormView nextRequest(");
		const at = order(body, [
			"persistReal(done,",
			"SessionManager.reset();",
			"SessionManager.getCurrent().getFormShowParameter(pageId)",
			"buildView(fsp, skip, true)",
			"if (dispatch) {",
			"ctl.registerListener();",
		]);
		expect([...at].sort((a, b) => a - b)).toEqual(at);
		// 重建的视图不能是 loadData 过的：数据要从模型缓存现取
		expect(body).not.toContain("loadData");
		expect(body).not.toContain("activate()");
	});

	it("--set 照浏览器入口先判这格能不能改，再 setValue：谁先碰表头决定重建后表头带不带分录", () => {
		// 真机反证：跳过这一步，修之前的写法在重建的请求里取到 2 行（断言会过）；走这一步取到 0 行，和线上一致
		const body = methodBody("static void applySets(");
		for (const set of [
			"model.setValue(pos.field, v);",
			"model.setValue(pos.field, v, pos.row);",
			"model.setValue(pos.field, v, pos.subRow, pos.row);",
		]) {
			const at = body.indexOf(set);
			expect(at, `缺少：${set}`).toBeGreaterThan(-1);
			const check = body.lastIndexOf("editCheck(view, pos.field);", at);
			expect(check, `${set} 之前没判能不能改`).toBeGreaterThan(-1);
			// 中间不能夹着别的 setValue：判的就是这一次
			expect(body.slice(check, at)).not.toMatch(/model\.setValue\(/);
		}
		expect(methodBody("static void editCheck(")).toContain("((FieldEdit) control).checkEditFieldStatus()");
	});

	it("发往浏览器的锁定和选中行按页面留着，重建视图不丢", () => {
		const body = methodBody("static <T> T recorder(");
		expect(body).toContain("CLIENT_STATES.get(pageId)");
		expect(body).not.toContain("new HashMap<String, Map<String, Object>>()");
		expect(methodBody("static Object swapClientProxy(")).toContain("recorder(IClientViewProxy.class, pageId)");
		expect(methodBody("static void resetState()")).toContain("CLIENT_STATES.clear();");
	});

	it("重建的页面不再写 --cache 预置值：之后的请求读缓存里的现值", () => {
		const body = methodBody("static IPageCache pageCache(");
		expect(body).toContain("SEEDED_PAGES.add(pageId) ? PAGE_CACHE : null");
		expect(methodBody("static void resetState()")).toContain("SEEDED_PAGES.clear();");
	});

	it("打终值不按表头对象进分录：从缓存重建的模型 getDataEntity() 没有分录", () => {
		const body = methodBody("static void dumpShow(");
		expect(body).toContain("DynamicObject whole = model.getDataEntity(true);");
		expect(body).not.toContain("checkReference(model.getDataEntity(),");
	});

	it("跑完每个 pageId 只清一次缓存，最后换掉这条线程的 SessionManager", () => {
		const tail = run.slice(run.lastIndexOf("} finally {"));
		expect(tail).toContain("if (released.add(v.getPageId())) {");
		expect(tail).toContain("releaseReal(v);");
		expect(tail).toContain("SessionManager.reset();");
	});
});
