/**
 * 和开发助手模板长得不一样的苍穹工程：能从工程文件读出来的自动读，读不出来的由模型用
 * cosmic_doctor action=config 核对后写进工程配置。
 *
 * 覆盖：Kotlin 写的构建脚本、只有 settings 没有 gradle.properties、租户从启动类读、
 * JDK 的先后顺序（config.json → gradle.properties 的 org.gradle.java.home → JAVA_HOME）
 * 以及它被放到子进程 PATH 最前面、jvmArgs / gradleArgs、gradle 报出来的模块目录、写配置前的核对。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FileSystemPort, gradleModulesFile } from "../../src/kernel/config/detect.ts";
import { loadConfig, requireRuntime } from "../../src/kernel/config/load-config.ts";
import { hasProjectMarkers } from "../../src/kernel/config/project-root.ts";
import { setProjectConfig } from "../../src/kernel/config/set-config.ts";
import { productJvmOptions } from "../../src/kernel/context.ts";
import { kernelLayout } from "../../src/kernel/layout.ts";
import { withJavaHome } from "../../src/kernel/open-project.ts";
import type { FsPort } from "../../src/kernel/ports.ts";
import { residentServerArgs } from "../../src/kernel/probe/server.ts";
import { baseConfig, makeContext } from "./fake-context.ts";

const ROOT = "D:/shape";
const AGENT = "D:/agent";

/** 路径 → 内容；读写都按正斜杠比。 */
function memoryFs(files: Record<string, string>): FileSystemPort & FsPort {
	const map = new Map(Object.entries(files).map(([path, text]) => [path.replace(/\\/g, "/"), text]));
	const key = (path: string): string => path.replace(/\\/g, "/");
	return {
		read: (path) => map.get(key(path)) ?? "",
		listJavaFiles: (dir) => {
			const prefix = `${key(dir)}/`;
			return [...map.keys()].filter((path) => path.startsWith(prefix) && path.endsWith(".java"));
		},
		exists: (path) => map.has(key(path)) || [...map.keys()].some((file) => file.startsWith(`${key(path)}/`)),
		write: (path, text) => {
			map.set(key(path), text);
		},
		mkdirp: () => undefined,
		readBytes: () => null,
		tryCreate: (path, text) => {
			if (map.has(key(path))) return false;
			map.set(key(path), text);
			return true;
		},
		tryRename: () => false,
		mtimeMs: () => null,
		readDir: () => [],
		remove: (path) => {
			map.delete(key(path));
		},
	};
}

const LAUNCH = `
package demo.debug;
public class Boot {
    public static void main(String[] args) {
        Launcher cosmic = devRemote();
        cosmic.start();
    }
    private static Launcher devLocal() {
        Launcher cosmic = new Launcher(true);
        cosmic.setTenantNumber("local");
        return cosmic;
    }
    private static Launcher devRemote() {
        Launcher cosmic = new Launcher(false);
        cosmic.setConfigUrl("10.0.0.1:2181?user=zk&password=a}b");
        cosmic.setTenantNumber("demo_tenant");
        return cosmic;
    }
}
`;

/** Kotlin 写的构建脚本、没有 gradle.properties。 */
const KTS_PROJECT: Record<string, string> = {
	[`${ROOT}/settings.gradle.kts`]: 'include("demo-debug", ":demo-biz")\n',
	[`${ROOT}/demo-debug/build.gradle.kts`]:
		'plugins { id("cosmic_plugin.java-application-conventions") }\ndependencies { implementation(project(":demo-biz")) }\n',
	[`${ROOT}/demo-biz/build.gradle.kts`]: "",
	[`${ROOT}/demo-debug/src/main/java/demo/debug/Boot.java`]: LAUNCH,
};

function load(files: Record<string, string>, env: Record<string, string> = {}) {
	return loadConfig({ root: ROOT, agentConfigDir: AGENT, env }, memoryFs(files));
}

describe("Kotlin 构建脚本、没有 gradle.properties 的工程", () => {
	it("认得出工程根", () => {
		const fs = memoryFs(KTS_PROJECT);
		expect(hasProjectMarkers(ROOT, (path) => fs.exists(path))).toBe(true);
	});

	it("模块、调试模块、启动类、配置方法照样自动探测，每一项注明从哪读的", () => {
		const config = load(KTS_PROJECT);
		expect(config.auto.modules).toEqual(["demo-debug", "demo-biz"]);
		expect(config.debugModule).toBe("demo-debug");
		expect(config.codeModules).toEqual(["demo-biz"]);
		expect(config.appClass).toBe("demo.debug.Boot");
		expect(config.appMethod).toBe("devRemote");
		expect(config.sources.appClass?.via).toContain("Boot.java");
	});

	it("租户读的是探针真会跑的那个配置方法里的字面量，不是别的方法里的", () => {
		const config = load(KTS_PROJECT);
		expect(config.tenant).toBe("demo_tenant");
		expect(config.sources.tenant?.source).toBe("自动探测");
	});

	it("缺的 ISV、苍穹目录不再要人填，补救写明让模型读工程文件、用 cosmic_doctor action=config 写", () => {
		const error = requireRuntime(load(KTS_PROJECT));
		expect(error?.code).toBe("CONFIG_INCOMPLETE");
		expect(error?.detail).toMatchObject({ fromProject: ["isv"], askUser: ["account", "user"] });
		expect(error?.remedy).toContain("cosmic_doctor action=config");
		expect(error?.remedy).toContain("/cosmic-env");
	});
});

describe("用哪个 JDK", () => {
	const withGradleJdk = { ...KTS_PROJECT, [`${ROOT}/gradle.properties`]: "org.gradle.java.home=D\\:\\\\jdk\\\\8\n" };

	it("工程 gradle.properties 的 org.gradle.java.home 压过 JAVA_HOME，转义照 properties 的写法去掉", () => {
		const config = load(withGradleJdk, { JAVA_HOME: "C:/jdk17" });
		expect(config.javaHome).toBe("D:\\jdk\\8");
		expect(config.sources.javaHome?.via).toContain("org.gradle.java.home");
	});

	it("工程配置的 javaHome 压过两者；都没有就用 JAVA_HOME；再没有就是 PATH 上的 java", () => {
		const configured = { ...withGradleJdk, [`${ROOT}/.cosmic-ai/config.json`]: '{"javaHome":"E:/jdk8"}' };
		expect(load(configured, { JAVA_HOME: "C:/jdk17" }).javaHome).toBe("E:/jdk8");
		expect(load(KTS_PROJECT, { JAVA_HOME: "C:/jdk17" }).javaHome).toBe("C:/jdk17");
		const none = load(KTS_PROJECT);
		expect(none.javaHome).toBeNull();
		expect(none.sources.javaHome?.via).toContain("PATH");
	});

	it("选定的 JDK 放进 JAVA_HOME 和子进程 PATH 的最前面，Windows 的 Path 拼法照改", () => {
		const env = withJavaHome({ Path: "C:\\Windows;C:\\Oracle\\javapath", JAVA_HOME: "C:/jdk17" }, "D:/jdk8", "win32");
		expect(env.JAVA_HOME).toBe("D:/jdk8");
		expect(env.Path).toBe("D:\\jdk8\\bin;C:\\Windows;C:\\Oracle\\javapath");
		expect(withJavaHome({}, "/opt/jdk8", "linux").PATH).toBe("/opt/jdk8/bin");
	});
});

describe("jvmArgs / gradleArgs", () => {
	it("没配：gradlew 带 --offline，JVM 只有产品参数", () => {
		const config = load(KTS_PROJECT);
		expect(config.gradleArgs).toEqual(["--offline"]);
		expect(config.jvmArgs).toEqual([]);
	});

	it("配了：gradleArgs 整体替换；jvmArgs 里的 -Xmx 替换默认那项，其余追加在产品参数后面", () => {
		const files = {
			...KTS_PROJECT,
			[`${ROOT}/.cosmic-ai/config.json`]: '{"gradleArgs":["-x","test"],"jvmArgs":"-Xmx6g -Dzk.pwd=1"}',
		};
		const config = load(files);
		expect(config.gradleArgs).toEqual(["-x", "test"]);
		expect(config.jvmArgs).toEqual(["-Xmx6g", "-Dzk.pwd=1"]);
		expect(productJvmOptions(config, ["-Xmx2g", "-XX:MaxMetaspaceSize=512m"])).toEqual(["-XX:MaxMetaspaceSize=512m"]);
	});

	it("常驻探针 JVM 的命令行：用户的 -Xmx 取代 -Xmx2g，用户的 -D 排在 cosmic 自己的 -D 后面、主类前面", () => {
		const fake = makeContext({ config: { jvmArgs: ["-Xmx6g", "-Dcosmic.dbLink=platform"] } });
		const args = residentServerArgs(
			fake.ctx,
			{ mode: "instrument", args: [], warning: null },
			"D:/jdk/lib/tools.jar",
		);
		expect(args).not.toContain("-Xmx2g");
		expect(args[0]).toBe("-XX:MaxMetaspaceSize=512m");
		const user = args.indexOf("-Dcosmic.dbLink=platform");
		expect(user).toBeGreaterThan(args.indexOf("-Dcosmic.dbLink=fast"));
		expect(user).toBeLessThan(args.indexOf("CosmicProbeServer"));
	});
});

describe("模块目录按 gradle 报的", () => {
	it("有 build/cosmic-modules.json 就用里面的源码和输出目录，没有才按默认目录", () => {
		const modulesFile = gradleModulesFile(ROOT);
		const files = {
			...KTS_PROJECT,
			[modulesFile]: JSON.stringify({
				modules: {
					"demo-debug": { src: [`${ROOT}/demo-debug/java`], out: `${ROOT}/out/debug` },
					"demo-biz": { src: [`${ROOT}/demo-biz/source`, `${ROOT}/demo-biz/gen`], out: `${ROOT}/out/biz` },
				},
			}),
			[`${ROOT}/demo-debug/java/demo/debug/Boot.java`]: LAUNCH,
		};
		const config = load(files);
		const layout = kernelLayout({
			root: ROOT,
			cacheRoot: "D:/cache",
			runtimeKeyId: "rk",
			resourcesDir: "D:/cache/resources",
			codeModules: config.codeModules,
			debugModule: config.debugModule,
			gradleDirs: config.auto.gradleDirs,
		});
		expect(layout.moduleDirs[0]).toEqual({
			name: "demo-biz",
			src: join(`${ROOT}/demo-biz/source`),
			out: join(`${ROOT}/out/biz`),
		});
		expect(layout.launchModule?.out).toBe(join(`${ROOT}/out/debug`));
		// 启动类也到 gradle 报的源码目录里找
		expect(config.sources.appClass?.via).toContain("demo-debug/java");
		const plain = kernelLayout({
			root: ROOT,
			cacheRoot: "D:/cache",
			runtimeKeyId: "rk",
			resourcesDir: "D:/cache/resources",
			codeModules: ["demo-biz"],
		});
		expect(plain.moduleDirs[0]?.out).toBe(join(ROOT, "demo-biz", "build", "classes", "java", "main"));
	});
});

describe("cosmic_doctor action=config 写工程配置之前逐项核对", () => {
	function setUp(extra: Record<string, string> = {}) {
		const fs = memoryFs({ ...KTS_PROJECT, ...extra });
		const config = loadConfig({ root: ROOT, agentConfigDir: AGENT, env: {} }, fs);
		const run = (
			changes: Record<string, unknown>,
			current: Partial<Record<"debugModule" | "appClass", string>> = {},
		) =>
			setProjectConfig(
				{
					root: ROOT,
					changes,
					auto: config.auto,
					currentDebugModule: current.debugModule ?? config.debugModule,
					currentAppClass: current.appClass ?? config.appClass,
					currentAppMethod: config.appMethod,
					platform: "win32",
				},
				fs,
			);
		return { fs, run, file: join(ROOT, ".cosmic-ai", "config.json") };
	}

	it("账套和用户不收：只能由用户来选", () => {
		const result = setUp().run({ account: "demo_dev", user: "1" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("CONFIG_SET_INVALID");
			expect(JSON.stringify(result.error.detail)).toContain("只能由用户来选");
		}
	});

	it("一项不对就一项都不写，逐项说清哪里不对", () => {
		const { fs, run, file } = setUp();
		const result = run({
			isv: "demo",
			debugModule: "nope",
			javaHome: "D:/not-a-jdk",
			jvmArgs: ["-cp", "x"],
			color: 1,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const problems = (result.error.detail as { problems: string[] }).problems.join("\n");
			expect(problems).toContain("nope 不在 settings.gradle");
			expect(problems).toContain("bin/java.exe");
			expect(problems).toContain("类路径和主类由 cosmic 定");
			expect(problems).toContain("不认识 color");
		}
		expect(fs.read(file)).toBe("");
	});

	it("配置方法对着启动类源码核：要存在、要是无参静态方法；main 也认", () => {
		const { run } = setUp();
		expect(run({ appMethod: "devLocal" }).ok).toBe(true);
		expect(run({ appMethod: "main" }).ok).toBe(true);
		const absent = run({ appMethod: "devCloud" });
		expect(!absent.ok && JSON.stringify(absent.error.detail)).toContain("没有叫 devCloud 的方法");
	});

	it("写成了报每一项的改前改后；null 删掉这项、回到自动探测", () => {
		const { fs, run, file } = setUp({ [`D:/jdk8/bin/java.exe`]: "" });
		const first = run({ isv: "demo", javaHome: "D:/jdk8", gradleArgs: [] });
		expect(first.ok).toBe(true);
		if (first.ok)
			expect(first.value.changes).toEqual([
				{ field: "isv", before: null, after: "demo" },
				{ field: "javaHome", before: null, after: "D:/jdk8" },
				{ field: "gradleArgs", before: null, after: [] },
			]);
		expect(JSON.parse(fs.read(file))).toEqual({ isv: "demo", javaHome: "D:/jdk8", gradleArgs: [] });
		const second = run({ javaHome: null });
		expect(second.ok && second.value.changes).toEqual([{ field: "javaHome", before: "D:/jdk8", after: null }]);
		expect(JSON.parse(fs.read(file))).toEqual({ isv: "demo", gradleArgs: [] });
		const config = loadConfig({ root: ROOT, agentConfigDir: AGENT, env: {} }, fs);
		expect(config.isv).toBe("demo");
		expect(requireRuntime(config)?.detail).toMatchObject({ fromProject: [], askUser: ["account", "user"] });
	});

	it("工程 gradle.properties 写了 cosmic_home，配置里不许换成另一个", () => {
		const { run } = setUp({
			[`${ROOT}/gradle.properties`]: "systemProp.cosmic_home=D:/cosmic\n",
			"D:/other/x": "",
		});
		const result = run({ cosmicHome: "D:/other" });
		expect(!result.ok && JSON.stringify(result.error.detail)).toContain("以工程为准");
	});
});

it("fake-context 的默认配置和真实默认一致：gradlew 默认带 --offline", () => {
	expect(baseConfig().gradleArgs).toEqual(["--offline"]);
});
