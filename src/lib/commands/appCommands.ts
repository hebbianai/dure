// The app's command registry: what can be asked for by name, when it applies,
// and whether the palette can run it. Title and keys of a shortcut command
// stay in settingsShortcuts, the table the Shortcuts page reads, so the two
// surfaces cannot disagree on a name or a chord. This file adds only what that
// table has no place for. The Record below makes a new shortcut a compile
// error here until someone says how the palette treats it.

import {
	allShortcuts,
	type ShortcutId,
} from "@/lib/settings/settingsShortcuts";

/** What the app looks like at the moment the palette opens. */
export interface AppCommandContext {
	readonly hasActivePane: boolean;
	readonly canBalancePanes: boolean;
	readonly canUndoPaneMove: boolean;
	readonly hasNextUp: boolean;
	/** Pinpointing Dure's own UI needs source locations only dev builds carry. */
	readonly devBuild: boolean;
	/** Basic mode folds Pinpoint away, its shortcut included. */
	readonly proInterface: boolean;
}

type Applies = (context: AppCommandContext) => boolean;

const hasActivePane: Applies = (context) => context.hasActivePane;

/** Why a listed command cannot be run from the palette itself.
 * - keyboard-only: it acts on a focused terminal's input, or needs a digit
 *   the palette has no way to ask for.
 * - already-open: it opens the palette. */
export type AppCommandUnavailable = "keyboard-only" | "already-open";

interface AppCommandBehavior {
	/** Extra search terms. The title and the id are always searchable. */
	readonly keywords?: readonly string[];
	/** Hides the command when it would have nothing to act on. */
	readonly applies?: Applies;
	readonly unavailable?: AppCommandUnavailable;
}

const KEYBOARD_ONLY = "keyboard-only" as const;

const SHORTCUT_COMMANDS = {
	"native-search": {
		keywords: ["palette", "command", "find"],
		unavailable: "already-open",
	},
	"quick-dispatch": { keywords: ["agent", "request", "new", "dispatch"] },
	"toggle-sidebar": { keywords: ["hide", "show", "panel"] },
	"open-settings": { keywords: ["preferences"] },
	"close-pane": { keywords: ["tab"], applies: hasActivePane },
	"new-desktop": { keywords: ["space", "workspace"] },
	"switch-desktop": {
		keywords: ["space", "workspace", "tab"],
		unavailable: KEYBOARD_ONLY,
	},
	"focus-pane-previous": { keywords: ["history", "back"], applies: hasActivePane },
	"focus-pane-next": { keywords: ["history", "forward"], applies: hasActivePane },
	"go-to-next-up": {
		keywords: ["waiting", "attention", "agent"],
		applies: (context) => context.hasNextUp,
	},
	"split-right": { keywords: ["vertical"], applies: hasActivePane },
	"split-below": { keywords: ["horizontal"], applies: hasActivePane },
	"balance-panes": {
		keywords: ["layout", "even", "equalize"],
		applies: (context) => context.canBalancePanes,
	},
	"focus-pane-left": { applies: hasActivePane },
	"focus-pane-right": { applies: hasActivePane },
	"focus-pane-up": { applies: hasActivePane },
	"focus-pane-down": { applies: hasActivePane },
	"toggle-maximize-pane": {
		keywords: ["zoom", "fullscreen", "restore"],
		applies: hasActivePane,
	},
	"undo-pane-move": {
		keywords: ["layout"],
		applies: (context) => context.canUndoPaneMove,
	},
	"font-inc": { keywords: ["zoom", "larger", "bigger"] },
	"font-dec": { keywords: ["zoom", "smaller"] },
	"font-reset": { keywords: ["zoom", "default"] },
	"pinpoint-self": {
		keywords: ["design", "inspect", "element"],
		applies: (context) => context.devBuild,
	},
	"pinpoint-browser": {
		keywords: ["design", "inspect", "element", "browser"],
		applies: (context) => context.proInterface,
	},
	"send-feedback": { keywords: ["bug", "report", "idea", "issue"] },
	"term-copy": { keywords: ["clipboard"], unavailable: KEYBOARD_ONLY },
	"term-kill-line": { keywords: ["delete", "clear"], unavailable: KEYBOARD_ONLY },
	"term-bol": { keywords: ["cursor", "home"], unavailable: KEYBOARD_ONLY },
	"term-eol": { keywords: ["cursor", "end"], unavailable: KEYBOARD_ONLY },
	"term-kill-word": { keywords: ["delete"], unavailable: KEYBOARD_ONLY },
	"term-find": { keywords: ["search", "scrollback"], unavailable: KEYBOARD_ONLY },
} as const satisfies Record<ShortcutId, AppCommandBehavior>;

/** Commands reached from a menu that have no shortcut. Their titles are not in
 * the shortcut table, so they are spelled here. */
const MENU_COMMANDS = {
	"new-terminal": {
		title: "search.appCommand.newTerminal",
		keywords: ["shell"],
	},
	"open-browser": {
		title: "common.openBrowser",
		keywords: ["web", "url", "pane"],
	},
	"open-mobile-simulator": {
		title: "panels.mobile.title",
		keywords: ["ios", "android", "phone", "device"],
	},
	"open-onboarding": {
		title: "common.openGettingStarted",
		keywords: ["guide", "start", "tutorial"],
	},
	"open-token-inspector": {
		title: "search.appCommand.openTokenInspector",
		keywords: ["design", "theme", "color"],
	},
} as const satisfies Record<
	string,
	AppCommandBehavior & { readonly title: string }
>;

type MenuCommandId = keyof typeof MENU_COMMANDS;

type AppCommandId = ShortcutId | MenuCommandId;

type UnavailableCommandId = {
	[Id in keyof typeof SHORTCUT_COMMANDS]: (typeof SHORTCUT_COMMANDS)[Id] extends {
		unavailable: AppCommandUnavailable;
	}
		? Id
		: never;
}[keyof typeof SHORTCUT_COMMANDS];

/** Commands the palette can run. The runner's table is keyed by this. */
export type RunnableAppCommandId = Exclude<AppCommandId, UnavailableCommandId>;

export interface AppCommand extends AppCommandBehavior {
	readonly id: AppCommandId;
	/** Semantic message id or canonical literal, resolved by the surface. */
	readonly title: string;
	/** Set when the Shortcuts page lists this command. */
	readonly shortcutId?: ShortcutId;
}

/** Every app command, in Shortcuts-page order and then the menu-only ones. */
export function appCommands(): AppCommand[] {
	const shortcutCommands = allShortcuts().map((shortcut): AppCommand => {
		const id = shortcut.id as ShortcutId;
		return {
			...SHORTCUT_COMMANDS[id],
			id,
			title: shortcut.command,
			shortcutId: id,
		};
	});
	const menuCommands = (Object.keys(MENU_COMMANDS) as MenuCommandId[]).map(
		(id): AppCommand => ({ ...MENU_COMMANDS[id], id }),
	);
	return [...shortcutCommands, ...menuCommands];
}

export function appCommandApplies(
	command: AppCommand,
	context: AppCommandContext,
): boolean {
	return command.applies?.(context) ?? true;
}
