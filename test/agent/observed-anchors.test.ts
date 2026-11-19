import { describe, expect, it } from "vitest";
import { observedAnchors } from "../../src/agent/tools/observed-anchors.ts";

describe("requirement observations", () => {
	it("keeps only explicit impact targets, not the expanded graph", () => {
		const anchors = observedAnchors("cosmic_impact", {
			action: "query",
			targets: [
				{ kind: "class", value: "demo.SelectedPlugin" },
				{ kind: "field", value: "instrumentusename", entity: "zlgd_test" },
			],
			impact: {
				classes: Array.from({ length: 652 }, (_, index) => ({ class: `demo.Expanded${index}` })),
			},
		});
		expect(anchors).toEqual([
			{ kind: "plugin", id: "demo.SelectedPlugin", relation: "mentions", source: "static" },
			{ kind: "field", id: "zlgd_test.instrumentusename", relation: "mentions", source: "metadata" },
		]);
	});

	it("records a layout entry point as a layout of its entity", () => {
		const anchors = observedAnchors("cosmic_impact", {
			action: "query",
			targets: [{ kind: "layout", value: "zlgd_wtd_xnl", entity: "zlgd_qty_wtd" }],
		});
		expect(anchors).toEqual([
			{ kind: "layout", id: "zlgd_wtd_xnl", owner: "zlgd_qty_wtd", relation: "mentions", source: "metadata" },
		]);
	});

	it("caps broad probe observations", () => {
		const anchors = observedAnchors("cosmic_probe", {
			records: Array.from({ length: 100 }, (_, index) => ({ class: `demo.Plugin${index}` })),
		});
		expect(anchors).toHaveLength(48);
	});
});
