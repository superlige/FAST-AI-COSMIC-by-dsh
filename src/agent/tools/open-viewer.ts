/**
 * 用系统自带的看图程序打开一个文件（monitor 验证码图）。终端里画不了图，看图要靠它。
 * 打不开不算错：输入框里同时写着文件路径，人可以自己去开。
 */
import { spawn } from "node:child_process";

export function openWithSystemViewer(file: string, platform: NodeJS.Platform = process.platform): boolean {
	try {
		const child =
			platform === "win32"
				? spawn("cmd", ["/c", "start", '""', `"${file}"`], {
						detached: true,
						stdio: "ignore",
						windowsVerbatimArguments: true,
					})
				: spawn(platform === "darwin" ? "open" : "xdg-open", [file], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
