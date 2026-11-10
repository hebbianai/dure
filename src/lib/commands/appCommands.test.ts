import { describe, expect, it } from "vitest";
import {
	type AppCommandContext,
	appCommandApplies,
	appCommandSpaceTargets,
	appCommands,
} from "@/lib/commands/appCommands";
import { t } from "@/lib/i18n";
import { rankNativeSearchItems } from "@/lib/search/nativeSearch";
import { appCommandSearchItems } from "@/lib/search/nativeSearchAppCommands";
import { resolveShortcuts } from "@/lib/settings/shortcutBindings";
import { allShortcuts } from "@/lib/settings/settingsShortcuts";

const SPACES = [
	{ id: "desk-main", name: "Main" },
	{ id: "desk-api", name: "api-server" },
	{ id: "desk-plan", name: "planner" },
];

const EVERYTHING: AppCommandContext = {
	spaces: SPACES,
	activeSpaceId: "desk-main",
	hasActivePane: true,
	canBalancePanes: true,
	canUndoPaneMove: true,
	hasNextUp: true,
	devBuild: true,
	proInterface: true,
};

const NOTHING: AppCommandContext = {
	spaces: [SPACES[0]],
	activeSpaceId: "desk-main",
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

function spaceRows(context = EVERYTHING) {
	return appCommandSearchItems(context, {}).filter((item) =>
		item.id.startsWith("command:app:switch-desktop:"),
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
			if (shortcut.id === "switch-desktop") {
				// The range is listed once per Space, each row with its own step.
				expect(spaceRows().map((item) => item.shortcut)).toEqual([
					[["⌘", "2"]],
					[["⌘", "3"]],
				]);
				continue;
			}
			expect(itemFor(shortcut.id)?.shortcut).toEqual(shortcut.keys);
		}
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
		for (const id of ["term-kill-line", "native-search"]) {
			expect(itemFor(id, NOTHING)?.action, id).toEqual({ type: "unavailable" });
		}
		expect(itemFor("new-terminal")?.action).toEqual({
			type: "app-command",
			command: "new-terminal",
		});
	});
});

describe("Space commands", () => {
	it("offers a switch to every other Space, in tab-strip order", () => {
		const rows = spaceRows();
		expect(rows.map(({ title }) => title)).toEqual([
			t("search.appCommand.switchToSpace", { name: "api-server" }),
			t("search.appCommand.switchToSpace", { name: "planner" }),
		]);
		expect(rows.map(({ action }) => action)).toEqual([
			{ type: "app-command", command: "switch-desktop", spaceId: "desk-api" },
			{ type: "app-command", command: "switch-desktop", spaceId: "desk-plan" },
		]);
	});

	it("keeps each Space's ⌘n when the active Space is not first", () => {
		const rows = spaceRows({ ...EVERYTHING, activeSpaceId: "desk-api" });
		expect(
			rows.map(({ action, shortcut }) => [
				action.type === "app-command" && "spaceId" in action
					? action.spaceId
					: undefined,
				shortcut,
			]),
		).toEqual([
			["desk-main", [["⌘", "1"]]],
			["desk-plan", [["⌘", "3"]]],
		]);
	});

	it("has no Space to switch to in a one-Space app", () => {
		expect(spaceRows(NOTHING)).toEqual([]);
	});

	it("lists Spaces past the ninth without keys", () => {
		const spaces = Array.from({ length: 11 }, (_, index) => ({
			id: `desk-${index + 1}`,
			name: `Space ${index + 1}`,
		}));
		const rows = spaceRows({ ...EVERYTHING, spaces, activeSpaceId: "desk-1" });
		expect(rows.map(({ shortcut }) => shortcut?.[0]?.[1])).toEqual([
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"9",
			undefined,
			undefined,
		]);
	});

	it("counts a target's position across the whole strip", () => {
		const targets = appCommandSpaceTargets(EVERYTHING);
		expect(targets.map(({ space, position }) => [space.id, position])).toEqual([
			["desk-api", 2],
			["desk-plan", 3],
		]);
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

	it("finds a Space by its name", () => {
		expect(firstId("> plan")).toBe("command:app:switch-desktop:desk-plan");
		expect(firstId("> switch api")).toBe("command:app:switch-desktop:desk-api");
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
