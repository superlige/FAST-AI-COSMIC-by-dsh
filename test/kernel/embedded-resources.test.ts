/**
 * The generated resource module must equal the exported files, byte for byte.
 *
 * The kernel releases EMBEDDED_RESOURCES, never the resources/ directory, so a
 * bundled exe and a dev run put identical bytes on disk. If the generated module
 * ever drifted from resources/, the manifest hashes would describe files nobody
 * runs -- and a probe compiled from drifted host sources fails in ways that point
 * at the wrong file.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeSummary, probeUsage } from "../../src/kernel/commands/probe.ts";
import { EMBEDDED_RESOURCES } from "../../src/resources/embedded.generated.ts";
import { sha256 } from "../../src/runtime/fingerprint.ts";
import { findResourceViolations } from "../../src/runtime/resources.ts";

interface ResourceManifest {
	source: { dir: string };
	files: { path: string; sha256: string; bytes: number }[];
}

const EXPORT_SCRIPT = fileURLToPath(new URL("../../scripts/export-resources.mjs", import.meta.url));

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL("../../resources/manifest.json", import.meta.url)), "utf8"),
) as ResourceManifest;

describe("S3 embedded agent resources", () => {
	it("matches the export manifest file for file", () => {
		expect(EMBEDDED_RESOURCES).toHaveLength(manifest.files.length);
		const byPath = new Map(EMBEDDED_RESOURCES.map((entry) => [entry.relativePath, entry.content]));
		for (const file of manifest.files) {
			const content = byPath.get(file.path);
			expect(content, `missing embedded resource: ${file.path}`).toBeTypeOf("string");
			expect(sha256(content as string), file.path).toBe(file.sha256);
		}
	});

	it("carries the probe host, the bridge, the server and the Gradle init script", () => {
		const paths = EMBEDDED_RESOURCES.map((entry) => entry.relativePath);
		// ServiceBridge and HeadlessViews are part of the host, not probes; every host
		// compile and every staleness check must include them, or editing them changes
		// nothing silently.
		for (const required of [
			"runtime/CosmicProbe.java",
			"runtime/ServiceBridge.java",
			"runtime/HeadlessViews.java",
			"runtime/CosmicProbeServer.java",
			"runtime/cosmic-run.gradle",
			"tools/ApiTool.java",
		]) {
			expect(paths).toContain(required);
		}
	});

	it("contains only agent-owned source, never a Cosmic JAR or customer config", () => {
		expect(findResourceViolations(EMBEDDED_RESOURCES)).toEqual([]);
		for (const entry of EMBEDDED_RESOURCES) {
			expect(entry.relativePath).toMatch(/\.(java|gradle)$/);
		}
	});

	it("is what resources/ produces today, so a probe edit cannot ship without a re-export", () => {
		// The kernel releases EMBEDDED_RESOURCES, not resources/. A probe edited on
		// disk without `export-resources.mjs --write` would leave the agent running
		// the old bytes while every test above compares the module to itself.
		const result = spawnSync(process.execPath, [EXPORT_SCRIPT, "--check"], { encoding: "utf8" });
		expect(result.stderr + result.stdout, "运行 node scripts/export-resources.mjs --write").toContain(
			"探针资源与内嵌模块一致",
		);
		expect(result.status).toBe(0);
		expect(manifest.source).toEqual({ dir: "resources" });
	});
});

describe("probe behaviour that cosmic depends on", () => {
	it("keeps DataQueryProbe read-only and on the ORM, never raw SQL", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/DataQueryProbe.java")
			?.content as string;
		// The only two calls that reach the environment.
		expect(source).toContain("QueryServiceHelper.query(entity,");
		expect(source).toContain("ORM.create().count(");
		// No SQL of its own: the KSQL traps it exists to route around start there.
		expect(source).not.toMatch(/\bDB\s*\.\s*(query|update|execute)|queryDataSet|DBRoute/);
		// Secrets stay out of the model's context and build/ logs.
		expect(source).toContain("password|passwd|pwd|secret|token|salt");
	});

	it("never answers a parse mistake with 「命中 0 条」（2026-09-14 真机：两轮白跑）", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/DataQueryProbe.java")
			?.content as string;
		// 带引号的值、带括号的 in 清单解析得过，比的却是带引号的文本——0 条和「本来没数据」
		// 长得一模一样，于是被当成「这张单没数据」又跑一轮。
		expect(source).toContain("private static boolean quoting(");
		expect(source).toContain("的值不要加引号");
		expect(source).toContain("的值不要加括号");
		// 真是 0 条时，一次调用就把「条件没命中」和「这张单本来是空的」分开。
		expect(source).toContain("private static String emptiness(");
		expect(source).toContain("这张单一条数据都没有，不是条件的问题");
	});

	it("「!= null」按 is not null 查，不和文字 null 比（2026-10-07 S48 验收：没填的混进结果）", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/DataQueryProbe.java")
			?.content as string;
		const fn = source.slice(source.indexOf("private static String nullOp("));
		expect(fn.slice(0, fn.indexOf("\n    }\n"))).toContain(
			'return op.equals("=") ? "is null" : op.equals("!=") || op.equals("<>") ? "is not null" : null;',
		);
		// 普通条件和 @ 条件（含 @下游.单据.字段）都先过它，再判是不是空值运算符
		const condition = source.slice(source.indexOf("private static QFilter condition("));
		expect(condition.indexOf("nullOp(op, raw)")).toBeLessThan(condition.indexOf('op.equals("is null")'));
		const pseudo = source.slice(source.indexOf("private static Pseudo pseudo("));
		expect(pseudo.indexOf("nullOp(p.op, p.value)")).toBeLessThan(pseudo.indexOf("p.link = linked("));
	});
});

describe("2026-09-14 复盘：别让人去猜标识、去猜关键字", () => {
	it("MetaResolve 在标识两条路都问不出来时，先列出名字沾边的实体与布局", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/MetaResolve.java")
			?.content as string;
		expect(source).toContain("private static void suggest(String key)");
		expect(source).toContain("名字沾边的实体");
		expect(source).toContain("名字沾边的布局");
		// 只在失败那条路上查，成功路径一次库都不多查。
		expect(source).toMatch(/suggest\(key\);\s+throw new IllegalArgumentException/);
		// 下划线是 like 的通配符，按字面找就得转义；token 本身已被限死在 [a-z0-9_]。
		expect(source).toContain('token.matches("[a-z0-9_]{2,}")');
		expect(source).toContain('token.replace("_", "@_")');
	});

	it("MetaProbe 的 0 命中说得出「是没这个字段，还是关键字写法不对」", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/MetaProbe.java")
			?.content as string;
		expect(source).toContain("关键字一个都没匹配上");
		expect(source).toContain("按标识和名称做「包含」匹配、不分大小写");
		// 名称也按小写比：原来名称按原文比，Number ≠ number。
		expect(source).toContain("disp.toLowerCase().contains(key)");
		// 报总数时只数不打印，不刷一屏字段。
		expect(source).toContain("indent 为 null 时只数不打印");
	});

	it("MetaProbe 把多选基础资料当字段，并同时打印目标实体和映射表", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/MetaProbe.java")
			?.content as string;
		expect(source).toContain("if (p instanceof MulBasedataProp)");
		expect(source.indexOf("if (p instanceof MulBasedataProp)")).toBeLessThan(
			source.indexOf("if (p instanceof ICollectionProperty)"),
		);
		expect(source).toContain('m.getBaseEntityId() + "  映射表=" + m.getTableNameProp()');
	});
});

describe("2026-09-14 第二轮复盘：驱动不了要说是驱动不了，别报成配置错误", () => {
	const byPath = new Map(EMBEDDED_RESOURCES.map((entry) => [entry.relativePath, entry.content]));

	it("子页的「确定」两种写法各有一条通道，认不出是哪一种时说清楚", () => {
		const source = byPath.get("probes/FormCallbackSim.java") as string;
		// 控件那条路：Button.click() 与前端点一下走同一条派发链，invokeOperation 到不了它
		expect(source).toContain('control.getClass().getMethod("click")');
		// 默认的 btnok 认出是控件就自己改走控件，省掉一次 45 秒冷启动；显式点名的不自动换
		expect(source).toContain("本次自动改走控件点击");
		// 平台那句「未定义实现类」是这次死循环的起点：必须翻译成「你选错了通道」
		expect(source).toContain("未定义实现类");
		expect(source).toContain("不是操作，是界面控件");
		// 两条通道都不成立 = 结构性缺口，正确动作是停下来转人工验收，不是接着换参数
		expect(source).toContain("需人工验收");
		expect(source).toContain("不要再换参数试");
	});

	it("run flow 把子页动作交给同一个入口，并新增 --child-click", () => {
		const source = byPath.get("probes/FormFlowSim.java") as string;
		expect(source).toContain("FormCallbackSim.driveChild");
		expect(source).toContain('env("FLOW_CHILD_CLICK", "")');
		// 实际驱动的是哪条通道要进 JSON 旁路，复盘才核得动
		expect(source).toContain('"childAction", childAction');
	});

	it("run form 跑完说得出「这次没走到哪些回调」", () => {
		const source = byPath.get("probes/FormSim.java") as string;
		expect(source).toContain("static void dumpReach()");
		expect(source).toContain("没走到：");
		expect(source).toContain("本次断言证明不了它");
		// 反射要拿真 Class：插件是平台的类加载器装进来的，按名字反查一个都找不到
		expect(source).toContain("PLUGIN_TYPES.add(pp.getClass())");
		// 白名单，不是「public void + Event 参数」：后者会把插件自己的工具方法算成回调
		expect(source).toContain('"closedCallBack", "confirmCallBack"');
	});

	it("run list 只选、只点这次列表查出来的行（S62）", () => {
		const source = byPath.get("probes/ListSim.java") as string;
		const select = source.slice(source.indexOf("static ListSelectedRowCollection selectRows("));
		// 把关在读单据之前：照主键从库里读是读得到的，不代表列表上选得到
		expect(select.indexOf("requireListed(flag, spec);")).toBeGreaterThan(0);
		expect(select.indexOf("requireListed(flag, spec);")).toBeLessThan(
			select.indexOf("BusinessDataServiceHelper.loadSingle(pk, ENTITY)"),
		);
		// 行号只认首屏里真有的那一行；原来不在首屏时填「第几个选的」，指到首屏里别的单据上
		expect(source).not.toContain("int rowKey = selected.size();");
		expect(source).toContain("row.setRowKey(rowIndex(raw.trim()));");
		// 改对输入之后是另一个场景：走输入不成立、不留记录，不记 FAIL
		expect(source).toContain('ProbeAssert.inputInvalid("list-select", flag + " " + pks, why);');
		// 选行、点行、点超链接都从同一处进，没有别的选行入口
		expect(source.match(/selectRows\(/g)?.length).toBe(4);
	});

	it("run list 换主组织走平台自己重算主组织条件的那条路，排在 loadData 之后（S62）", () => {
		const source = byPath.get("probes/ListSim.java") as string;
		// 平台 loadData 时按筛选栏默认组织重算主组织条件；排在它前面设的会被盖掉、参数等于没写
		expect(source.indexOf("controller.loadData();")).toBeLessThan(
			source.indexOf("chooseMainOrgs((HeadlessViews.ListPage) view, billList, mainOrgSpec);"),
		);
		expect(source.indexOf("chooseMainOrgs((HeadlessViews.ListPage) view, billList, mainOrgSpec);")).toBeLessThan(
			source.indexOf("query(controller, view, limit);"),
		);
		// 不自己拼主组织条件（字段名、按权限维度隔离都由平台定），也不再有「设了就算数」的那行
		expect(source).not.toContain("list.setMainOrgQFilter(");
		expect(source).not.toContain("预置主组织");
		// 界面上选得到的只有有权限的组织；平台没按所选组织过滤时退回，不当成换成了
		expect(source).toContain("PermissionFilterUtil.getMainOrgIds(type, type.getName()");
		expect(source).toContain("!new HashSet<Long>(chosen).equals(new HashSet<Long>(ids))");
		const host = byPath.get("runtime/HeadlessViews.java") as string;
		expect(host).toContain("setSelectedMainOrgIds(ids);\n            setBillListFilterParameter(list);");
	});

	it("断言没过、输入不成立不带调用栈，宿主对没有栈的异常只打一行（S63）", () => {
		const assert = byPath.get("probes/ProbeAssert.java") as string;
		// 两种都是探针自己下的结论：原因在上面的 FAIL / ✘ 行，栈里只有探针和线程池自己的帧
		for (const name of ["InputInvalid", "Failed"]) {
			const body = assert.slice(assert.indexOf(`public static final class ${name} extends IllegalStateException`));
			expect(body.slice(0, body.indexOf("\n    }\n")), name).toContain(
				"public synchronized Throwable fillInStackTrace() {\n            return this;",
			);
		}
		// 九个仿真探针断言没过都抛同一个类；带栈的 IllegalStateException 会让输出末尾多十几行，
		// 输出被裁成头尾两段时把「操作成没成、成功几张」挤进省略的中段（真机 2026-10-11）
		for (const sim of [
			"CallSim",
			"FormCallbackSim",
			"FormSim",
			"ListSim",
			"OpSandbox",
			"PrintSim",
			"PushSim",
			"RuleSim",
			"WfSim",
		]) {
			const source = byPath.get(`probes/${sim}.java`) as string;
			expect(source, sim).toContain('throw new ProbeAssert.Failed("断言失败');
			expect(source, sim).not.toContain('throw new IllegalStateException("断言失败');
		}
		// 冷进程和常驻进程两个宿主同一条规矩
		for (const host of ["runtime/CosmicProbe.java", "runtime/CosmicProbeServer.java"]) {
			const source = byPath.get(host) as string;
			const at = source.lastIndexOf('"[PROBE-ERR] "');
			expect(source.slice(at, at + 400), host).toContain("if (t.getStackTrace().length > 0) {");
		}
	});

	it("run rule 不再把布局上每个字段都发一条 rule-state（S20 批 2）", () => {
		const source = byPath.get("probes/RuleSim.java") as string;
		// 只发规则碰过的和 --expect 点名的：真机一次 1,352 条里只有 60 条是规则碰过的
		expect(source).toContain("if (s.touchedByRule || expectNamed.contains(s.ap.getKey()))");
		// 其余汇总成一条，按原因计数且封顶，不然这条汇总自己又长成一千多条
		expect(source).toContain('ProbeJson.emit("rule-state-rest"');
		expect(source).toContain("topReasons(restHiddenBy, 10)");
		// 断言走的是全部控件的 facts，不能跟着 rule-state 一起被裁
		expect(source).toContain('facts.put(s.ap.getKey() + ".visible", String.valueOf(s.effVisible));');
	});
});

describe("S20 批 5：模型不用再去缓存里翻仿真探针的源码", () => {
	const byPath = new Map(EMBEDDED_RESOURCES.map((entry) => [entry.relativePath, entry.content]));

	it("run form 抓到带关闭回调的子页，拼好接着验回写的 run flow 命令", () => {
		const source = byPath.get("probes/FormSim.java") as string;
		expect(source).toContain(
			'suggestFlow(pk, op, click, link == null ? "" : hyperlink, env("FORM_TOOLBAR", ""), skip);',
		);
		// 断言之前打：断言挂了会抛，排在后面就永远打不出来
		expect(source.indexOf("suggestFlow(pk, op")).toBeLessThan(
			source.indexOf("ExpectSpec.model(view.getModel(), valueExpects)"),
		);
		// 列表选择页和没有父动作的弹窗，run flow 都接不了，不提示
		expect(source).toContain("parameter instanceof ListShowParameter");
		expect(source).toContain("if (op.isEmpty() && click.isEmpty() && hyperlink.isEmpty())");
		// 点分录超链接弹出的子页，接着验回写的命令照样拼（父动作写成 --hyperlink）
		expect(source).toContain('" --hyperlink " + hyperlink');
		// 另发一条结构化记录：文字输出超预算切中间，这条模型侧永远给全
		expect(source).toContain('ProbeJson.emit("next-step", "adapter", "run flow"');
	});

	it("写界面规则的用法卡片：每个入参都有自己一行，分组语法和多选基础资料的例子都在", () => {
		const usage = probeUsage(byPath.get("probes/FormRuleProbe.java") as string).doc;
		const starts = (name: string) => usage.filter((line) => line.startsWith(`${name}=`));
		for (const name of [
			"RULE_FORM",
			"RULE_TAG",
			"RULE_HOST",
			"RULE_REMOVE_IDS",
			"RULE_UPDATE_ID",
			"ROLLBACK",
			"APPLY",
		]) {
			expect(starts(name), name).not.toHaveLength(0);
		}
		const groups = starts("RULE_GROUPS").join("\n");
		expect(groups).toContain("分号分组、竖线分三列");
		expect(groups).toContain("MulBasedataInclude(demo_jcxm_dx.number, 'JCXM-01')");
		expect(usage.join("\n")).toContain("RULE_ALLOW_OVERLAP=1");
	});

	it("探针清单里父子页两个仿真器那一行，说清由哪个 run 命令驱动", () => {
		expect(probeSummary(byPath.get("probes/FormCallbackSim.java") as string)).toContain("cosmic_run callback");
		expect(probeSummary(byPath.get("probes/FormFlowSim.java") as string)).toContain("cosmic_run flow");
	});
});

describe("resident and host behaviour that cosmic depends on", () => {
	// S27 1.14：写元数据改在常驻进程里写，确认过的写入目标随那一次请求带进去。这条通道只能是
	// 名单内的两个属性、跑完就清，而 IsvGuard 每次检查现读——否则上一次的清单会漏到下一次。
	it("keeps the resident's per-request property channel narrow and one-shot", () => {
		const content = (path: string) =>
			EMBEDDED_RESOURCES.find((entry) => entry.relativePath === path)?.content as string;
		const server = content("runtime/CosmicProbeServer.java");
		expect(server).toContain('java.util.Arrays.asList("cosmic.targets", "cosmic.baseline", "cosmic.schedule")');
		expect(server).toContain("REQUEST_PROPS.contains(v.substring(0, e2))");
		expect(server).toMatch(/restoreEnv\(\);\s*for \(String key : REQUEST_PROPS\) \{\s*System\.clearProperty\(key\);/);
		const guard = content("probes/IsvGuard.java");
		expect(guard).toContain('return splitTargets(System.getProperty("cosmic.targets", ""));');
		expect(guard).not.toMatch(/static final [^;]*TARGETS/);
	});

	// S37 2-E.4：调度服务默认不起，请求点名才起一次；起不全不重试、这次不跑探针；只当执行节点，
	// 部署模式不是执行节点就不起——否则会参加选主、触发环境里的定时计划。
	it("starts the schedule services only when a request asks, once, as an execute node", () => {
		const content = (path: string) =>
			EMBEDDED_RESOURCES.find((entry) => entry.relativePath === path)?.content as string;
		const server = content("runtime/CosmicProbeServer.java");
		expect(server).toContain('if ("1".equals(props.get("cosmic.schedule")) && schedule == null) {');
		expect(server).toMatch(
			/String failed = startSchedule\(\);\s*if \(failed != null\) \{[\s\S]*?out\.println\("RESULT ERR 1"\);[\s\S]*?return;/,
		);
		expect(server).toContain("if (scheduleError != null) {");
		const host = content("runtime/CosmicProbe.java");
		expect(host).toContain('static final String SCHEDULE_MODE = "EXECUTE_NODE";');
		expect(host).toMatch(
			/if \(System\.getProperty\(SCHEDULE_MODE_KEY\) == null\) \{\s*System\.setProperty\(SCHEDULE_MODE_KEY, SCHEDULE_MODE\);/,
		);
		expect(host).toMatch(
			/if \(!SCHEDULE_MODE\.equals\(String\.valueOf\(mode\)\)\) \{\s*throw new IllegalStateException/,
		);
	});

	// S57：常驻进程每次请求都把探针重编一遍（真机查一条数据：编译 2.8～3.1 秒、运行 0.3 秒），
	// 拦 System.exit 的防护又让每次读文件多付 0.7 毫秒（请求前查一遍业务类 460 毫秒）。
	// 产物沿用的前提是编译结果取决于的三样都没变；类加载器照旧每次新建，探针的静态变量不带到下一次。
	it("reuses a probe's compiled output only while its inputs are unchanged, and keeps the exit guard off the file path", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		const stamp = server.slice(server.indexOf("private static String sourceStamp(File src)"));
		const stampBody = stamp.slice(0, stamp.indexOf("\n    }\n"));
		expect(stampBody).toContain("md.update(Files.readAllBytes(src.toPath()));");
		expect(stampBody).toContain("probesDir.listFiles()");
		expect(stampBody).toContain("append(watchedMtime).append('|').append(watchedSize)");
		expect(server).toContain("last[0].equals(stamp) && new File(last[1]).isDirectory()");
		// 编译失败不留记录：下一次必须重编，不能拿上一次成功的产物顶
		expect(server).toMatch(
			/if \(err == null && stamp != null\) \{\s*compiledProbes\.put\([\s\S]*?\} else \{\s*compiledProbes\.remove\(/,
		);
		// 过期检查排在沿用之前：业务类变了先回 STALE，换完类印记跟着变
		expect(server.indexOf("boolean staleNow = isStale();")).toBeLessThan(server.indexOf("compiledProbes.get("));
		expect(server).toContain("new ProbeClassLoader(outDir,");
		const guard = server.slice(server.indexOf("private static void installExitGuard()"));
		for (const check of [
			"public void checkRead(String file) {",
			"public void checkRead(String file, Object context) {",
			"public void checkWrite(String file) {",
			"public void checkDelete(String file) {",
			"public void checkPropertyAccess(String key) {",
			"public void checkPackageAccess(String pkg) {",
		]) {
			expect(guard).toContain(check);
		}
		expect(guard).toContain("throw new ProbeExitError(status);");
	});

	// S60：常驻进程写完元数据、换账套、闲久了都会重起，重起后用到的每个探针都要再编 2～3 秒。
	// 产物按印记留在磁盘上，下一个进程接着用；印记里多一样类路径（换了平台包旧产物不认）。
	it("keeps a probe's compiled output on disk for the next process, and only when it was compiled to the end", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		expect(server).toContain(
			"return new File(new File(hotRoot, \"kept\"), md5(src.getPath() + '|' + stamp + '|' + buildStamp));",
		);
		// 类路径上每个包的名字、大小、修改时间都进印记
		expect(server).toContain(
			"jars.append('|').append(entry.getName()).append(':').append(entry.length()).append(':').append(entry.lastModified());",
		);
		// 认的是「编完了」的标记，不是目录在不在：进程中途被停留下的半截产物要清掉重编
		expect(server).toContain("if (kept != null && new File(kept, KEPT_DONE).isFile()) {");
		expect(server).toMatch(
			/if \(kept != null\) \{[^}]*deleteTree\(kept\);\s*outDir = kept;\s*\}\s*err = compile\(srcFile, outDir\);/,
		);
		expect(server).toMatch(
			/if \(err == null && stamp != null\) \{\s*compiledProbes\.put\([^;]*;\s*new File\(outDir, KEPT_DONE\)\.createNewFile\(\);/,
		);
		// 沿用时碰一下标记，久没人用的才会被启动时清掉
		expect(server).toContain("new File(kept, KEPT_DONE).setLastModified(System.currentTimeMillis());");
		expect(server).toContain("if (now - last > KEPT_MAX_AGE_MS) {");
	});

	// S60：每个进程第一次用才付的几笔账，挪到本来就在等的时间里付。
	// 本机名反查（真机 4.4 秒）和读配置中心同时做；编译器热身和元数据预热同时做；许可信息在就绪后后台读。
	it("pays the once-per-process costs while it would be waiting anyway, and only through read-only calls", () => {
		const host = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbe.java")
			?.content as string;
		// 要在工程启动类设完系统属性之后：这一步会带起日志框架
		expect(host).toMatch(/configureLikeTheProject\(\);\s*prewarmLocalHostLookup\(\);/);
		const lookup = host.slice(host.indexOf("private static void prewarmLocalHostLookup()"));
		const lookupBody = lookup.slice(0, lookup.indexOf("\n    }\n"));
		expect(lookupBody).toContain('Class.forName("com.clickhouse.client.http.ClickHouseHttpClient", true,');
		expect(lookupBody).toContain("warm.setDaemon(true);");
		// 没有这个驱动的平台版本什么都不做，不能拦启动
		expect(lookupBody).toContain("} catch (Throwable absent) {");

		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		// 编译器只能一处用：热身由主线程做，做完再等预热，之后才开始收请求
		expect(server).toMatch(
			/CountDownLatch warmed = startInPool\(\(\) -> EntityMetadataCache\.getDataEntityType\("bos_org"\)\);\s*warmCompiler\(\);\s*await\(warmed, REQ_TIMEOUT_MS\);/,
		);
		expect(server.indexOf("await(warmed, REQ_TIMEOUT_MS);")).toBeLessThan(
			server.indexOf("try (ServerSocket ss = listen(port)) {"),
		);
		// 许可信息只走不带参数的取值入口；检查类接口会记一条许可使用日志，不能拿来预读
		const readsStart = server.indexOf("private static final String[][] LICENSE_READS = {");
		const reads = server.slice(readsStart, server.indexOf("};", readsStart));
		expect(reads).toContain('{"kd.bos.servicehelper.license.LicenseServiceHelper", "getModeType"}');
		expect(reads).not.toMatch(/"check\w*"/);
		const warm = server.slice(server.indexOf("private static void warmLicense()"));
		const warmBody = warm.slice(0, warm.indexOf("\n    }\n"));
		expect(warmBody).toContain("Class.forName(read[0]).getMethod(read[1]).invoke(null);");
		// 后台线程做完时多半有请求在跑，计时不能写进那次请求的日志
		expect(warmBody).not.toContain("log(");
		expect(warmBody).toContain("licenseWarmNote = ");
	});

	// S58：登记会被另一次启动盖掉，认归属要问得到端口上那个进程自己——版本号、用户、心跳口都在 PING 里；
	// 占不到端口的进程立刻退出，不留着占内存、不让登记指着一个收不到请求的进程。
	it("answers PING with its own identity and exits at once when its port is taken", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		const pingStart = server.indexOf('if ("PING".equals(head))');
		const ping = server.slice(pingStart, server.indexOf("return;", pingStart));
		for (const line of [
			'out.println("pid=" + pid());',
			'out.println("key=" + System.getProperty("probe.runtimeKey", ""));',
			'out.println("account=" + accountWant);',
			'out.println("user=" + userWant);',
			'out.println("health=" + healthPort);',
			'out.println("hotswap=" + hotSwapMode());',
		]) {
			expect(ping).toContain(line);
		}
		expect(server).toContain("try (ServerSocket ss = listen(port))");
		const listen = server.slice(server.indexOf("private static ServerSocket listen(int port)"));
		expect(listen.slice(0, listen.indexOf("\n    }\n"))).toMatch(
			/catch \(java\.net\.BindException e\) \{[\s\S]*?System\.setSecurityManager\(null\);\s*System\.exit\(4\);/,
		);
	});

	// S59：试过「常驻进程闲着时定时把空闲的数据库连接关掉重建」，真机量出来没有收益还有害，撤了，别再加回来：
	// 闲置 5～6 分钟的连接本来就是通的；出事的是扎堆新建的连接（这条网络上约 5% 连上后没人应、十几秒后断开），
	// 定时重建等于不停地新建连接。见 docs/S59-call-overhead-idle-connections.md 第 3.2 节。
	it("does not churn idle database connections", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		expect(server).not.toContain("softEvictConnections");
		expect(server).not.toContain("hikaricp.configurationFile");
	});

	// S59：每次请求那一行带上收到的时刻，会话里的工具调用才能和它一条条对上（scripts/measure-call-overhead.mjs）
	it("stamps each request line with when it arrived", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		expect(server).toMatch(
			/"，运行 " \+ runMs \+ " ms，"\s*\+ new SimpleDateFormat\("yyyy-MM-dd HH:mm:ss\.SSS"\)\.format\(new Date\(requestAt\)\) \+ " 收到"\);/,
		);
	});

	// S59 §9：本机进程离数据库远，平台默认每条 SQL 来回三趟、结果不压缩。宿主在平台读连接串模板之前换掉三项开关：
	// 必须排在调工程启动类之前（模板只读一次）；模板从平台包里现取（每个版本可能不一样，不带一份自己的）；
	// 配置里关了就不换。冷进程和常驻进程都从 initEnv 进，两条路不会漂移。
	it("tunes the database link before the platform builds its first data source", () => {
		const host = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbe.java")
			?.content as string;
		expect(host).toMatch(/requireConfig\(\);\s*\/\/[^\n]*\n\s*tuneDbLink\(\);\s*configureLikeTheProject\(\);/);
		expect(host).toContain('"jar".equals(candidate.getProtocol())');
		expect(host).toContain('"platform".equals(System.getProperty("cosmic.dbLink", "fast"))');
		for (const key of ["useServerPrepStmts", "useCursorFetch", "useCompression"]) expect(host).toContain(key);
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		expect(server).toContain('log("连数据库的方式：" + System.getProperty(CosmicProbe.DB_LINK_STATE));');
	});

	// S77：开发助手新模板把配置和 start() 都写在 main 里。宿主调 main，start() 走到的 Booter.main 是空替身，
	// 替身要是真去起服务，每个探针进程都会起一个苍穹 Web 服务。
	it("runs a main-only launch class through a no-op Booter stand-in", () => {
		const host = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbe.java")
			?.content as string;
		const configure = host.slice(host.indexOf("private static void configureLikeTheProject()"));
		const body = configure.slice(0, configure.indexOf("\n    }\n"));
		expect(body).toContain('app.getDeclaredMethod("main", String[].class)');
		expect(body).toContain("kd.bos.service.bootstrap.Booter.REACHED");
		const stub = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/Booter.java")?.content as string;
		expect(stub).toContain("package kd.bos.service.bootstrap;");
		const main = stub.slice(stub.indexOf("public static void main(String[] args) {"));
		expect(main.slice(0, main.indexOf("}"))).toMatch(/\{\s*System\.setProperty\(REACHED, "true"\);\s*$/);
	});

	// S27 3.1：换类必须整批一次换（JVM 保证整批原子：拒了就一个都没换），只换系统类加载器从业务类目录
	// 读的那些；只有换成功才把目录快照对齐——换失败还对齐，下一次就当它是新的，拿旧类跑、不报错。
	it("swaps changed business classes in one atomic batch and re-stamps only on success", () => {
		const server = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "runtime/CosmicProbeServer.java")
			?.content as string;
		expect(server).toContain('if ("SYNC".equals(head))');
		expect(server).toContain("public static class HotSwapAgent");
		expect(server).toContain("public static void premain(String args, java.lang.instrument.Instrumentation i)");
		expect(server).toContain("inst.redefineClasses(defs.toArray(new java.lang.instrument.ClassDefinition[0]));");
		expect(server).toContain("if (c.getClassLoader() != app)");
		const sync = server.slice(server.indexOf("private static synchronized String hotSync()"));
		expect(sync.indexOf("classStamps.putAll(now);")).toBeGreaterThan(sync.indexOf("inst.redefineClasses("));
		expect(sync.indexOf("classStamps.putAll(now);")).toBeGreaterThan(sync.indexOf("String why = jrebelProblem();"));
		expect(server).toContain('System.getProperty("cosmic.jrebel") != null');
	});

	it("keeps FormRuleProbe's reviewed update path, overlap gate, and action evidence", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/FormRuleProbe.java")
			?.content as string;
		// Updating an existing rule is exact and concurrency-safe: an intervening
		// metadata change is refused rather than overwritten by stale read evidence.
		expect(source).toContain('String updateId = env("RULE_UPDATE_ID", null)');
		expect(source).toContain('String expectedCondition = env("RULE_EXPECT_CONDITION", null)');
		expect(source).toContain("if (!expectedCondition.equals(actual))");
		expect(source).toContain("updateRule.setPreCondition(updateCondition)");
		expect(source).toContain("updateRule.setPreDescription(updateCondition)");
		// Adding another rule for a control already governed anywhere in the form
		// stops by default and names the explicit exceptional path.
		expect(source).toContain("List<String> refs = ruleRefs(fm, apId)");
		expect(source).toContain("RULE_ALLOW_OVERLAP=1");
		// The dry-run emits the actual action class pair, not just a generic success.
		expect(source).toContain("本次实际规则结构");
		expect(source).toContain("dumpRule(r, apById)");
		// The dry-run ends with the complete target list, built by the gate itself.
		// The old line named only the layout: authorising from it got the APPLY
		// refused on the first field and voided the whole grant (2026-09-14 真机).
		expect(source).toContain("IsvGuard.reportTargets()");
		expect(source).not.toContain("cosmic_authorize targets 可直接使用");
		expect(source).toContain("IsvGuard.assertOwnLayout(em.getKey(), form)");
		// Same-prefix rules are never removed on the probe's own initiative.
		expect(source).toContain("RULE_REMOVE_IDS");
		expect(source).toContain("if (!removeIds.contains(String.valueOf(r.getId()))) continue;");
		// PreCondition and PreDescription are two different things, said so -- on two
		// lines with two names. No 「不一致」 alarm: on the real form all 18 designer
		// rules differ (keys vs Chinese labels), and an alarm that always fires teaches
		// people to ignore alarms.
		expect(source).toContain("生效条件");
		expect(source).toContain("设计器描述");
		expect(source).toContain("不参与判定");
		expect(source).not.toContain("PreCondition 与 PreDescription 不一致");
	});

	it("FormRuleProbe 能往既有规则里追加字段，真假两边一起补（2026-09-15：原来只能新增整条 / 改条件 / 回滚）", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/FormRuleProbe.java")
			?.content as string;
		// 第四种写模式，和另外三种互斥。
		expect(source).toContain('String appendSpec = env("RULE_APPEND", null);');
		expect(source).toContain("RULE_APPEND、RULE_BATCH 是互斥写模式");
		// 按锚点找动作：含锚点的真动作、假动作都补，新字段插在锚点后面，走 setFields。
		expect(source).toContain("private static List<BizRuleAction> actionsWith(FormRule r, String apId)");
		expect(source).toContain('call(a, "setFields", next);');
		// 四道拦截。
		expect(source).toContain("没有管 ");
		expect(source).toContain("要先用 FormLayoutWriteProbe 的 add field 把字段落库");
		expect(source).toContain("已被规则管着");
		expect(source).toContain("还被没点名的规则管着");
		// 改前改后各序列化一次，新字段 id 多出的次数要等于追加次数。
		expect(source).toContain("设计态 XML 里多出的次数与追加次数一致");
		// 全都跟上了就不打 dry-run 结束行——那一行会被记成一条待确认修改。
		expect(source).toContain("无事可做：RULE_APPEND");
		// 用法卡片从头注释读：语法和例子都在。
		const doc = probeUsage(source).doc.join("\n");
		expect(doc).toContain("RULE_APPEND=规则id|锚点字段|新字段1,新字段2");
		expect(doc).toContain("RULE_APPEND=5Z3E6C2NPCNS|zlgd_klqd_ls|zlgd_klqd_ls_ysjl");
	});

	it("keeps OpSandbox's whole cause chain and its field-key hints (zlgd_ygpt2.0 复盘 §三.2/§三.3)", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/OpSandbox.java")
			?.content as string;
		// Message from the innermost cause, frames from the outermost wrapper: the
		// two used to be printed together and could not both be about the same
		// throw. Every link now prints its own frames.
		// Package-visible since S21: DataSeedProbe reuses the same cause chain.
		expect(source).toContain("static void explain(Throwable t)");
		expect(source).toContain('link == 0 ? "异常 " : "Caused by: "');
		expect(source).toContain('System.out.println("[PROBE]       at " + st[i]);');
		expect(source).not.toContain("栈顶: ");
		// "Is this the platform or my plugin?" -- the only question a stack is for.
		expect(source).toContain("private static String whose(Throwable t, String op, List<String> plugins)");
		expect(source).toContain("出错的是本工程的 ");
		expect(source).toContain("整条因果链里没有本工程");
		// No own frame says only what a stack can say: platform code was running at the
		// throw. Plugin code that handed the platform bad data (a validator's message
		// with a null holder list) leaves no frame either, so no verdict on whose fault.
		expect(source).not.toContain("看起来是平台或校验器侧的问题");
		expect(source).toContain("static List<String> ownOpPlugins(String entity, String op)");
		// No package prefixes means it says so; a guess here sends the reader a
		// whole round in the wrong direction.
		expect(source).toContain("OP_PKGS 未传");
		// A validation line names the field key, not just the Chinese label: the
		// same bill carries billno (单据编号) next to zlgd_fnumber (委托单编号).
		expect(source).toContain("private static String keysIn(MainEntityType met, String message)");
		expect(source).toContain("字段标识：");
		expect(source).toContain("collectKeys(((ICollectionProperty) p).getItemType(), key, message, hit)");
	});

	it("keeps IsvGuard target errors actionable and on the current authorization path", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/IsvGuard.java")
			?.content as string;
		expect(source).toContain("目标按完整路径匹配");
		expect(source).toContain("需要确认的目标：");
		expect(source).toContain("不在用户确认过的写入范围里");
		expect(source).toContain('assertConfirmedUnder("布局", entity, key)');
		expect(source).toContain('assertConfirmedUnder("操作", owner, key)');
		expect(source).not.toContain("driver.mjs");
		// The list the harness reads back, and the "nothing landed" marker a receipt
		// needs to tell a pre-flight refusal from a half-written save.
		expect(source).toContain("写入目标清单");
		expect(source).toContain("未落库：");
	});

	it("keeps the entry/sub-entry path support the patches exist for", () => {
		const byPath = new Map(EMBEDDED_RESOURCES.map((entry) => [entry.relativePath, entry.content]));
		const formSim = byPath.get("probes/FormSim.java") as string;
		const expectSpec = byPath.get("probes/ExpectSpec.java") as string;

		// --set must route through the same path parser --expect uses. The frozen
		// version called the single-argument setValue, which rejects any dotted
		// path with "属性:分录.字段不存在".
		expect(formSim).toContain("ExpectSpec.Pos.parse");
		expect(formSim).toContain("model.setValue(pos.field, v, pos.row)");
		// Sub-entry write: (key, value, rowIndex, parentRowIndex).
		expect(formSim).toContain("model.setValue(pos.field, v, pos.subRow, pos.row)");
		expect(formSim).toContain("createNewEntryRow");

		// Three-segment paths must survive parsing; the frozen parser split on the
		// first dot only, leaving "子分录.字段" as a field name that cannot resolve.
		expect(expectSpec).toContain("public final String sub;");
		expect(expectSpec).toContain("public final int subRow;");
		// 同名 id 必须从指定分录行读取，不能按字段名回到单头。
		expect(expectSpec).toContain("valueOf(model.getDataEntity(true), pos)");
		expect(expectSpec).not.toContain("model.getValue(pos.field, pos.row)");
		expect(expectSpec).not.toContain("model.getValue(pos.field, pos.subRow, pos.row)");
		expect(expectSpec).toContain("property instanceof ICollectionProperty");
		expect(expectSpec).toContain("property instanceof IComplexProperty");
		expect(expectSpec).toContain('ProbeAssert.unresolved("field", pos.original');
		expect(formSim).toContain("ExpectSpec.propAt(MET, pos)");

		// Every other Pos consumer must handle `sub` or refuse. Reading a three-segment
		// path as two would write the leaf field onto the PARENT entry row -- which
		// succeeds silently whenever the parent happens to carry the same field name.
		const callbackSim = byPath.get("probes/FormCallbackSim.java") as string;
		const ruleSim = byPath.get("probes/RuleSim.java") as string;
		expect(callbackSim).toContain("model.setValue(pos.field, value, pos.subRow, pos.row)");
		expect(ruleSim).toContain("run rule 不支持子分录路径");

		// run op was the last Pos consumer still splitting the path itself: three
		// segments came back as "分录 X 上没有字段 子分录.字段" -- honest, but the same
		// --set line worked under run form and not under run op.
		const opSandbox = byPath.get("probes/OpSandbox.java") as string;
		expect(opSandbox).toContain("ExpectSpec.Pos.parse(path)");
		expect(opSandbox).toContain("host.getDynamicObjectCollection(pos.sub)");
	});

	it("keeps the phone lookup the startup wizard turns into a user id", () => {
		const userProbe = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/UserProbe.java")
			?.content as string;
		// Nobody remembers their own user id; everybody remembers their phone number.
		expect(userProbe).toContain('new QFilter("phone", QCP.like, "%" + key + "%")');
		// The machine-readable side is what the wizard reads; the human line alone
		// would put us back to parsing Chinese prose for an id we then write to disk.
		expect(userProbe).toContain('ProbeJson.emit("user",');
		// Neither channel may carry the raw phone number: both land in build/.
		expect(userProbe).toContain('"phone_mask", maskPhone(u.getString("phone"))');
		expect(userProbe).not.toContain('"phone", u.getString("phone")');
	});

	it("keeps the read-only print control locator machine-readable and key-only", () => {
		const source = EMBEDDED_RESOURCES.find((entry) => entry.relativePath === "probes/PrintTplDesignProbe.java")
			?.content as string;
		expect(source).toContain('env("TPL_CONTROL_KEY")');
		expect(source).toContain('wanted.equals(s(value.get("key")))');
		expect(source).toContain('ProbeJson.emit("ptpl-control"');
		expect(source).toContain('"path", match.path, "controlType", control.get("type")');
		expect(source).toContain('"bindField", bindField, "formulaData", formulaData');
	});

	it("keeps one value contract for --set, not one per adapter", () => {
		const byPath = new Map(EMBEDDED_RESOURCES.map((entry) => [entry.relativePath, entry.content]));
		const expectSpec = byPath.get("probes/ExpectSpec.java") as string;

		// Dates and multi-select basedata had no conversion at all on the form side,
		// and the four adapters disagreed about the rest. The contract lives in one
		// place now; each adapter only owns its write channel.
		expect(expectSpec).toContain("public static Object convert(IDataEntityProperty p, String raw)");
		expect(expectSpec).toContain("MulBasedataProp");
		expect(expectSpec).toContain("yyyy-MM-dd HH:mm:ss");
		// Lenient parsing turns 2026-13-45 into 2027-02-14 without an error -- a wrong
		// value no assertion can catch.
		expect(expectSpec).toContain("setLenient(false)");
		// Assertion-side dates use the same stable literals instead of Date.toString().
		expect(expectSpec).toContain('new SimpleDateFormat("yyyy-MM-dd").format((Date) actual)');
		// Numeric base-data numbers such as 001 used to be treated as id=1 without
		// checking that id existed. IDataModel then accepted the missing id as null,
		// so --set printed success while --show and the plugin both saw null.
		expect(expectSpec).toContain('new QFilter("id", "=", id)');
		expect(expectSpec).toContain('new QFilter("number", "=", val)');
		expect(expectSpec).toContain("里找不到 id 或编码");

		for (const path of [
			"probes/FormSim.java",
			"probes/OpSandbox.java",
			"probes/FormCallbackSim.java",
			"probes/RuleSim.java",
		]) {
			expect(byPath.get(path) as string, path).toContain("ExpectSpec.convert(");
		}
	});
});
