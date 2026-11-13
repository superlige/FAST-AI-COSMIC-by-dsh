/**
 * 苍穹设计态元数据（t_meta_entitydesign / t_meta_formdesign 的 FDATA，XML 全文）的读、合并、摘要。
 *
 * 苍穹一张单的元数据不是一行，是一条链叠出来的：祖先模板（bos_billtpl → … → sm_salorder）一层层继承，
 * 每一层还可能有别的 ISV 做的扩展（fmasterid 指向被扩展的那一行）。后面的行只写差量：
 *   - 带 Id 子元素、或 oid 属性的元素是「有身份的」，按身份对上前面同一个元素；
 *   - action="edit" 改它、action="remove" 删它，没有 action 的是新加的；
 *   - 没有身份的简单属性（<MustInput>true</MustInput>）后写的覆盖先写的，action="setnull" 置空、"reset" 恢复默认。
 * 字段的列名、所属分录、插件类名都在合并结果里。这里只读不写，合并结果只用来回答「生产上现在是什么样」，
 * 不回写任何地方。
 *
 * 没有身份的列表（<RefProps><RefProp>）按标签合并会把几项叠成一项——只影响这类细节属性，
 * 字段、分录、操作、插件都有身份，不受影响。
 */

export interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	text: string;
	children: XmlNode[];
	/** 合并时记下这个元素是哪一行带进来的（行的编号），摘要里报「谁加的」 */
	from?: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, name: string) => {
		if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
		if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
		return ENTITIES[name] ?? whole;
	});
}

/** 够用的 XML 解析：元素、属性、文本、CDATA、注释、声明。不认 DTD。格式坏了抛错 */
export function parseXml(text: string): XmlNode {
	const root: XmlNode = { tag: "#document", attrs: {}, text: "", children: [] };
	const stack: XmlNode[] = [root];
	let i = 0;
	const n = text.length;
	while (i < n) {
		const lt = text.indexOf("<", i);
		const top = stack[stack.length - 1] as XmlNode;
		if (lt < 0) {
			top.text += decodeEntities(text.slice(i));
			break;
		}
		if (lt > i) top.text += decodeEntities(text.slice(i, lt));
		if (text.startsWith("<!--", lt)) {
			const end = text.indexOf("-->", lt);
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (text.startsWith("<![CDATA[", lt)) {
			const end = text.indexOf("]]>", lt);
			top.text += text.slice(lt + 9, end < 0 ? n : end);
			i = end < 0 ? n : end + 3;
			continue;
		}
		if (text.startsWith("<?", lt) || text.startsWith("<!", lt)) {
			const end = text.indexOf(">", lt);
			i = end < 0 ? n : end + 1;
			continue;
		}
		const gt = text.indexOf(">", lt);
		if (gt < 0) throw new Error("XML 标签没有闭合");
		const raw = text.slice(lt + 1, gt);
		i = gt + 1;
		if (raw.startsWith("/")) {
			const tag = raw.slice(1).trim();
			const open = stack.pop();
			if (open === undefined || open.tag !== tag) throw new Error(`XML 标签对不上：</${tag}>`);
			continue;
		}
		const selfClosing = raw.endsWith("/");
		const body = selfClosing ? raw.slice(0, -1) : raw;
		const nameMatch = /^([^\s/>]+)/.exec(body);
		if (nameMatch === null) throw new Error("XML 标签没有名字");
		const node: XmlNode = { tag: nameMatch[1] as string, attrs: {}, text: "", children: [] };
		for (const attr of body.slice(nameMatch[0].length).matchAll(/([^\s=]+)\s*=\s*"([^"]*)"/g))
			node.attrs[attr[1] as string] = decodeEntities(attr[2] as string);
		top.children.push(node);
		if (!selfClosing) stack.push(node);
	}
	if (stack.length !== 1) throw new Error(`XML 没有收尾：<${(stack[stack.length - 1] as XmlNode).tag}> 没闭合`);
	return root;
}

export function child(node: XmlNode, tag: string): XmlNode | undefined {
	return node.children.find((c) => c.tag === tag);
}

export function childText(node: XmlNode, tag: string): string {
	return child(node, tag)?.text.trim() ?? "";
}

/**
 * 元素的身份：oid 属性 > PkId > Id 子元素 > 插件的类名。
 * PkId 在 Id 前面：根模板 bos_billtpl 的单据头写的是 <PkId>00305e8b000007ac</PkId>，
 * 它的 <Id> 却是整份文档的 id；下游每一层都按 oid="00305e8b000007ac" 改单据头（真机 2026-11-11）。
 */
export function identity(node: XmlNode): string | null {
	if (node.attrs.oid) return node.attrs.oid;
	const pk = childText(node, "PkId");
	if (pk !== "") return pk;
	const id = childText(node, "Id");
	if (id !== "") return id;
	if (node.tag === "Plugin") {
		const cls = childText(node, "ClassName");
		if (cls !== "") return cls;
	}
	return null;
}

function clone(node: XmlNode, from: string): XmlNode {
	const { action: _action, ...attrs } = node.attrs;
	return {
		tag: node.tag,
		attrs,
		text: node.text,
		children: node.children.map((c) => clone(c, from)),
		from: node.from ?? from,
	};
}

function hasElementChildren(node: XmlNode): boolean {
	return node.children.length > 0;
}

/** 把一行差量叠到合并结果上（原地改 base） */
export function mergeInto(base: XmlNode, delta: XmlNode, from: string): void {
	for (const d of delta.children) {
		const action = d.attrs.action ?? "";
		const id = identity(d);
		if (id !== null) {
			const at = base.children.findIndex((b) => identity(b) === id);
			if (action === "remove") {
				if (at >= 0) base.children.splice(at, 1);
				continue;
			}
			if (at >= 0) {
				const target = base.children[at] as XmlNode;
				mergeInto(target, d, from);
				if (d.text.trim() !== "") target.text = d.text;
				continue;
			}
			base.children.push(clone(d, from));
			continue;
		}
		const at = base.children.findIndex((b) => b.tag === d.tag && identity(b) === null);
		if (action === "remove" || action === "reset") {
			if (at >= 0) base.children.splice(at, 1);
			continue;
		}
		if (action === "setnull") {
			if (at >= 0) base.children[at] = { tag: d.tag, attrs: {}, text: "", children: [], from };
			else base.children.push({ tag: d.tag, attrs: {}, text: "", children: [], from });
			continue;
		}
		if (at < 0) {
			base.children.push(clone(d, from));
			continue;
		}
		const target = base.children[at] as XmlNode;
		if (hasElementChildren(d)) {
			mergeInto(target, d, from);
		} else {
			base.children[at] = clone(d, from);
		}
	}
}

/** 文档的根元素（EntityMetadata / FormMetadata） */
export function documentElement(doc: XmlNode): XmlNode {
	const first = doc.children[0];
	if (first === undefined) throw new Error("XML 里没有根元素");
	return first;
}

export interface MetaRow {
	kind: "entity" | "form";
	fid: string;
	fnumber: string;
	fisv: string;
	fparentid: string;
	fmasterid: string;
	finheritpath: string;
	fmodifydate: string;
	fdata: string;
}

/**
 * 合并顺序：继承链从根到本单，每一层后面紧跟作用在它上面的扩展。
 * 返回顺序本身也是要报给人看的事实（「合并了哪几行」）。
 */
export function mergeOrder(rows: readonly MetaRow[], selfId: string, kind: MetaRow["kind"]): MetaRow[] {
	// 同一张单的实体行和布局行 fid 相同：必须连 kind 一起认，否则合布局时拿到的是实体链
	const self = rows.find((r) => r.fid === selfId && r.kind === kind);
	if (self === undefined) return [];
	const chain = [
		...self.finheritpath
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id !== "" && id !== selfId),
		selfId,
	];
	const order: MetaRow[] = [];
	const seen = new Set<string>();
	const add = (row: MetaRow | undefined): void => {
		if (row === undefined || seen.has(row.fid)) return;
		seen.add(row.fid);
		order.push(row);
	};
	// 本单自己是扩展时（给的是 xxx_ext），它出现在被扩展那一层的扩展里，不再在链尾重复
	for (const id of chain) {
		add(rows.find((r) => r.fid === id && r.kind === self.kind));
		for (const ext of rows.filter((r) => r.kind === self.kind && r.fmasterid === id && r.fid !== id)) add(ext);
	}
	return order;
}

export function mergeRows(order: readonly MetaRow[]): XmlNode | null {
	let merged: XmlNode | null = null;
	for (const row of order) {
		if (row.fdata.trim() === "") continue;
		const element = documentElement(parseXml(row.fdata));
		if (merged === null) merged = clone(element, row.fnumber);
		else mergeInto(merged, element, row.fnumber);
	}
	return merged;
}

export interface MetaEntityPart {
	id: string;
	key: string;
	name: string;
	tag: string;
	table: string;
	parentId: string;
}

export interface MetaField {
	id: string;
	key: string;
	name: string;
	tag: string;
	column: string;
	entityKey: string;
	table: string;
	mustInput: boolean;
	from: string;
}

export interface MetaPlugin {
	/** 表单插件挂在表单上；操作插件、校验器挂在某个操作上 */
	where: string;
	className: string;
	enabled: boolean;
	description: string;
	from: string;
}

export interface EntitySummary {
	entities: MetaEntityPart[];
	fields: MetaField[];
	opPlugins: MetaPlugin[];
	operations: { id: string; key: string; name: string; type: string; validations: number; from: string }[];
}

function items(root: XmlNode): XmlNode[] {
	return child(root, "Items")?.children ?? [];
}

function pluginsUnder(node: XmlNode, where: string): MetaPlugin[] {
	const found: MetaPlugin[] = [];
	const visit = (n: XmlNode): void => {
		if (n.tag === "Plugin") {
			const className = childText(n, "ClassName") || n.attrs.oid || "";
			if (className !== "")
				found.push({
					where,
					className,
					enabled: childText(n, "Enabled") !== "false",
					description: childText(n, "Description"),
					from: n.from ?? "",
				});
			return;
		}
		for (const c of n.children) visit(c);
	};
	visit(node);
	return found;
}

export function summarizeEntity(root: XmlNode): EntitySummary {
	const all = items(root);
	const entities: MetaEntityPart[] = all
		.filter((n) => /Entity$/.test(n.tag))
		.map((n) => ({
			id: identity(n) ?? "",
			key: childText(n, "Key"),
			name: childText(n, "Name"),
			tag: n.tag,
			table: childText(n, "TableName"),
			parentId: childText(n, "ParentId"),
		}));
	const head = entities[0];
	const byId = new Map(entities.map((e) => [e.id, e]));
	const fields: MetaField[] = all
		.filter((n) => childText(n, "FieldName") !== "")
		.map((n) => {
			const owner = byId.get(childText(n, "ParentId")) ?? head;
			const multiLang = /MuliLang|MultiLang/i.test(n.tag);
			const table = owner?.table ?? "";
			return {
				id: identity(n) ?? "",
				key: childText(n, "Key"),
				name: childText(n, "Name"),
				tag: n.tag,
				column: childText(n, "FieldName"),
				entityKey: owner === head ? "" : (owner?.key ?? ""),
				table: table === "" ? "" : multiLang ? `${table}_l` : table,
				mustInput: childText(n, "MustInput") === "true",
				from: n.from ?? "",
			};
		});
	const operations: EntitySummary["operations"] = [];
	const opPlugins: MetaPlugin[] = [];
	const ops = (head === undefined ? undefined : all.find((n) => identity(n) === head.id)) ?? all[0];
	for (const op of child(ops ?? root, "Operations")?.children ?? []) {
		const key = childText(op, "Key") || identity(op) || "";
		operations.push({
			id: identity(op) ?? "",
			key,
			name: childText(op, "Name"),
			type: childText(op, "OperationType"),
			validations: child(op, "Validations")?.children.length ?? 0,
			from: op.from ?? "",
		});
		opPlugins.push(...pluginsUnder(op, `操作 ${key}`));
	}
	return { entities, fields, opPlugins, operations };
}

/** 表单插件：布局根上的 Plugins（BillFormAp / FormAp / ListFormAp…） */
export function summarizeForm(root: XmlNode): MetaPlugin[] {
	const found: MetaPlugin[] = [];
	for (const n of items(root)) {
		const plugins = child(n, "Plugins");
		if (plugins !== undefined) found.push(...pluginsUnder(plugins, "表单"));
	}
	return found;
}
