import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sidebar = readFileSync(
	fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)),
	"utf8",
);
const app = readFileSync(
	fileURLToPath(new URL("../../App.tsx", import.meta.url)),
	"utf8",
);

describe("frontend lazy import boundaries", () => {
	it("keeps the default Spaces surface eager and inactive sidebar surfaces lazy", () => {
		expect(sidebar).toContain(
			'import { SpacesPane } from "@/components/spaces/SpacesPane"',
		);
		for (const optional of [
			"sessions/SessionsPane",
			"search/SearchPane",
			"sidebar/DurePluginsPane",
			"plugins/PluginSidebarContent",
			"ssh/SshPane",
			"scm/SourceControlPane",
			"settings/SettingsDialog",
		]) {
			expect(sidebar).toContain(`import("@/components/${optional}")`);
			expect(sidebar).not.toMatch(
				new RegExp(`from ["']@/components/${optional.replace("/", "\\/")}["']`),
			);
		}
	});

	it("loads native search through its activation-preserving launcher", () => {
		expect(app).toContain(
			'import { LazyNativeSearchDialog } from "@/components/search/LazyNativeSearchDialog"',
		);
		expect(app).not.toContain(
			'from "@/components/search/NativeSearchDialog"',
		);
	});
});
