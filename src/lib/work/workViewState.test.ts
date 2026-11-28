import { describe, expect, it, vi } from "vitest";
import {
	parseWorkViewState,
	serializeWorkViewState,
	WORK_VIEW_DEFAULT,
	withFoldOpen,
	withPinMoved,
	workDetailColumns,
} from "@/lib/work/workViewState";
import { RESULTS_TODAY_FOLD_KEY } from "@/lib/work/workViewList";
import { createWorkViewStore } from "@/lib/work/workViewStore";

describe("workViewState", () => {
	it("round-trips what the main window keeps", () => {
		const state = {
			selected: "agent-1",
			depth: "all" as const,
			grouping: "none" as const,
			openFolds: ["results-today", "ended:project:p-app"],
			managedOpen: false,
			pinned: ["lead-app", "lead-api"],
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
			openFolds: [],
			managedOpen: true,
			pinned: [],
		});
	});

	it("reads the open results of a state saved before folds were keyed", () => {
		const saved = (resultsOpen: boolean) =>
			parseWorkViewState(
				JSON.stringify({
					state: { selected: null, depth: "top", grouping: "project", resultsOpen },
					version: 1,
				}),
			).openFolds;
		expect(saved(true)).toEqual([RESULTS_TODAY_FOLD_KEY]);
		expect(saved(false)).toEqual([]);
	});

	it("reads a state saved before pins and the managed fold existed with none pinned and the fold open", () => {
		expect(
			parseWorkViewState(
				JSON.stringify({
					state: { selected: "agent-1", depth: "all", grouping: "project", resultsOpen: false },
					version: 1,
				}),
			),
		).toEqual({ ...WORK_VIEW_DEFAULT, selected: "agent-1", depth: "all" });
	});

	it("normalizes each field on its own", () => {
		expect(
			parseWorkViewState(
				JSON.stringify({
					state: {
						selected: "",
						depth: "deep",
						grouping: "none",
						openFolds: "results-today",
						managedOpen: "no",
						pinned: ["a", "", 7, "a", "b"],
					},
					version: 1,
				}),
			),
		).toEqual({ ...WORK_VIEW_DEFAULT, grouping: "none", pinned: ["a", "b"] });
	});

	it("saves only when something it keeps changed", () => {
		const save = vi.fn();
		const store = createWorkViewStore(WORK_VIEW_DEFAULT, save);
		store.getState().select("agent-1");
		store.getState().select("agent-1");
		store.getState().setDepth("all");
		store.getState().setManagedOpen(false);
		store.getState().setManagedOpen(false);
		expect(save).toHaveBeenCalledTimes(3);
		expect(save).toHaveBeenLastCalledWith({
			...WORK_VIEW_DEFAULT,
			selected: "agent-1",
			depth: "all",
			managedOpen: false,
		});
	});

	it("pins, moves and unpins columns and saves each change", () => {
		const save = vi.fn();
		const store = createWorkViewStore(WORK_VIEW_DEFAULT, save);
		const { pin, unpin, movePin } = store.getState();
		pin("lead-app");
		pin("lead-api");
		pin("lead-app");
		expect(store.getState().pinned).toEqual(["lead-app", "lead-api"]);
		movePin("lead-api", -1);
		expect(store.getState().pinned).toEqual(["lead-api", "lead-app"]);
		// Either end, or an agent that is not pinned, leaves the order alone.
		movePin("lead-api", -1);
		movePin("lead-app", 1);
		movePin("other", 1);
		unpin("other");
		expect(store.getState().pinned).toEqual(["lead-api", "lead-app"]);
		unpin("lead-api");
		expect(store.getState().pinned).toEqual(["lead-app"]);
		expect(save).toHaveBeenCalledTimes(4);
		expect(save).toHaveBeenLastCalledWith({
			...WORK_VIEW_DEFAULT,
			pinned: ["lead-app"],
		});
	});

	it("keeps a pinned agent that was removed until it is unpinned", () => {
		const store = createWorkViewStore(
			parseWorkViewState(
				serializeWorkViewState({ ...WORK_VIEW_DEFAULT, pinned: ["gone"] }),
			),
		);
		expect(workDetailColumns(store.getState())).toEqual([
			{ key: "gone", pinned: true, selected: false },
		]);
	});
});

describe("withFoldOpen", () => {
	const listFolds = ["ended:project:a", "ended:project:b", RESULTS_TODAY_FOLD_KEY];
	it("opens and closes a fold", () => {
		const opened = withFoldOpen([], "ended:project:a", true, listFolds);
		expect(opened).toEqual(["ended:project:a"]);
		expect(withFoldOpen(opened, "ended:project:a", false, listFolds)).toEqual([]);
		// Unchanged state keeps its identity, so nothing is saved.
		expect(withFoldOpen(opened, "ended:project:a", true, listFolds)).toBe(opened);
	});

	it("forgets a saved fold that matches none the list has now", () => {
		expect(
			withFoldOpen(
				["ended:project:gone", RESULTS_TODAY_FOLD_KEY],
				"ended:project:b",
				true,
				listFolds,
			),
		).toEqual([RESULTS_TODAY_FOLD_KEY, "ended:project:b"]);
	});

	it("saves a fold toggled through the store", () => {
		const save = vi.fn();
		const store = createWorkViewStore(WORK_VIEW_DEFAULT, save);
		store.getState().setFoldOpen(RESULTS_TODAY_FOLD_KEY, true, listFolds);
		expect(save).toHaveBeenLastCalledWith({
			...WORK_VIEW_DEFAULT,
			openFolds: [RESULTS_TODAY_FOLD_KEY],
		});
	});
});

describe("workDetailColumns", () => {
	it("puts the pinned agents first in their order, then the selection", () => {
		expect(
			workDetailColumns({ pinned: ["lead-app", "lead-api"], selected: "worker" }),
		).toEqual([
			{ key: "lead-app", pinned: true, selected: false },
			{ key: "lead-api", pinned: true, selected: false },
			{ key: "worker", pinned: false, selected: true },
		]);
	});

	it("marks a pinned selection instead of adding a second column", () => {
		expect(
			workDetailColumns({ pinned: ["lead-app", "lead-api"], selected: "lead-api" }),
		).toEqual([
			{ key: "lead-app", pinned: true, selected: false },
			{ key: "lead-api", pinned: true, selected: true },
		]);
		expect(workDetailColumns({ pinned: [], selected: null })).toEqual([]);
	});

	it("keeps a selection's column in place when it is pinned", () => {
		const before = workDetailColumns({ pinned: ["lead-app"], selected: "worker" });
		const after = workDetailColumns({
			pinned: ["lead-app", "worker"],
			selected: "worker",
		});
		expect(after.map((column) => column.key)).toEqual(
			before.map((column) => column.key),
		);
		expect(withPinMoved(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
	});
});
