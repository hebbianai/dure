// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMountedAgentClaimPanes } from "./useAgentClaimPanes";

type SourceState = {
	layouts: Record<string, unknown>;
	spaces: Array<{ id: string }>;
	agents: Array<{ id: string; name?: string }>;
};
type HiddenState = { hidden: Record<string, { desktopId: string; paneId: string }> };

const sources = vi.hoisted(() => ({
	main: { layouts: {}, spaces: [], agents: [] } as SourceState,
	hidden: { hidden: {} } as HiddenState,
	mainListeners: new Set<(next: SourceState, previous: SourceState) => void>(),
	hiddenListeners: new Set<
		(next: HiddenState, previous: HiddenState) => void
	>(),
}));

vi.mock("@/store", () => ({
	useStore: {
		getState: () => sources.main,
		subscribe: (
			listener: (next: SourceState, previous: SourceState) => void,
		) => {
			sources.mainListeners.add(listener);
			return () => sources.mainListeners.delete(listener);
		},
	},
}));
vi.mock("@/lib/workspace/pane/hiddenPanesStore", () => ({
	useHiddenPanes: {
		getState: () => sources.hidden,
		subscribe: (
			listener: (next: HiddenState, previous: HiddenState) => void,
		) => {
			sources.hiddenListeners.add(listener);
			return () => sources.hiddenListeners.delete(listener);
		},
	},
}));

function updateMain(next: Partial<SourceState>) {
	act(() => {
		const previous = sources.main;
		sources.main = { ...previous, ...next };
		for (const listener of sources.mainListeners)
			listener(sources.main, previous);
	});
}
function updateHidden(hidden: HiddenState["hidden"]) {
	act(() => {
		const previous = sources.hidden;
		sources.hidden = { hidden };
		for (const listener of sources.hiddenListeners)
			listener(sources.hidden, previous);
	});
}

afterEach(() => {
	cleanup();
	updateMain({ layouts: {}, spaces: [], agents: [] });
	updateHidden({});
});

describe("agent claim pane observation lifetime", () => {
	it("starts once for consumers and detaches both stores when the last pane leaves", () => {
		expect(sources.mainListeners.size).toBe(0);
		expect(sources.hiddenListeners.size).toBe(0);
		const first = renderHook(() =>
			useMountedAgentClaimPanes("one", "agent:one"),
		);
		const second = renderHook(() =>
			useMountedAgentClaimPanes("two", "agent:two"),
		);
		expect(sources.mainListeners.size).toBe(1);
		expect(sources.hiddenListeners.size).toBe(1);
		expect(first.result.current).toEqual(second.result.current);
		expect(first.result.current).toHaveLength(2);
		first.unmount();
		expect(sources.mainListeners.size).toBe(1);
		second.unmount();
		expect(sources.mainListeners.size).toBe(0);
		expect(sources.hiddenListeners.size).toBe(0);
	});

	it("does not publish pane identities again for unrelated agent or layout metadata changes", () => {
		updateMain({
			spaces: [{ id: "desktop" }],
			agents: [{ id: "one" }],
			layouts: { desktop: { panels: { "agent:one": { contentComponent: "agent", params: { agentRef: { agentId: "one" } } } } } },
		});
		const rendered = vi.fn();
		const hook = renderHook(() => {
			rendered();
			return useMountedAgentClaimPanes("one", "agent:one");
		});
		const previous = hook.result.current;
		rendered.mockClear();
		updateMain({ agents: [{ id: "one", name: "renamed" }] });
		updateMain({
			layouts: { desktop: { panels: { "agent:one": { contentComponent: "agent", params: { agentRef: { agentId: "one" } }, title: "renamed" } } } },
		});
		expect(hook.result.current).toBe(previous);
		expect(rendered).not.toHaveBeenCalled();
	});

	it("refreshes cold, hidden and removed desktop projections after remount", () => {
		const first = renderHook(() =>
			useMountedAgentClaimPanes("one", "agent:one"),
		);
		first.unmount();
		updateMain({
			spaces: [{ id: "desktop" }],
			agents: [{ id: "two" }, { id: "hidden" }],
			layouts: {
				desktop: { panels: { "agent:two": { contentComponent: "agent", params: { agentId: "stale" } } } },
				deleted: { panels: { "agent:orphan": { contentComponent: "agent", params: { agentRef: { agentId: "orphan" } } } } },
			},
		});
		updateHidden({ hidden: { desktopId: "desktop", paneId: "agent:hidden" } });
		const second = renderHook(() =>
			useMountedAgentClaimPanes("one", "agent:one"),
		);
		expect(second.result.current.map((pane) => pane.agentId)).toEqual([
			"hidden",
			"one",
			"two",
		]);
		updateMain({ spaces: [] });
		expect(second.result.current).toEqual([
			{ id: "agent:one", agentId: "one" },
		]);
	});

	it("does not let cleanup from a replaced mount remove its successor", () => {
		const previous = renderHook(() =>
			useMountedAgentClaimPanes("one", "agent:one"),
		);
		const current = renderHook(() =>
			useMountedAgentClaimPanes("one", "agent:one"),
		);
		previous.unmount();
		expect(current.result.current).toEqual([
			{ id: "agent:one", agentId: "one" },
		]);
	});
});
