import { describe, expect, it } from "vitest";
import {
	matchesSpacesQuery,
	normalizeSpacesQuery,
	openSpaceRowSearchParts,
	unopenedAgentSearchParts,
} from "@/lib/spaces/spacesSearch";

describe("spacesSearch", () => {
	it("normalizes like every Spaces surface does", () => {
		expect(normalizeSpacesQuery("  AgEnt/Diff ")).toBe("agent/diff");
	});

	it("matches over newline-joined parts, skipping empties", () => {
		expect(matchesSpacesQuery("diff", ["Claude", undefined, "agent/diff"])).toBe(
			true,
		);
		expect(matchesSpacesQuery("절대없는말", ["Claude", "agent/diff"])).toBe(
			false,
		);
	});

	it("finds an open agent row by worktree path even when activity replaced it in the info line", () => {
		// 정보줄(detail)이 "브랜치 · 활동"으로 채워지면 경로가 화면에서 빠진다 —
		// 검색은 화면과 달리 경로·cwd로도 찾혀야 한다(감사 마찰 #13).
		const parts = openSpaceRowSearchParts({
			title: "Claude Code",
			detail: "agent/diff · fix the retry loop",
			projectName: "HebbianIDE",
			provider: "claude",
			cwd: "/repo/.worktrees/komojini-1",
			relativePath: "worktree/komojini-1",
		});
		expect(matchesSpacesQuery("komojini", parts)).toBe(true);
		expect(matchesSpacesQuery("agent/diff", parts)).toBe(true);
	});

	it("keeps the unopened haystack shape (branch and path searchable)", () => {
		// The checkpoint text left the haystack with the feature (2026-08-27).
		const parts = unopenedAgentSearchParts({
			displayName: "posthog-1",
			name: "posthog-1",
			provider: "codex",
			projectName: "HebbianIDE",
			worktreePath: "/repo/.worktrees/posthog-1",
			branch: "agent/posthog",
		});
		expect(matchesSpacesQuery("agent/posthog", parts)).toBe(true);
		expect(matchesSpacesQuery("posthog-1", parts)).toBe(true);
	});
});
