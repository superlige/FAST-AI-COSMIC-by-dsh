import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileSystemPort } from "../../src/kernel/config/detect.ts";
import {
	loadConfig,
	missingRequired,
	requireRuntime,
	resolveCosmicHome,
	sourceOf,
} from "../../src/kernel/config/load-config.ts";

const ROOT = "D:/proj";
const AGENT_DIR = "D:/agent";

interface FakeProject {
	gradleProperties?: string;
	settings?: string;
	buildGradle?: Record<string, string>;
	javaFiles?: Record<string, string>;
	/** The machine-wide file, `<AGENT_DIR>/config.json`. */
	configJson?: string;
	/** The per-project file, `<ROOT>/.cosmic-ai/config.json`. */
	projectConfigJson?: string;
}

function fakeFs(project: FakeProject): FileSystemPort {
	const files = new Map<string, string>();
	const put = (path: string, content: string): void => {
		files.set(path.replace(/\\/g, "/"), content);
	};

	if (project.gradleProperties !== undefined) put(join(ROOT, "gradle.properties"), project.gradleProperties);
	if (project.settings !== undefined) put(join(ROOT, "settings.gradle"), project.settings);
	for (const [module, text] of Object.entries(project.buildGradle ?? {})) {
		put(join(ROOT, module, "build.gradle"), text);
	}
	for (const [path, text] of Object.entries(project.javaFiles ?? {})) put(path, text);
	if (project.configJson !== undefined) put(join(AGENT_DIR, "config.json"), project.configJson);
	if (project.projectConfigJson !== undefined) {
		put(join(ROOT, ".cosmic-ai", "config.json"), project.projectConfigJson);
	}

	return {
		read: (path) => files.get(path.replace(/\\/g, "/")) ?? "",
		listJavaFiles: (dir) => {
			const prefix = `${dir.replace(/\\/g, "/")}/`;
			return [...files.keys()].filter((path) => path.startsWith(prefix) && path.endsWith(".java"));
		},
	};
}

const LAUNCHER = `
package com.acme.debug;
public class DebugApp {
  public static void main(String[] args) {
    Launcher cosmic = devRemote();
    cosmic.start();
  }
}
`;

const COMPLETE_PROJECT: FakeProject = {
	gradleProperties: "systemProp.developer_flag=zlgd\nsystemProp.cosmic_home=D:/cosmic/runtime\n",
	settings: "include('zlgd-cosmic-debug', 'zlgd-hhx')",
	buildGradle: {
		"zlgd-cosmic-debug":
			"plugins { id 'java-application-conventions' }\ndependencies { implementation project(':zlgd-hhx') }",
		"zlgd-hhx": "",
	},
	javaFiles: { [`${ROOT}/zlgd-cosmic-debug/src/main/java/com/acme/debug/DebugApp.java`]: LAUNCHER },
};

function load(project: FakeProject, env: Record<string, string | undefined> = {}) {
	return loadConfig({ root: ROOT, agentConfigDir: AGENT_DIR, env }, fakeFs(project));
}

describe("S2.1 config detection", () => {
	it("detects isv, debug module, code modules and launch entry from the project", () => {
		const config = load(COMPLETE_PROJECT);
		expect(config.isv).toBe("zlgd");
		expect(config.debugModule).toBe("zlgd-cosmic-debug");
		expect(config.codeModules).toEqual(["zlgd-hhx"]);
		expect(config.appClass).toBe("com.acme.debug.DebugApp");
		// The probe must call the configure-only method, never start().
		expect(config.appMethod).toBe("devRemote");
	});

	describe("开发助手新模板：配置和 start() 都写在 main 里", () => {
		const DEBUG = `${ROOT}/pps6-cosmic-debug/src/main/java`;
		const APP = `
package pps6.cosmic.debug;
import kd.cosmic.debug.tools.CosmicLauncher;
public class DebugApplication {
    public static void main(String[] args) {
        CosmicLauncher cosmic = new CosmicLauncher(false);
//        cosmic.setConfigUrl("127.0.0.1:2181?user=zk&password=xxx");
        cosmic.setConfigUrl("127.0.0.1:2181");
        cosmic.setMcServerUrl("http://127.0.0.1:8090/");
        cosmic.start();
    }
}
`;
		const launcher = (startBody: string) => `
package kd.cosmic.debug.tools;
/** 启动器 */
public final class CosmicLauncher {
    public void start() {
${startBody}
    }
}
`;
		const project = (startBody: string, app = APP): FakeProject => ({
			gradleProperties: "systemProp.developer_flag=pps6\nsystemProp.cosmic_home=D:/cosmic/runtime\n",
			settings: "include(':pps6-cosmic-debug', ':pps6-ofa10-ofa')",
			buildGradle: { "pps6-cosmic-debug": "dependencies { implementation project(':pps6-ofa10-ofa') }" },
			javaFiles: {
				[`${DEBUG}/kd/cosmic/debug/tools/CosmicLauncher.java`]: launcher(startBody),
				[`${DEBUG}/pps6/cosmic/debug/DebugApplication.java`]: app,
			},
		});

		it("认出启动类，appMethod 为 main（启动器的 start 走平台 Booter.main）", () => {
			const config = load(project("        Booter.main(null);"));
			expect(config.appClass).toBe("pps6.cosmic.debug.DebugApplication");
			expect(config.appMethod).toBe("main");
			expect(sourceOf(config, "appMethod").source).toBe("自动探测");
		});

		it("启动器不经 Booter.main 起服务时不猜：探针里调 main 会真起一个服务", () => {
			expect(load(project("        new JettyServer().start();")).appMethod).toBeNull();
			expect(load(project("        // Booter.main(null);")).appMethod).toBeNull();
		});

		it("main 里没调 start() 的不当成新模板", () => {
			const config = load(project("        Booter.main(null);", APP.replace("cosmic.start();", "")));
			expect(config.appMethod).toBeNull();
		});
	});

	it("注释掉的配置方法不算：取 main 里真在用的那个", () => {
		const app = LAUNCHER.replace(
			"Launcher cosmic = devRemote();",
			"// Launcher cosmic = devVm();\n    Launcher cosmic = devRemote();",
		);
		const config = load({
			...COMPLETE_PROJECT,
			javaFiles: { [`${ROOT}/zlgd-cosmic-debug/src/main/java/com/acme/debug/DebugApp.java`]: app },
		});
		expect(config.appMethod).toBe("devRemote");
	});

	it("records where every field came from", () => {
		const config = load(COMPLETE_PROJECT, { COSMIC_ACCOUNT: "acct" });
		expect(sourceOf(config, "isv").source).toBe("自动探测");
		expect(sourceOf(config, "account")).toEqual({ source: "环境变量", via: "COSMIC_ACCOUNT" });
		expect(sourceOf(config, "tenant").source).toBe("内置默认");
		expect(sourceOf(config, "user").source).toBe("(缺失)");
	});
});

describe("多工程：工程级 config.json", () => {
	// One machine, several Cosmic projects: a single machine-wide file applies
	// project A's account to project B, and a wrong `user` has no symptom at all.
	const GLOBAL = JSON.stringify({ account: "globalAcct", user: "42", isv: "globalIsv" });

	it("applies env over the project file over the machine-wide file over detection", () => {
		const project = {
			...COMPLETE_PROJECT,
			configJson: GLOBAL,
			projectConfigJson: JSON.stringify({ account: "projAcct" }),
		};
		expect(load(project).account).toBe("projAcct");
		expect(load(project, { COSMIC_ACCOUNT: "envAcct" }).account).toBe("envAcct");
	});

	it("merges per field, so a machine-wide value stays in force where the project is silent", () => {
		const config = load({
			...COMPLETE_PROJECT,
			configJson: GLOBAL,
			projectConfigJson: JSON.stringify({ account: "projAcct" }),
		});
		expect(config.user).toBe("42");
		expect(sourceOf(config, "user")).toEqual({ source: "全局 config.json", via: join(AGENT_DIR, "config.json") });
	});

	it("names the file each value came from, so the two layers are never confused", () => {
		const config = load({
			...COMPLETE_PROJECT,
			configJson: GLOBAL,
			projectConfigJson: JSON.stringify({ account: "projAcct" }),
		});
		expect(sourceOf(config, "account")).toEqual({
			source: "工程 .cosmic-ai/config.json",
			via: join(ROOT, ".cosmic-ai", "config.json"),
		});
	});

	it("reports both files and blames the right one for a syntax error", () => {
		const config = load({ ...COMPLETE_PROJECT, configJson: GLOBAL, projectConfigJson: "{ not json" });
		expect(config.projectConfigFile).toBe(join(ROOT, ".cosmic-ai", "config.json"));
		expect(config.projectConfigExists).toBe(true);
		expect(config.configFile).toBe(join(AGENT_DIR, "config.json"));
		expect(config.parseErrorFile).toBe(join(ROOT, ".cosmic-ai", "config.json"));
		expect(requireRuntime(config)?.remedy).toContain(".cosmic-ai");
	});

	it("points a missing-field remedy at the project file, not at the shared one", () => {
		const error = requireRuntime(load(COMPLETE_PROJECT));
		expect(error?.code).toBe("CONFIG_INCOMPLETE");
		expect(error?.remedy).toContain(join(ROOT, ".cosmic-ai", "config.json"));
	});

	it("lets the project override code modules while the machine-wide file supplies the rest", () => {
		const config = load({
			...COMPLETE_PROJECT,
			configJson: JSON.stringify({ codeModules: ["global-mod"], user: "42" }),
			projectConfigJson: JSON.stringify({ codeModules: ["proj-mod"] }),
		});
		expect(config.codeModules).toEqual(["proj-mod"]);
		expect(sourceOf(config, "codeModules").source).toBe("工程 .cosmic-ai/config.json");
	});
});

describe("S2.1 config precedence", () => {
	it("applies env over config.json over detection over default", () => {
		const project = { ...COMPLETE_PROJECT, configJson: JSON.stringify({ isv: "fromfile", tenant: "fromfile" }) };
		expect(load(project).isv).toBe("fromfile");
		expect(load(project, { COSMIC_ISV: "fromenv" }).isv).toBe("fromenv");
		expect(load(COMPLETE_PROJECT).tenant).toBe("ierp");
	});

	it("treats empty string and empty array as absent, so a blank entry does not shadow detection", () => {
		const project = { ...COMPLETE_PROJECT, configJson: JSON.stringify({ isv: "", codeModules: [] }) };
		const config = load(project, { COSMIC_ISV: "" });
		expect(config.isv).toBe("zlgd");
		expect(config.codeModules).toEqual(["zlgd-hhx"]);
	});

	it("still honours the legacy bizModules name", () => {
		const project = { ...COMPLETE_PROJECT, configJson: JSON.stringify({ bizModules: ["legacy"] }) };
		expect(load(project).codeModules).toEqual(["legacy"]);
	});

	it("reports a config.json parse failure instead of throwing during load", () => {
		const project = { ...COMPLETE_PROJECT, configJson: "{ not json" };
		const config = load(project);
		expect(config.parseError).not.toBeNull();
		expect(requireRuntime(config)?.code).toBe("CONFIG_PARSE_FAILED");
	});
});

describe("S2.1 resident-agent isolation (D9)", () => {
	it("does not leak field origins between two projects loaded in sequence", () => {
		// The frozen config.mjs kept SOURCES in module scope. One process per command
		// made that safe; a resident agent would show project A's origin for project B.
		const withEnv = load(COMPLETE_PROJECT, { COSMIC_ISV: "fromenv" });
		const withoutEnv = load(COMPLETE_PROJECT, {});
		expect(sourceOf(withEnv, "isv")).toEqual({ source: "环境变量", via: "COSMIC_ISV" });
		expect(sourceOf(withoutEnv, "isv").source).toBe("自动探测");
		// The first result must be unchanged by the second load.
		expect(sourceOf(withEnv, "isv").source).toBe("环境变量");
	});

	it("reads only the env object it was given, never ambient process.env", () => {
		process.env.COSMIC_ISV = "ambient-should-not-be-seen";
		try {
			expect(load(COMPLETE_PROJECT, {}).isv).toBe("zlgd");
		} finally {
			delete process.env.COSMIC_ISV;
		}
	});
});

describe("S2.2 cosmicHome: agent config may not silently replace the project", () => {
	it("uses the project value and flags a disagreeing agent value", () => {
		const project = { ...COMPLETE_PROJECT, configJson: JSON.stringify({ cosmicHome: "D:/other/runtime" }) };
		const config = load(project);
		// Project wins: probes must compile against the runtime the project runs on.
		expect(config.cosmicHome).toBe("D:/cosmic/runtime");
		expect(config.cosmicHomeResolution.conflict).toEqual({
			projectValue: "D:/cosmic/runtime",
			agentValue: "D:/other/runtime",
		});
	});

	it("accepts an agent value only when the project declares none", () => {
		const project: FakeProject = {
			...COMPLETE_PROJECT,
			gradleProperties: "systemProp.developer_flag=zlgd\n",
			configJson: JSON.stringify({ cosmicHome: "D:/fallback" }),
		};
		const config = load(project);
		expect(config.cosmicHome).toBe("D:/fallback");
		expect(config.cosmicHomeResolution.source).toBe("全局 config.json（gradle 未声明）");
		expect(config.cosmicHomeResolution.conflict).toBeNull();
	});

	it("raises no conflict when both agree", () => {
		expect(resolveCosmicHome("D:/same", "D:/same").conflict).toBeNull();
		expect(resolveCosmicHome(null, null).value).toBeNull();
		expect(resolveCosmicHome("D:/p", "   ").conflict).toBeNull();
	});
});

describe("S2.1 required fields", () => {
	it("lists everything missing at once rather than stopping at the first", () => {
		const missing = missingRequired(load(COMPLETE_PROJECT));
		expect(missing.map((m) => m.field)).toEqual(["account", "user"]);
	});

	it("returns a KernelError instead of exiting the process", () => {
		const error = requireRuntime(load(COMPLETE_PROJECT));
		expect(error?.code).toBe("CONFIG_INCOMPLETE");
		expect(error?.detail.missing).toHaveLength(2);
	});

	it("passes once account and user are supplied", () => {
		expect(requireRuntime(load(COMPLETE_PROJECT, { COSMIC_ACCOUNT: "a", COSMIC_USER: "u" }))).toBeNull();
	});

	it("gives account and user no default, deliberately", () => {
		// A defaulted account connects to somebody else's account set; a defaulted
		// user has NO symptom at all -- every write records the wrong modifier.
		const config = load(COMPLETE_PROJECT);
		expect(config.account).toBeNull();
		expect(config.user).toBeNull();
		expect(config.tenant).toBe("ierp");
	});
});
