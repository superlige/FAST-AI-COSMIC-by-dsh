import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { queryImpact, queryReport } from "../../src/kernel/commands/impact.ts";
import { eventExamples } from "../../src/kernel/impact/event-examples.ts";
import type { ImpactIndex, IndexedClass } from "../../src/kernel/impact/model.ts";
import { nearbyExamples } from "../../src/kernel/nearby-examples.ts";
import { makeContext } from "./fake-context.ts";

const cls = (name: string, entity = "bill", enabled = true): IndexedClass => ({
	class: `demo.${name}`,
	file: `src/${name}.java`,
	pluginType: "form",
	bindings: [{ entity, kind: "form", layouts: 1, enabled, numbers: [entity] }],
	entities: [],
	fields: [],
	chain: [],
});
function setup() {
	const { ctx, fs } = makeContext();
	const classes = [
		cls("Target"),
		cls("A"),
		cls("B"),
		cls("C"),
		cls("D"),
		cls("Other", "other"),
		cls("Disabled", "bill", false),
	];
	const index: ImpactIndex = {
		kind: "ImpactIndex",
		at: "2026-09-22",
		runtimeKeyId: ctx.runtimeKeyId,
		src: {
			at: "2026-09-22",
			ms: 0,
			files: 7,
			calls: { total: 0, unbound: 0 },
			classes: 7,
			entityRefs: 0,
			fieldRefs: 0,
			entityResolution: { constant: 0, dynamic: 0, literal: 0, none: 0, origin: 0 },
			fieldResolution: { constant: 0, dynamic: 0, literal: 0, none: 0, origin: 0 },
			edges: 0,
			chain: { classes: 0, keys: 0 },
			unknownSigs: [],
		},
		meta: { at: "2026-09-22", ms: 0, scanned: 2, bindings: 7, foreign: 0, templates: 0, fields: 0, fieldsMs: 0 },
		classes,
		templates: [],
		fields: [],
		fieldOwners: {},
		entityRefs: [],
		fieldRefs: [],
	};
	for (const row of classes)
		fs.put(
			resolve(ctx.projectRoot, row.file as string),
			`class ${row.class.split(".").at(-1)} {\n  @Override\n  public void click(Event e) { }\n  class Inner { public void click(Event e) {} }\n}`,
		);
	return { ctx, fs, index };
}

describe("nearby examples", () => {
	it("caps at three after excluding target and duplicates, and distinguishes unknown from none", () => {
		const rows = ["target", "a", "a", "b", "c", "d"].map((reference) => ({
			reference,
			reason: "same",
			configuration: { value: "001" },
		}));
		expect(nearbyExamples("target", "bill", rows)).toMatchObject({
			status: "found",
			omitted: 1,
			items: [{ reference: "a" }, { reference: "b" }, { reference: "c" }],
		});
		expect(nearbyExamples("target", "bill", []).status).toBe("none");
		expect(nearbyExamples("target", "bill", [], "缺数据").status).toBe("partial");
	});
	it("only uses other enabled registrations on the same bill and current outer-class method positions", () => {
		const { ctx, fs, index } = setup();
		const before = eventExamples(ctx, index, [{ kind: "class", value: "demo.Target" }], "click");
		expect(before.items.map((item) => item.reference)).toEqual(["src/A.java:2", "src/B.java:2", "src/C.java:2"]);
		expect(before.omitted).toBe(1);
		const path = resolve(ctx.projectRoot, "src/A.java");
		fs.put(path, `\n\n${fs.read(path)}`);
		const after = eventExamples(ctx, index, [{ kind: "class", value: "demo.Target" }], "click");
		expect(after.items[0]?.reference).toBe("src/A.java:4");
		expect(after.items[0]?.configuration.sourceSha256).not.toBe(before.items[0]?.configuration.sourceSha256);
	});
	it("reports missing source, unknown registration and invalid event without fabricating no examples", () => {
		const { ctx, fs, index } = setup();
		fs.put(resolve(ctx.projectRoot, "src/A.java"), "class A {");
		expect(eventExamples(ctx, index, [{ kind: "entity", value: "bill" }], "click").status).toBe("partial");
		expect(eventExamples(ctx, { ...index, meta: null }, [{ kind: "entity", value: "bill" }], "click").status).toBe(
			"partial",
		);
		expect(eventExamples(ctx, index, [{ kind: "entity", value: "bill" }], "x.*").status).toBe("partial");
	});
	it("query return carries samples only when an event is requested", () => {
		const { ctx, fs, index } = setup();
		fs.put(ctx.layout.impactIndex, JSON.stringify(index));
		const plain = queryImpact(ctx, { terms: ["demo.Target"] });
		const example = queryImpact(ctx, { terms: ["demo.Target"], event: "click" });
		expect(plain.ok && plain.value.text).not.toContain("nearby-examples");
		expect(example.ok && example.value.text).not.toContain("nearby-examples");
		expect(plain.ok && queryReport(plain.value).eventLocations).toBeUndefined();
		expect(example.ok && queryReport(example.value).eventLocations?.items[0]?.reference).toBe("src/A.java:2");
		expect(example.ok && queryReport(example.value).eventLocations?.note).toContain("仅供导航");
		expect(example.ok && queryReport(example.value)).not.toHaveProperty("examples");
	});
});
