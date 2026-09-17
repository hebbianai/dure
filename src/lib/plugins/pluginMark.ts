import type { PluginViewIconV1 } from "@/contracts/generated/extensionContracts";
import type { DurePluginCatalogEntry } from "@/lib/plugins/durePlugins";

/** The glyph that stands for a plugin wherever the plugin itself is the
 * subject — the catalog row, its detail header. It is the icon of the first
 * view container the package contributes, so the plugin list and the activity
 * rail agree on what a plugin looks like without a second icon field to keep
 * in step (owner decision 2026-09-03: the list drew one generic cube for
 * every plugin). A package that puts nothing in the rail — workflows or
 * settings only, like Dure Core — has no mark of its own; the caller draws
 * the generic package glyph. */
export function pluginMarkIcon(
	entry: Pick<DurePluginCatalogEntry, "view_contributions">,
): PluginViewIconV1 | null {
	for (const contribution of entry.view_contributions) {
		const icon = contribution.views.containers[0]?.icon;
		if (icon) return icon;
	}
	return null;
}
