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

it("carries a muted agent's mute and nothing for an unmuted one", () => {
	expect(sessionPresentation({ kind: "agent", notificationsMuted: true })).toMatchObject({
		notificationsMuted: true,
	});
	expect(
		JSON.stringify(sessionPresentation({ kind: "agent", notificationsMuted: false })),
	).not.toContain("notificationsMuted");
});

it("names the row's Agent and its manager only when the relation owner knows them", () => {
	expect(
		sessionPresentation({ kind: "agent" }, undefined, undefined, {
			agentId: "agent-worker",
			managerAgentId: "agent-lead",
		}),
	).toMatchObject({ agentId: "agent-worker", managerAgentId: "agent-lead" });
	const root = JSON.stringify(
		sessionPresentation({ kind: "agent" }, undefined, undefined, { agentId: "agent-lead" }),
	);
	expect(root).toContain('"agentId":"agent-lead"');
	expect(root).not.toContain("managerAgentId");
	expect(JSON.stringify(sessionPresentation({ kind: "term" }))).not.toContain("agentId");
});

it("carries the backend's recovery wait only while one is known", () => {
	expect(
		sessionPresentation({ kind: "agent", displayState: "error", continuesAtMs: 1_700_000_600_000 }),
	).toMatchObject({ displayState: "error", continuesAtMs: 1_700_000_600_000 });
	expect(JSON.stringify(sessionPresentation({ kind: "agent", displayState: "error" }))).not.toContain(
		"continuesAtMs",
	);
});
