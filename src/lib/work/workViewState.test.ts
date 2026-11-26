import { describe, expect, it, vi } from "vitest";
import {
	parseWorkViewState,
	serializeWorkViewState,
	WORK_VIEW_DEFAULT,
} from "@/lib/work/workViewState";
import { createWorkViewStore } from "@/lib/work/workViewStore";

describe("workViewState", () => {
	it("round-trips what the main window keeps", () => {
		const state = {
			selected: "agent-1",
			depth: "all" as const,
			grouping: "none" as const,
			resultsOpen: true,
		};
		expect(parseWorkViewState(serializeWorkViewState(state))).toEqual(state);
	});

	it("reads absent, corrupt or foreign state as the defaults", () => {
		expect(parseWorkViewState(null)).toEqual(WORK_VIEW_DEFAULT);
		expect(parseWorkViewState("{not json")).toEqual(WORK_VIEW_DEFAULT);
		expect(
			parseWorkViewState(JSON.stringify({ state: { depth: "all" }, version: 99 })),
		).toEqual(WORK_VIEW_DEFAULT);
		expect(WORK_VIEW_DEFAULT).toEqual({
			selected: null,
			depth: "top",
			grouping: "project",
			resultsOpen: false,
		});
	});

	it("normalizes each field on its own", () => {
		expect(
			parseWorkViewState(
				JSON.stringify({
					state: { selected: "", depth: "deep", grouping: "none", resultsOpen: "yes" },
					version: 1,
				}),
			),
		).toEqual({ ...WORK_VIEW_DEFAULT, grouping: "none" });
	});

	it("saves only when something it keeps changed", () => {
		const save = vi.fn();
		const store = createWorkViewStore(WORK_VIEW_DEFAULT, save);
		store.getState().select("agent-1");
		store.getState().select("agent-1");
		store.getState().setDepth("all");
		expect(save).toHaveBeenCalledTimes(2);
		expect(save).toHaveBeenLastCalledWith({
			...WORK_VIEW_DEFAULT,
			selected: "agent-1",
			depth: "all",
		});
	});
});
