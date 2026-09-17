import { beforeEach, describe, expect, it } from "vitest";
import { renameAgentDisplayName } from "@/lib/agents/agentDisplayNameState";
import { useStore } from "@/store";
import type { Agent } from "@/types";

const agent: Agent = {
	id: "agent-1",
	name: "codex-1",
	provider: "codex",
	projectId: "project-1",
	worktreePath: "/repo/.worktrees/codex-1",
	branch: "agent/codex-1",
	sessionId: "session-1",
	sessionKind: "pty",
};

describe("renameAgentDisplayName", () => {
	beforeEach(() => useStore.setState({ agents: [agent] }));

	it("changes only presentation metadata", () => {
		renameAgentDisplayName(agent.id, "Release QA");

		expect(useStore.getState().agents[0]).toEqual({
			...agent,
			displayName: "Release QA",
		});
	});

	it("clears the override without changing resource coordinates", () => {
		useStore.setState({ agents: [{ ...agent, displayName: "Release QA" }] });
		renameAgentDisplayName(agent.id, " ");

		expect(useStore.getState().agents[0]).toEqual({
			...agent,
			displayName: undefined,
		});
	});
});
