/** 给人敲的命令在界面里的样子：收参数的命令要声明 input，不然界面不认命令名后面的字。 */
import { describe, expect, it } from "vitest";
import { cosmicCommands } from "../../src/dsh/commands.ts";

const commands = cosmicCommands({
	host: {} as never,
	cwdOf: async () => "",
	questions: () => undefined,
	authorization: () => undefined,
});

describe("给人敲的命令", () => {
	it("说明里写了「/命令 参数」用法的，都声明了收参数", () => {
		// 没声明时，界面上敲「/cosmic-jvm stop 1234」回车，整行当成一句话发给了模型，命令根本没跑
		const takesArgs = commands.filter((command) => command.description.includes(`/${command.name} `));
		expect(takesArgs.map((command) => command.name)).toEqual(["cosmic-jvm"]);
		for (const command of takesArgs) expect(command.input?.hint, command.name).toBeTruthy();
	});
});
