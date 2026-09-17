import { expect, it } from "vitest";
import { sessionPresentation } from "./sessionPresentation";

it("keeps unobserved activity and Git absent while carrying known location", () => {
	const value = sessionPresentation({
		kind: "agent",
		hostId: "server",
		cwd: "/repo",
		projectId: "project",
		provider: "codex",
	});
	expect(value.activityAt).toBeUndefined();
	expect(value.git).toBeUndefined();
	expect(value).toMatchObject({
		hostId: "server",
		cwd: "/repo",
		projectId: "project",
		provider: "codex",
	});
});

it("carries desktop patch file counts independently of line counts", () => {
	const badge = {
		ahead: 1,
		behind: 6,
		committed: { files: 2, added: 300 },
		worktree: { files: 51, added: 1800 },
	};
	expect(
		sessionPresentation(
			{ activityAt: 1_700_000_000_000, detail: "Reviewing the list" },
			badge,
		),
	).toMatchObject({
		activityAt: 1_700_000_000_000,
		detail: "Reviewing the list",
		git: { committed: 2, worktree: 51, ahead: 1, behind: 6 },
	});
});
