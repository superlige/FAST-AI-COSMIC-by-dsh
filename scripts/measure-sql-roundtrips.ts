/**
 * 尺子：苍穹进程里一条 SQL 要过几趟网络、各趟多久；MySQL 驱动里和这件事有关的开关现在是什么值。
 *
 * 用法：
 *   node --experimental-strip-types scripts/measure-sql-roundtrips.ts <工程目录> [--repeat 20] [--jvm-opt <-D名=值> …]
 *     [--url-template <改过的 mysql.xml>] [--big <单据标识>]
 *
 * 把 scripts/sql-roundtrips/SqlRoundTripProbe.java 编到临时目录，另起一个苍穹冷进程跑一次（和探针走冷进程时同一套启动参数，
 * 约一两分钟），原样打出它的输出：连接一层层包的是什么、连接串、驱动开关，以及同一条只读 SQL 在四种用法下
 * 「预编译、执行、取结果、关闭」各多少毫秒（平台包过的连接照常用；裸连接照常用；裸连接强制本机预编译；裸连接强制服务器预编译）。
 * 再量一下到数据库服务器建一条空连接多久：比 SQL 的一趟来回短很多，说明本机有代理或 VPN 客户端先把连接接下了。
 *
 * `--big`：再把这张单的整份设计元数据读 5 遍，报多大、读一遍多久（大字段过网络要多久）。
 *
 * `--url-template`：平台按 bos-dbengine 包里的 jdbc_url_generator/mysql.xml 拼 MySQL 连接串，预编译在哪一侧做、用不用游标取数
 * 都是这个模板里写死的默认值。给一份改过的模板，尺子把它放在类路径最前面顶掉平台自带的，只影响这一次起的进程，
 * 用来试「换一种开关，一条 SQL 变成几趟」。模板从包里取：`unzip -p <bos-dbengine 包> jdbc_url_generator/mysql.xml`。
 *
 * 这个 Java 类要拿裸的数据库连接、要用反射，临时探针那道「只准读」的检查不放行这两样，所以它不走探针工具，
 * 由这把尺子自己编译、自己起进程。它只发 select；不写工程目录，不碰常驻进程。
 * 口径和基线见 `docs/S59-call-overhead-idle-connections.md` §9。
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKernelAdapter } from "../src/agent/tools/kernel-adapter.ts";
import { PRODUCT_ID } from "../src/brand.ts";
import { baseChildEnv, jvmProps, type KernelContext, poolProps } from "../src/kernel/context.ts";
import { classpathOf, runJava, runJavac } from "../src/kernel/toolchain.ts";
import { EMBEDDED_RESOURCES } from "../src/resources/embedded.generated.ts";

const argv = process.argv.slice(2);
const one = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const many = (name: string): string[] =>
	argv.flatMap((arg, i) => (arg === name && argv[i + 1] ? [argv[i + 1] as string] : []));
const project = argv[0];
if (project === undefined || project.startsWith("--")) {
	console.error(
		"用法：measure-sql-roundtrips.ts <工程目录> [--repeat 20] [--jvm-opt <-D名=值> …] [--url-template <改过的 mysql.xml>]",
	);
	process.exit(2);
}
const root = resolve(project);
const PROBE = "SqlRoundTripProbe";

/** 建一条空连接要多久：三次握手正好是一趟来回 */
function connectMs(host: string, port: number): Promise<number | null> {
	return new Promise((done) => {
		const started = performance.now();
		const socket = connect({ host, port });
		const finish = (value: number | null) => {
			socket.destroy();
			done(value);
		};
		socket.once("connect", () => finish(performance.now() - started));
		socket.once("error", () => finish(null));
		socket.setTimeout(5000, () => finish(null));
	});
}

const agentConfigDir = join(homedir(), `.${PRODUCT_ID}`);
const kernel = createKernelAdapter({
	agentConfigDir,
	cacheRoot: join(agentConfigDir, "cache"),
	agentVersion: "0.0.0-dev",
	resources: EMBEDDED_RESOURCES,
});
const opened = await kernel.open(root);
if (!opened.ok) {
	console.error(JSON.stringify(opened.error.toJSON()));
	process.exit(1);
}
const ctx = (opened.value.handle as unknown as { ctx: KernelContext }).ctx;

const classes = mkdtempSync(join(tmpdir(), "cosmic-sql-roundtrips-"));
let exitCode = 0;
try {
	const template = one("--url-template");
	if (template !== undefined) {
		mkdirSync(join(classes, "jdbc_url_generator"), { recursive: true });
		copyFileSync(resolve(template), join(classes, "jdbc_url_generator", "mysql.xml"));
	}
	const compiled = await runJavac(ctx, [
		"-encoding",
		"UTF-8",
		"-nowarn",
		"-proc:none",
		`@${ctx.layout.javacArgs}`,
		"-d",
		classes,
		join(import.meta.dirname, "sql-roundtrips", `${PROBE}.java`),
	]);
	if (compiled.status !== 0) {
		console.log(`没编过：\n${compiled.out.slice(0, 3000)}`);
		exitCode = 1;
	} else {
		const run = await runJava(
			ctx,
			[
				"-Dfile.encoding=UTF-8",
				...jvmProps(ctx.config),
				...poolProps(ctx.config),
				...many("--jvm-opt"),
				"-cp",
				classpathOf(classes, ctx.layout.probeClasses, ctx.layout.pathingJar),
				"CosmicProbe",
				PROBE,
			],
			{ ...baseChildEnv(ctx), TRIP_REPEAT: one("--repeat") ?? "20", TRIP_BIG_ENTITY: one("--big") ?? "" },
		);
		const lines = run.out.split("\n").filter((line) => line.startsWith("[PROBE]"));
		console.log(`冷进程跑了 ${run.seconds} 秒，退出码 ${String(run.status)}`);
		if (run.status !== 0 || lines.length === 0) {
			// 没跑成：把进程最后说的话原样打出来
			console.log(run.out.slice(-3000));
			exitCode = 1;
		} else {
			console.log(lines.join("\n"));
			const url = /jdbc:mysql:\/\/([\w.-]+):(\d+)/.exec(lines.join("\n"));
			if (url !== null) {
				const samples: number[] = [];
				for (let i = 0; i < 7; i++) {
					const ms = await connectMs(url[1] as string, Number(url[2]));
					if (ms !== null) samples.push(ms);
					await new Promise((go) => setTimeout(go, 300));
				}
				samples.sort((a, b) => a - b);
				const mid = samples[Math.floor(samples.length / 2)];
				console.log(
					mid === undefined
						? `到 ${String(url[1])}:${String(url[2])} 建空连接没成功`
						: `到 ${String(url[1])}:${String(url[2])} 建一条空连接中位 ${mid.toFixed(1)} 毫秒（${String(samples.length)} 次）`,
				);
			}
		}
	}
} finally {
	rmSync(classes, { recursive: true, force: true });
}
process.exit(exitCode);
