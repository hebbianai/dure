// The registry as palette rows: applicable commands only, each with the chord
// the Shortcuts page shows for it right now.

import {
	type AppCommand,
	type AppCommandContext,
	type AppCommandUnavailable,
	appCommandApplies,
	appCommands,
	type RunnableAppCommandId,
} from "@/lib/commands/appCommands";
import { t } from "@/lib/i18n";
import type { NativeSearchItem } from "@/lib/search/nativeSearch";
import {
	resolveShortcuts,
	type ShortcutOverrides,
} from "@/lib/settings/shortcutBindings";

const UNAVAILABLE_DETAIL: Record<AppCommandUnavailable, string> = {
	"keyboard-only": "search.appCommand.keyboardOnly",
	"already-open": "search.appCommand.alreadyOpen",
};

function commandItem(
	command: AppCommand,
	keys: readonly (readonly string[])[] | undefined,
): NativeSearchItem {
	const { unavailable } = command;
	return {
		id: `command:app:${command.id}`,
		kind: "command",
		title: t(command.title),
		detail: t(
			unavailable ? UNAVAILABLE_DETAIL[unavailable] : "search.appCommand.label",
		),
		// The id keeps every command findable in English under any UI language.
		keywords: [command.id.replace(/-/g, " "), ...(command.keywords ?? [])],
		...(keys && keys.length > 0 ? { shortcut: keys } : {}),
		action: unavailable
			? { type: "unavailable" }
			: { type: "app-command", command: command.id as RunnableAppCommandId },
	};
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
		.map((command) =>
			commandItem(
				command,
				command.shortcutId ? keysById.get(command.shortcutId) : undefined,
			),
		);
}
