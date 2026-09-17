import { describe, expect, it } from "vitest";

import {
	allShortcuts,
	shortcutDefinition,
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
});
