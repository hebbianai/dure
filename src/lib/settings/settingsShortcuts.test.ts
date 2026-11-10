import { describe, expect, it } from "vitest";

import {
	conflictingShortcutIds,
	resolveShortcuts,
	shortcutChord,
} from "@/lib/settings/shortcutBindings";
import {
	allShortcuts,
	shortcutDefinition,
	shortcutGroups,
	switchDesktopKeys,
} from "@/lib/settings/settingsShortcuts";

describe("shortcut definitions", () => {
	it("deep-freezes the shared defaults used by hot-path lookups", () => {
		const definition = shortcutDefinition("close-pane");
		expect(definition).toBeDefined();
		expect(Object.isFrozen(definition)).toBe(true);
		expect(Object.isFrozen(definition?.keys)).toBe(true);
		expect(definition?.keys.every(Object.isFrozen)).toBe(true);
		expect(Reflect.set(definition?.keys[0] ?? [], 1, "Q")).toBe(false);

		const projected = allShortcuts().find(
			(shortcut) => shortcut.id === "close-pane",
		);
		expect(projected?.keys).toBe(definition?.keys);
		expect(shortcutDefinition("close-pane")?.keys).toEqual([["⌘", "W"]]);
	});

	it("lists the pane maximize toggle in Settings on the platform modifier", () => {
		const global = shortcutGroups().find((group) => group.group === "Global");
		expect(global?.items.map((item) => item.id)).toContain(
			"toggle-maximize-pane",
		);
		expect(shortcutDefinition("toggle-maximize-pane")).toMatchObject({
			command: "settings.shortcuts.cmd.toggleMaximizePane",
			keys: [["⌘", "⇧", "↵"]],
			source: "app",
		});
		// ⌘ is the platform modifier: Command on macOS, Ctrl elsewhere.
		expect(shortcutChord("toggle-maximize-pane", {})).toEqual({
			mod: true,
			shift: true,
			alt: false,
			key: "enter",
		});
		expect(
			conflictingShortcutIds(resolveShortcuts({})).has("toggle-maximize-pane"),
		).toBe(false);
	});

	it("spells each step of the Space range the way the range itself does", () => {
		const range = shortcutDefinition("switch-desktop")?.keys;
		expect(range).toEqual([["⌘", "1"], ["…"], ["⌘", "9"]]);
		expect(switchDesktopKeys(1)).toEqual(range?.[0]);
		expect(switchDesktopKeys(3)).toEqual(["⌘", "3"]);
		expect(switchDesktopKeys(9)).toEqual(range?.[2]);
		for (const outside of [0, 10, 2.5, -1]) {
			expect(switchDesktopKeys(outside), String(outside)).toBeUndefined();
		}
	});
});
