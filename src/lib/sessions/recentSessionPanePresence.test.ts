import { describe, expect, it } from "vitest";
import { recentSessionPaneSpaces } from "@/lib/sessions/recentSessionPanePresence";
import { projectRecentWork } from "@/lib/sessions/recentWork";
import type { Agent, Project } from "@/types";

const NOW = 1_800_000_000;

const project: Project = {
	id: "project-1",
	name: "app",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function agent(id: string, conversationId: string): Agent {
	return {
		id,
		name: id,
		provider: "claude",
		projectId: project.id,
		worktreePath: "/repo",
		branch: "main",
		sessionId: `session-${id}`,
		sessionKind: "pty",
		conversationId,
	};
}

function items(
	entries: readonly {
		id: string;
		executionLocation?: "local" | "ssh";
		hostId?: string;
	}[],
) {
	return projectRecentWork({
		entries: entries.map((entry, index) => ({
			provider: "claude" as const,
			id: entry.id,
			title: entry.id,
			mtime: NOW - index,
			cwd: "/repo",
			repositoryRoot: "/repo",
			resumeCapability: "exact" as const,
			executionLocation: entry.executionLocation ?? "local",
			...(entry.hostId ? { hostId: entry.hostId } : {}),
			workingDirectoryAvailable: true,
		})),
		agents: [],
		projects: [project],
		activity: {},
		limit: entries.length,
		nowSeconds: NOW,
	}).groups.flatMap((group) => group.items);
}

describe("recentSessionPaneSpaces", () => {
	it("maps a session to the Space of the pane running its exact conversation", () => {
		const [shown, unshown] = items([{ id: "shown" }, { id: "unshown" }]);
		const spaces = recentSessionPaneSpaces({
			items: [shown, unshown],
			agents: [agent("agent-shown", "shown"), agent("agent-hidden", "unshown")],
			projects: [project],
			paneLocations: [{ agentId: "agent-shown", desktopId: "space-a" }],
		});

		expect([...spaces]).toEqual([[shown.key, "space-a"]]);
	});

	it("takes the first pane when one Agent is showing in two Spaces", () => {
		const [shown] = items([{ id: "shown" }]);
		const spaces = recentSessionPaneSpaces({
			items: [shown],
			agents: [agent("agent-shown", "shown")],
			projects: [project],
			paneLocations: [
				{ agentId: "agent-shown", desktopId: "space-a" },
				{ agentId: "agent-shown", desktopId: "space-b" },
			],
		});

		expect(spaces.get(shown.key)).toBe("space-a");
	});

	it("does not match the same conversation id running somewhere else", () => {
		const [remote] = items([
			{ id: "shared-id", executionLocation: "ssh", hostId: "build-mac" },
		]);
		const spaces = recentSessionPaneSpaces({
			items: [remote],
			agents: [agent("agent-local", "shared-id")],
			projects: [project],
			paneLocations: [{ agentId: "agent-local", desktopId: "space-a" }],
		});

		expect(spaces.size).toBe(0);
	});
});
