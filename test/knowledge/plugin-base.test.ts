/**
 * S7.4 plugin-family recognition.
 *
 * The failure this file exists to prevent is silent: an unrecognised plugin and
 * a class that is not a plugin produce exactly the same output (nothing), so a
 * recognition gap reads as "no advice needed" rather than as a gap. Every case
 * below is one of the three shapes the measurement on a real ISV project turned
 * up -- direct parent, project base class in between, and an identifier that
 * merely appears in the text.
 */
import { describe, expect, it } from "vitest";
import { PLUGIN_ROUTES } from "../../src/knowledge/catalog.ts";
import { type JavaSourcePort, pluginBaseOf, pluginFamiliesIn, supertypesOf } from "../../src/knowledge/plugin-base.ts";

const SRC = "D:/proj/zlgd-hhx/src/main/java";

/** In-memory Java tree keyed by posix path. */
function tree(files: Record<string, string>): JavaSourcePort {
	const map = new Map(Object.entries(files).map(([path, text]) => [path.replace(/\\/g, "/"), text]));
	return {
		exists: (path) => map.has(path.replace(/\\/g, "/")),
		read: (path) => map.get(path.replace(/\\/g, "/")) ?? "",
	};
}

function javaClass(pkg: string, name: string, extendsName: string, imports: readonly string[] = []): string {
	return [
		`package ${pkg};`,
		"",
		...imports.map((fqcn) => `import ${fqcn};`),
		"",
		`public class ${name} extends ${extendsName} {`,
		"}",
		"",
	].join("\n");
}

describe("S7.4 supertypesOf", () => {
	it("reads both extends and implements, in declaration order", () => {
		const text = "public class A extends AbstractBillPlugIn implements Serializable, IWorkflowPlugin {}";
		expect(supertypesOf(text)).toEqual(["AbstractBillPlugIn", "Serializable", "IWorkflowPlugin"]);
	});

	it("keeps only the simple name of a qualified supertype", () => {
		expect(supertypesOf("class A extends kd.bos.form.plugin.AbstractFormPlugin {}")).toEqual(["AbstractFormPlugin"]);
	});
});

describe("S7.4 tier 1: the declared parent", () => {
	it("recognises a class that extends a platform base outright", () => {
		const hit = pluginBaseOf("public class A extends AbstractBillPlugIn {}");
		expect(hit?.route.base).toBe("AbstractBillPlugIn");
		expect(hit?.tier).toBe("direct");
		expect(hit?.via).toEqual([]);
	});

	it("recognises an interface family through implements", () => {
		// Four of the routed families are reached this way; matching only `extends`
		// would drop them all with no error.
		const hit = pluginBaseOf("public class A implements IWorkflowPlugin {}");
		expect(hit?.route.base).toBe("IWorkflowPlugin");
		expect(hit?.tier).toBe("direct");
	});

	it("says nothing about a class that is not a plugin", () => {
		expect(pluginBaseOf("public class Util { public static int add(int a, int b) { return a + b; } }")).toBeNull();
	});
});

describe("S7.4 tier 2: climbing the project's own base classes", () => {
	it("finds the platform base through a same-package project base", () => {
		const files = tree({
			[`${SRC}/com/zlgd/op/ExtOperationServicePlugin.java`]: javaClass(
				"com.zlgd.op",
				"ExtOperationServicePlugin",
				"AbstractOperationServicePlugIn",
			),
			[`${SRC}/com/zlgd/op/OrderSavePlugin.java`]: javaClass(
				"com.zlgd.op",
				"OrderSavePlugin",
				"ExtOperationServicePlugin",
			),
		});
		const file = `${SRC}/com/zlgd/op/OrderSavePlugin.java`;
		const hit = pluginBaseOf(files.read(file), { file, source: files });
		expect(hit?.route.base).toBe("AbstractOperationServicePlugIn");
		expect(hit?.tier).toBe("climbed");
		expect(hit?.via).toEqual(["ExtOperationServicePlugin"]);
	});

	it("locates a base class in another package through its import", () => {
		// The source root is derived from the file's own package declaration, so a
		// base class two packages away is still found.
		const files = tree({
			[`${SRC}/com/zlgd/common/BaseBillPlugin.java`]: javaClass(
				"com.zlgd.common",
				"BaseBillPlugin",
				"AbstractBillPlugIn",
			),
			[`${SRC}/com/zlgd/sale/OrderPlugin.java`]: javaClass("com.zlgd.sale", "OrderPlugin", "BaseBillPlugin", [
				"com.zlgd.common.BaseBillPlugin",
			]),
		});
		const file = `${SRC}/com/zlgd/sale/OrderPlugin.java`;
		const hit = pluginBaseOf(files.read(file), { file, source: files });
		expect(hit?.route.base).toBe("AbstractBillPlugIn");
		expect(hit?.via).toEqual(["BaseBillPlugin"]);
	});

	it("walks more than one project base and reports the whole chain", () => {
		const files = tree({
			[`${SRC}/com/zlgd/a/L1.java`]: javaClass("com.zlgd.a", "L1", "AbstractFormPlugin"),
			[`${SRC}/com/zlgd/a/L2.java`]: javaClass("com.zlgd.a", "L2", "L1"),
			[`${SRC}/com/zlgd/a/Leaf.java`]: javaClass("com.zlgd.a", "Leaf", "L2"),
		});
		const file = `${SRC}/com/zlgd/a/Leaf.java`;
		const hit = pluginBaseOf(files.read(file), { file, source: files });
		expect(hit?.route.base).toBe("AbstractFormPlugin");
		// The chain is reported because "my class does not extend that" is the first
		// thing a reader thinks when the hint names a base they never wrote.
		expect(hit?.via).toEqual(["L2", "L1"]);
	});

	it("terminates on a cycle instead of recursing forever", () => {
		const files = tree({
			[`${SRC}/com/zlgd/a/A.java`]: javaClass("com.zlgd.a", "A", "B"),
			[`${SRC}/com/zlgd/a/B.java`]: javaClass("com.zlgd.a", "B", "A"),
		});
		const file = `${SRC}/com/zlgd/a/A.java`;
		expect(pluginBaseOf(files.read(file), { file, source: files })).toBeNull();
	});

	/**
	 * The regression for the 43/315 measurement.
	 *
	 * On the project that was measured, 43 of 315 classes with an `extends` reach
	 * a platform base only through a project base class, and the single largest
	 * family (ExtOperationServicePlugin) is entirely inside that 43. The assertion
	 * that matters is the second one: without the climb every one of them is
	 * invisible, and invisible here means "lint said nothing", which is what a
	 * clean run also looks like.
	 */
	it("recognises a whole family that only reaches the platform through a project base", () => {
		const members = Array.from({ length: 43 }, (_, index) => `Ext${String(index)}Plugin`);
		const files = tree({
			[`${SRC}/com/zlgd/op/ExtOperationServicePlugin.java`]: javaClass(
				"com.zlgd.op",
				"ExtOperationServicePlugin",
				"AbstractOperationServicePlugIn",
			),
			...Object.fromEntries(
				members.map((name) => [
					`${SRC}/com/zlgd/op/${name}.java`,
					javaClass("com.zlgd.op", name, "ExtOperationServicePlugin"),
				]),
			),
		});
		const paths = members.map((name) => `${SRC}/com/zlgd/op/${name}.java`);

		for (const file of paths) {
			const hit = pluginBaseOf(files.read(file), { file, source: files });
			expect(hit?.route.base, `${file} 应当经工程基类认出来`).toBe("AbstractOperationServicePlugIn");
		}
		// Direct-parent-only recognition -- what the code did before the climb.
		for (const file of paths) {
			expect(pluginBaseOf(files.read(file)), `${file} 只认直接父类时必须是认不出来`).toBeNull();
		}
		// And they collapse to one family, not 43 copies of the same advice.
		expect(pluginFamiliesIn(paths, files)).toHaveLength(1);
	});
});

describe("S7.4 tier 3: the identifier scan, and why it runs last", () => {
	it("recognises a family from a bare fully-qualified name", () => {
		// This is the tier `cosmic_knowledge api` uses: the whole input is a name.
		const hit = pluginBaseOf("kd.bos.form.plugin.AbstractFormPlugin");
		expect(hit?.route.base).toBe("AbstractFormPlugin");
		expect(hit?.tier).toBe("loose");
	});

	it("does not let a mentioned name beat the class's real ancestry", () => {
		// The measured failure: a full-text scan named the wrong family for 3 of 315
		// classes. A wrong family points at the wrong guide as confidently as a right
		// one does, which is worse than saying nothing.
		const files = tree({
			[`${SRC}/com/zlgd/op/ExtOperationServicePlugin.java`]: javaClass(
				"com.zlgd.op",
				"ExtOperationServicePlugin",
				"AbstractOperationServicePlugIn",
			),
			[`${SRC}/com/zlgd/op/OrderSavePlugin.java`]: [
				"package com.zlgd.op;",
				"",
				"// 参考 AbstractFormPlugin 的写法，但这里是操作插件",
				"public class OrderSavePlugin extends ExtOperationServicePlugin {",
				"}",
				"",
			].join("\n"),
		});
		const file = `${SRC}/com/zlgd/op/OrderSavePlugin.java`;
		const hit = pluginBaseOf(files.read(file), { file, source: files });
		expect(hit?.route.base).toBe("AbstractOperationServicePlugIn");
		expect(hit?.tier).toBe("climbed");
	});
});

describe("S7.4 pluginFamiliesIn", () => {
	it("keys families by platform base class, not by pluginType", () => {
		// AbstractPrintPlugin and AbstractPrintSeniorPlugin are both `printplugin`
		// and have different event sets. Collapsing them would let reading one
		// family's guide clear the other, with no error at any point.
		const both = PLUGIN_ROUTES.filter((route) => route.pluginType === "printplugin").map((route) => route.base);
		expect(both.length).toBeGreaterThan(1);
		const files = tree(
			Object.fromEntries(
				both.map((base, index) => [`${SRC}/p/P${String(index)}.java`, javaClass("p", `P${String(index)}`, base)]),
			),
		);
		const families = pluginFamiliesIn(
			both.map((_, index) => `${SRC}/p/P${String(index)}.java`),
			files,
		);
		expect(families.map((family) => family.route.base).sort()).toEqual([...both].sort());
	});

	it("skips files it cannot read rather than failing the batch", () => {
		const files = tree({ [`${SRC}/p/A.java`]: javaClass("p", "A", "AbstractBillPlugIn") });
		const families = pluginFamiliesIn([`${SRC}/p/A.java`, `${SRC}/p/Gone.java`], files);
		expect(families.map((family) => family.route.base)).toEqual(["AbstractBillPlugIn"]);
	});
});
