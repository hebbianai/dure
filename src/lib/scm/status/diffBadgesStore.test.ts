import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffBadge } from "./diffBadges";
import { useDiffBadges } from "./diffBadgesStore";

const badge: DiffBadge = {
	added: 3,
	deleted: 1,
	binary: 0,
	files: 1,
	committed: { added: 0, deleted: 0, binary: 0, files: 0 },
	worktree: { added: 3, deleted: 1, binary: 0, files: 1 },
	ahead: 0,
	behind: 0,
};

beforeEach(() => {
	useDiffBadges.setState(useDiffBadges.getInitialState(), true);
});

describe("diff badge store publication", () => {
	it("keeps unchanged polling results and cleanup silent", () => {
		const store = useDiffBadges.getState();
		store.setBadge("agent", badge);
		const snapshot = useDiffBadges.getState();
		const listener = vi.fn();
		const unsubscribe = useDiffBadges.subscribe(listener);
		try {
			for (let poll = 0; poll < 20; poll += 1) {
				store.setBadge("agent", structuredClone(badge));
				store.setBadge("missing", null);
				store.prune(new Set(["agent"]));
			}
			expect(listener).not.toHaveBeenCalled();
			expect(useDiffBadges.getState()).toBe(snapshot);
		} finally {
			unsubscribe();
		}
	});

	it("publishes badge changes, failed reads, and removed agents", () => {
		const store = useDiffBadges.getState();
		store.setBadge("retired", badge);
		const listener = vi.fn();
		const unsubscribe = useDiffBadges.subscribe(listener);
		try {
			store.setBadge("agent", badge);
			const changed = { ...badge, ahead: 1 };
			store.setBadge("agent", changed);
			expect(useDiffBadges.getState().badges.agent).toEqual(changed);
			store.prune(new Set(["agent"]));
			expect(useDiffBadges.getState().badges).toEqual({ agent: changed });
			store.setBadge("agent", null);
			expect(useDiffBadges.getState().badges).toEqual({});
			expect(listener).toHaveBeenCalledTimes(4);
		} finally {
			unsubscribe();
		}
	});
});
