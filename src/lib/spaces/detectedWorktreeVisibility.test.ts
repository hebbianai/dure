import { describe, expect, it } from "vitest";
import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";
import {
	DETECTED_WORKTREE_HIDDEN_LIMIT,
	hideDetectedWorktree,
	isHiddenDetectedWorktree,
	normalizeHiddenDetectedWorktrees,
} from "@/lib/spaces/detectedWorktreeVisibility";

function session(
	overrides: Partial<DetectedWorktreeSession["worktree"]> = {},
): DetectedWorktreeSession {
	return {
		projectId: "project-1",
		projectName: "App",
		projectKind: "local",
		name: "feature",
		provider: "codex",
		lastActivityAt: overrides.codexLastTs ?? 20,
		worktree: {
			path: "/repo/.worktrees/feature",
			branch: "agent/feature",
			isMain: false,
			claudeSessions: 1,
			codexSessions: 1,
			claudeLastTs: 10,
			codexLastTs: 20,
			...overrides,
		},
	};
}

describe("detected worktree visibility", () => {
	it("hides only the observed history and resurfaces new activity", () => {
		const original = session();
		const hidden = hideDetectedWorktree([], original);

		expect(isHiddenDetectedWorktree(original, hidden)).toBe(true);
		expect(
			isHiddenDetectedWorktree(
				session({ codexSessions: 2, codexLastTs: 30 }),
				hidden,
			),
		).toBe(false);
		expect(
			isHiddenDetectedWorktree(session({ branch: "agent/reused" }), hidden),
		).toBe(false);
	});

	it("keeps the newest bounded observation for each worktree", () => {
		let hidden = [] as ReturnType<typeof normalizeHiddenDetectedWorktrees>;
		for (
			let index = 0;
			index < DETECTED_WORKTREE_HIDDEN_LIMIT + 3;
			index += 1
		) {
			hidden = hideDetectedWorktree(
				hidden,
				session({ path: `/repo/.worktrees/${index}` }),
			) as typeof hidden;
		}

		expect(hidden).toHaveLength(DETECTED_WORKTREE_HIDDEN_LIMIT);
		expect(hidden[0]?.key).toContain("/repo/.worktrees/3");
	});

	it("drops malformed persisted records", () => {
		expect(
			normalizeHiddenDetectedWorktrees([
				null,
				{
					key: "",
					branch: "main",
					observedActivityAt: 0,
					observedSessionCount: 0,
				},
				{
					key: '["project"]',
					branch: "main",
					observedActivityAt: 1,
					observedSessionCount: 1,
				},
			]),
		).toEqual([
			{
				key: '["project"]',
				branch: "main",
				observedActivityAt: 1,
				observedSessionCount: 1,
			},
		]);
	});
});
