/**
 * S17 batch 4 -- the metadata snapshot says how old it is and catches up by itself.
 *
 * The property everything here protects: a snapshot patched from a change list
 * equals the snapshot a full rebuild would have produced. The field half is the
 * hard one, because a bill's owner count can only move if the patch knows whether
 * that bill carried the key before -- so it is checked against a full build of a
 * small library, before and after the same edits.
 */

import { describe, expect, it } from "vitest";
import { loadIndex, queryImpact, type RunProbe, refreshMeta } from "../../src/kernel/commands/impact.ts";
import { formatTrace, traceField } from "../../src/kernel/impact/field-trace.ts";
import {
	baselineOf,
	diffBaseline,
	fieldWhitelist,
	patchFields,
	patchRegistrations,
} from "../../src/kernel/impact/meta-refresh.ts";
import { markMetaPending, metaCheckDue } from "../../src/kernel/impact/meta-state.ts";
import {
	type FieldOwnership,
	lookup,
	type MetaBaseline,
	type MetaIndex,
	mergeIndex,
	type SrcIndex,
	snapshotLabel,
	snapshotStatus,
} from "../../src/kernel/impact/model.ts";
import { makeContext } from "./fake-context.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-04T00:00:00.000Z");

function srcIndex(overrides: Partial<SrcIndex> = {}): SrcIndex {
	return {
		kind: "SrcIndex",
		at: "2026-10-04T00:00:00.000Z",
		ms: 100,
		files: 1,
		cpEntries: 10,
		calls: { total: 1, unbound: 0 },
		diagnostics: null,
		classes: [{ class: "zlgd.demo.APlugin", file: "src/A.java", pluginType: "form" }],
		entityRefs: [{ class: "zlgd.demo.APlugin", entity: "zlgd_a", mode: "read", resolution: "literal" }] as never,
		fieldRefs: [{ class: "zlgd.demo.APlugin", field: "zlgd_x", mode: "write", resolution: "literal" }] as never,
		edges: [],
		unknownSigs: [],
		...overrides,
	};
}

/** A tiny library: bill -> its field keys (all on the header). */
type Library = Record<string, string[]>;

const row = (entity: string, key: string): FieldOwnership => ({
	entity,
	key,
	level: "header",
	entry: "",
	kind: "field",
	parentEntry: "",
});

/** What `EntityFieldIndexProbe` reports in full (`IDX_ALL_ON_ENTITIES=1`) for this library and whitelist. */
function fullFields(library: Library, whitelist: { fields: Set<string>; entities: Set<string> }) {
	const fields = Object.entries(library)
		.filter(([entity]) => whitelist.entities.has(entity))
		.flatMap(([entity, keys]) => keys.map((key) => row(entity, key)));
	const tracked = new Set([...whitelist.fields, ...fields.map((f) => f.key)]);
	// Owner lists for every key in the library; counts only for the keys the project asks about.
	const owners: Record<string, string[]> = {};
	for (const [entity, keys] of Object.entries(library)) {
		for (const key of keys) {
			const list = owners[key] ?? [];
			list.push(entity);
			owners[key] = list;
		}
	}
	for (const list of Object.values(owners)) list.sort();
	const fieldOwners = Object.fromEntries(
		Object.entries(owners)
			.filter(([k]) => tracked.has(k))
			.map(([k, v]) => [k, v.length]),
	);
	return { fields, owners, fieldOwners };
}

const sortRows = (rows: readonly FieldOwnership[]) =>
	rows.map((r) => `${r.entity}|${r.key}`).sort((a, b) => a.localeCompare(b));

function baseline(rows: Record<string, [string, string, string][]>): MetaBaseline {
	return { at: "2026-10-04T00:00:00.000Z", sites: Object.keys(rows), rows };
}

describe("diffBaseline: 比主键清单，删掉的行也看得到", () => {
	it("新增、改过、删掉都按登记编号交给补扫；没变的不碰", () => {
		const before = baseline({
			form: [
				["1", "zlgd_l1", "t1"],
				["2", "zlgd_l2", "t1"],
				["3", "zlgd_gone", "t1"],
			],
			entity: [["9", "zlgd_a", "t1"]],
		});
		const now = baseline({
			form: [
				["1", "zlgd_l1", "t1"],
				["2", "zlgd_l2", "t2"],
				["4", "zlgd_new", "t2"],
			],
			entity: [["9", "zlgd_a", "t1"]],
		});
		const changes = diffBaseline(before, now);
		expect(changes.rows).toBe(3);
		expect([...(changes.numbers.get("form") ?? [])].sort()).toEqual(["zlgd_gone", "zlgd_l2", "zlgd_new"]);
		expect(changes.numbers.has("entity")).toBe(false);
	});

	it("同一行换了编号：新旧两个编号都补扫，旧编号的登记才会被拿掉", () => {
		const changes = diffBaseline(
			baseline({ task: [["1", "old_task", "t1"]] }),
			baseline({ task: [["1", "new_task", "t1"]] }),
		);
		expect([...(changes.numbers.get("task") ?? [])].sort()).toEqual(["new_task", "old_task"]);
	});

	it("探针没报汇总行就不算一份清单", () => {
		expect(baselineOf([{ t: "stamp", site: "form", id: "1", number: "a", stamp: "t" }], "x")).toBeNull();
		const got = baselineOf(
			[
				{ t: "stamp", site: "form", id: "2", number: "b", stamp: "t" },
				{ t: "stamp", site: "form", id: "1", number: "a", stamp: "t" },
				{ t: "stamp-summary", rows: 2, sites: ["form", "entity"] },
			],
			"x",
		);
		expect(got?.rows.form).toEqual([
			["1", "a", "t"],
			["2", "b", "t"],
		]);
		expect(got?.sites).toEqual(["form", "entity"]);
	});
});

describe("patchRegistrations", () => {
	it("变了的编号整个换成补扫结果，补扫查不到的编号连登记一起拿掉，别的不动", () => {
		const meta = {
			bindings: [
				{ class: "zlgd.A", entity: "zlgd_a", kind: "form", enabled: true, layout: "zlgd_l1" },
				{ class: "zlgd.B", entity: "zlgd_a", kind: "form", enabled: true, layout: "zlgd_gone" },
				{ class: "zlgd.C", entity: "zlgd_b", kind: "form", enabled: true, layout: "zlgd_keep" },
				{ class: "zlgd.P", entity: "zlgd_a", kind: "print", enabled: true, layout: "58" },
			],
			templates: [{ number: "58", entity: "zlgd_a", classes: ["zlgd.P"] }],
			names: [
				{ site: "print", id: "58", name: "旧名" },
				{ site: "task", id: "T1", name: "任务" },
			],
		} as unknown as MetaIndex;
		const numbers = new Map([
			["form", new Set(["zlgd_l1", "zlgd_gone"])],
			["print", new Set(["58"])],
		]);
		const got = patchRegistrations(meta, numbers, {
			bindings: [
				{ class: "zlgd.A2", entity: "zlgd_a", kind: "form", enabled: true, layout: "zlgd_l1" },
				{ class: "zlgd.P", entity: "zlgd_a", kind: "print", enabled: true, layout: "58" },
			],
			templates: [{ number: "58", entity: "zlgd_a", classes: ["zlgd.P"] }],
			names: [{ site: "print", id: "58", name: "新名" }],
		});
		expect(got.bindings.map((b) => `${b.class}@${b.layout}`).sort()).toEqual([
			"zlgd.A2@zlgd_l1",
			"zlgd.C@zlgd_keep",
			"zlgd.P@58",
		]);
		expect(got.names).toEqual([
			{ site: "task", id: "T1", name: "任务" },
			{ site: "print", id: "58", name: "新名" },
		]);
		expect(got.templates).toHaveLength(1);
	});
});

describe("patchFields：补扫结果等于完整重建", () => {
	const before: Library = {
		zlgd_a: ["zlgd_x", "zlgd_y", "zlgd_org"],
		zlgd_b: ["zlgd_y", "zlgd_org"],
		zlgd_c: ["zlgd_org", "zlgd_z"],
		zlgd_d: ["zlgd_org"],
	};

	function check(after: Library, src: SrcIndex, changedEntities: string[], before0: SrcIndex = srcIndex()) {
		const wl0 = fieldWhitelist(before0, []);
		const full0 = fullFields(before, wl0);
		const meta = {
			kind: "MetaIndex",
			fields: full0.fields,
			fieldOwners: full0.fieldOwners,
			owners: full0.owners,
			fieldsAll: true,
			asked: { entities: [...wl0.entities].sort() },
		} as unknown as MetaIndex;
		const wl1 = fieldWhitelist(src, []);
		const rescanned = new Set([...changedEntities, ...[...wl1.entities].filter((e) => !wl0.entities.has(e))]);
		const rows = [...rescanned].flatMap((entity) => (after[entity] ?? []).map((key) => row(entity, key)));
		const patched = patchFields(meta, wl1, { rescanned, rows, billNames: [] });
		const full1 = fullFields(after, wl1);
		expect(sortRows(patched.fields)).toEqual(sortRows(full1.fields));
		expect(patched.owners).toEqual(full1.owners);
		expect(patched.fieldOwners).toEqual(full1.fieldOwners);
		return patched;
	}

	it("白名单上的单加了字段、删了字段", () => {
		const patched = check({ ...before, zlgd_a: ["zlgd_x", "zlgd_org", "zlgd_new"] }, srcIndex(), ["zlgd_a"]);
		expect(patched.fieldOwners.zlgd_new).toBe(1);
	});

	it("白名单外的单变了：只动全库计数，不收它的字段行", () => {
		check({ ...before, zlgd_c: ["zlgd_z"], zlgd_d: ["zlgd_org", "zlgd_x"] }, srcIndex(), ["zlgd_c", "zlgd_d"]);
	});

	it("单据删掉了：从每个标识的归属里拿掉", () => {
		const { zlgd_b: _gone, ...after } = before;
		check(after, srcIndex(), ["zlgd_b"]);
	});

	it("代码点过名、全库原来没有的标识，后来出现在变了的单上：照单加，带点的路径不算标识", () => {
		const src = srcIndex({
			fieldRefs: [
				{ class: "zlgd.demo.APlugin", field: "zlgd_x", mode: "write", resolution: "literal" },
				{ class: "zlgd.demo.APlugin", field: "zlgd_ghost", mode: "read", resolution: "literal" },
				{ class: "zlgd.demo.APlugin", field: "zlgd_entry.zlgd_x", mode: "read", resolution: "literal" },
			] as never,
		});
		const patched = check({ ...before, zlgd_d: ["zlgd_org", "zlgd_ghost"] }, src, ["zlgd_d"], src);
		expect(patched.owners?.zlgd_ghost).toEqual(["zlgd_d"]);
		expect(patched.fieldOwners["zlgd_entry.zlgd_x"]).toBeUndefined();
	});

	it("代码新用到一张单：它的字段收进来，计数照全库清单算，不用重数", () => {
		const src = srcIndex({
			entityRefs: [
				{ class: "zlgd.demo.APlugin", entity: "zlgd_a", mode: "read", resolution: "literal" },
				{ class: "zlgd.demo.APlugin", entity: "zlgd_c", mode: "read", resolution: "literal" },
			] as never,
		});
		const patched = check(before, src, []);
		expect(patched.fieldOwners.zlgd_z).toBe(1);
	});
});

// ---------------------------------------------------------------- orchestration

function outcome(records: unknown[]): never {
	return {
		probe: "P",
		src: "probes/P.java",
		path: "hot",
		coldReason: null,
		exitCode: 0,
		output: "",
		json: { records: records as never, broken: [], file: "x.json" },
		outputFile: "x.out",
		outputLines: { total: 1, shown: 1 },
		stale: { files: 0, lane: "platform", mode: "block", action: "none" },
		notes: [],
	} as never;
}

const stamps = (rows: [string, string, string, string][]) => [
	...rows.map(([site, id, number, stamp]) => ({ t: "stamp", site, id, number, stamp })),
	{ t: "stamp-summary", rows: rows.length, sites: ["form", "entity"] },
];

/** A project with a full snapshot (baseline, every field, owner lists) on disk. */
function snapshotted() {
	const fake = makeContext({ config: { codeModules: ["demo-biz"] } });
	fake.clock.advance(T0);
	const src = srcIndex();
	const meta: MetaIndex = {
		kind: "MetaIndex",
		at: "2026-10-04T00:00:00.000Z",
		ms: 1,
		scanned: 2,
		bindings: [{ class: "zlgd.demo.APlugin", entity: "zlgd_a", kind: "form", enabled: true, layout: "zlgd_l1" }],
		templates: [],
		names: [],
		fields: [row("zlgd_a", "zlgd_x")],
		fieldOwners: { zlgd_x: 1 },
		owners: { zlgd_x: ["zlgd_a"] },
		fieldsAll: true,
		fieldsMs: 1,
		sites: ["form", "entity", "print", "task", "api", "convert", "workflow"],
		asked: { entities: ["zlgd_a"] },
		baseline: baseline({ form: [["1", "zlgd_l1", "t1"]], entity: [["9", "zlgd_a", "t1"]] }),
	};
	const work = fake.ctx.layout.impactWork;
	fake.fs.put(`${work}/src-index.json`, JSON.stringify(src));
	fake.fs.put(`${work}/meta-index.json`, JSON.stringify(meta));
	fake.fs.put(
		fake.ctx.layout.impactIndex,
		JSON.stringify(mergeIndex(src, meta, "2026-10-04T00:00:00.000Z", fake.ctx.runtimeKeyId)),
	);
	return fake;
}

type Call = {
	name: string;
	env: Record<string, string>;
	coldFallback?: boolean;
	startResident?: boolean;
	countRepeats?: boolean;
};

function prober(reply: (name: string, env: Record<string, string>) => unknown[]) {
	const calls: Call[] = [];
	const runProbe = (async (
		_ctx: unknown,
		name: string,
		options: {
			env?: Record<string, string>;
			coldFallback?: boolean;
			startResident?: boolean;
			countRepeats?: boolean;
		} = {},
	) => {
		const env = options.env ?? {};
		calls.push({
			name,
			env,
			coldFallback: options.coldFallback,
			startResident: options.startResident,
			countRepeats: options.countRepeats,
		});
		return { ok: true, value: outcome(reply(name, env)) };
	}) as unknown as RunProbe;
	return { calls, runProbe };
}

describe("refreshMeta：只搭常驻 JVM，只补变了的", () => {
	it("没变化：只查一次变化清单，记下「查过没变化」，快照日期跟着往前走", async () => {
		const fake = snapshotted();
		const { calls, runProbe } = prober(() =>
			stamps([
				["form", "1", "zlgd_l1", "t1"],
				["entity", "9", "zlgd_a", "t1"],
			]),
		);
		fake.clock.advance(2 * DAY);
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(got.state).toBe("same");
		expect(calls.map((c) => c.name)).toEqual(["MetaChangeProbe"]);
		// Never the reason a JVM starts, never a cold process; asking the same question every time is the point, not a repeat.
		expect(calls[0]).toMatchObject({ coldFallback: false, startResident: false, countRepeats: false });
		const index = loadIndex(fake.ctx);
		expect(index.ok && index.value.meta?.check?.state).toBe("same");
		if (index.ok) {
			expect(snapshotStatus(index.value, fake.ctx.ports.clock.now())).toBe("元数据快照 10-04 建，10-06 查过没变化");
			expect(snapshotLabel(index.value, fake.ctx.ports.clock.now())).toBe("快照 10-06");
		}
	});

	it("改了一个布局：只重扫那一个布局，结果并进快照和代码关系表，表的建立时间不变", async () => {
		const fake = snapshotted();
		const { calls, runProbe } = prober((name, env) => {
			if (name === "MetaChangeProbe") {
				return stamps([
					["form", "1", "zlgd_l1", "t2"],
					["entity", "9", "zlgd_a", "t1"],
				]);
			}
			if (name === "PluginIndexProbe") {
				expect(fake.fs.read(env.IDX_ONLY_FILE as string)).toBe("form\tzlgd_l1");
				return [
					{ t: "binding", class: "zlgd.demo.BPlugin", entity: "zlgd_a", layout: "zlgd_l1", kind: "form" },
					{ t: "binding-summary", partial: true, scanned: 1 },
				];
			}
			throw new Error(`没有变化的单据不该重扫字段：${name}`);
		});
		markMetaPending(fake.ctx, "FormLayoutWriteProbe", ["zlgd_l1"]);
		fake.clock.advance(DAY);
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(got.state).toBe("patched");
		expect(got.text).toBe("补了 表单设计态 1");
		expect(calls.map((c) => c.name)).toEqual(["MetaChangeProbe", "PluginIndexProbe"]);
		expect(
			calls.every((c) => c.coldFallback === false && c.startResident === false && c.countRepeats === false),
		).toBe(true);
		const index = loadIndex(fake.ctx);
		expect(index.ok).toBe(true);
		if (!index.ok) return;
		expect(index.value.at).toBe("2026-10-04T00:00:00.000Z");
		expect(index.value.classes.find((c) => c.class === "zlgd.demo.APlugin")?.bindings).toEqual([]);
		// The write recorded before the check is covered by it.
		expect(index.value.meta?.pending).toBeUndefined();
		expect(snapshotStatus(index.value, fake.ctx.ports.clock.now())).toBe(
			"元数据快照 10-04 建，10-05 查到 1 处变化已补",
		);
		const meta = JSON.parse(fake.fs.read(`${fake.ctx.layout.impactWork}/meta-index.json`)) as MetaIndex;
		expect(meta.baseline?.rows.form).toEqual([["1", "zlgd_l1", "t2"]]);
		expect(meta.at).toBe("2026-10-04T00:00:00.000Z");
	});

	it("探针跳过拼不进查询的行：补扫照样算跑完，跳过那行留着快照里的旧登记，结果里报出来", async () => {
		const fake = snapshotted();
		const { calls, runProbe } = prober((name) => {
			if (name === "MetaChangeProbe") {
				return stamps([
					["form", "1", "zlgd_l1", "t2"],
					["entity", "9", "zlgd_a", "t1"],
				]);
			}
			if (name === "PluginIndexProbe") {
				return [{ t: "binding-summary", partial: true, scanned: 0, skipped: ["form zlgd_l1"] }];
			}
			throw new Error(`没有变化的单据不该重扫字段：${name}`);
		});
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(calls.map((c) => c.name)).toEqual(["MetaChangeProbe", "PluginIndexProbe"]);
		expect(got.state).toBe("patched");
		expect(got.text).toBe("补了 表单设计态 1；1 行编号拼不进查询没补（form zlgd_l1），完整重建能收进来");
		const meta = JSON.parse(fake.fs.read(`${fake.ctx.layout.impactWork}/meta-index.json`)) as MetaIndex;
		// Scanned rows would replace the snapshot's; a skipped one was never asked, so it keeps what it had.
		expect(meta.bindings.map((b) => b.class)).toEqual(["zlgd.demo.APlugin"]);
		expect(meta.baseline?.rows.form).toEqual([["1", "zlgd_l1", "t2"]]);
	});

	it("变化超过上限：一处都不补、基线不动，下次还查得到", async () => {
		const fake = snapshotted();
		const rows: [string, string, string, string][] = [];
		for (let i = 0; i < 101; i++) rows.push(["form", `n${i}`, `zlgd_n${i}`, "t"]);
		const { calls, runProbe } = prober(() => stamps(rows));
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(got.state).toBe("over");
		expect(calls.map((c) => c.name)).toEqual(["MetaChangeProbe"]);
		const meta = JSON.parse(fake.fs.read(`${fake.ctx.layout.impactWork}/meta-index.json`)) as MetaIndex;
		expect(meta.baseline?.rows.form).toEqual([["1", "zlgd_l1", "t1"]]);
		const index = loadIndex(fake.ctx);
		if (index.ok) {
			const now = fake.ctx.ports.clock.now();
			expect(snapshotLabel(index.value, now)).toBe("快照 10-04，之后有 103 处变化没补");
			expect(snapshotStatus(index.value, now)).toContain("查到 103 处变化，一次补不完没补，空闲时完整重建");
		}
	});

	it("快照没记基线：不跑探针，照实说要完整重建一次", async () => {
		const fake = snapshotted();
		const work = fake.ctx.layout.impactWork;
		const meta = JSON.parse(fake.fs.read(`${work}/meta-index.json`)) as MetaIndex;
		delete meta.baseline;
		fake.fs.put(`${work}/meta-index.json`, JSON.stringify(meta));
		const { calls, runProbe } = prober(() => []);
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(got.state).toBe("baseline");
		expect(calls).toEqual([]);
		const index = loadIndex(fake.ctx);
		if (index.ok) {
			expect(snapshotStatus(index.value, fake.ctx.ports.clock.now())).toContain("没记变化基线、查不了变没变");
		}
	});

	it("变化清单没拿到（常驻 JVM 不在、忙）：记成没查成，不当成没变化", async () => {
		const fake = snapshotted();
		const runProbe = (async () => ({
			ok: false,
			error: { code: "PROBE_RESIDENT_ONLY", message: "常驻不可用" },
		})) as unknown as RunProbe;
		const got = await refreshMeta(fake.ctx, runProbe);
		expect(got.state).toBe("failed");
		const index = loadIndex(fake.ctx);
		if (index.ok) expect(snapshotStatus(index.value, fake.ctx.ports.clock.now())).toContain("查变化没成");
	});
});

describe("本机写了元数据：当场记待补，每处读快照的都说", () => {
	it("快照日期后面跟一句还没补进来；完整重建之后这句消失", async () => {
		const fake = snapshotted();
		fake.clock.advance(DAY);
		markMetaPending(fake.ctx, "FormLayoutWriteProbe", ["zlgd_a"]);
		const index = loadIndex(fake.ctx);
		expect(index.ok).toBe(true);
		if (!index.ok) return;
		const now = fake.ctx.ports.clock.now();
		expect(snapshotLabel(index.value, now)).toBe("快照 10-04，1 天前，之后本机写过元数据，还没补进来");
		expect(snapshotStatus(index.value, now)).toContain("本机 10-05 写过元数据，还没补进来");
	});

	it("查类时第一行就是快照状态", () => {
		const fake = snapshotted();
		fake.clock.advance(DAY);
		markMetaPending(fake.ctx, "FormLayoutWriteProbe", ["zlgd_a"]);
		const got = queryImpact(fake.ctx, { terms: ["zlgd.demo.APlugin"] });
		expect(got.ok).toBe(true);
		if (!got.ok) return;
		expect(got.value.text.split("\n")[0]).toBe(
			"[IMPACT] 元数据快照 10-04 建，还没查过之后有没有变化（常驻 JVM 在跑时自动查），本机 10-05 写过元数据，还没补进来（截至 1 天前）",
		);
	});
});

describe("字段收全之后能说「不在这张单上」", () => {
	it("快照收全了这张单的字段，没有就是没有；没收全时只说没记到", () => {
		const src = srcIndex({
			fieldRefs: [{ class: "zlgd.demo.APlugin", field: "zlgd_y", mode: "read", resolution: "literal" }] as never,
		});
		const meta = {
			kind: "MetaIndex",
			at: "2026-10-04T00:00:00.000Z",
			ms: 1,
			scanned: 1,
			bindings: [{ class: "zlgd.demo.APlugin", entity: "zlgd_a", kind: "form", enabled: true }],
			templates: [],
			fields: [row("zlgd_a", "zlgd_x"), row("zlgd_b", "zlgd_y")],
			fieldOwners: { zlgd_x: 1, zlgd_y: 3 },
			fieldsMs: 1,
		} as MetaIndex;
		const known = { fieldsAll: true, fieldBases: { zlgd_a: { outside: "bos_billtpl" } }, fieldIsv: "zlgd" };
		const say = (extra: Partial<MetaIndex>, value = "zlgd_y") => {
			const index = mergeIndex(src, { ...meta, ...extra }, "2026-10-04T00:00:00.000Z");
			const lk = lookup(index);
			const trace = traceField(index, lk, { kind: "field", value, entity: "zlgd_a" });
			return formatTrace(trace, lk).join("\n");
		};
		// 原厂模板上不可能有本 ISV 前缀的字段：自己的设计里没有就是没有
		expect(say(known)).toContain("zlgd_y 不在 zlgd_a 上（快照 10-04）；全库 3 张单有它");
		expect(say({})).toContain("快照没记到 zlgd_a 上有 zlgd_y");
		// 收全了但不知道继承了什么（继承信息之前建的快照）：只说没记到
		expect(say({ fieldsAll: true })).toContain("快照没记到 zlgd_a 上有 zlgd_y");
		// 不带本 ISV 前缀的字段可能是从原厂模板继承来的（billno、billstatus）
		const inherited = say(known, "billno");
		expect(inherited).not.toContain("billno 不在 zlgd_a 上");
		expect(inherited).toContain("zlgd_a 继承自 bos_billtpl，继承来的字段快照里不收");
		// 没有父设计的单：自己的设计就是全部
		expect(say({ ...known, fieldBases: { zlgd_a: {} } }, "billno")).toContain("billno 不在 zlgd_a 上");
	});

	it("补扫后继承信息跟着换：重扫的单用新的，没扫的照旧，扫回来没有的就不留旧的", () => {
		const meta = {
			kind: "MetaIndex",
			at: "2026-10-04T00:00:00.000Z",
			ms: 1,
			scanned: 1,
			bindings: [],
			templates: [],
			fields: [row("zlgd_a", "zlgd_x"), row("zlgd_b", "zlgd_y")],
			fieldOwners: {},
			fieldsMs: 1,
			fieldBases: { zlgd_a: { outside: "bos_billtpl" }, zlgd_b: { outside: "bos_billtpl" } },
			fieldIsv: "zlgd",
		} as MetaIndex;
		const whitelist = { fields: new Set(["zlgd_x", "zlgd_y"]), entities: new Set(["zlgd_a", "zlgd_b", "zlgd_c"]) };
		const patched = patchFields(meta, whitelist, {
			rescanned: new Set(["zlgd_a", "zlgd_c"]),
			rows: [row("zlgd_c", "zlgd_x")],
			billNames: [],
			bases: { zlgd_c: { parents: ["zlgd_tpl"], outside: "bos_basetpl" } },
			isv: "zlgd",
		});
		expect(patched.fieldBases).toEqual({
			zlgd_b: { outside: "bos_billtpl" },
			zlgd_c: { parents: ["zlgd_tpl"], outside: "bos_basetpl" },
		});
		expect(patched.fieldIsv).toBe("zlgd");
	});

	it("代码没读写过、但快照收全了的字段也认得出；没有读写处时说的是现在真不记的几种写法", () => {
		const meta = {
			kind: "MetaIndex",
			at: "2026-10-04T00:00:00.000Z",
			ms: 1,
			scanned: 1,
			bindings: [{ class: "zlgd.demo.APlugin", entity: "zlgd_a", kind: "form", enabled: true }],
			templates: [],
			fields: [row("zlgd_a", "zlgd_x"), row("zlgd_a", "zlgd_quiet")],
			fieldOwners: { zlgd_x: 1, zlgd_quiet: 1 },
			fieldsMs: 1,
			fieldsAll: true,
		} as MetaIndex;
		const index = mergeIndex(srcIndex(), meta, "2026-10-04T00:00:00.000Z");
		const lk = lookup(index);
		const trace = traceField(index, lk, { kind: "field", value: "zlgd_quiet", entity: "zlgd_a" });
		const text = formatTrace(trace, lk).join("\n");
		expect(text).toContain("表里没记到这张单上的读写处");
		expect(text).toContain("放进 Map、界面控件、按名字比较的用法表里不记");
		expect(text).not.toContain("查询条件");
	});
});

describe("一次会话查几次", () => {
	it("头一回查；查过就不再查；之后本机写了元数据再查一次", () => {
		const checked = "2026-10-04T01:00:00.000Z";
		expect(metaCheckDue(undefined, null)).toBe(true);
		expect(metaCheckDue(checked, null)).toBe(false);
		const write = (at: string) => ({ at, writes: [{ at, probe: "FormLayoutWriteProbe", targets: [] }] });
		expect(metaCheckDue(checked, write("2026-10-04T00:30:00.000Z"))).toBe(false);
		expect(metaCheckDue(checked, write("2026-10-04T02:00:00.000Z"))).toBe(true);
	});
});
