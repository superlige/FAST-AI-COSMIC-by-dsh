import { describe, expect, it } from "vitest";
import { probePolicyPrompt } from "../../src/agent/prompt/probe-policy.ts";
import { scanAdHocProbe } from "../../src/kernel/policy/probe-scan.ts";
import { WRITE_APIS } from "../../src/kernel/policy/write-apis.ts";

describe("S4 probe policy prompt", () => {
	it("临时探针只留一句红线，逐条的原因和替代探针在拒绝信息里", () => {
		// S44 批 4.2：禁用清单不再常驻。提示里说清哪几类会被拒；每一项具体为什么、该换哪个
		// 已发布探针，由编译前的扫描在拒绝时给出——这里验那条路上真的带着替代探针。
		const text = probePolicyPrompt({ released: ["EnvDiagProbe"] });
		expect(text).toContain("临时探针没人审过，只准读");
		for (const api of WRITE_APIS) expect(text).not.toContain(api.why);
		const hits = scanAdHocProbe("new MetadataWriter(t).save(em, fm);");
		expect(hits.map((hit) => hit.why).join("")).toContain("FormLayoutWriteProbe");
	});

	it("lists the released probes the model is supposed to reach for instead", () => {
		const text = probePolicyPrompt({ released: ["AddFieldProbe", "EnvDiagProbe"] });
		expect(text).toContain("AddFieldProbe EnvDiagProbe");
		expect(text).toContain("共 2 个");
	});
});
