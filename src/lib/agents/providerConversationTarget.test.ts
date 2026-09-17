import { describe, expect, it } from "vitest";
import {
	providerConversationTargetForAgent,
	providerConversationTargetKey,
} from "@/lib/agents/providerConversationTarget";
import type { Agent } from "@/types";

const agent: Agent = {
	id: "agent-1",
	name: "history-agent",
	provider: "claude",
	projectId: "project-1",
	worktreePath: "/repo",
	branch: "main",
	sessionId: "session-1",
	sessionKind: "pty",
	conversationId: " conversation-1 ",
};

describe("providerConversationTargetForAgent", () => {
	it("keys provider conversations by exact execution location", () => {
		const local = providerConversationTargetKey({
			provider: "claude",
			conversationId: "conversation-1",
			executionLocation: "local",
		});
		expect(
			providerConversationTargetKey({
				provider: "claude",
				conversationId: "conversation-1",
				executionLocation: "local",
				hostId: "ignored-local-host",
			}),
		).toBe(local);
		expect(
			providerConversationTargetKey({
				provider: "claude",
				conversationId: "conversation-1",
				executionLocation: "ssh",
				hostId: "host-1",
			}),
		).not.toBe(local);
	});

	it("uses the project location for a legacy Agent without a runtime binding", () => {
		expect(
			providerConversationTargetForAgent(agent, { kind: "local" }),
		).toEqual({
			provider: "claude",
			conversationId: "conversation-1",
			executionLocation: "local",
		});
	});

	it("prefers an exact runtime binding for SSH history", () => {
		expect(
			providerConversationTargetForAgent(
				{
					...agent,
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_ssh_session_v1",
						source: "ssh",
						hostId: "host-runtime",
						sessionId: "session-runtime",
					} as unknown as Agent["runtimeBinding"],
				},
				{ kind: "ssh", sshHostId: "host-project" },
			),
		).toEqual({
			provider: "claude",
			conversationId: "conversation-1",
			executionLocation: "ssh",
			hostId: "host-runtime",
		});
	});

	it("prefers the Host-projected managed conversation identity", () => {
		expect(
			providerConversationTargetForAgent(
				{
					...agent,
					conversationId: "legacy-conversation",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "hmux_managed_v1",
						source: "local",
						hostId: "local",
						sessionId: "session-1",
						workspaceId: "workspace-1",
						conversationIdentity: {
							schemaVersion: 1,
							sessionId: "session-1",
							workspaceId: "workspace-1",
							runnerPrincipal: "runner-principal",
							runnerInstance: "runner-instance",
							channelEpoch: "1",
							hostInstanceId: "host-instance",
							terminalEpoch: "epoch-1",
							revision: "1",
							observedThroughOutputSeq: "1",
							providerId: "claude",
							conversationId: "projected-conversation",
							source: "provider_event",
						},
					},
				},
				{ kind: "local" },
			),
		).toEqual({
			provider: "claude",
			conversationId: "projected-conversation",
			executionLocation: "local",
		});
	});

	it("does not invent a target without conversation or location identity", () => {
		expect(
			providerConversationTargetForAgent(
				{ ...agent, conversationId: undefined },
				{ kind: "local" },
			),
		).toBeUndefined();
		expect(
			providerConversationTargetForAgent(agent, undefined),
		).toBeUndefined();
	});
});
