/**
 * S5.1 doctor parity.
 *
 * The frozen doctor's contract is a single sentence: it always runs, and every
 * value it prints says where it came from. These tests assert exactly that, plus
 * the one thing D13 changed -- an unconfigured knowledge base is a reported
 * source, not a missing prerequisite.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doctor } from "../../src/kernel/commands/doctor.ts";
import type { FileSystemPort } from "../../src/kernel/config/detect.ts";
import { loadConfig } from "../../src/kernel/config/load-config.ts";
import type { KnowledgeSourceStatus } from "../../src/knowledge/source.ts";

const ROOT = "D:/proj";
const AGENT_DIR = "D:/agent";

function fakeFs(files: Record<string, string>): FileSystemPort {
	const map = new Map(Object.entries(files).map(([path, text]) => [path.replace(/\\/g, "/"), text]));
	return {
		read: (path) => map.get(path.replace(/\\/g, "/")) ?? "",
		listJavaFiles: (dir) => {
			const prefix = `${dir.replace(/\\/g, "/")}/`;
			return [...map.keys()].filter((path) => path.startsWith(prefix) && path.endsWith(".java"));
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

const COMPLETE: Record<string, string> = {
	[join(ROOT, "gradle.properties")]: "systemProp.developer_flag=zlgd\nsystemProp.cosmic_home=D:/cosmic/runtime\n",
	[join(ROOT, "settings.gradle")]: "include('zlgd-cosmic-debug', 'zlgd-hhx')",
	[join(ROOT, "zlgd-cosmic-debug", "build.gradle")]:
		"plugins { id 'java-application-conventions' }\ndependencies { implementation project(':zlgd-hhx') }",
	[join(ROOT, "zlgd-hhx", "build.gradle")]: "",
	[`${ROOT}/zlgd-cosmic-debug/src/main/java/com/acme/debug/DebugApp.java`]: LAUNCHER,
};

const EMBEDDED: KnowledgeSourceStatus = {
	kind: "embedded",
	root: "C:/cache/knowledge/snap/cosmic",
	inForce: { bundleVersion: "2.2.1", snapshotId: "snapshot-digest", docCount: 1763 },
	embedded: { bundleVersion: "2.2.1", snapshotId: "snapshot-digest", docCount: 1763 },
	overrideProblem: null,
};

function report(files: Record<string, string>, env: Record<string, string | undefined> = {}, knowledge = EMBEDDED) {
	const config = loadConfig({ root: ROOT, agentConfigDir: AGENT_DIR, env }, fakeFs(files));
	return doctor({ config, knowledge });
}

function rowOf(fields: ReturnType<typeof report>["rows"], field: string) {
	const row = fields.find((item) => item.field === field);
	if (row === undefined) throw new Error(`doctor 没有 ${field} 这一行`);
	return row;
}

describe("doctor", () => {
	it("每个字段都带出处，环境变量出处写明变量名", () => {
		const result = report(
			{ ...COMPLETE, [join(AGENT_DIR, "config.json")]: '{"account":"1001"}' },
			{ COSMIC_USER: "7" },
		);

		expect(rowOf(result.rows, "isv")).toMatchObject({ value: "zlgd", source: "自动探测" });
		expect(rowOf(result.rows, "account")).toMatchObject({ value: "1001", source: "全局 config.json" });
		expect(rowOf(result.rows, "user")).toMatchObject({ value: "7", source: "环境变量", via: "COSMIC_USER" });
		expect(rowOf(result.rows, "tenant")).toMatchObject({ value: "ierp", source: "内置默认" });
	});

	it("配置不全时照样出报告，并逐项列出缺什么", () => {
		const result = report(COMPLETE);

		expect(result.ok).toBe(false);
		expect(result.missingRequired.map((item) => item.field)).toEqual(["account", "user"]);
		// The point of the command: it answers even when the project is unusable.
		expect(result.rows.length).toBeGreaterThan(0);
		expect(rowOf(result.rows, "account").value).toBeNull();
		expect(result.nextActions.join("\n")).toContain("account");
	});

	it("config.json 语法错时报告解析错误而不是抛出", () => {
		const result = report({ ...COMPLETE, [join(AGENT_DIR, "config.json")]: "{oops" });

		expect(result.parseError).not.toBeNull();
		expect(result.ok).toBe(false);
		expect(result.nextActions.join("\n")).toContain("JSON");
	});

	it("认不出的工程依赖被原样列出，不猜模块名", () => {
		const files = {
			...COMPLETE,
			[join(ROOT, "zlgd-cosmic-debug", "build.gradle")]:
				"dependencies { implementation project(':zlgd-hhx'); implementation projects.zlgd.unknownThing }",
		};
		const result = report(files);

		expect(result.modules.unresolvedDeps.length).toBeGreaterThan(0);
		expect(result.modules.codeModules).not.toContain("unknownThing");
		expect(result.nextActions.join("\n")).toContain("extraCodeModules");
	});

	it("cosmicHome 冲突时以工程值为准并报出冲突", () => {
		const result = report({
			...COMPLETE,
			[join(AGENT_DIR, "config.json")]: '{"cosmicHome":"D:/other/runtime","account":"1001","user":"7"}',
		});

		expect(rowOf(result.rows, "cosmicHome").value).toBe("D:/cosmic/runtime");
		expect(result.cosmicHomeConflict).toEqual({ projectValue: "D:/cosmic/runtime", agentValue: "D:/other/runtime" });
	});

	it("未配 knowledgeRoot 不再是缺配置：报告内嵌快照与版本（D13）", () => {
		const result = report(COMPLETE);

		expect(rowOf(result.rows, "knowledgeRoot").value).toBeNull();
		expect(result.knowledge.source).toMatchObject({ kind: "embedded", bundleVersion: "2.2.1" });
		expect(result.knowledge.lines.join("\n")).toContain("内嵌快照");
		expect(result.missingRequired.map((item) => item.field)).not.toContain("knowledgeRoot");
	});

	it("覆盖配了但不可用时报成降级，并给出改法", () => {
		const degraded: KnowledgeSourceStatus = {
			...EMBEDDED,
			overrideProblem: { kind: "missing-path", root: "D:/nope", missing: [], message: "配置目录不存在" },
		};
		const result = report(COMPLETE, {}, degraded);

		expect(result.knowledge.source?.degradedFrom).toBe("配置目录不存在");
		expect(result.nextActions.join("\n")).toContain("回退到内嵌快照");
	});

	it("快照都读不出来时说清楚，但不让 doctor 失败", () => {
		const config = loadConfig({ root: ROOT, agentConfigDir: AGENT_DIR, env: {} }, fakeFs(COMPLETE));
		const result = doctor({ config, knowledge: null });

		expect(result.knowledge.source).toBeNull();
		expect(result.knowledge.lines.join("\n")).toContain("cosmic-kb.pack");
	});
});
