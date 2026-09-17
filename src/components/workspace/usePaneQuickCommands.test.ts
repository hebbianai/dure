// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStore } from "@/store";
import { usePaneQuickCommands } from "./usePaneQuickCommands";

vi.mock("@/store", async () => {
	const { create } = await import("zustand");
	const { createAppPrefsStoreSlice } = await import(
		"@/lib/settings/appPrefsStoreSlice"
	);
	return { useStore: create(createAppPrefsStoreSlice) };
});
afterEach(cleanup);

it("moves against current preferences, preserving intervening edits and removals", () => {
	const first = {
		id: "first",
		label: "Same label",
		text: "first",
		appendEnter: false,
	};
	const second = { ...first, id: "second", text: "second" };
	useStore.getState().setUiPrefs({ quickCommands: [first, second] });
	const { result } = renderHook(() => usePaneQuickCommands(undefined));
	const move = result.current.move;
	const edited = { ...second, text: "edited\n", appendEnter: true };
	const added = { ...first, id: "added", text: "new" };
	act(() =>
		useStore.getState().setUiPrefs({ quickCommands: [first, edited, added] }),
	);
	const prefs = useStore.getState().uiPrefs;
	act(() => move("second", 1));
	expect(useStore.getState().uiPrefs).toEqual({
		...prefs,
		quickCommands: [first, added, edited],
	});
	act(() => useStore.getState().setUiPrefs({ quickCommands: [first, added] }));
	const afterRemoval = useStore.getState().uiPrefs;
	act(() => move("second", -1));
	expect(useStore.getState().uiPrefs).toBe(afterRemoval);
});
