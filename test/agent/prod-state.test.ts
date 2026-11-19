import { describe, expect, it } from "vitest";
import {
	initialProdState,
	modeRefusal,
	prodModeBlocksFileWrite,
	toolsForMode,
	withEvidence,
} from "../../src/agent/state/prod-state.ts";
import { COSMIC_TOOL_NAMES } from "../../src/agent/tools/names.ts";
import { metaWritePlan } from "../../src/kernel/meta/parse.ts";

const isMetaWrite = (argv: readonly string[]): boolean => metaWritePlan(argv) !== null;

describe("生产排障模式：工具面", () => {
	it("开发模式不挂 cosmic_prod，其余照旧", () => {
		const dev = toolsForMode("dev", COSMIC_TOOL_NAMES);
		expect(dev).not.toContain("cosmic_prod");
		expect(dev).toHaveLength(COSMIC_TOOL_NAMES.length - 1);
	});

	it("排障模式挂 cosmic_prod，不挂编译、真跑", () => {
		const prod = toolsForMode("prod", COSMIC_TOOL_NAMES);
		expect(prod).toContain("cosmic_prod");
		for (const tool of ["cosmic_fast", "cosmic_run"]) expect(prod).not.toContain(tool);
		expect(prod).toContain("cosmic_impact");
		expect(prod).toContain("cosmic_knowledge");
	});
});

describe("生产排障模式：执行前门槛", () => {
	it("开发模式什么都不拦", () => {
		expect(modeRefusal("dev", "cosmic_fast", {}, isMetaWrite)).toBeNull();
		expect(modeRefusal("dev", "cosmic_probe", { name: "DataSeedProbe" }, isMetaWrite)).toBeNull();
	});

	it("排障模式拒改东西的：编译、真跑、部署、写元数据、探针落库、造数改数", () => {
		for (const tool of ["cosmic_fast", "cosmic_run"])
			expect(modeRefusal("prod", tool, {}, isMetaWrite)?.code, tool).toBe("PROD_MODE_READ_ONLY");
		expect(modeRefusal("prod", "cosmic_runtime", { action: "deploy" }, isMetaWrite)?.code).toBe(
			"PROD_MODE_READ_ONLY",
		);
		const write = ["ptpl", "apply", "demo_t", "--file", "build/a.meta.json"];
		expect(isMetaWrite(write)).toBe(true);
		expect(modeRefusal("prod", "cosmic_meta", { argv: write }, isMetaWrite)?.code).toBe("PROD_MODE_READ_ONLY");
		expect(
			modeRefusal("prod", "cosmic_probe", { name: "FormRuleProbe", env: { APPLY: "1" } }, isMetaWrite)?.code,
		).toBe("PROD_MODE_READ_ONLY");
		// 造数探针不带 APPLY 也默认落库
		expect(modeRefusal("prod", "cosmic_probe", { name: "DataSeedProbe", env: {} }, isMetaWrite)?.code).toBe(
			"PROD_MODE_READ_ONLY",
		);
		expect(modeRefusal("prod", "cosmic_probe", { name: "DataUpdateProbe" }, isMetaWrite)?.code).toBe(
			"PROD_MODE_READ_ONLY",
		);
	});

	it("排障模式放行只读的：生产查询、查知识、查影响面、看运行状态、只读探针、造数的回滚预演", () => {
		expect(modeRefusal("prod", "cosmic_prod", { action: "sql" }, isMetaWrite)).toBeNull();
		expect(modeRefusal("prod", "cosmic_knowledge", {}, isMetaWrite)).toBeNull();
		expect(modeRefusal("prod", "cosmic_impact", {}, isMetaWrite)).toBeNull();
		expect(modeRefusal("prod", "cosmic_runtime", { action: "probe-status" }, isMetaWrite)).toBeNull();
		expect(modeRefusal("prod", "cosmic_meta", { argv: ["ptpl", "dump", "demo_t"] }, isMetaWrite)).toBeNull();
		expect(
			modeRefusal("prod", "cosmic_probe", { name: "MetaProbe", env: { META_ENTITY: "x" } }, isMetaWrite),
		).toBeNull();
		expect(
			modeRefusal("prod", "cosmic_probe", { name: "DataSeedProbe", env: { PREVIEW: "1" } }, isMetaWrite),
		).toBeNull();
	});

	it("排障模式下工程里的文件只读，.cosmic-ai 和工程外不管；大小写、斜杠方向不影响", () => {
		const root = "D:\\kingdee\\proj";
		expect(prodModeBlocksFileWrite("D:/kingdee/proj/mod/src/main/java/A.java", root)).toBe(true);
		expect(prodModeBlocksFileWrite("d:\\KINGDEE\\proj\\build.gradle", root)).toBe(true);
		expect(prodModeBlocksFileWrite("D:/kingdee/proj", root)).toBe(true);
		expect(prodModeBlocksFileWrite("D:/kingdee/proj/.cosmic-ai/notes.md", root)).toBe(false);
		expect(prodModeBlocksFileWrite("D:/kingdee/proj2/A.java", root)).toBe(false);
		expect(prodModeBlocksFileWrite("C:/tmp/x.txt", root)).toBe(false);
		expect(prodModeBlocksFileWrite("D:/kingdee/proj/A.java", undefined)).toBe(false);
	});
});

describe("生产排障模式：证据编号", () => {
	it("接着最大的往下编", () => {
		const one = withEvidence(initialProdState(), { kind: "生产数据", summary: "a", at: "t" });
		expect(one.id).toBe("E1");
		const two = withEvidence(one.state, { kind: "生产日志", summary: "b", at: "t" });
		expect(two.id).toBe("E2");
		expect(two.state.evidence.map((e) => e.id)).toEqual(["E1", "E2"]);
	});
});
