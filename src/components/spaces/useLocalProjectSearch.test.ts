// @vitest-environment jsdom
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LocalFolderSuggestion } from "@/lib/spaces/localFolderSuggestions";
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/lib/spaces/localProjectSearch", () => ({
	searchLocalProjects: mocks.search,
}));
import { useLocalProjectSearch } from "./useLocalProjectSearch";

beforeEach(() => {
	vi.useFakeTimers();
	mocks.search.mockReset();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

it("debounces typing and ignores an older search that finishes after the current query", async () => {
	let finishOld!: (results: LocalFolderSuggestion[]) => void;
	mocks.search
		.mockReturnValueOnce(
			new Promise((resolve) => {
				finishOld = resolve;
			}),
		)
		.mockResolvedValueOnce([]);
	const { result, rerender } = renderHook(
		({ query }) => useLocalProjectSearch(true, query),
		{ initialProps: { query: "a" } },
	);
	rerender({ query: "atlas" });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
	expect(mocks.search).toHaveBeenCalledTimes(1);
	expect(mocks.search).toHaveBeenCalledWith("atlas");
	rerender({ query: "new" });
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
	await act(async () => {
		finishOld([
			{
				path: "/atlas",
				name: "atlas",
				isRepo: true,
				sessionCount: 0,
				lastMtime: 0,
			},
		]);
	});
	expect(result.current).toEqual({ results: [], loading: false, error: false });
	rerender({ query: "" });
	expect(result.current.loading).toBe(false);
});

it("exposes failure separately from an empty result and clears it with the query", async () => {
	mocks.search.mockRejectedValueOnce(new Error("unavailable"));
	const { result, rerender } = renderHook(
		({ query }) => useLocalProjectSearch(true, query),
		{ initialProps: { query: "atlas" } },
	);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(200);
	});
	expect(result.current.error).toBe(true);
	rerender({ query: "" });
	expect(result.current.error).toBe(false);
});
