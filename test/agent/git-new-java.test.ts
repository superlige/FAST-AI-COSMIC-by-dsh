import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitNewJava, isSourceJava } from "../../src/agent/tools/git-new-java.ts";

const git = (root: string, ...args: string[]): string =>
	execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/** 和 pi 的 write 一样：先过 beforeWrite，再落盘，再过 afterWrite。 */
async function write(tracker: ReturnType<typeof createGitNewJava>, root: string, rel: string, text = "class A {}\n") {
	const file = join(root, rel);
	tracker.beforeWrite(root, file);
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, text);
	return tracker.afterWrite(root, file);
}

describe("isSourceJava: only module source Java is registered", () => {
	const root = "D:/kingdee/proj";
	it("takes .java under src/main/java", () => {
		expect(isSourceJava(root, "D:/kingdee/proj/mod-a/src/main/java/demo/A.java")).toBe(true);
		expect(isSourceJava(root, "D:/kingdee/proj/src/main/java/demo/A.java")).toBe(true);
	});
	it("leaves docs, resources, stray Java and files outside the project alone", () => {
		expect(isSourceJava(root, "D:/kingdee/proj/docs/说明.md")).toBe(false);
		expect(isSourceJava(root, "D:/kingdee/proj/mod-a/src/main/resources/a.properties")).toBe(false);
		expect(isSourceJava(root, "D:/kingdee/proj/docs/A.java")).toBe(false);
		expect(isSourceJava(root, "D:/kingdee/other/src/main/java/A.java")).toBe(false);
	});
});

describe("createGitNewJava against a real repository", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cosmic-git-new-java-"));
		git(root, "init", "-q");
		writeFileSync(join(root, ".gitignore"), "ignored/\n");
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("registers a new source Java file without staging its content", async () => {
		const tracker = createGitNewJava();
		expect(await write(tracker, root, "mod/src/main/java/demo/A.java")).toBe(true);
		expect(git(root, "status", "--porcelain", "--", "mod")).toBe(" A mod/src/main/java/demo/A.java\n");
	});

	it("does not touch a new document or a Java file outside src/main/java", async () => {
		const tracker = createGitNewJava();
		expect(await write(tracker, root, "docs/说明.md", "# x\n")).toBe(false);
		expect(await write(tracker, root, "docs/A.java")).toBe(false);
		expect(git(root, "ls-files")).toBe("");
	});

	it("does not register a file that existed before the write", async () => {
		mkdirSync(join(root, "mod/src/main/java"), { recursive: true });
		writeFileSync(join(root, "mod/src/main/java/Old.java"), "class Old {}\n");
		const tracker = createGitNewJava();
		expect(await write(tracker, root, "mod/src/main/java/Old.java", "class Old { int x; }\n")).toBe(false);
		expect(git(root, "ls-files")).toBe("");
	});

	it("gives up quietly when git refuses an ignored path", async () => {
		const tracker = createGitNewJava();
		expect(await write(tracker, root, "ignored/src/main/java/A.java")).toBe(false);
		expect(git(root, "ls-files")).toBe("");
	});

	it("drops the registration when the new file is deleted again", async () => {
		const tracker = createGitNewJava();
		await write(tracker, root, "mod/src/main/java/A.java");
		rmSync(join(root, "mod/src/main/java/A.java"));
		expect(await tracker.sweep()).toBe(1);
		expect(git(root, "status", "--porcelain", "--", "mod")).toBe("");
	});

	it("keeps an entry the user really added before the file was deleted", async () => {
		const tracker = createGitNewJava();
		await write(tracker, root, "mod/src/main/java/A.java");
		git(root, "add", "--", "mod/src/main/java/A.java");
		rmSync(join(root, "mod/src/main/java/A.java"));
		expect(await tracker.sweep()).toBe(0);
		expect(git(root, "ls-files")).toBe("mod/src/main/java/A.java\n");
	});

	it("does nothing outside a git repository", async () => {
		const bare = mkdtempSync(join(tmpdir(), "cosmic-no-git-"));
		try {
			const tracker = createGitNewJava();
			// 临时目录本身可能落在某个仓库里；这里只要求不抛错、写入照常。
			await expect(write(tracker, bare, "src/main/java/A.java")).resolves.toBeTypeOf("boolean");
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});
});
