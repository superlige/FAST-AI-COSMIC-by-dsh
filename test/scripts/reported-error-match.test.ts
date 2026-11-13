/**
 * 尺子 `scripts/measure-reported-errors.ts` 认报错、比原文、折结论的那份规则。
 *
 * 三句真实的提问原文（真机 2026-10-12、10-13、10-14）钉在这里：尺子的基线是照这三句数出来的。
 */

import { describe, expect, it } from "vitest";
import {
	comparableErrorText,
	type ErrorSighting,
	errorLabel,
	errorShownIn,
	noteSighting,
	REPORTED_ERRORS_MAX,
	reportedErrorStatus,
	reportedErrors,
	SIGHTINGS_MAX,
} from "../../scripts/reported-error-match.ts";

const EMPTY_NAME =
	"操作插件：zlgd.zljy.opplugin.TestBillAuditPushMesOpPlugin 没有加载字段导致报错：kd.bos.dataentity.exception.ORMDesignException: 实体类型zlgd_entryentity_ccd中不存在名为的属性  。把使用的字段都加载了";
const DIVIDE = [
	"插件报错：/ by zerokd.bos.exception.KDException: / by zero",
	"    at kd.bos.service.operation.OperationServiceImpl.localInvokeOperation(OperationServiceImpl.java:129)",
	"Caused by: java.lang.ArithmeticException: / by zero",
	"    at zlgd.ygpt.opplugin.LCXSRBOpplugin.setRate(LCXSRBOpplugin.java:251)",
].join("\n");
const NPE = [
	"Key: billlistap",
	"调用堆栈：",
	"java.lang.NullPointerException",
	"    at kd.bos.mvc.list.QueryBuilderFactory.createQueryBuilder(QueryBuilderFactory.java:422)",
	"    at kd.bos.mvc.list.ListModel.setQueryBuilder(ListModel.java:552)",
].join("\n");

const T = (minute: number): string => `2026-10-14T01:${String(minute).padStart(2, "0")}:00.000Z`;

describe("认出用户贴的报错", () => {
	it("类名后面跟着冒号和原文：原文到句号为止，后面说的话不算", () => {
		const [error, ...rest] = reportedErrors(EMPTY_NAME);
		expect(rest).toEqual([]);
		expect(error?.cls).toBe("kd.bos.dataentity.exception.ORMDesignException");
		expect(error?.message).toBe("实体类型zlgd_entryentity_ccd中不存在名为的属性");
		expect(errorLabel(error as NonNullable<typeof error>)).toBe(
			"ORMDesignException: 实体类型zlgd_entryentity_ccd中不存在名为的属性",
		);
	});

	it("带 Caused by 的调用栈：每层一条，各带自己的栈顶", () => {
		const errors = reportedErrors(DIVIDE);
		expect(errors.map((error) => error.cls.split(".").pop())).toEqual(["KDException", "ArithmeticException"]);
		expect(errors.map((error) => error.message)).toEqual(["/ by zero", "/ by zero"]);
		expect(errors[1]?.frames).toEqual(["LCXSRBOpplugin.setRate"]);
	});

	it("只有类名和调用栈、没有原文的也算", () => {
		const [error] = reportedErrors(NPE);
		expect(error?.message).toBe("");
		expect(error?.frames[0]).toBe("QueryBuilderFactory.createQueryBuilder");
		expect(errorLabel(error as NonNullable<typeof error>)).toContain("QueryBuilderFactory.createQueryBuilder");
	});

	it("需求里提到异常类名、没贴原文也没贴栈的，不算报错", () => {
		expect(reportedErrors("样品编号重复时抛 KDException 提示用户，写明是第几行")).toEqual([]);
		expect(reportedErrors("把返回错误原因里面的单据编号都统一换成委托单号")).toEqual([]);
	});

	it("整份日志贴进来也只记前几条", () => {
		const log = Array.from(
			{ length: 9 },
			(_, index) => `java.lang.IllegalStateException: 第${"一二三四五六七八九"[index]}种`,
		);
		expect(reportedErrors(log.join("\n"))).toHaveLength(REPORTED_ERRORS_MAX);
	});
});

describe("输出里有没有这句原文", () => {
	const [emptyName] = reportedErrors(EMPTY_NAME) as [NonNullable<ReturnType<typeof reportedErrors>[0]>];

	it("一字不差的算", () => {
		expect(errorShownIn(emptyName, '[PROBE] row.get("") → 实体类型zlgd_entryentity_ccd中不存在名为的属性')).toBe(
			true,
		);
	});

	it("字段没加载抛的是带字段名的另一句，不算", () => {
		expect(errorShownIn(emptyName, "实体类型zlgd_entryentity_ccd中不存在名为zlgd_ra_avg_ccd的属性")).toBe(false);
	});

	it("单据号、内码不一样不妨碍：带数字的词两边都抹掉再比", () => {
		const [error] = reportedErrors("kd.bos.exception.KDException: 单据 SYSJC-20260917-0002 的检测项目为空");
		expect(error).toBeDefined();
		expect(
			errorShownIn(error as NonNullable<typeof error>, "KDException: 单据 SYSJC-20261014-0031 的检测项目为空"),
		).toBe(true);
		expect(comparableErrorText("单据 SYSJC-20260917-0002 的")).toBe("单据#的");
	});

	it("原文很短的要连类名一起出现", () => {
		const [error] = reportedErrors("java.lang.RuntimeException: null");
		expect(errorShownIn(error as NonNullable<typeof error>, "value = null")).toBe(false);
		expect(errorShownIn(error as NonNullable<typeof error>, "java.lang.RuntimeException: null")).toBe(true);
	});

	it("没有原文的看类名加栈顶", () => {
		const [error] = reportedErrors(NPE) as [NonNullable<ReturnType<typeof reportedErrors>[0]>];
		expect(errorShownIn(error, "java.lang.NullPointerException\n at a.b.Other.run(Other.java:1)")).toBe(false);
		expect(
			errorShownIn(
				error,
				"NullPointerException\n at kd.bos.mvc.list.QueryBuilderFactory.createQueryBuilder(X.java:1)",
			),
		).toBe(true);
	});
});

describe("一条条运行折成结论", () => {
	const run = (key: string, minute: number, shown: boolean) => ({ key, command: key, at: T(minute), shown });
	const folded = (sightings: readonly ErrorSighting[], ...runs: ReturnType<typeof run>[]): ErrorSighting[] =>
		runs.reduce<ErrorSighting[]>((all, next) => noteSighting(all, next), [...sightings]);

	it("没跑出过原文的命令不记", () => {
		expect(folded([], run("probe A", 1, false))).toEqual([]);
	});

	it("改之前跑出来过、改之后同一条命令不再出现：fixed", () => {
		const sightings = folded([], run("probe A", 1, true), run("probe A", 9, false));
		expect(reportedErrorStatus(sightings, T(5))).toEqual({ status: "fixed", command: "probe A" });
	});

	it("改之后同一条命令还在出现：still", () => {
		const sightings = folded([], run("probe A", 1, true), run("probe A", 9, true));
		expect(reportedErrorStatus(sightings, T(5)).status).toBe("still");
	});

	it("跑出来过、改之后没再跑：unverified；改之前就不再出现的也是", () => {
		expect(reportedErrorStatus(folded([], run("probe A", 1, true)), T(5)).status).toBe("unverified");
		expect(reportedErrorStatus(folded([], run("probe A", 1, true), run("probe A", 3, false)), T(5)).status).toBe(
			"unverified",
		);
	});

	it("从没跑出来过：never", () => {
		expect(reportedErrorStatus([], T(5))).toEqual({ status: "never", command: null });
	});

	it("改完才第一次跑出来、再改之后不出现：也是 fixed（它在最后那次改动之前出现过）", () => {
		const sightings = folded([], run("run op", 6, true), run("run op", 12, false));
		expect(reportedErrorStatus(sightings, T(10)).status).toBe("fixed");
		// 最后一次改动之后才跑出来、后来自己不出现了：没有哪次改动能解释它消失，不算 fixed
		expect(reportedErrorStatus(sightings, T(5)).status).toBe("unverified");
	});

	it("一条命令修好了就算 fixed，另一条直接调平台接口的探针照旧抛错不改变它", () => {
		const sightings = folded(
			[],
			run("api probe", 1, true),
			run("run op", 2, true),
			run("api probe", 8, true),
			run("run op", 9, false),
		);
		expect(reportedErrorStatus(sightings, T(5))).toEqual({ status: "fixed", command: "run op" });
	});

	it("记的命令有上限", () => {
		const many = folded(
			[],
			...Array.from({ length: SIGHTINGS_MAX + 3 }, (_, index) => run(`p${String(index)}`, index, true)),
		);
		expect(many).toHaveLength(SIGHTINGS_MAX);
		expect(many[0]?.key).toBe("p3");
	});
});
