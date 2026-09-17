import { describe, expect, it, vi } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import {
	type RecentSessionHistoryLiveState,
	recentSessionHistoryTitleTransition,
	startRecentSessionHistoryLiveRefresh,
} from "./recentSessionHistoryLiveRefresh";

function runtime(
	activity: HmuxAgentRuntimeState["activity"],
	turnCompletedCount?: string,
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-a",
		revision: "1",
		observedThroughOutputSeq: "1",
		lifecycle: "running",
		activity,
		attention: "none",
		source: "provider_event",
		...(turnCompletedCount === undefined ? {} : { turnCompletedCount }),
	};
}

function state(
	overrides: Partial<RecentSessionHistoryLiveState> = {},
): RecentSessionHistoryLiveState {
	return {
		sessionActivity: {},
		sessionAgentRuntimeState: {},
		sshHosts: [],
		...overrides,
	};
}

function fakeStore(initial: RecentSessionHistoryLiveState) {
	let current = initial;
	const listeners = new Set<() => void>();
	return {
		getState: () => current,
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next: RecentSessionHistoryLiveState) {
			current = next;
			for (const listener of listeners) listener();
		},
	};
}

describe("recent session history title transitions", () => {
	it("refreshes when a prompt is submitted", () => {
		const before = state();
		const after = state({
			sessionActivity: { "session-a": { text: "ship it", at: 10 } },
		});
		expect(recentSessionHistoryTitleTransition(before, after)).toBe(true);
	});

	it("refreshes when a turn completes", () => {
		const before = state({
			sessionAgentRuntimeState: { "session-a": runtime("working", "1") },
		});
		const waiting = state({
			sessionAgentRuntimeState: { "session-a": runtime("waiting", "1") },
		});
		const counted = state({
			sessionAgentRuntimeState: { "session-a": runtime("working", "2") },
		});
		expect(recentSessionHistoryTitleTransition(before, waiting)).toBe(true);
		expect(recentSessionHistoryTitleTransition(before, counted)).toBe(true);
	});

	it("ignores unrelated store writes and a turn that merely starts", () => {
		const before = state({
			sessionActivity: { "session-a": { text: "ship it", at: 10 } },
			sessionAgentRuntimeState: { "session-a": runtime("waiting", "1") },
		});
		const same = state({
			sessionActivity: before.sessionActivity,
			sessionAgentRuntimeState: before.sessionAgentRuntimeState,
			sshHosts: [],
		});
		const started = state({
			sessionActivity: before.sessionActivity,
			sessionAgentRuntimeState: { "session-a": runtime("working", "1") },
		});
		expect(recentSessionHistoryTitleTransition(before, same)).toBe(false);
		expect(recentSessionHistoryTitleTransition(before, started)).toBe(false);
	});
});

describe("startRecentSessionHistoryLiveRefresh", () => {
	it("runs one debounced refresh for a burst of transitions, then stops", () => {
		vi.useFakeTimers();
		try {
			const store = fakeStore(state());
			const refresh = vi.fn(() => Promise.resolve());
			const stop = startRecentSessionHistoryLiveRefresh({
				store,
				refresh,
				debounceMs: 100,
			});

			store.set(
				state({ sessionActivity: { "session-a": { text: "one", at: 1 } } }),
			);
			vi.advanceTimersByTime(60);
			store.set(
				state({ sessionActivity: { "session-a": { text: "two", at: 2 } } }),
			);
			vi.advanceTimersByTime(60);
			expect(refresh).not.toHaveBeenCalled();
			vi.advanceTimersByTime(40);
			expect(refresh).toHaveBeenCalledTimes(1);

			stop();
			store.set(
				state({ sessionActivity: { "session-a": { text: "three", at: 3 } } }),
			);
			vi.advanceTimersByTime(200);
			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
