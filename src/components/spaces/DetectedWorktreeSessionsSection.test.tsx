// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetectedWorktreeSessionsSection } from "@/components/spaces/DetectedWorktreeSessionsSection";
import type { DetectedWorktreeSession } from "@/lib/spaces/detectedWorktreeSessions";
import { useDetectedWorktreeVisibilityStore } from "@/lib/spaces/detectedWorktreeVisibilityStore";

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));

function candidate(index: number): DetectedWorktreeSession {
	return {
		projectId: "project-1",
		projectName: "app",
		projectKind: "local",
		name: `worktree-${index}`,
		provider: "codex",
		lastActivityAt: 100 - index,
		worktree: {
			path: `/repo/.worktrees/${index}`,
			branch: `agent/${index}`,
			isMain: false,
			claudeSessions: 0,
			codexSessions: 1,
			codexLastTs: 100 - index,
		},
	};
}

beforeEach(() => {
	localStorage.clear();
	useDetectedWorktreeVisibilityStore.setState({ hidden: [] });
});

afterEach(cleanup);

describe("DetectedWorktreeSessionsSection", () => {
	it("starts collapsed, previews five rows, and expands only on request", () => {
		const sessions = Array.from({ length: 7 }, (_, index) => candidate(index));
		render(
			<DetectedWorktreeSessionsSection
				sessions={sessions}
				searchActive={false}
				onAdopt={vi.fn()}
			/>,
		);

		const header = screen.getByRole("button", { name: /외부 워크트리 기록/ });
		expect(header.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByText("worktree-0")).toBeNull();

		fireEvent.click(header);
		expect(screen.getByText("worktree-0")).toBeTruthy();
		expect(screen.getByText("worktree-4")).toBeTruthy();
		expect(screen.queryByText("worktree-5")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "전체 보기 (7)" }));
		expect(screen.getByText("worktree-6")).toBeTruthy();
	});

	it("automatically opens matching search results", () => {
		render(
			<DetectedWorktreeSessionsSection
				sessions={[candidate(1)]}
				searchActive
				onAdopt={vi.fn()}
			/>,
		);

		expect(screen.getByText("worktree-1")).toBeTruthy();
	});

	it("restores presentation-only hidden worktrees from the section header", () => {
		const hiddenCandidate = candidate(2);
		useDetectedWorktreeVisibilityStore.getState().hide(hiddenCandidate);
		render(
			<DetectedWorktreeSessionsSection
				sessions={[hiddenCandidate]}
				searchActive={false}
				onAdopt={vi.fn()}
			/>,
		);

		expect(screen.getByText(/숨김 1/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "숨긴 worktree 모두 복원" }));
		fireEvent.click(
			screen.getByRole("button", { name: /외부 워크트리 기록/ }),
		);
		expect(screen.getByText("worktree-2")).toBeTruthy();
	});
});
