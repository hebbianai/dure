import { describe, expect, it } from "vitest";
import type { DurePluginCatalogEntry } from "@/lib/plugins/durePlugins";
import { pluginMarkIcon } from "./pluginMark";

type DureViewsCatalogContribution =
	DurePluginCatalogEntry["view_contributions"][number];

const views = (
	id: string,
	containers: DureViewsCatalogContribution["views"]["containers"],
): DureViewsCatalogContribution => ({
	contribution_id: id,
	views: { schema_version: 1, containers, views: [] },
});

const container = (
	id: string,
	icon: "github" | "list_todo",
): DureViewsCatalogContribution["views"]["containers"][number] => ({
	id,
	location: "primary_sidebar",
	title: { default: id },
	icon,
});

describe("pluginMarkIcon", () => {
	it("is the icon of the first view container the package contributes", () => {
		expect(
			pluginMarkIcon({
				view_contributions: [
					views("dure.github.views", [container("dure.github.work", "github")]),
				],
			}),
		).toBe("github");
	});

	it("skips a contribution that declares no container", () => {
		expect(
			pluginMarkIcon({
				view_contributions: [
					views("dure.beads.empty", []),
					views("dure.beads.views", [
						container("dure.beads.issues", "list_todo"),
					]),
				],
			}),
		).toBe("list_todo");
	});

	it("has no mark for a package that puts nothing in the rail", () => {
		expect(pluginMarkIcon({ view_contributions: [] })).toBeNull();
	});
});
