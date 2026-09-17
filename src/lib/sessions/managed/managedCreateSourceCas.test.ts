import { describe, expect, it } from "vitest";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

const fence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
});

function agent(): Agent {
	return agentFixture({
		id: "agent-1",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		conversationId: "conversation-1",
		terminalEnv: { TERM: "xterm-256color" },
		runtimeBinding: managedBindingFixture({
			sessionId: "session-1",
			workspaceId: "project-1",
			stopFence: fence,
		}),
	});
}

function remoteAgent(): Agent {
	return {
		...agent(),
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "remote-host-1",
			sessionId: "session-1",
			workspaceId: "project-1",
			createIdempotencyKey: "create-1",
			commandBridgeNonce: "bridge-1",
			stopFence: fence,
		},
	};
}

describe("managed create source CAS", () => {
	it("accepts an unchanged launch source", () => {
		const expected = agent();
		expect(sameManagedCreateSource(structuredClone(expected), expected)).toBe(
			true,
		);
	});

	it.each([
		[
			"conversation",
			(current: Agent) => (current.conversationId = "conversation-2"),
		],
		["cwd", (current: Agent) => (current.worktreePath = "/repo/other")],
		["credential", (current: Agent) => (current.credentialId = "credential-2")],
		[
			"generation",
			(current: Agent) => {
				if (current.runtimeBinding?.runtime === "hmux_managed_v1") {
					current.runtimeBinding.stopFence = {
						...fence,
						terminalEpoch: "terminal-2",
					};
				}
			},
		],
	])("rejects a changed %s", (_label, mutate) => {
		const expected = agent();
		const current = structuredClone(expected);
		mutate(current);
		expect(sameManagedCreateSource(current, expected)).toBe(false);
	});

	it("rejects a provider projection that converged during remote create", () => {
		const expected = remoteAgent();
		const current = structuredClone(expected);
		if (
			current.runtimeBinding?.runtime !== "hmux_managed_v1" ||
			current.runtimeBinding.source !== "ssh"
		) {
			throw new Error("expected remote managed binding");
		}
		current.runtimeBinding.conversationIdentity = {
			schemaVersion: 1,
			sessionId: "session-1",
			workspaceId: "project-1",
			...fence,
			revision: "1",
			observedThroughOutputSeq: "4",
			providerId: "codex",
			conversationId: "conversation-1",
			source: "provider_event",
		};

		expect(sameManagedCreateSource(current, expected)).toBe(false);
	});
});
