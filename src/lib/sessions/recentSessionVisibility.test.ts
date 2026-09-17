// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { durableWriteCoordinator } from "@/lib/persistence/durableWriteCoordinator";
import {
	hideRecentSession,
	isRecentSessionHidden,
	normalizeHiddenRecentSessions,
	RECENT_SESSION_HIDDEN_LIMIT,
	type RecentSessionVisibilityTarget,
} from "@/lib/sessions/recentSessionVisibility";
import {
	RECENT_SESSION_VISIBILITY_STORAGE_KEY,
	useRecentSessionVisibilityStore,
} from "@/lib/sessions/recentSessionVisibilityStore";

function conversation(
	overrides: Partial<RecentSessionVisibilityTarget> = {},
): RecentSessionVisibilityTarget {
	return {
		provider: "claude",
		id: "conversation-1",
		mtime: 100,
		executionLocation: "local",
		...overrides,
	};
}

beforeEach(async () => {
	useRecentSessionVisibilityStore.setState({ hidden: [] });
	useRecentSessionVisibilityStore.persist.clearStorage();
	await durableWriteCoordinator.flush();
});

afterEach(() => {
	useRecentSessionVisibilityStore.setState({ hidden: [] });
});

describe("recent session visibility", () => {
	it("hides only the exact provider conversation and execution host", () => {
		const remote = conversation({
			id: "shared-id",
			executionLocation: "ssh",
			hostId: "build-a",
		});
		const hidden = hideRecentSession([], remote);

		expect(isRecentSessionHidden(remote, hidden)).toBe(true);
		expect(
			isRecentSessionHidden({ ...remote, hostId: "build-b" }, hidden),
		).toBe(false);
		expect(
			isRecentSessionHidden(
				conversation({ id: "shared-id", provider: "codex" }),
				hidden,
			),
		).toBe(false);
	});

	it("shows a removed conversation again after newer provider activity", () => {
		const original = conversation({ mtime: 100 });
		const hidden = hideRecentSession([], original);

		expect(isRecentSessionHidden(original, hidden)).toBe(true);
		expect(isRecentSessionHidden({ ...original, mtime: 101 }, hidden)).toBe(
			false,
		);
	});

	it("normalizes untrusted persistence and keeps only the newest bounded identities", () => {
		const records = Array.from(
			{ length: RECENT_SESSION_HIDDEN_LIMIT + 1 },
			(_, index) =>
				hideRecentSession([], conversation({ id: `conversation-${index}` }))[0],
		);
		const duplicate = records[records.length - 1];
		const normalized = normalizeHiddenRecentSessions([
			{ key: "not-json", observedMtime: 100 },
			...records,
			duplicate,
		]);

		expect(normalized).toHaveLength(RECENT_SESSION_HIDDEN_LIMIT);
		expect(normalized[0]).toEqual(records[1]);
		expect(normalized[normalized.length - 1]).toEqual(duplicate);
	});
});

describe("recent session visibility persistence", () => {
	it("persists removals and restores all records", async () => {
		const target = conversation();
		useRecentSessionVisibilityStore.getState().remove(target);
		await durableWriteCoordinator.flush();
		const durable = localStorage.getItem(RECENT_SESSION_VISIBILITY_STORAGE_KEY);

		expect(
			durable
				? (JSON.parse(durable) as { state: { hidden: unknown[] } }).state.hidden
				: undefined,
		).toHaveLength(1);

		useRecentSessionVisibilityStore.setState({ hidden: [] });
		if (durable) {
			localStorage.setItem(RECENT_SESSION_VISIBILITY_STORAGE_KEY, durable);
		}
		await useRecentSessionVisibilityStore.persist.rehydrate();
		expect(useRecentSessionVisibilityStore.getState().hidden).toHaveLength(1);

		useRecentSessionVisibilityStore.getState().restoreAll();
		expect(useRecentSessionVisibilityStore.getState().hidden).toEqual([]);
	});
});
