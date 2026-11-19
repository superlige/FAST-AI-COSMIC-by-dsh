/**
 * 生产排障配置的读、并、写：缺哪项、填错哪项认得出；答案并进去不丢别的键；
 * 问人期间文件被改过不覆盖；写出来的文件读的那一侧一定认。
 */
import { describe, expect, it } from "vitest";
import { parseProdConfig, prodConfigFile } from "../../src/kernel/prod/config.ts";
import { mergeProdConfig, readProdConfigDraft, writeProdConfig } from "../../src/kernel/prod/setup.ts";
import { MemoryFs } from "./fake-context.ts";

const DIR = "C:/home/.fast-ai-cosmic";
const FILE = prodConfigFile(DIR);
const DB = { host: "10.0.0.1", port: "8000", database: "demo", user: "reader", password: " p w " };

describe("生产排障配置草稿", () => {
	it("文件不在：数据库六项都要问（库类型也问），monitor 没配", () => {
		const draft = readProdConfigDraft(new MemoryFs(), DIR);
		expect(draft).toMatchObject({
			file: FILE,
			exists: false,
			parseError: null,
			monitorConfigured: false,
			summary: null,
		});
		expect(draft.badDb).toEqual(["driver", "host", "port", "database", "user", "password"]);
	});

	it("只缺密码、端口写错：只问这两项；库类型空着按 opengauss 算，有别的项要问时一起问", () => {
		const fs = new MemoryFs();
		fs.put(FILE, JSON.stringify({ db: { host: "h", port: "abc", database: "d", user: "u" } }));
		expect(readProdConfigDraft(fs, DIR).badDb).toEqual(["driver", "port", "password"]);
		fs.put(FILE, JSON.stringify({ db: { driver: "postgresql", host: "h", port: 5432, database: "d", user: "u" } }));
		expect(readProdConfigDraft(fs, DIR).badDb).toEqual(["password"]);
	});

	it("齐了：给摘要（不带密码），当前值里也没有密码", () => {
		const fs = new MemoryFs();
		fs.put(
			FILE,
			JSON.stringify({
				db: { ...DB, port: 8000 },
				monitor: { url: "https://m/monitor/eye", username: "v", password: "x" },
			}),
		);
		const draft = readProdConfigDraft(fs, DIR);
		expect(draft.badDb).toEqual([]);
		expect(draft.monitorConfigured).toBe(true);
		expect(draft.summary).toContain("10.0.0.1:8000/demo");
		expect(draft.summary).not.toContain("p w");
		expect(JSON.stringify(draft.current)).not.toContain("p w");
	});

	it("JSON 坏了：报出来，不当成空文件", () => {
		const fs = new MemoryFs();
		fs.put(FILE, "{ db: ");
		const draft = readProdConfigDraft(fs, DIR);
		expect(draft.parseError).not.toBeNull();
		expect(
			writeProdConfig(fs, draft, mergeProdConfig({ ...draft, parseError: null, text: "" }, { db: DB })),
		).toMatchObject({
			ok: false,
			error: { code: "CONFIG_PARSE_FAILED" },
		});
		expect(fs.read(FILE)).toBe("{ db: ");
	});
});

describe("生产排障配置写入", () => {
	it("新建：端口存成数字、密码原样（不去首尾空格），读的一侧认", () => {
		const fs = new MemoryFs();
		const draft = readProdConfigDraft(fs, DIR);
		const written = writeProdConfig(fs, draft, mergeProdConfig(draft, { db: { driver: "opengauss", ...DB } }));
		expect(written).toEqual({ ok: true, value: { file: FILE, created: true } });
		const saved = JSON.parse(fs.read(FILE));
		expect(saved.db).toEqual({
			driver: "opengauss",
			host: "10.0.0.1",
			port: 8000,
			database: "demo",
			user: "reader",
			password: " p w ",
		});
		expect(parseProdConfig(fs.read(FILE), FILE).ok).toBe(true);
	});

	it("补项：文件里别的键原样留着，monitor 一节并进去", () => {
		const fs = new MemoryFs();
		fs.put(FILE, JSON.stringify({ name: "prod", limits: { maxRows: 100 }, db: { ...DB, password: "" } }));
		const draft = readProdConfigDraft(fs, DIR);
		const merged = mergeProdConfig(draft, {
			db: { password: "secret" },
			monitor: { url: "https://m/monitor/eye", username: "v", password: "x" },
		});
		expect(writeProdConfig(fs, draft, merged).ok).toBe(true);
		const saved = JSON.parse(fs.read(FILE));
		expect(saved.limits).toEqual({ maxRows: 100 });
		expect(saved.db.host).toBe("10.0.0.1");
		expect(saved.db.password).toBe("secret");
		expect(saved.monitor).toEqual({ url: "https://m/monitor/eye", username: "v", password: "x" });
	});

	it("问人期间文件被别处改过：不覆盖", () => {
		const fs = new MemoryFs();
		const draft = readProdConfigDraft(fs, DIR);
		fs.put(FILE, "{}");
		expect(writeProdConfig(fs, draft, mergeProdConfig(draft, { db: { driver: "opengauss", ...DB } }))).toMatchObject({
			ok: false,
			error: { code: "CONFIG_INIT_CONFLICT" },
		});
		expect(fs.read(FILE)).toBe("{}");
	});

	it("并完还是不全：不写", () => {
		const fs = new MemoryFs();
		const draft = readProdConfigDraft(fs, DIR);
		expect(writeProdConfig(fs, draft, mergeProdConfig(draft, { db: { host: "h" } })).ok).toBe(false);
		expect(fs.exists(FILE)).toBe(false);
	});
});
