import { describe, expect, it } from "vitest";
import {
	basicFoldedSettingsPages,
	settingsNavigationGroups,
} from "@/components/settings/settingsNav";

describe("settings navigation basic-mode folding", () => {
	it("basic keeps setup and environment cleanup pages while folding advanced pages", () => {
		const folded = basicFoldedSettingsPages();
		const ids = settingsNavigationGroups(true, folded).flatMap((group) =>
			group.items.map((item) => item.id),
		);
		expect(ids).toEqual([
			"accounts",
			"providers",
			"agentTooling",
			"general",
			"environments",
			"appearance",
			"notifications",
			"usage",
			"privacy",
		]);
	});

	it("pro shows every page including the mac group", () => {
		const ids = settingsNavigationGroups(true).flatMap((group) =>
			group.items.map((item) => item.id),
		);
		expect(ids).toContain("providers");
		expect(ids).toContain("macos");
		expect(ids).toContain("mobile");
	});
});
