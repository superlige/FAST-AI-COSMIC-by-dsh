/**
 * 写法检查要的工程事实（S51）：常量索引、哪些方法查库、插件挂在哪张单上。
 *
 * 常量索引从工程全部源码现算（五百多个文件约零点几秒）；查库的方法和插件挂载从代码关系表
 * （`.cosmic-ai/work/impact.json`）读——没有关系表就只缺跨文件那一档，别的照查。
 * 关系表在模型这次写的代码之前建的，新写的方法不在里面；它答的是「循环里调的那个老方法查不查库」，正好够用。
 */

import type { FsPort } from "../ports.ts";
import { buildConstIndex, type ConstClass, type ConstIndex, classNameOf, type StyleEnv } from "./plugin-style.ts";

export interface StyleProject {
	consts: ConstIndex;
	/** 查库的方法（一路往下），`全限定类名#方法名`。 */
	dbMethods: Set<string>;
	simpleToFqcn: Map<string, string[]>;
	/** 插件类全限定名 → 它挂的单据和插件类型。 */
	bindings: Map<string, { entity: string; pluginType: string | null }[]>;
	/** `单据|插件类型` → 挂在上面的插件类简单名。 */
	pluginsOn: Map<string, string[]>;
	/** 代码关系表里读写过的单据标识。 */
	entities: Set<string>;
	hasIndex: boolean;
}

interface ImpactShape {
	classes?: { class: string; pluginType?: string | null; bindings?: { entity: string }[] }[];
	entityRefs?: { entity?: string; inMethod?: string | null; via?: string | null }[];
	edges?: { from: string; to: string }[];
}

const methodKey = (id: string): string => id.replace(/\(.*$/, "");

/** `sources` 是工程各代码模块的源码目录。 */
export function loadStyleProject(fs: FsPort, sources: readonly string[], impactFile: string | null): StyleProject {
	const files: { file: string; text: string }[] = [];
	for (const dir of sources) for (const file of fs.listJavaFiles(dir)) files.push({ file, text: fs.read(file) });
	const consts = buildConstIndex(files);
	const project: StyleProject = {
		consts,
		dbMethods: new Set(),
		simpleToFqcn: new Map(),
		bindings: new Map(),
		pluginsOn: new Map(),
		entities: new Set(),
		hasIndex: false,
	};
	if (impactFile === null || !fs.exists(impactFile)) return project;
	let index: ImpactShape;
	try {
		index = JSON.parse(fs.read(impactFile)) as ImpactShape;
	} catch {
		return project;
	}
	project.hasIndex = true;
	for (const cls of index.classes ?? []) {
		const simple = cls.class.slice(cls.class.lastIndexOf(".") + 1);
		project.simpleToFqcn.set(simple, [...(project.simpleToFqcn.get(simple) ?? []), cls.class]);
		const bound = (cls.bindings ?? []).map((b) => ({ entity: b.entity, pluginType: cls.pluginType ?? null }));
		if (bound.length > 0) project.bindings.set(cls.class, bound);
		for (const b of bound) {
			const key = `${b.entity}|${b.pluginType ?? ""}`;
			const list = project.pluginsOn.get(key) ?? [];
			if (!list.includes(simple)) list.push(simple);
			project.pluginsOn.set(key, list);
		}
	}
	for (const ref of index.entityRefs ?? []) {
		if (ref.entity) project.entities.add(ref.entity);
		if (!ref.inMethod || !ref.via || /#newDynamicObject\(/.test(ref.via)) continue;
		project.dbMethods.add(methodKey(ref.inMethod));
	}
	const callers = new Map<string, string[]>();
	for (const edge of index.edges ?? []) {
		const to = methodKey(edge.to);
		callers.set(to, [...(callers.get(to) ?? []), methodKey(edge.from)]);
	}
	const queue = [...project.dbMethods];
	while (queue.length > 0) {
		const next = queue.pop() as string;
		for (const caller of callers.get(next) ?? []) {
			if (project.dbMethods.has(caller)) continue;
			project.dbMethods.add(caller);
			queue.push(caller);
		}
	}
	return project;
}

export function styleEnvFor(project: StyleProject, file: string): StyleEnv {
	return {
		consts: project.consts,
		selfClass: classNameOf(file),
		entities: project.entities,
		...(project.hasIndex
			? {
					externalTouchesDb: (cls: string, method: string) =>
						(project.simpleToFqcn.get(cls) ?? []).some((fqcn) => project.dbMethods.has(`${fqcn}#${method}`)),
				}
			: {}),
	};
}

/**
 * 这个类管的单据的常量类：先看它挂在哪张单上（关系表），再看源码里写到的单据标识。
 * 只认 `ENTITY` 那类常量的值恰好是这张单的常量类。
 */
export function billConstClasses(project: StyleProject, fqcn: string, text: string): ConstClass[] {
	const entities = new Set((project.bindings.get(fqcn) ?? []).map((b) => b.entity));
	const byEntity = new Map<string, ConstClass[]>();
	for (const cls of project.consts.classes.values()) {
		if (cls.entity === null) continue;
		byEntity.set(cls.entity, [...(byEntity.get(cls.entity) ?? []), cls]);
	}
	if (entities.size === 0) {
		for (const entity of byEntity.keys()) if (text.includes(`"${entity}"`)) entities.add(entity);
		for (const cls of project.consts.classes.values()) {
			if (cls.entity !== null && new RegExp(`(?<![\\w$])${cls.cls}\\.`).test(text)) entities.add(cls.entity);
		}
	}
	return [...entities].flatMap((entity) => byEntity.get(entity) ?? []);
}
