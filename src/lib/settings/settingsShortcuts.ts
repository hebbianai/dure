// Canonical shortcuts wired into the app. Binding definitions stay semantic
// and allocation-free; the Settings surface resolves message IDs with t().

/** A shortcut shown in Settings. `command` is a semantic message ID or a
 * canonical literal, and `keys` lists simultaneous key-cap sequences. */
export interface Shortcut {
	readonly id: string;
	readonly command: string;
	readonly keys: readonly (readonly string[])[];
	readonly source: "app" | "terminal";
}

export type ShortcutDefinition = Omit<Shortcut, "id">;

function shortcut(
	source: ShortcutDefinition["source"],
	command: string,
	...keys: (readonly string[])[]
): ShortcutDefinition {
	for (const sequence of keys) Object.freeze(sequence);
	return Object.freeze({ command, keys: Object.freeze(keys), source });
}

function appShortcut(
	command: string,
	...keys: (readonly string[])[]
): ShortcutDefinition {
	return shortcut("app", command, ...keys);
}

function terminalShortcut(
	command: string,
	...keys: (readonly string[])[]
): ShortcutDefinition {
	return shortcut("terminal", command, ...keys);
}

const SHORTCUT_DEFINITIONS = Object.freeze({
	"native-search": appShortcut("common.unifiedSearch", ["⌘", "P"]),
	"quick-dispatch": appShortcut("agents.quickDispatch.command", ["⌘", "N"]),
	"toggle-sidebar": appShortcut("settings.shortcuts.cmd.toggleSidebar", [
		"⌘",
		"S",
	]),
	"open-settings": appShortcut("common.openSettings", ["⌘", ","]),
	"close-pane": appShortcut("settings.shortcuts.cmd.closePane", ["⌘", "W"]),
	"new-desktop": appShortcut("common.newDesktop", ["⌘", "⇧", "T"]),
	"switch-desktop": appShortcut(
		"settings.shortcuts.cmd.switchDesktop",
		["⌘", "1"],
		["…"],
		["⌘", "9"],
	),
	"focus-pane-previous": appShortcut(
		"settings.shortcuts.cmd.focusPanePrevious",
		["⌘", "["],
	),
	"focus-pane-next": appShortcut("settings.shortcuts.cmd.focusPaneNext", [
		"⌘",
		"]",
	]),
	// ⇧ because the chord matcher reads Ctrl as ⌘, and a bare Ctrl+J is the
	// newline agent CLIs take in the very terminals this walks between.
	"go-to-next-up": appShortcut("settings.shortcuts.cmd.goToNextUp", [
		"⌘",
		"⇧",
		"J",
	]),
	"split-right": appShortcut("settings.shortcuts.cmd.splitRight", ["⌘", "D"]),
	"split-below": appShortcut("settings.shortcuts.cmd.splitBelow", [
		"⌘",
		"⇧",
		"D",
	]),
	// ⌘⇧B, not an ⌥ chord: on macOS ⌥ rewrites event.key for letters and
	// symbols (⌥= arrives as ≠), and the chord matcher reads event.key.
	"balance-panes": appShortcut("workspace.desktopBar.balancePanes", [
		"⌘",
		"⇧",
		"B",
	]),
	"focus-pane-left": appShortcut("settings.shortcuts.cmd.focusPaneLeft", [
		"⌥",
		"⌘",
		"←",
	]),
	"focus-pane-right": appShortcut("settings.shortcuts.cmd.focusPaneRight", [
		"⌥",
		"⌘",
		"→",
	]),
	"focus-pane-up": appShortcut("settings.shortcuts.cmd.focusPaneUp", [
		"⌥",
		"⌘",
		"↑",
	]),
	"focus-pane-down": appShortcut("settings.shortcuts.cmd.focusPaneDown", [
		"⌥",
		"⌘",
		"↓",
	]),
	// ⌘ is Ctrl outside macOS (Ctrl+Shift+Enter). paneShortcuts consumes the
	// chord in capture, so a focused terminal or agent TUI never receives it.
	"toggle-maximize-pane": appShortcut(
		"settings.shortcuts.cmd.toggleMaximizePane",
		["⌘", "⇧", "↵"],
	),
	"undo-pane-move": appShortcut("settings.shortcuts.cmd.undoPaneMove", [
		"⌘",
		"Z",
	]),
	"font-inc": appShortcut("settings.shortcuts.cmd.fontIncrease", ["⌘", "+"]),
	"font-dec": appShortcut("settings.shortcuts.cmd.fontDecrease", ["⌘", "−"]),
	"font-reset": appShortcut("settings.shortcuts.cmd.fontReset", ["⌘", "0"]),
	"pinpoint-self": appShortcut("settings.shortcuts.cmd.pinpointSelf", [
		"⌥",
		"⇧",
		"D",
	]),
	"pinpoint-browser": appShortcut("settings.shortcuts.cmd.pinpointBrowser", [
		"⌥",
		"⇧",
		"B",
	]),
	"send-feedback": appShortcut("feedback.command", ["⌘", "⇧", "/"]),
	"term-copy": terminalShortcut("settings.shortcuts.cmd.termCopy", ["⌘", "C"]),
	"term-kill-line": terminalShortcut("settings.shortcuts.cmd.termKillLine", [
		"⌘",
		"⌫",
	]),
	"term-bol": terminalShortcut("settings.shortcuts.cmd.termLineStart", [
		"⌘",
		"←",
	]),
	"term-eol": terminalShortcut("settings.shortcuts.cmd.termLineEnd", [
		"⌘",
		"→",
	]),
	"term-kill-word": terminalShortcut("settings.shortcuts.cmd.termKillWord", [
		"⌥",
		"⌫",
	]),
	// ⌘F on macOS; Ctrl+Shift+F elsewhere so the shell keeps Ctrl+F
	// (lib/terminal/interaction/terminalFind).
	"term-find": terminalShortcut("settings.shortcuts.cmd.termFind", ["⌘", "F"]),
} satisfies Record<string, ShortcutDefinition>);

export type ShortcutId = keyof typeof SHORTCUT_DEFINITIONS;

interface ShortcutGroupDefinition {
	group: string;
	items: readonly ShortcutId[];
}

const SHORTCUT_GROUPS = [
	{
		group: "Global",
		items: [
			"native-search",
			"quick-dispatch",
			"open-settings",
			"toggle-sidebar",
			"close-pane",
			"new-desktop",
			"switch-desktop",
			"focus-pane-previous",
			"focus-pane-next",
			"go-to-next-up",
			"split-right",
			"split-below",
			"balance-panes",
			"focus-pane-left",
			"focus-pane-right",
			"focus-pane-up",
			"focus-pane-down",
			"toggle-maximize-pane",
			"undo-pane-move",
			"send-feedback",
		],
	},
	{
		group: "settings.shortcuts.group.terminalDisplay",
		items: ["font-inc", "font-dec", "font-reset", "term-find"],
	},
	{
		group: "Pinpoint",
		items: ["pinpoint-self", "pinpoint-browser"],
	},
	{
		group: "settings.shortcuts.group.terminalEditing",
		items: [
			"term-copy",
			"term-kill-line",
			"term-bol",
			"term-eol",
			"term-kill-word",
		],
	},
] as const satisfies readonly ShortcutGroupDefinition[];

export function shortcutDefinition(id: string): ShortcutDefinition | undefined {
	const definition = SHORTCUT_DEFINITIONS[id as ShortcutId] as
		| ShortcutDefinition
		| undefined;
	return definition && Array.isArray(definition.keys) ? definition : undefined;
}

/** Settings projection. Copy is resolved by the rendering surface so a
 * language change never freezes translated strings at module scope. */
export function shortcutGroups(): { group: string; items: Shortcut[] }[] {
	return SHORTCUT_GROUPS.map((group) => ({
		group: group.group,
		items: group.items.map((id) => ({ id, ...SHORTCUT_DEFINITIONS[id] })),
	}));
}

export function allShortcuts(): Shortcut[] {
	return shortcutGroups().flatMap((group) => group.items);
}
