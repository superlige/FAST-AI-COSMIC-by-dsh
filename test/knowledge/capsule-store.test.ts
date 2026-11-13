import { describe, expect, it } from "vitest";
import { createKnowledgeCapsule } from "../../src/knowledge/capsule.ts";
import { CAPSULE_DELIVERY_SCHEMA, capsuleDeliveryStore } from "../../src/knowledge/capsule-store.ts";
import { makeContext } from "../kernel/fake-context.ts";

function capsule(runtimeKeyId = "runtime-1") {
	return createKnowledgeCapsule({
		subject: "AbstractBillPlugIn ← OrderPlugin.java",
		kind: "plugin",
		runtimeKeyId,
		must: ["按真实事件契约实现"],
		avoid: ["不要猜参数"],
		signatures: ["void afterBindData(EventObject e)"],
		verificationRoute: ["FormPluginProbe"],
		sourceRefs: ["knowledge:platform/form-plugin.md"],
		confidence: "exact",
	});
}

function storeFor(runtimeKeyId = "runtime-1") {
	const fake = makeContext({ runtimeKeyId });
	return {
		fake,
		store: capsuleDeliveryStore({
			fs: fake.ctx.ports.fs,
			file: fake.ctx.layout.knowledgeCapsules,
			runtimeKeyId,
			now: () => "2026-09-10T01:00:00.000Z",
		}),
	};
}

describe("S15.2 Capsule delivery store", () => {
	it("records schema 2 audit facts without persisting the Capsule body", () => {
		const { fake, store } = storeFor();
		const source = capsule();
		const [entry] = store.record([source]);

		expect(entry?.digest).toBe(source.digest);
		expect(entry?.sourceRefs).toEqual(source.sourceRefs);
		expect(store.read()[source.digest]?.deliveredAt).toBe("2026-09-10T01:00:00.000Z");
		const raw = fake.fs.read(fake.ctx.layout.knowledgeCapsules);
		expect(JSON.parse(raw).schema).toBe(CAPSULE_DELIVERY_SCHEMA);
		expect(raw).not.toContain("按真实事件契约实现");
		expect(raw).not.toContain("afterBindData");
	});

	it("fails open as an empty accelerator for corrupt or foreign RuntimeKey files", () => {
		const { fake, store } = storeFor("runtime-1");
		fake.fs.write(fake.ctx.layout.knowledgeCapsules, "{broken");
		expect(store.read()).toEqual({});
		fake.fs.write(
			fake.ctx.layout.knowledgeCapsules,
			JSON.stringify({ schema: CAPSULE_DELIVERY_SCHEMA, runtimeKeyId: "runtime-2", entries: {} }),
		);
		expect(store.read()).toEqual({});
	});
});
