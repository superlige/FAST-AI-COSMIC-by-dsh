/**
 * S33 批 1：把分录当实体填，探针发起前按代码关系表在本地挡下。
 *
 * 用例里的标识都是真机 2026-09-21 那次会话里模型实际填错的。
 */

import { describe, expect, it } from "vitest";
import { prepareProbeInvocation } from "../../src/kernel/commands/probe.ts";
import { entryAsEntityBlockers, loadFieldRows } from "../../src/kernel/meta/entity-role.ts";
import type { FieldOwnershipRow } from "../../src/kernel/meta/ptpl-edit.ts";
import { makeContext } from "./fake-context.ts";

const ROWS: FieldOwnershipRow[] = [
	{
		entity: "zlgd_sys_test_bill",
		key: "zlgd_entryentity_jxsy",
		level: "entry",
		entry: "zlgd_entryentity_jxsy",
		parentEntry: "",
		kind: "container",
	},
	{
		entity: "zlgd_sys_test_bill",
		key: "zlgd_jyxm",
		level: "entry",
		entry: "zlgd_entryentity_jxsy",
		parentEntry: "",
		kind: "field",
	},
	{
		entity: "zlgd_sys_test_bill",
		key: "zlgd_subentryentity_jx",
		level: "subentry",
		entry: "zlgd_subentryentity_jx",
		parentEntry: "zlgd_entryentity_jxsy",
		kind: "container",
	},
	// 真机表里确有其事：一条分录和一张单同名
	{ entity: "zlgd_ldapsx", key: "zlgd_name", level: "header", entry: "", parentEntry: "", kind: "field" },
	{
		entity: "zlgd_other",
		key: "zlgd_ldapsx",
		level: "entry",
		entry: "zlgd_ldapsx",
		parentEntry: "",
		kind: "container",
	},
];

describe("分录当实体填", () => {
	it("挡下并给出照抄的写法", () => {
		const blockers = entryAsEntityBlockers(ROWS, { QUERY_ENTITY: "zlgd_entryentity_jxsy", QUERY_FIELDS: "id" });
		expect(blockers).toHaveLength(1);
		expect(blockers[0]?.code).toBe("PROBE_ENTITY_IS_ENTRY");
		expect(blockers[0]?.message).toContain("zlgd_sys_test_bill 上的分录");
		expect(blockers[0]?.remedy).toContain("QUERY_ENTITY 填 zlgd_sys_test_bill");
		expect(blockers[0]?.remedy).toContain("zlgd_entryentity_jxsy.字段");
	});

	it("子分录连着父分录写路径", () => {
		const [blocker] = entryAsEntityBlockers(ROWS, { META_ENTITY: "zlgd_subentryentity_jx" });
		expect(blocker?.message).toContain("分录 zlgd_entryentity_jxsy 下的子分录");
		expect(blocker?.remedy).toContain("zlgd_entryentity_jxsy.zlgd_subentryentity_jx.字段");
	});

	it("字段当实体填不挡：可能和基础资料同名，交给 Java 侧按平台元数据说", () => {
		expect(entryAsEntityBlockers(ROWS, { QUERY_ENTITY: "zlgd_jyxm" })).toEqual([]);
	});

	it("和某张单同名的分录不挡", () => {
		expect(entryAsEntityBlockers(ROWS, { QUERY_ENTITY: "zlgd_ldapsx" })).toEqual([]);
	});

	it("表里没记着的、不是填实体的入参，一律放行", () => {
		expect(entryAsEntityBlockers(ROWS, { QUERY_ENTITY: "zlgd_unknown" })).toEqual([]);
		expect(entryAsEntityBlockers(ROWS, { QUERY_FIELDS: "zlgd_entryentity_jxsy" })).toEqual([]);
	});
});

const QUERY_SRC = `
public class DataQueryProbe {
  public static void run() {
    String e = req("QUERY_ENTITY");
    String f = env("QUERY_FIELDS", "");
  }
}
`;

function withIndex(rows: readonly FieldOwnershipRow[] | null) {
	const fake = makeContext({ probes: ["DataQueryProbe"] });
	fake.fs.put(`${fake.ctx.layout.probesDir.replace(/\\/g, "/")}/DataQueryProbe.java`, QUERY_SRC);
	if (rows !== null) fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify({ kind: "ImpactIndex", fields: rows }));
	return fake;
}

describe("探针发起前的本地核对", () => {
	it("分录当实体填，不起 Java 就挡下", () => {
		const fake = withIndex(ROWS);
		const prepared = prepareProbeInvocation(fake.ctx, "DataQueryProbe", {
			env: { QUERY_ENTITY: "zlgd_entryentity_jxsy" },
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;
		expect(prepared.value.blockers.map((b) => b.code)).toContain("PROBE_ENTITY_IS_ENTRY");
		expect(prepared.value.estimatedCost.processes).toBe(0);
	});

	it("没有代码关系表时照常放行", () => {
		const fake = withIndex(null);
		const prepared = prepareProbeInvocation(fake.ctx, "DataQueryProbe", {
			env: { QUERY_ENTITY: "zlgd_entryentity_jxsy" },
		});
		expect(prepared.ok && prepared.value.blockers).toEqual([]);
	});

	it("表重建了就重读，没重建不重读", () => {
		const fake = withIndex(ROWS);
		expect(loadFieldRows(fake.ctx)).toHaveLength(ROWS.length);
		fake.fs.put(fake.ctx.layout.impactIndex, JSON.stringify({ kind: "ImpactIndex", fields: ROWS.slice(0, 1) }));
		expect(loadFieldRows(fake.ctx)).toHaveLength(1);
	});
});
