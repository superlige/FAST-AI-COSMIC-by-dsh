import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeProdConfig, jdbcUrl, parseProdConfig } from "../../src/kernel/prod/config.ts";
import {
	type HttpPort,
	type HttpReply,
	type MonitorSession,
	monitorCaptcha,
	monitorLogin,
	monitorQuery,
	queryForm,
} from "../../src/kernel/prod/monitor.ts";
import { checkDiagnosis, renderDiagnosis } from "../../src/kernel/prod/report.ts";

const MONITOR = { url: "https://demo.example/monitor/eye", username: "viewer", password: "p@ss word" };

function reply(body: unknown, headers: Record<string, string> = {}, setCookies: string[] = []): HttpReply {
	return {
		status: 202,
		text: JSON.stringify(body),
		header: (name) => headers[name] ?? null,
		setCookies,
	};
}

/** 照 monitor 接口的样子回答，记下每次请求 */
function fakeMonitor(captchaEnabled: boolean) {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
	const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
	const bare = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
	const http: HttpPort = {
		async post(url, body, headers) {
			calls.push({ url, body: body as Record<string, unknown>, headers });
			if (url.endsWith("/eye/verifyCode"))
				return reply({
					code: 0,
					data: { enable: captchaEnabled, code: "data:image/jpeg;base64,/9j/AAAA", loginId: "L1" },
				});
			if (url.endsWith("/eye/getPublicKey")) return reply({ code: 0, data: { publicKey: bare } });
			if (url.endsWith("/eye/login")) {
				const password = privateDecrypt(
					{ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
					Buffer.from(String((body as Record<string, unknown>).password), "base64"),
				).toString("utf8");
				const ok = password === MONITOR.password && (!captchaEnabled || headers.Cookie === "verifyCode=ab12");
				return ok
					? reply({ code: 0, msg: "success" }, { "monitor-csrf-token": "CSRF" }, [
							"ierp-cluster-Auth_Token=TOK; Path=/",
						])
					: reply({ code: -1, msg: "验证码错误" });
			}
			if (url.endsWith("/eye/queryLogDatasource"))
				return reply({ code: 0, data: { default: "ds1", logKeywordEncryptEnable: true } });
			if (url.endsWith("/eye/logQuery/query"))
				return headers.Cookie === "ierp-cluster-Auth_Token=TOK" && headers["monitor-csrf-token"] === "CSRF"
					? reply({ code: 0, data: [{ level: "ERROR", message: "x" }] })
					: reply({ code: 50009, msg: "No token" });
			return reply({ code: -1 });
		},
	};
	return { http, calls };
}

describe("monitor 登录", () => {
	it("开了验证码：取图和 loginId；人输的字放 cookie，密码按公钥加密；会话记 token 和 csrf", async () => {
		const { http, calls } = fakeMonitor(true);
		const captcha = await monitorCaptcha(http, MONITOR);
		if (!captcha.ok) throw captcha.error;
		expect(captcha.value).toMatchObject({ required: true, loginId: "L1", imageType: "jpeg" });
		expect(captcha.value.image?.length).toBeGreaterThan(0);
		const session = await monitorLogin(http, MONITOR, captcha.value, " ab12 ");
		if (!session.ok) throw session.error;
		expect(session.value).toMatchObject({
			cookies: [["ierp-cluster-Auth_Token", "TOK"]],
			csrf: "CSRF",
			keywordBase64: true,
			datasource: "ds1",
		});
		const login = calls.find((c) => c.url.endsWith("/eye/login"));
		expect(login?.body).toMatchObject({ username: "viewer", verifycode: "ab12", loginId: "L1" });
		expect(String(login?.body.password)).not.toContain("p@ss");
		expect(calls[0]?.url).toBe("https://demo.example/monitor/eye/verifyCode");
	});

	it("验证码错了：照实报，不重试", async () => {
		const { http, calls } = fakeMonitor(true);
		const captcha = await monitorCaptcha(http, MONITOR);
		if (!captcha.ok) throw captcha.error;
		const session = await monitorLogin(http, MONITOR, captcha.value, "zzzz");
		expect(session.ok).toBe(false);
		if (!session.ok) expect(session.error.message).toContain("验证码错误");
		expect(calls.filter((c) => c.url.endsWith("/eye/login"))).toHaveLength(1);
	});
});

describe("monitor 查询", () => {
	const session: MonitorSession = {
		username: "viewer",
		cookies: [["ierp-cluster-Auth_Token", "TOK"]],
		csrf: "CSRF",
		loggedInAt: 0,
		keywordBase64: true,
		datasource: "ds1",
	};

	it("表单照页面的格式拼：关键字 base64、级别大写、时间按分钟往回推、条数有上限", () => {
		const now = Date.parse("2026-11-11T08:00:00Z");
		const form = queryForm({ keyword: "部门不对", level: "error", minutes: 30, size: 99999 }, session, now);
		expect(form.keyword).toBe(Buffer.from("部门不对", "utf8").toString("base64"));
		expect(form.level).toBe("ERROR");
		expect(form.time).toEqual(["2026-11-11T07:30:00.000Z", "2026-11-11T08:00:00.000Z"]);
		expect(form.size).toBe(5000);
		expect(form.datasource).toBe("ds1");
		expect(queryForm({ keyword: "x" }, { ...session, keywordBase64: false }, now).keyword).toBe("x");
	});

	it("没登录、过期都回「请用户登录」，不自己去登录", async () => {
		const { http, calls } = fakeMonitor(true);
		const none = await monitorQuery(http, MONITOR, null, {}, 0);
		expect(!none.ok && none.error.code).toBe("PROD_MONITOR_LOGIN_REQUIRED");
		const stale = await monitorQuery(http, MONITOR, { ...session, csrf: "OLD" }, {}, 0);
		expect(!stale.ok && stale.error.code).toBe("PROD_MONITOR_LOGIN_REQUIRED");
		if (!stale.ok) expect(stale.error.remedy).toContain("/cosmic-monitor-login");
		expect(calls.some((c) => c.url.endsWith("/eye/login"))).toBe(false);
	});

	it("登录着：带上 token 和 csrf，拿回日志行", async () => {
		const { http } = fakeMonitor(true);
		const got = await monitorQuery(http, MONITOR, session, { traceId: "t1" }, 0);
		if (!got.ok) throw got.error;
		expect(got.value.rows).toHaveLength(1);
		expect(got.value.form.traceId).toBe("t1");
	});
});

describe("诊断报告", () => {
	const evidence = [
		{ id: "E1", kind: "生产日志", summary: "submit 报部门不对", at: "t", file: "/w/a.txt" },
		{ id: "E2", kind: "生产数据", summary: "单据部门是 150099", at: "t" },
	];

	it("引用了没有的编号直接拒，并列出有哪些编号", () => {
		const error = checkDiagnosis({ title: "提交报错", findings: [{ text: "x", evidence: ["E9"] }] }, evidence);
		expect(error?.code).toBe("PROD_REPORT_INVALID");
		expect(error?.remedy).toContain("E1、E2");
	});

	it("没有标题、没有结论都拒", () => {
		expect(checkDiagnosis({ title: "", findings: [{ text: "x", evidence: [] }] }, evidence)?.code).toBe(
			"PROD_REPORT_INVALID",
		);
		expect(checkDiagnosis({ title: "t", findings: [] }, evidence)?.code).toBe("PROD_REPORT_INVALID");
	});

	it("有引用的标「有证据」，没引用的标「推断」，末尾列出引用到的证据", () => {
		const input = {
			title: "提交报错：销售部门不对",
			findings: [
				{ text: "报错来自部门校验规则", evidence: ["E1", "E2"] },
				{ text: "规则条件可能写漏了部门", evidence: [] },
			],
			next: "切回开发模式改规则",
		};
		expect(checkDiagnosis(input, evidence)).toBeNull();
		const text = renderDiagnosis(input, evidence, "2026-11-11 16:00");
		expect(text).toContain("1. 【有证据 E1、E2】报错来自部门校验规则");
		expect(text).toContain("2. 【推断，未查证】规则条件可能写漏了部门");
		expect(text).toContain("- E1 生产日志（t）：submit 报部门不对　全文 /w/a.txt");
		expect(text).toContain("## 下一步");
	});
});

describe("生产排障配置", () => {
	const good = {
		db: { host: "10.0.0.1", port: "8000", database: "demo_all", user: "ro", password: " pw " },
		monitor: { url: "https://demo.example/monitor/eye/", username: "viewer", password: "x" },
	};

	it("读得出连接、默认限额，monitor 去掉末尾斜杠，密码不 trim", () => {
		const parsed = parseProdConfig(JSON.stringify(good), "/c/prod.json");
		if (!parsed.ok) throw parsed.error;
		expect(parsed.value.db).toMatchObject({ driver: "opengauss", port: 8000, password: " pw " });
		expect(parsed.value.limits).toEqual({ timeoutSeconds: 15, maxRows: 500 });
		expect(parsed.value.monitor?.url).toBe("https://demo.example/monitor/eye");
		expect(jdbcUrl(parsed.value.db)).toBe("jdbc:opengauss://10.0.0.1:8000/demo_all");
	});

	it("缺项、端口不是数字、驱动不认识都拒，并指出文件", () => {
		for (const broken of [
			{ ...good, db: { ...good.db, host: "" } },
			{ ...good, db: { ...good.db, port: "abc" } },
			{ ...good, db: { ...good.db, driver: "mysql" } },
		]) {
			const parsed = parseProdConfig(JSON.stringify(broken), "/c/prod.json");
			expect(parsed.ok).toBe(false);
			if (!parsed.ok) expect(parsed.error.code).toBe("PROD_CONFIG_MISSING");
		}
	});

	it("限额有上限，防止一次拖慢生产", () => {
		const parsed = parseProdConfig(
			JSON.stringify({ ...good, limits: { timeoutSeconds: 9999, maxRows: 100000 } }),
			"/c/prod.json",
		);
		if (!parsed.ok) throw parsed.error;
		expect(parsed.value.limits).toEqual({ timeoutSeconds: 120, maxRows: 5000 });
	});

	it("给人和模型看的摘要里没有密码", () => {
		const parsed = parseProdConfig(JSON.stringify(good), "/c/prod.json");
		if (!parsed.ok) throw parsed.error;
		const text = describeProdConfig(parsed.value);
		expect(text).not.toContain(" pw ");
		expect(text).not.toMatch(/password/i);
		expect(text).toContain("账号 ro");
	});
});
