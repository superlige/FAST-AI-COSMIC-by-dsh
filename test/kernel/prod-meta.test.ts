import { describe, expect, it } from "vitest";
import { diffSides, renderDiff, renderSide, summarizeSide } from "../../src/kernel/prod/meta.ts";
import {
	childText,
	documentElement,
	identity,
	type MetaRow,
	mergeInto,
	mergeOrder,
	parseXml,
	summarizeEntity,
} from "../../src/kernel/prod/meta-xml.ts";

// 形状照真机生产库（2026-11-11）：根模板单据头用 PkId 认身份，下游各层用 oid 改它；
// 字段带 ParentId 指向分录；操作插件在单据头的 Operations 里；扩展行的 fmasterid 指向被扩展的那一层。
const BASE = `<?xml version="1.0" encoding="UTF-8"?>
<EntityMetadata>
  <Id>BASEDOC</Id>
  <Items>
    <BillEntity>
      <PkId>HEAD</PkId>
      <Id>BASEDOC</Id>
      <Key>demo_billtpl</Key>
      <Name>单据模板</Name>
      <Operations>
        <Operation>
          <Id>OPSAVE</Id>
          <Key>save</Key>
          <Plugins>
            <Plugin>
              <ClassName>kd.bos.CodeRuleOp</ClassName>
              <Enabled>true</Enabled>
            </Plugin>
          </Plugins>
        </Operation>
      </Operations>
    </BillEntity>
    <TextField>
      <Id>F1</Id>
      <Key>billno</Key>
      <Name>单据编号</Name>
      <FieldName>fbillno</FieldName>
    </TextField>
  </Items>
</EntityMetadata>`;

const BILL = `<EntityMetadata>
  <Id>BILL</Id>
  <InheritPath>BASEDOC</InheritPath>
  <Items>
    <BillEntity action="edit" oid="HEAD">
      <Key>demo_bill</Key>
      <TableName>t_demo_bill</TableName>
    </BillEntity>
    <EntryEntity>
      <Id>ENTRY</Id>
      <Key>demo_entry</Key>
      <Name>明细</Name>
      <TableName>t_demo_billentry</TableName>
    </EntryEntity>
    <QtyField>
      <Id>F2</Id>
      <Key>qty</Key>
      <Name>数量</Name>
      <FieldName>fqty</FieldName>
      <MustInput>true</MustInput>
      <ParentId>ENTRY</ParentId>
    </QtyField>
    <MuliLangTextField>
      <Id>F3</Id>
      <Key>remark</Key>
      <Name>备注</Name>
      <FieldName>fremark</FieldName>
    </MuliLangTextField>
  </Items>
</EntityMetadata>`;

const EXT = `<EntityMetadata>
  <Id>EXT</Id>
  <Items>
    <BillEntity action="edit" oid="HEAD">
      <Operations>
        <Operation action="edit" oid="OPSAVE">
          <Plugins>
            <Plugin>
              <ClassName>demo.plugin.SaveCheckOp</ClassName>
              <Enabled>true</Enabled>
              <Description>保存校验</Description>
            </Plugin>
            <Plugin action="edit" oid="kd.bos.CodeRuleOp">
              <Enabled>false</Enabled>
            </Plugin>
          </Plugins>
        </Operation>
      </Operations>
    </BillEntity>
    <TextField>
      <Id>F4</Id>
      <Key>demo_note</Key>
      <Name>说明</Name>
      <FieldName>fk_demo_note</FieldName>
    </TextField>
    <QtyField action="edit" oid="F2">
      <MustInput action="setnull"/>
    </QtyField>
    <MuliLangTextField action="remove" oid="F3"/>
  </Items>
</EntityMetadata>`;

const FORM = `<FormMetadata>
  <Id>BILL</Id>
  <InheritPath>BASEDOC</InheritPath>
  <Items>
    <BillFormAp action="edit" oid="FORMHEAD">
      <Plugins>
        <Plugin>
          <ClassName>demo.plugin.BillEditPlugin</ClassName>
          <Description>编辑界面</Description>
        </Plugin>
      </Plugins>
    </BillFormAp>
  </Items>
</FormMetadata>`;

const FORM_BASE = `<FormMetadata><Id>BASEDOC</Id><Items><BillFormAp><PkId>FORMHEAD</PkId><Plugins><Plugin><ClassName>kd.bos.TemplateBillEdit</ClassName></Plugin></Plugins></BillFormAp></Items></FormMetadata>`;

function row(
	kind: MetaRow["kind"],
	fid: string,
	fnumber: string,
	fdata: string,
	extra: Partial<MetaRow> = {},
): MetaRow {
	return {
		kind,
		fid,
		fnumber,
		fisv: "kingdee",
		fparentid: "",
		fmasterid: "",
		finheritpath: "",
		fmodifydate: "2026-01-01 00:00:00",
		fdata,
		...extra,
	};
}

// 实体行和布局行 fid 相同——真机就是这样，合并时必须连 kind 一起认
const ROWS: MetaRow[] = [
	row("entity", "BASEDOC", "demo_billtpl", BASE),
	row("entity", "BILL", "demo_bill", BILL, { finheritpath: "BASEDOC", fparentid: "BASEDOC" }),
	row("entity", "EXT", "demo_bill_ext", EXT, {
		fisv: "demo",
		fmasterid: "BILL",
		finheritpath: "BASEDOC,BILL",
		fmodifydate: "2026-11-07 13:21:01",
	}),
	row("form", "BASEDOC", "demo_billtpl", FORM_BASE),
	row("form", "BILL", "demo_bill", FORM, { finheritpath: "BASEDOC" }),
];

describe("XML 解析", () => {
	it("认元素、属性、文本、自闭合、转义", () => {
		const root = documentElement(parseXml('<?xml version="1.0"?><A x="1&amp;2"><B>a &lt; b</B><C/></A>'));
		expect(root.attrs.x).toBe("1&2");
		expect(childText(root, "B")).toBe("a < b");
		expect(root.children.map((c) => c.tag)).toEqual(["B", "C"]);
	});

	it("标签对不上就报错，不悄悄合出一棵错树", () => {
		expect(() => parseXml("<A><B></A>")).toThrow(/对不上/);
		expect(() => parseXml("<A><B>")).toThrow(/没闭合/);
	});

	it("身份：oid > PkId > Id > 插件类名", () => {
		const doc = documentElement(parseXml(BASE));
		const head = doc.children.find((c) => c.tag === "Items")?.children[0];
		expect(head && identity(head)).toBe("HEAD");
	});
});

describe("差量合并", () => {
	it("合并顺序：继承链从根到本单，每层后面跟它的扩展；实体、布局分开排", () => {
		expect(mergeOrder(ROWS, "BILL", "entity").map((r) => r.fnumber)).toEqual([
			"demo_billtpl",
			"demo_bill",
			"demo_bill_ext",
		]);
		expect(mergeOrder(ROWS, "BILL", "form").map((r) => `${r.fnumber}.${r.kind}`)).toEqual([
			"demo_billtpl.form",
			"demo_bill.form",
		]);
	});

	it("edit 改、remove 删、setnull 置空、新元素追加，并记下是哪一行带进来的", () => {
		const base = documentElement(parseXml(BASE));
		mergeInto(base, documentElement(parseXml(BILL)), "demo_bill");
		mergeInto(base, documentElement(parseXml(EXT)), "demo_bill_ext");
		const summary = summarizeEntity(base);
		expect(summary.entities.map((e) => [e.key, e.table])).toEqual([
			["demo_bill", "t_demo_bill"],
			["demo_entry", "t_demo_billentry"],
		]);
		const byKey = new Map(summary.fields.map((f) => [f.key, f]));
		expect(byKey.get("billno")?.table).toBe("t_demo_bill");
		expect(byKey.get("qty")).toMatchObject({ table: "t_demo_billentry", column: "fqty", entityKey: "demo_entry" });
		expect(byKey.get("qty")?.mustInput).toBe(false);
		expect(byKey.has("remark")).toBe(false);
		expect(byKey.get("demo_note")?.from).toBe("demo_bill_ext");
		const plugins = summary.opPlugins.map((p) => [p.where, p.className, p.enabled]);
		expect(plugins).toEqual([
			["操作 save", "kd.bos.CodeRuleOp", false],
			["操作 save", "demo.plugin.SaveCheckOp", true],
		]);
	});

	it("多语言字段报到 <表>_l", () => {
		const base = documentElement(parseXml(BASE));
		mergeInto(base, documentElement(parseXml(BILL)), "demo_bill");
		expect(summarizeEntity(base).fields.find((f) => f.key === "remark")?.table).toBe("t_demo_bill_l");
	});
});

describe("摘要和比对", () => {
	it("摘要：链、表、本工程字段、非原厂插件，原厂只计数，全量指向文件", () => {
		const side = summarizeSide(ROWS, "demo_bill");
		expect(side.broken).toEqual([]);
		const text = renderSide(side, "demo_bill", "demo", "/w/meta");
		expect(text).toContain("demo_billtpl → demo_bill → demo_bill_ext(demo)");
		expect(text).toContain("demo_bill（单据头）");
		expect(text).toContain("t_demo_bill.fk_demo_note");
		expect(text).toContain("demo.plugin.SaveCheckOp ← demo_bill_ext");
		expect(text).toContain("另有原厂 1 个");
		expect(text).toContain("summary.txt");
		expect(text).not.toContain("kd.bos.TemplateBillEdit");
		expect(renderSide(side, "demo_bill", "demo", "/w/meta", true)).toContain("kd.bos.TemplateBillEdit");
	});

	it("比对：多出的行、字段属性、插件、启停逐项报，0 项也报", () => {
		const prod = summarizeSide(ROWS, "demo_bill");
		const testRows = ROWS.filter((r) => r.fnumber !== "demo_bill_ext");
		const test = summarizeSide(testRows, "demo_bill");
		const diff = diffSides(ROWS, prod, testRows, test);
		expect(diff.onlyProdRows).toEqual(["demo_bill_ext.entity"]);
		expect(diff.fieldsOnlyProd).toEqual(["demo_note"]);
		expect(diff.fieldsOnlyTest).toEqual(["remark"]);
		expect(diff.fieldsChanged).toEqual(["demo_entry.qty：必录 生产否 / 测试是"]);
		expect(diff.pluginsOnlyProd).toEqual(["操作 save demo.plugin.SaveCheckOp"]);
		expect(diff.pluginsEnabledDiffer).toEqual(["操作 save kd.bos.CodeRuleOp：生产停用 / 测试启用"]);
		const text = renderDiff(diff);
		expect(text).toContain("只在测试有的元数据行：0");
		expect(text).toContain("两边都有但内容不同的行：0");
	});
});
