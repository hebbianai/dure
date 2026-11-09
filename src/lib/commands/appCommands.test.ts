import { describe, expect, it } from "vitest";
import {
	type AppCommandContext,
	appCommandApplies,
	appCommands,
} from "@/lib/commands/appCommands";
import { rankNativeSearchItems } from "@/lib/search/nativeSearch";
import { appCommandSearchItems } from "@/lib/search/nativeSearchAppCommands";
import { resolveShortcuts } from "@/lib/settings/shortcutBindings";
import { allShortcuts } from "@/lib/settings/settingsShortcuts";

const EVERYTHING: AppCommandContext = {
	hasActivePane: true,
	canBalancePanes: true,
	canUndoPaneMove: true,
	hasNextUp: true,
	devBuild: true,
	proInterface: true,
};

const NOTHING: AppCommandContext = {
	hasActivePane: false,
	canBalancePanes: false,
	canUndoPaneMove: false,
	hasNextUp: false,
	devBuild: false,
	proInterface: false,
};

function itemFor(id: string, context = EVERYTHING, overrides = {}) {
	return appCommandSearchItems(context, overrides).find(
		(item) => item.id === `command:app:${id}`,
	);
}

describe("app command registry", () => {
	it("has one entry per command id", () => {
		const ids = appCommands().map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("lists every shortcut on the Shortcuts page, with that page's keys", () => {
		const resolved = resolveShortcuts({});
		expect(resolved.length).toBeGreaterThan(0);
		for (const shortcut of resolved) {
			expect(itemFor(shortcut.id)?.shortcut).toEqual(shortcut.keys);
		}
	});

	it("shows a range shortcut in the page's notation", () => {
		expect(itemFor("switch-desktop")?.shortcut).toEqual([
			["⌘", "1"],
			["…"],
			["⌘", "9"],
		]);
	});

	it("follows a remapped shortcut and drops a cleared one", () => {
		const remapped = {
			"split-right": { mod: true, shift: false, alt: true, key: "r" },
		};
		expect(itemFor("split-right", EVERYTHING, remapped)?.shortcut).toEqual([
			["⌘", "⌥", "R"],
		]);
		expect(
			itemFor("split-right", EVERYTHING, { "split-right": null })?.shortcut,
		).toBeUndefined();
	});

	it("gives menu-only commands no shortcut", () => {
		const shortcutIds = new Set(allShortcuts().map(({ id }) => id));
		const menuOnly = appCommands().filter(({ id }) => !shortcutIds.has(id));
		expect(menuOnly.map(({ id }) => id)).toContain("new-terminal");
		for (const command of menuOnly) {
			expect(itemFor(command.id)?.shortcut).toBeUndefined();
		}
	});
});

describe("app command context", () => {
	it("hides commands with nothing to act on", () => {
		for (const id of [
			"close-pane",
			"split-right",
			"balance-panes",
			"undo-pane-move",
			"go-to-next-up",
			"pinpoint-self",
			"pinpoint-browser",
		]) {
			expect(itemFor(id, EVERYTHING), id).toBeDefined();
			expect(itemFor(id, NOTHING), id).toBeUndefined();
		}
	});

	it("keeps context-free commands in an empty app", () => {
		for (const id of ["new-terminal", "open-settings", "new-desktop"]) {
			expect(itemFor(id, NOTHING), id).toBeDefined();
		}
	});

	it("scopes each pane requirement to its own fact", () => {
		const balance = appCommands().find(({ id }) => id === "balance-panes");
		expect(balance).toBeDefined();
		if (!balance) return;
		expect(
			appCommandApplies(balance, { ...EVERYTHING, canBalancePanes: false }),
		).toBe(false);
		expect(
			appCommandApplies(balance, { ...NOTHING, canBalancePanes: true }),
		).toBe(true);
	});

	it("lists keyboard-only commands without a runnable action", () => {
		for (const id of ["term-kill-line", "switch-desktop", "native-search"]) {
			expect(itemFor(id, NOTHING)?.action, id).toEqual({ type: "unavailable" });
		}
		expect(itemFor("new-terminal")?.action).toEqual({
			type: "app-command",
			command: "new-terminal",
		});
	});
});

describe("app command matching", () => {
	const items = appCommandSearchItems(EVERYTHING, {});
	const firstId = (query: string) => rankNativeSearchItems(items, query)[0]?.id;

	it("finds a command by an abbreviation of its name", () => {
		expect(firstId("> splr")).toBe("command:app:split-right");
	});

	it("finds a command by its English id under any UI language", () => {
		expect(firstId("> toggle sidebar")).toBe("command:app:toggle-sidebar");
	});

	it("finds a command by a keyword that is not in its title", () => {
		expect(
			rankNativeSearchItems(items, "> equalize").map(({ id }) => id),
		).toContain("command:app:balance-panes");
	});

	it("does not start the list on a row Enter cannot run", () => {
		const scoped = rankNativeSearchItems(items, ">", 200);
		expect(scoped[0]?.action.type).toBe("app-command");
		const firstUnavailable = scoped.findIndex(
			({ action }) => action.type === "unavailable",
		);
		expect(
			scoped.slice(firstUnavailable).every(
				({ action }) => action.type === "unavailable",
			),
		).toBe(true);
	});

	it("scopes to commands with the > prefix and returns all of them", () => {
		const scoped = rankNativeSearchItems(items, ">", 200);
		expect(scoped).toHaveLength(items.length);
		expect(scoped.every(({ kind }) => kind === "command")).toBe(true);
	});
});
