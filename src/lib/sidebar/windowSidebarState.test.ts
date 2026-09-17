import { describe, expect, it, vi } from "vitest";
import {
	AUXILIARY_WINDOW_SIDEBAR_DEFAULT,
	initialWindowSidebarState,
	MAIN_WINDOW_SIDEBAR_DEFAULT,
	serializeWindowSidebarState,
	windowSidebarScope,
} from "@/lib/sidebar/windowSidebarState";
import { createWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";

describe("window sidebar state", () => {
	it("restores Space for an old plugin tab with no saved container", () => {
		const saved = JSON.stringify({
			state: { open: true, width: 360, tab: "plugin" },
			version: 1,
		});
		expect(initialWindowSidebarState("main", saved, null)).toMatchObject({
			open: true,
			width: 360,
			tab: "spaces",
		});
	});
	it("persists plugin container and view changes only through its own window writer", () => {
		const save = vi.fn();
		const main = createWindowSidebarStore(MAIN_WINDOW_SIDEBAR_DEFAULT, save);
		const auxiliary = createWindowSidebarStore(
			AUXILIARY_WINDOW_SIDEBAR_DEFAULT,
		);
		const selection = { containerKey: "tracker", viewId: "claims" };
		main.getState().openPluginView(selection);
		expect(main.getState()).toMatchObject({
			open: true,
			tab: "plugin",
			pluginSelection: selection,
		});
		expect(auxiliary.getState().pluginSelection).toBeNull();
		expect(auxiliary.getState().open).toBe(false);
		expect(save).toHaveBeenLastCalledWith({
			...MAIN_WINDOW_SIDEBAR_DEFAULT,
			tab: "plugin",
			pluginSelection: selection,
		});
		main.getState().selectPluginView({ ...selection, viewId: "other" });
		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith({
			...MAIN_WINDOW_SIDEBAR_DEFAULT,
			tab: "plugin",
			pluginSelection: { ...selection, viewId: "other" },
		});
		main.getState().selectPluginView({ ...selection, viewId: "other" });
		expect(save).toHaveBeenCalledTimes(2);
		main.getState().openPluginView({ containerKey: "second", viewId: "inbox" });
		const persisted = serializeWindowSidebarState(
			save.mock.calls[save.mock.calls.length - 1][0],
		);
		expect(initialWindowSidebarState("main", persisted, null)).toMatchObject({
			tab: "plugin",
			pluginSelection: { containerKey: "second", viewId: "inbox" },
		});
		expect(initialWindowSidebarState("auxiliary", persisted, null)).toEqual(
			AUXILIARY_WINDOW_SIDEBAR_DEFAULT,
		);
	});
	it("retires a missing plugin route and active tab in one saved snapshot", () => {
		const save = vi.fn();
		const store = createWindowSidebarStore(
			{
				open: false,
				width: 412,
				tab: "plugin",
				pluginSelection: { containerKey: "missing", viewId: null },
			},
			save,
		);
		store.getState().selectPluginView(null);
		expect(save).toHaveBeenCalledExactlyOnceWith({
			open: false,
			width: 412,
			tab: "spaces",
			pluginSelection: null,
		});
		store.getState().setTab("files");
		store.getState().selectPluginView(null);
		expect(store.getState().tab).toBe("files");
	});
	it.each([
		null,
		{},
		{ containerKey: "", viewId: null },
		{ containerKey: "tracker", viewId: 3 },
	])("does not restore an incomplete plugin route: %j", (pluginSelection) => {
		const saved = JSON.stringify({
			state: { open: false, width: 360, tab: "plugin", pluginSelection },
		});
		expect(initialWindowSidebarState("main", saved, null)).toEqual({
			open: false,
			width: 360,
			tab: "spaces",
			pluginSelection: null,
		});
	});
	it("does not migrate a legacy plugin tab into an arbitrary plugin", () => {
		const legacy = JSON.stringify({
			state: { sidebarTab: "plugin", sidebarOpen: true, sidebarWidth: 400 },
		});
		expect(initialWindowSidebarState("main", null, legacy)).toEqual({
			open: true,
			width: 400,
			tab: "spaces",
			pluginSelection: null,
		});
	});
	it("classifies a Desktop URL as an independent auxiliary window", () => {
		expect(windowSidebarScope("?desktop=desk-2")).toBe("auxiliary");
		expect(windowSidebarScope("")).toBe("main");
	});

	it("starts a newly created Desktop window with only the activity rail visible", () => {
		expect(initialWindowSidebarState("auxiliary", null, null)).toEqual(
			AUXILIARY_WINDOW_SIDEBAR_DEFAULT,
		);
		expect(AUXILIARY_WINDOW_SIDEBAR_DEFAULT.open).toBe(false);
	});

	it("migrates the main window's legacy shared presentation values", () => {
		const legacy = JSON.stringify({
			state: {
				sidebarOpen: false,
				sidebarWidth: 412,
				sidebarTab: "files",
			},
			version: 3,
		});

		expect(initialWindowSidebarState("main", null, legacy)).toEqual({
			open: false,
			width: 412,
			tab: "files",
			pluginSelection: null,
		});
	});

	it("prefers the dedicated main-window state after migration", () => {
		const dedicated = serializeWindowSidebarState({
			open: true,
			width: 360,
			tab: "recovery",
			pluginSelection: null,
		});
		const legacy = JSON.stringify({
			state: {
				sidebarOpen: false,
				sidebarWidth: 240,
				sidebarTab: "search",
			},
		});

		expect(initialWindowSidebarState("main", dedicated, legacy)).toEqual({
			open: true,
			width: 360,
			tab: "recovery",
			pluginSelection: null,
		});
	});

	it("keeps each window store independent and persists only through its own writer", () => {
		const saveMain = vi.fn();
		const main = createWindowSidebarStore(
			MAIN_WINDOW_SIDEBAR_DEFAULT,
			saveMain,
		);
		const auxiliary = createWindowSidebarStore(
			AUXILIARY_WINDOW_SIDEBAR_DEFAULT,
		);

		auxiliary.getState().toggle();
		auxiliary.getState().setTab("files");
		auxiliary.getState().setWidth(420);

		expect(auxiliary.getState()).toMatchObject({
			open: true,
			width: 420,
			tab: "files",
		});
		expect(main.getState()).toMatchObject(MAIN_WINDOW_SIDEBAR_DEFAULT);
		expect(saveMain).not.toHaveBeenCalled();

		main.getState().toggle();
		expect(main.getState().open).toBe(false);
		expect(auxiliary.getState().open).toBe(true);
		expect(saveMain).toHaveBeenCalledWith({
			open: false,
			width: MAIN_WINDOW_SIDEBAR_DEFAULT.width,
			tab: MAIN_WINDOW_SIDEBAR_DEFAULT.tab,
			pluginSelection: null,
		});
	});

	it("writes a migrated main-window snapshot before shared state can drop legacy fields", () => {
		const saveMain = vi.fn();
		createWindowSidebarStore(
			{ open: false, width: 412, tab: "files", pluginSelection: null },
			saveMain,
			true,
		);

		expect(saveMain).toHaveBeenCalledOnce();
		expect(saveMain).toHaveBeenCalledWith({
			open: false,
			width: 412,
			tab: "files",
			pluginSelection: null,
		});
	});
});
