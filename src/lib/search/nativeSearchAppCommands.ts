// The registry as palette rows: applicable commands only, each with the chord
// the Shortcuts page shows for it right now.

import {
	type AppCommand,
	type AppCommandContext,
	type AppCommandUnavailable,
	appCommandApplies,
	appCommandSpaceTargets,
	appCommands,
	type PlainAppCommandId,
	type SpaceCommandId,
} from "@/lib/commands/appCommands";
import { t } from "@/lib/i18n";
import type { NativeSearchItem } from "@/lib/search/nativeSearch";
import {
	resolveShortcuts,
	type ShortcutOverrides,
} from "@/lib/settings/shortcutBindings";

type Keys = readonly (readonly string[])[];

const UNAVAILABLE_DETAIL: Record<AppCommandUnavailable, string> = {
	"keyboard-only": "search.appCommand.keyboardOnly",
	"already-open": "search.appCommand.alreadyOpen",
};

/** The id keeps every command findable in English under any UI language. */
function commandKeywords(command: AppCommand): string[] {
	return [command.id.replace(/-/g, " "), ...(command.keywords ?? [])];
}

function withKeys(keys: Keys | undefined) {
	return keys && keys.length > 0 ? { shortcut: keys } : {};
}

function commandItem(
	command: AppCommand,
	keys: Keys | undefined,
): NativeSearchItem {
	const { unavailable } = command;
	return {
		id: `command:app:${command.id}`,
		kind: "command",
		title: t(command.title),
		detail: t(
			unavailable ? UNAVAILABLE_DETAIL[unavailable] : "search.appCommand.label",
		),
		keywords: commandKeywords(command),
		...withKeys(keys),
		action: unavailable
			? { type: "unavailable" }
			: {
					type: "app-command",
					command: command.id as PlainAppCommandId,
				},
	};
}

/** One row per Space the command can act on, each with the keys that run it
 * on that Space: for Switch desktop, its tab's step of the ⌘1…⌘9 range. */
function spaceCommandItems(
	command: AppCommand,
	perSpace: NonNullable<AppCommand["perSpace"]>,
	context: AppCommandContext,
): NativeSearchItem[] {
	return appCommandSpaceTargets(context).map(({ space, position }) => {
		const step = perSpace.keys?.(position);
		return {
			id: `command:app:${command.id}:${space.id}`,
			kind: "command",
			title: t(perSpace.title, { name: space.name }),
			detail: t("search.appCommand.label"),
			keywords: commandKeywords(command),
			...withKeys(step ? [step] : undefined),
			action: {
				type: "app-command",
				command: command.id as SpaceCommandId,
				spaceId: space.id,
			},
		};
	});
}

export function appCommandSearchItems(
	context: AppCommandContext,
	overrides: ShortcutOverrides,
): NativeSearchItem[] {
	const keysById = new Map(
		resolveShortcuts(overrides).map((shortcut) => [shortcut.id, shortcut.keys]),
	);
	return appCommands()
		.filter((command) => appCommandApplies(command, context))
		.flatMap((command) =>
			command.perSpace
				? spaceCommandItems(command, command.perSpace, context)
				: [
						commandItem(
							command,
							command.shortcutId ? keysById.get(command.shortcutId) : undefined,
						),
					],
		);
}
