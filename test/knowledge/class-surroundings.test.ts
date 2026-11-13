import { describe, expect, it } from "vitest";
import {
	buildJavaIndex,
	classSurroundings,
	createSurroundingsSeen,
	javaClassFacts,
	type ProjectJavaPort,
} from "../../src/knowledge/class-surroundings.ts";

const ROOT = "D:/demo";
const SRC = `${ROOT}/demo-mod/src/main/java`;

const FILES: Record<string, string> = {
	"demo/common/ExtOp.java": `package demo.common;

import kd.bos.entity.plugin.AbstractOperationServicePlugIn;
import kd.bos.entity.plugin.PreparePropertysEventArgs;

/** 扩展操作插件 */
public class ExtOp extends AbstractOperationServicePlugIn {
    public static final String OP_SUBMIT = "submit";

    //获取日志
    public Object getLogger() {
        return null;
    }

    //加载全量字段
    @Override
    public void onPreparePropertys(PreparePropertysEventArgs e) {
        super.onPreparePropertys(e);
    }
}
`,
	"demo/common/BillCon.java": `package demo.common;

public class BillCon {
    /** 报告编号 **/
    public static final String KEY_BGBH = "demo_bgbh";
    /** 专业编号 **/
    public static final String KEY_ZYBH = "demo_zybh";
}
`,
	"demo/qty/SubmitOp.java": `package demo.qty;

import demo.common.BillCon;
import demo.common.ExtOp;
import kd.bos.entity.plugin.args.EndOperationTransactionArgs;

public class SubmitOp extends ExtOp {
    // 这里写 @Override 不算：注释里的
    @Override
    public void endOperationTransaction(EndOperationTransactionArgs e) {
        String key = BillCon.KEY_BGBH;
        if (OP_SUBMIT.equals(key)) {
            return;
        }
    }
}
`,
	"demo/qty/AuditOp.java": `package demo.qty;

import demo.common.ExtOp;

public class AuditOp extends ExtOp {
    @Override
    public void onAddValidators(Object e) {
    }
}
`,
	"demo/other/SaveOp.java": `package demo.other;

import demo.common.*;

public class SaveOp extends ExtOp {
    @Override
    public void onAddValidators(Object e) {
    }

    @Override public void beforeExecuteOperationTransaction(Object e) {
    }
}
`,
	"demo/qty/UnauditOp.java": `package demo.qty;

import demo.common.BillCon;
import demo.common.ExtOp;

public class UnauditOp extends ExtOp {
    @Override
    public void endOperationTransaction(Object e) {
        String a = BillCon.KEY_BGBH;
        String b = BillCon.KEY_ZYBH;
    }
}
`,
	"demo/form/BillForm.java": `package demo.form;

import kd.bos.form.plugin.AbstractFormPlugin;

public class BillForm extends AbstractFormPlugin {
    @Override
    public void afterBindData(Object e) {
    }
}
`,
};

function port(): ProjectJavaPort {
	const byPath = new Map(Object.entries(FILES).map(([path, text]) => [`${SRC}/${path}`, text]));
	return {
		exists: (path) => byPath.has(path),
		read: (path) => byPath.get(path) ?? "",
		listJavaFiles: (dir) => [...byPath.keys()].filter((path) => path.startsWith(`${dir}/`)),
	};
}

function surroundings(file: string, seen = createSurroundingsSeen()) {
	const source = port();
	const index = buildJavaIndex(ROOT, [SRC], source);
	return classSurroundings({ index, file: `${SRC}/${file}`, source, seen });
}

describe("读到插件类时附上的周边", () => {
	it("父类链给到平台基类，带父类自己写的方法、行号、上面那行注释，本类覆盖的标出来", () => {
		const text = surroundings("demo/qty/SubmitOp.java")?.text ?? "";
		expect(text).toContain(
			"父类：ExtOp（demo-mod/src/main/java/demo/common/ExtOp.java） → AbstractOperationServicePlugIn（平台）",
		);
		expect(text).toContain("getLogger 第 11–13 行（获取日志）");
		expect(text).toContain("onPreparePropertys 第 16–19 行（加载全量字段）");
	});

	it("常量给值、上面那行注释：别的类的 类名.常量，和直接用到的父类常量；本类自己声明的不列", () => {
		const text = surroundings("demo/qty/SubmitOp.java")?.text ?? "";
		expect(text).toContain(
			'BillCon（demo-mod/src/main/java/demo/common/BillCon.java）：KEY_BGBH="demo_bgbh"（报告编号）',
		);
		expect(text).toContain('ExtOp（demo-mod/src/main/java/demo/common/ExtOp.java）：OP_SUBMIT="submit"');
		expect(text).not.toContain("KEY_ZYBH");
	});

	it("同类写法：同一个父类的其他类常写、本类没写的方法，例子挑包名最接近的", () => {
		const text = surroundings("demo/qty/SubmitOp.java")?.text ?? "";
		expect(text).toContain("同一个父类的还有 3 个类");
		expect(text).toContain("onAddValidators：2 个类写了，例 demo-mod/src/main/java/demo/qty/AuditOp.java 第 7 行");
		expect(text).toContain(
			"beforeExecuteOperationTransaction：1 个类写了，例 demo-mod/src/main/java/demo/other/SaveOp.java 第 10 行",
		);
		// 本类已经写了的不列
		expect(text).not.toContain("endOperationTransaction：");
	});

	it("点到名的文件按原因记下：父类、常量类、同类写法的例子", () => {
		const named = surroundings("demo/qty/SubmitOp.java")?.named ?? [];
		expect(named).toContainEqual({ file: `${SRC}/demo/common/ExtOp.java`, why: "parent" });
		expect(named).toContainEqual({ file: `${SRC}/demo/common/BillCon.java`, why: "constant" });
		expect(named).toContainEqual({ file: `${SRC}/demo/qty/AuditOp.java`, why: "sibling" });
	});

	it("工程基类、常量类不给：它们是别人的周边", () => {
		expect(surroundings("demo/common/ExtOp.java")).toBeNull();
		expect(surroundings("demo/common/BillCon.java")).toBeNull();
	});

	it("直接继承平台基类的也给（所有插件类型）；只有一个平台父类、别的什么都没有就不给", () => {
		const text = surroundings("demo/qty/SubmitOp.java")?.text ?? "";
		expect(text).toContain("AbstractOperationServicePlugIn（平台）");
		// BillForm 的父类是平台的、没用常量、同父类的只有它自己：源码里 extends 那行就写着，不重复
		expect(surroundings("demo/form/BillForm.java")).toBeNull();
	});

	it("同一个会话里同一个父类只给一次，常量也只给一次；什么新东西都没有就不给", () => {
		const seen = createSurroundingsSeen();
		expect(surroundings("demo/qty/SubmitOp.java", seen)).not.toBeNull();
		const second = surroundings("demo/qty/UnauditOp.java", seen)?.text ?? "";
		expect(second).toContain("父类 ExtOp 的父类链和同类写法前面已经给过");
		expect(second).toContain('KEY_ZYBH="demo_zybh"（专业编号）');
		expect(second).not.toContain("KEY_BGBH");
		expect(second).not.toContain("同一个父类的还有");
		expect(surroundings("demo/qty/AuditOp.java", seen)).toBeNull();
	});

	it("注释里的 extends、@Override 不算；同一行写注解和方法头也认", () => {
		const facts = javaClassFacts(`${SRC}/demo/other/SaveOp.java`, FILES["demo/other/SaveOp.java"] as string);
		expect(facts?.parent).toBe("ExtOp");
		expect(facts?.wildcards).toEqual(["demo.common"]);
		expect(facts?.overrides.map((one) => one.name)).toEqual(["onAddValidators", "beforeExecuteOperationTransaction"]);
		const submit = javaClassFacts(`${SRC}/demo/qty/SubmitOp.java`, FILES["demo/qty/SubmitOp.java"] as string);
		expect(submit?.overrides).toEqual([{ name: "endOperationTransaction", line: 10 }]);
	});
});
