/**
 * D8's anchor validation, as a join (S7.2).
 *
 * The rule from IMPLEMENTATION.md: "以反射方法集为准去 join 文档，文档有而 JAR 没有 =
 * 该 API 在用户版本里已消失（悬空锚点），JAR 有而文档没有 = 该方法无注释。两侧都要报出来,
 * 让快照过期时自己喊，而不是等用户踩坑。"
 *
 * The embedded knowledge is a snapshot; the user's Cosmic moves on. Without this,
 * drift is silent -- the model reads a method's Chinese description out of a
 * document and hands the developer an API their JAR does not have, which is exactly
 * the hallucination the whole knowledge base exists to prevent. So neither side is
 * allowed to win quietly:
 *
 *   - doc-only  => 悬空. The snapshot documents something this JAR does not have.
 *   - jar-only  => 无注释. The JAR has a method nothing describes, so `sig` can only
 *                  print its erased signature -- no Chinese, no real parameter names.
 *   - joined    => the useful case: reflection's truth plus the document's prose.
 *
 * Reflection is the truth for EXISTENCE; the document is the truth for MEANING.
 * That asymmetry is the whole design: a method the JAR does not have cannot be made
 * real by a document, and a parameter name reflection reports as `arg0` cannot be
 * made meaningful by reflection.
 *
 * One caveat that must stay visible: both sides here are a class's OWN declared
 * public and protected methods (`ApiTool sig` uses `getDeclaredMethods`). A
 * document that also lists inherited methods would show them as 悬空 when they
 * are merely declared further up. `joinApi` therefore accepts the inherited
 * methods `sig` lists after the declared ones and classifies those separately
 * rather than reporting a false dangling anchor.
 *
 * protected counts as existing: a validator or a task plugin is written by
 * subclassing, and the base class's hooks for subclasses are mostly protected
 * (`AbstractValidator.addErrorMessage`). Listing only public ones told the model
 * those hooks did not exist, and it went for a public look-alike instead.
 */
import { type ApiDoc, type ApiMethod, eraseType, isUninformativeDoc, methodKey, splitParams } from "./api-doc.ts";

/** One method as the user's JAR actually has it. Types are erased simple names. */
export interface ReflectedMethod {
	name: string;
	paramTypes: readonly string[];
	returnType: string;
	isStatic: boolean;
	/** Callable from a subclass only. Absent means public. */
	isProtected?: boolean;
	/**
	 * The same parameters with their type arguments (`List<List<Object>>`), when they differ
	 * from the erased ones. Shown to the caller; never part of the join key.
	 */
	genericParamTypes?: readonly string[];
	genericReturnType?: string;
}

export interface ReflectedClass {
	fqcn: string;
	/** The jar the class was loaded from, as `sig` reports it. */
	jar: string;
	superclass: string | null;
	interfaces: readonly string[];
	methods: readonly ReflectedMethod[];
	/**
	 * Public fields declared here, one line each as `ApiTool` prints them:
	 * `[static ]Type name[ = value]`, the value only for a static final when the
	 * class initialised. Not part of the join -- the documents describe methods --
	 * but the answer to "what is QCP.is_notnull" (S72).
	 */
	fields?: readonly string[];
	/** Public and protected constructors declared here, written `[protected ]SimpleName(Type, Type)`. */
	constructors?: readonly string[];
	/**
	 * Public and protected methods declared on a superclass or interface and not
	 * overridden here, each with the class that declares it. Not shown at class
	 * level; it is what answers `#name` when this class does not declare it.
	 */
	inheritedMethods?: readonly InheritedMethod[];
	/** Inherited fields, as `[protected ][static ]Type name` with the declaring class. */
	inheritedFields?: readonly { line: string; declaringClass: string }[];
	/** False when static initialisation failed, so constant values are unavailable. */
	initialized: boolean;
}

/** The field's name in a `[static ]Type name[ = value]` line. */
export function reflectedFieldName(line: string): string {
	const head = line.split(" = ")[0] ?? line;
	return head.trim().split(/\s+/).pop() ?? "";
}

export interface InheritedMethod extends ReflectedMethod {
	/** Full name of the superclass or interface that declares it. */
	declaringClass: string;
}

export interface JoinedMethod {
	key: string;
	reflected: ReflectedMethod;
	documented: ApiMethod;
	/** True when the document's prose says nothing beyond the method's own name. */
	uninformative: boolean;
}

export interface ApiJoin {
	fqcn: string;
	/** Reflection's truth carrying the document's meaning. The point of the exercise. */
	joined: readonly JoinedMethod[];
	/** 悬空: documented, but this JAR does not declare it. */
	dangling: readonly ApiMethod[];
	/** Documented here, declared by a superclass. Not dangling -- just not this class's. */
	inherited: readonly ApiMethod[];
	/** 无注释: the JAR has it, nothing describes it. */
	undocumented: readonly ReflectedMethod[];
	/** joined / (joined + undocumented): how much of this JAR's surface is described. */
	coverage: number;
	/** Of the joined methods, how many carry prose worth reading. */
	informative: number;
}

function reflectedKey(method: ReflectedMethod): string {
	return methodKey(method.name, method.paramTypes);
}

function documentedKey(method: ApiMethod): string {
	return methodKey(method.name, method.paramTypes);
}

/**
 * Joins one class's documentation against one class's reflected method set.
 *
 * Pure, and deliberately so: the JAR side arrives as data (see `parseSigOutput`), so
 * every branch here is testable without a Cosmic installation. The half that needs a
 * real JAR is the half that only reads it.
 */
export function joinApi(
	doc: ApiDoc,
	reflected: ReflectedClass,
	inheritedMethods: readonly ReflectedMethod[] = [],
): ApiJoin {
	const byKey = new Map<string, ReflectedMethod>();
	for (const method of reflected.methods) byKey.set(reflectedKey(method), method);
	const inheritedKeys = new Set(inheritedMethods.map(reflectedKey));

	const joined: JoinedMethod[] = [];
	const dangling: ApiMethod[] = [];
	const inherited: ApiMethod[] = [];
	const matched = new Set<string>();
	for (const documented of doc.methods) {
		const key = documentedKey(documented);
		const hit = byKey.get(key);
		if (hit === undefined) {
			if (inheritedKeys.has(key)) inherited.push(documented);
			else dangling.push(documented);
			continue;
		}
		matched.add(key);
		joined.push({ key, reflected: hit, documented, uninformative: isUninformativeDoc(documented) });
	}
	const undocumented = reflected.methods.filter((method) => !matched.has(reflectedKey(method)));
	const surface = joined.length + undocumented.length;
	return {
		fqcn: doc.fqcn,
		joined,
		dangling,
		inherited,
		undocumented,
		coverage: surface === 0 ? 1 : joined.length / surface,
		informative: joined.filter((entry) => !entry.uninformative).length,
	};
}

/**
 * Renders one joined method the way `sig` should print it.
 *
 * This is what D13 found missing: the frozen `sig` printed a reflected signature and,
 * separately, one `when_to_use` sentence for the whole class. What a developer needs
 * is this method's own description, its REAL parameter names, and what it returns --
 * all of which exist, and none of which anything had ever read.
 */
export function renderJoinedMethod(entry: JoinedMethod): string[] {
	const { reflected, documented } = entry;
	const params = documented.params
		.map((param, index) => `${withTypeArguments(param.type, reflected.genericParamTypes?.[index])} ${param.name}`)
		.join(", ");
	const returns = withTypeArguments(documented.returnType, reflected.genericReturnType);
	const lines = [`${modifiers(reflected)}${returns} ${documented.name}(${params})`];
	if (!entry.uninformative) {
		for (const line of documented.doc.split("\n")) lines.push(`  ${line.trim()}`);
	}
	for (const param of documented.params) {
		if (param.doc !== "") lines.push(`  @param ${param.name} ${param.doc}`);
	}
	if (documented.returns !== "") lines.push(`  @return ${documented.returns}`);
	return lines;
}

/**
 * The document's type, or the JAR's when the document wrote it bare and the JAR has the
 * type arguments for the same type (`List` → `List<List<Object>>`). A document that already
 * spells type arguments is left alone.
 */
function withTypeArguments(documented: string, generic: string | undefined): string {
	if (generic === undefined || documented.includes("<") || !generic.includes("<")) return documented;
	return eraseType(generic) === eraseType(documented) ? generic : documented;
}

/** One reflected method as a signature line, with the type arguments when the JAR has them. */
export function renderReflectedMethod(method: ReflectedMethod): string {
	const params = method.genericParamTypes ?? method.paramTypes;
	return `${modifiers(method)}${method.genericReturnType ?? method.returnType} ${method.name}(${params.join(", ")})`;
}

function modifiers(method: ReflectedMethod): string {
	return `${method.isProtected === true ? "protected " : ""}${method.isStatic ? "static " : ""}`;
}

const SECTION = /^---\s*(.+?)\s*\((\d+)\)\s*---$/;
/** `ApiTool` prints `[protected ][static ]name(Type, Type) -> Ret` -- no return type before the name. */
const METHOD_LINE = /^(protected\s+)?(static\s+)?([A-Za-z_$][\w$]*)\((.*)\)\s*->\s*(\S+)$/;
/** The line under it when type arguments are there: `泛型 [static ]name(List<List<Object>>, T) -> Map<String,T>`. */
const GENERIC_LINE = /^泛型\s+(?:protected\s+)?(?:static\s+)?[A-Za-z_$][\w$]*\((.*)\)\s*->\s*(.+)$/;
/** An inherited member ends with `  <- <declaring class>`. */
const DECLARED_BY = /^(.*\S)\s+<-\s+([\w$.]+)$/;

function parseMethodLine(line: string): ReflectedMethod | null {
	const match = METHOD_LINE.exec(line);
	if (match === null) return null;
	const [, protectedFlag, staticFlag, name, inside, returnType] = match;
	return {
		name: name as string,
		paramTypes: (inside ?? "").trim() === "" ? [] : (inside as string).split(",").map((item) => item.trim()),
		returnType: returnType as string,
		isStatic: staticFlag !== undefined,
		...(protectedFlag !== undefined ? { isProtected: true } : {}),
	};
}

/**
 * Parses `ApiTool sig <fqn>` stdout into a `ReflectedClass`.
 *
 * `ApiTool` is a frozen resource (`resources/tools/ApiTool.java`) and is not changed
 * for this: its `sig` output is already the exact data the join needs -- declared
 * public members, erased simple type names, static flags. Adding a JSON mode would
 * mean editing a frozen artefact and re-exporting it to buy formatting that this
 * function does for free.
 *
 * Returns null for the "找不到类" case, which is itself a signal: a documented class
 * the JAR does not have at all is the class-level version of a dangling anchor.
 */
export function parseSigOutput(text: string): ReflectedClass | null {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const header = lines.find((line) => /^(?:abstract class|class|interface|enum)\s+\S+$/.test(line.trim()));
	if (header === undefined) return null;
	const fqcn = header.trim().split(/\s+/).pop() as string;
	let jar = "";
	let superclass: string | null = null;
	let interfaces: string[] = [];
	let initialized = true;
	const methods: ReflectedMethod[] = [];
	const fields: string[] = [];
	const constructors: string[] = [];
	const inheritedMethods: InheritedMethod[] = [];
	const inheritedFields: { line: string; declaringClass: string }[] = [];
	const simpleClassName = fqcn.slice(fqcn.lastIndexOf(".") + 1);
	let section: string | null = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (line === "") continue;
		const sectionMatch = SECTION.exec(line);
		if (sectionMatch !== null) {
			section = sectionMatch[1] ?? null;
			continue;
		}
		if (line.startsWith("来自 jar")) {
			jar = line.slice(line.indexOf(":") + 1).trim();
			continue;
		}
		if (line.startsWith("父类")) {
			superclass = line.slice(line.indexOf(":") + 1).trim() || null;
			continue;
		}
		if (line.startsWith("实现")) {
			interfaces = line
				.slice(line.indexOf(":") + 1)
				.split(",")
				.map((item) => item.trim())
				.filter((item) => item !== "");
			continue;
		}
		if (line.startsWith("(静态初始化失败")) {
			initialized = false;
			continue;
		}
		if (section === "字段/常量") {
			fields.push(line);
			continue;
		}
		if (section === "构造") {
			constructors.push(line.replace(/^(protected\s+)?<init>/, `$1${simpleClassName}`));
			continue;
		}
		if (section === "继承的方法" || section === "继承的字段") {
			const declared = DECLARED_BY.exec(line);
			if (declared === null) continue;
			const [, member, declaringClass] = declared as unknown as [string, string, string];
			if (section === "继承的字段") {
				inheritedFields.push({ line: member, declaringClass });
				continue;
			}
			const method = parseMethodLine(member);
			if (method !== null) inheritedMethods.push({ ...method, declaringClass });
			continue;
		}
		if (section !== "方法") continue;
		const generic = GENERIC_LINE.exec(line);
		if (generic !== null) {
			const last = methods.pop();
			if (last !== undefined) {
				const inside = (generic[1] ?? "").trim();
				methods.push({
					...last,
					genericParamTypes: inside === "" ? [] : splitParams(inside),
					genericReturnType: (generic[2] ?? "").trim(),
				});
			}
			continue;
		}
		const method = parseMethodLine(line);
		if (method !== null) methods.push(method);
	}
	return {
		fqcn,
		jar,
		superclass,
		interfaces,
		methods,
		fields,
		constructors,
		inheritedMethods,
		inheritedFields,
		initialized,
	};
}

// ------------------------------------------------------- 批量锚点校验（D8 的正题）

/**
 * The batch sweep, without touching `ApiTool`.
 *
 * D8 wants a whole-snapshot check when the RuntimeKey changes, and the obvious
 * shape -- `sig` per class -- means 1,520 JVM starts. But `ApiTool suggest` already
 * answers a whole query FILE in one JVM, and for a `method` query whose name exists
 * it returns every same-name overload with its full signature. That is exactly the
 * data the sweep needs, so the sweep is a query file, not a new tool mode.
 *
 * It also answers the inherited-vs-dangling question properly: each candidate line
 * carries the DECLARING class, so "documented here, declared on the parent" stops
 * looking like a vanished API.
 */
export interface AnchorQuery {
	id: string;
	owner: string;
	name: string;
	arity: number;
}

/** One query per (class, distinct method name): suggest returns all overloads at once. */
export function buildAnchorQueries(docs: readonly ApiDoc[]): AnchorQuery[] {
	const out: AnchorQuery[] = [];
	docs.forEach((doc, index) => {
		const seen = new Set<string>();
		for (const method of doc.methods) {
			if (seen.has(method.name)) continue;
			seen.add(method.name);
			out.push({ id: `a${index}:${method.name}`, owner: doc.fqcn, name: method.name, arity: -1 });
		}
	});
	return out;
}

/** Renders queries in ApiTool's tab-separated `id kind owner name arity` format. */
export function renderAnchorQueries(queries: readonly AnchorQuery[]): string {
	return queries
		.map((query) =>
			["method", query.owner, query.name, String(query.arity)].reduce((line, part) => `${line}\t${part}`, query.id),
		)
		.join("\n");
}

/** One candidate line from `suggest`: `[static ]Owner.name(Types) -> Ret [hint]`. */
const CANDIDATE_LINE = /^(static\s+)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\((.*?)\)\s*->\s*(\S+)/;

export interface Candidate extends ReflectedMethod {
	/** Simple name of the class that DECLARES it, which is how inheritance is seen. */
	declaringClass: string;
}

export function parseCandidateLine(line: string): Candidate | null {
	const match = CANDIDATE_LINE.exec(line.trim());
	if (match === null) return null;
	const [, staticFlag, declaringClass, name, inside, returnType] = match;
	return {
		declaringClass: declaringClass as string,
		name: name as string,
		paramTypes: (inside ?? "").trim() === "" ? [] : (inside as string).split(",").map((item) => item.trim()),
		returnType: returnType as string,
		isStatic: staticFlag !== undefined,
	};
}

export interface DanglingAnchor {
	fqcn: string;
	method: string;
	signature: string;
}

export interface AnchorReport {
	classes: number;
	/** Documented classes the JAR does not have at all. The class-level dangling anchor. */
	missingClasses: string[];
	methods: number;
	joined: number;
	/** Documented on this page, declared by a supertype. Not a defect. */
	inherited: number;
	dangling: readonly DanglingAnchor[];
	/** Queries reflection returned nothing for: neither a hit nor a near miss. */
	unanswered: number;
}

const simpleNameOf = (fqcn: string): string => fqcn.slice(fqcn.lastIndexOf(".") + 1);

/**
 * Classifies every documented method against what `suggest` found.
 *
 * The rule the whole stage rests on: reflection decides EXISTENCE. A documented
 * overload with no same-name candidate carrying the same erased parameter types
 * does not exist in this JAR, and saying so is the point -- 悬空是信号不是故障.
 */
export function anchorSweep(docs: readonly ApiDoc[], answers: ReadonlyMap<string, readonly string[]>): AnchorReport {
	const queries = buildAnchorQueries(docs);
	const byOwnerName = new Map(queries.map((query) => [`${query.owner}#${query.name}`, query.id]));
	const missingClasses = new Set<string>();
	const dangling: DanglingAnchor[] = [];
	let joined = 0;
	let inherited = 0;
	let methods = 0;
	let unanswered = 0;

	for (const doc of docs) {
		const own = simpleNameOf(doc.fqcn);
		for (const method of doc.methods) {
			methods += 1;
			const id = byOwnerName.get(`${doc.fqcn}#${method.name}`);
			const lines = id === undefined ? undefined : answers.get(id);
			if (lines === undefined) {
				unanswered += 1;
				continue;
			}
			// ApiTool marks "the owner class itself could not be loaded" with a leading !.
			if (lines.some((line) => line.trim().startsWith("!类 "))) {
				missingClasses.add(doc.fqcn);
				continue;
			}
			const key = methodKey(method.name, method.paramTypes);
			const candidates = lines
				.map(parseCandidateLine)
				.filter((candidate): candidate is Candidate => candidate !== null && candidate.name === method.name)
				.filter((candidate) => methodKey(candidate.name, candidate.paramTypes) === key);
			if (candidates.length === 0) {
				dangling.push({ fqcn: doc.fqcn, method: method.name, signature: method.signature });
				continue;
			}
			if (candidates.some((candidate) => candidate.declaringClass === own)) joined += 1;
			else inherited += 1;
		}
	}
	return {
		classes: docs.length,
		missingClasses: [...missingClasses].sort(),
		methods,
		joined,
		inherited,
		dangling,
		unanswered,
	};
}
