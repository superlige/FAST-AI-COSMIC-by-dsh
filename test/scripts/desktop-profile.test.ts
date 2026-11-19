import { expect, it } from "vitest";
import { withCosmicDesktopBundle } from "../../scripts/desktop-profile.ts";

const base = "@deepseek-ai/dsh-base";
const web = "@deepseek-ai/dsh-web-app";
const cosmic = "fast-ai-cosmic";

it("覆盖安装给原版桌面配置加上 Cosmic，并保留其他插件的顺序", () => {
	const original = [base, web, "third-party-bundle"];
	const updated = withCosmicDesktopBundle(original);
	expect(updated).toEqual([base, web, cosmic, "third-party-bundle"]);
	expect(original).toEqual([base, web, "third-party-bundle"]);
	expect(withCosmicDesktopBundle(updated)).toBe(updated);
});

it("缺少 Cosmic 所依赖的层时保留用户配置", () => {
	const custom = [base, "third-party-bundle"];
	expect(withCosmicDesktopBundle(custom)).toBe(custom);
	expect(withCosmicDesktopBundle(undefined)).toBeUndefined();
});
