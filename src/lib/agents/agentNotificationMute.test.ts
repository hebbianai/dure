import { beforeEach, describe, expect, it } from "vitest";
import {
	agentNotificationsMuted,
	setAgentNotificationsMuted,
} from "@/lib/agents/agentNotificationMute";
import { normalizePersistedAgents } from "@/lib/persistence/persistedAgents";
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
const other: Agent = { ...agent, id: "agent-2", name: "codex-2", sessionId: "session-2" };

describe("setAgentNotificationsMuted", () => {
	beforeEach(() => useStore.setState({ agents: [agent, other] }));

	it("mutes one agent and leaves the others and its identity alone", () => {
		setAgentNotificationsMuted(agent.id, true);

		const [muted, untouched] = useStore.getState().agents;
		expect(muted).toEqual({ ...agent, notificationsMuted: true });
		expect(agentNotificationsMuted(muted)).toBe(true);
		expect(untouched).toBe(other);
	});

	it("unmutes by removing the flag, so an unmuted agent reads as never muted", () => {
		setAgentNotificationsMuted(agent.id, true);
		setAgentNotificationsMuted(agent.id, false);

		expect(useStore.getState().agents[0]).toEqual(agent);
		expect(Object.keys(useStore.getState().agents[0])).not.toContain(
			"notificationsMuted",
		);
	});

	it("keeps the store unchanged when the agent is gone or already in that state", () => {
		const before = useStore.getState().agents;
		setAgentNotificationsMuted("missing", true);
		setAgentNotificationsMuted(agent.id, false);

		expect(useStore.getState().agents).toBe(before);
	});
});

describe("the persisted mute", () => {
	it("survives a reload and drops anything but true", () => {
		const [muted, malformed, absent] = normalizePersistedAgents([
			{ ...agent, notificationsMuted: true },
			{ ...other, notificationsMuted: "yes" },
			{ ...agent, id: "agent-3", sessionId: "session-3" },
		]);

		expect(muted.notificationsMuted).toBe(true);
		expect(malformed).not.toHaveProperty("notificationsMuted");
		expect(absent).not.toHaveProperty("notificationsMuted");
	});
});
