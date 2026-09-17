import { Box, CircleDot, Inbox, ListTodo, Puzzle } from "lucide-react";
import type { ComponentType } from "react";

import { GithubRailIcon } from "@/components/sidebar/RailIcons";
import type { PluginViewIconV1 } from "@/contracts/generated/extensionContracts";

/** The one mapping from the view-icon enum a plugin manifest may name to a
 * drawn glyph. The GitHub mark belongs to surfaces that mean the GitHub
 * service; the bundled GitHub plugin is the one plugin that does, so its
 * container is the one place the octocat appears in the rail. */
const PLUGIN_VIEW_ICONS: Record<
	PluginViewIconV1,
	ComponentType<{ className?: string }>
> = {
	circle_dot: CircleDot,
	github: GithubRailIcon,
	inbox: Inbox,
	list_todo: ListTodo,
	puzzle: Puzzle,
};

/** A plugin's glyph — the activity rail button, the catalog row, the detail
 * header all draw the same one. `icon` is the view-container icon the package
 * declares (`pluginMarkIcon` picks it from a catalog entry); `null` is a
 * package with no rail presence and draws the generic package glyph. */
export function PluginMark({
	icon,
	className,
}: {
	icon: PluginViewIconV1 | null;
	className?: string;
}) {
	const Icon = icon ? PLUGIN_VIEW_ICONS[icon] : Box;
	return <Icon className={className} />;
}
