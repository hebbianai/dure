import { describe, expect, it } from "vitest";
import {
	applyConversationIdentityReadiness,
	applyManagedConversationIdentity,
	applyProjectedConversationIdentity,
	conversationIdentityFromHook,
	hookSessionFenceEvidence,
} from "@/lib/sessions/managed/managedConversationIdentity";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		id: "agent-1",
		name: "codex-1",
		projectId: "workspace-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "managed-1",
		runtimeBinding: managedBindingFixture({
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: undefined,
		}),
		...patch,
	});
}

function remoteManagedAgent(patch: Partial<Agent> = {}): Agent {
	return managedAgent({
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "remote-host-1",
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			commandBridgeNonce: "bridge-1",
			stopFence: {
				runnerPrincipal: "remote-user",
				runnerInstance: "runner-1",
				channelEpoch: "1",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
			},
		},
		...patch,
	});
}

describe("managed conversation identity", () => {
	it("persists reviewed evidence against the exact live binding", () => {
		const agents = [managedAgent()];
		const next = applyManagedConversationIdentity(agents, {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			providerId: "codex",
			conversationId: "019fa342-4698-78b2-a47d-784690b3c756",
		});

		expect(next).not.toBe(agents);
		expect(next[0].conversationId).toBe("019fa342-4698-78b2-a47d-784690b3c756");
		expect(next[0].conversationIdentity).toEqual({
			state: "ready",
			conversationId: "019fa342-4698-78b2-a47d-784690b3c756",
		});
	});

	it("ignores delayed predecessor evidence and never overwrites an identity", () => {
		const current = managedAgent({
			sessionId: "successor",
			conversationId: "conversation-current",
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				sessionId: "successor",
			} as Agent["runtimeBinding"],
		});
		const agents = [current];

		expect(
			applyManagedConversationIdentity(agents, {
				sessionId: "managed-1",
				workspaceId: "workspace-1",
				providerId: "codex",
				conversationId: "conversation-stale",
			}),
		).toBe(agents);
	});

	it("accepts a bounded hook identity and rejects shell-shaped input", () => {
		expect(
			conversationIdentityFromHook({
				conversationId: " conversation-safe:1 ",
			}),
		).toBe("conversation-safe:1");
		expect(
			conversationIdentityFromHook({
				conversationId: "unsafe; touch /tmp/pwned",
			}),
		).toBeUndefined();
	});

	it("distinguishes complete, malformed current, and legacy hook fences", () => {
		const fence = {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "local-user",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
		};
		expect(hookSessionFenceEvidence({ sessionFence: fence })).toEqual({
			kind: "fenced",
			fence,
		});
		expect(
			hookSessionFenceEvidence({
				sessionFence: { ...fence, channelEpoch: "0" },
			}),
		).toEqual({ kind: "malformed" });
		expect(hookSessionFenceEvidence({})).toEqual({ kind: "legacy" });
	});

	it("persists the newest Host-owned conversation within an exact generation", () => {
		const first = applyProjectedConversationIdentity([managedAgent()], {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "local-user",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
			revision: "2",
			observedThroughOutputSeq: "8",
			providerId: "codex",
			conversationId: "conversation-host-2",
			source: "provider_event",
		});
		expect(first[0].conversationId).toBe("conversation-host-2");
		expect(first[0].conversationIdentity).toEqual({
			state: "ready",
			conversationId: "conversation-host-2",
		});
		const binding = first[0].runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("expected managed binding");
		}

		const olderRevision = applyProjectedConversationIdentity(first, {
			...binding.conversationIdentity!,
			revision: "1",
			conversationId: "conversation-stale-revision",
		});
		expect(olderRevision).toBe(first);

		const staleEpoch = applyProjectedConversationIdentity(first, {
			...binding.conversationIdentity!,
			terminalEpoch: "terminal-old",
			revision: "99",
			conversationId: "conversation-stale-epoch",
		});
		expect(staleEpoch).toBe(first);

		const newer = applyProjectedConversationIdentity(first, {
			...binding.conversationIdentity!,
			revision: "3",
			conversationId: "conversation-host-3",
		});
		expect(newer[0].conversationId).toBe("conversation-host-3");
		expect(newer[0].runtimeBinding).toMatchObject({
			conversationIdentity: {
				revision: "3",
				conversationId: "conversation-host-3",
			},
		});
		const restored: Agent[] = JSON.parse(JSON.stringify(newer));
		expect(
			applyProjectedConversationIdentity(
				restored,
				binding.conversationIdentity!,
			),
		).toBe(restored);
		expect(
			applyProjectedConversationIdentity(newer, {
				...binding.conversationIdentity!,
				revision: "3",
				conversationId: "conflicting-replay",
			}),
		).toBe(newer);
		expect(
			applyProjectedConversationIdentity(newer, {
				...binding.conversationIdentity!,
				revision: "4",
				source: "launch_request",
			}),
		).toBe(newer);
	});

	it("converges a fresh remote binding only from its exact Host report", () => {
		const projection = {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "remote-user",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
			revision: "1",
			observedThroughOutputSeq: "4",
			providerId: "codex" as const,
			conversationId: "conversation-provider-reported",
			source: "provider_event" as const,
		};

		const next = applyProjectedConversationIdentity(
			[remoteManagedAgent()],
			projection,
			"terminal-1",
		);

		expect(next[0].conversationId).toBe("conversation-provider-reported");
		expect(next[0].runtimeBinding).toMatchObject({
			conversationIdentity: {
				schemaVersion: 1,
				...projection,
			},
		});
		expect(
			applyProjectedConversationIdentity(
				[remoteManagedAgent()],
				{ ...projection, runnerInstance: "runner-stale" },
				"terminal-1",
			),
		).toEqual([remoteManagedAgent()]);
	});

	it("restores ready from a repeated exact Host snapshot after WebView restart", () => {
		const projection = {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "local-user",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
			revision: "2",
			observedThroughOutputSeq: "8",
			providerId: "codex" as const,
			conversationId: "conversation-host-2",
			source: "provider_event" as const,
		};
		const hydrated = managedAgent({
			conversationId: projection.conversationId,
			conversationIdentity: {
				state: "pending",
				code: "conversation_identity_required",
				detail: "stale WebView projection",
			},
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				stopFence: {
					runnerPrincipal: "local-user",
					runnerInstance: "runner-stale",
					channelEpoch: "1",
					hostInstanceId: "host-stale",
					terminalEpoch: "terminal-stale",
				},
				conversationIdentity: {
					schemaVersion: 1,
					...projection,
				},
			} as Agent["runtimeBinding"],
		});

		const next = applyProjectedConversationIdentity(
			[hydrated],
			projection,
			"terminal-1",
		);

		expect(next).not.toEqual([hydrated]);
		expect(next[0].conversationIdentity).toEqual({
			state: "ready",
			conversationId: projection.conversationId,
		});
		expect(next[0].runtimeBinding).toMatchObject({
			stopFence: {
				runnerPrincipal: projection.runnerPrincipal,
				runnerInstance: projection.runnerInstance,
				channelEpoch: projection.channelEpoch,
				hostInstanceId: projection.hostInstanceId,
				terminalEpoch: projection.terminalEpoch,
			},
		});
	});

	it("lets a fresh rehost descriptor replace predecessor binding evidence", () => {
		const predecessor = managedAgent({
			sessionId: "managed-successor",
			conversationId: "conversation-predecessor",
			runtimeBinding: {
				...managedAgent().runtimeBinding,
				sessionId: "managed-successor",
				conversationIdentity: {
					schemaVersion: 1,
					sessionId: "managed-successor",
					workspaceId: "workspace-1",
					runnerPrincipal: "local-user",
					runnerInstance: "runner-old",
					channelEpoch: "1",
					hostInstanceId: "host-old",
					terminalEpoch: "terminal-old",
					revision: "9",
					observedThroughOutputSeq: "100",
					providerId: "codex",
					conversationId: "conversation-predecessor",
					source: "provider_event",
				},
			} as Agent["runtimeBinding"],
		});

		const next = applyProjectedConversationIdentity(
			[predecessor],
			{
				sessionId: "managed-successor",
				workspaceId: "workspace-1",
				runnerPrincipal: "local-user",
				runnerInstance: "runner-new",
				channelEpoch: "1",
				hostInstanceId: "host-new",
				terminalEpoch: "terminal-new",
				revision: "1",
				observedThroughOutputSeq: "0",
				providerId: "codex",
				conversationId: "conversation-successor",
				source: "launch_request",
			},
			"terminal-new",
		);

		expect(next[0].conversationId).toBe("conversation-successor");
	});

	it("accepts the complete Host opaque alphabet and rejects values beyond u64", () => {
		const projection = {
			sessionId: "managed-1",
			workspaceId: "workspace-1",
			runnerPrincipal: "local+user",
			runnerInstance: "runner-1",
			channelEpoch: "18446744073709551615",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-1",
			revision: "18446744073709551615",
			observedThroughOutputSeq: "18446744073709551615",
			providerId: "codex" as const,
			conversationId: "conversation+opaque-1",
			source: "provider_event" as const,
		};

		const accepted = applyProjectedConversationIdentity(
			[managedAgent()],
			projection,
		);
		expect(accepted[0].conversationId).toBe("conversation+opaque-1");
		expect(
			applyProjectedConversationIdentity([managedAgent()], {
				...projection,
				revision: "18446744073709551616",
			}),
		).toEqual([managedAgent()]);
	});
});

describe("applyConversationIdentityReadiness", () => {
	const pending = {
		state: "pending",
		code: "conversation_identity_required",
		detail: "no open rollout",
	} as const;
	const unavailable = {
		state: "unavailable",
		code: "conversation_identity_ambiguous",
		detail: "two rollouts",
	} as const;

	it("그 세션의 에이전트에만 관측 결과를 남긴다", () => {
		const agents = [
			managedAgent(),
			managedAgent({ id: "agent-2", sessionId: "managed-2" }),
		];
		const next = applyConversationIdentityReadiness(
			agents,
			"managed-1",
			pending,
		);
		expect(next[0].conversationIdentity).toEqual(pending);
		expect(next[1].conversationIdentity).toBeUndefined();
	});

	// 뒤늦게 도착한 pending 관측이 확정된 신원을 흐리면 안 된다.
	it("이미 확정된 에이전트는 건드리지 않는다", () => {
		const agents = [managedAgent({ conversationId: "conv-1" })];
		expect(
			applyConversationIdentityReadiness(agents, "managed-1", pending),
		).toBe(agents);
	});

	it("같은 상태가 반복되면 새 배열을 만들지 않는다 — 불필요한 재렌더 방지", () => {
		const agents = applyConversationIdentityReadiness(
			[managedAgent()],
			"managed-1",
			pending,
		);
		expect(
			applyConversationIdentityReadiness(agents, "managed-1", pending),
		).toBe(agents);
	});

	it("상태가 바뀌면 갱신한다", () => {
		const first = applyConversationIdentityReadiness(
			[managedAgent()],
			"managed-1",
			pending,
		);
		const second = applyConversationIdentityReadiness(
			first,
			"managed-1",
			unavailable,
		);
		expect(second).not.toBe(first);
		expect(second[0].conversationIdentity).toEqual(unavailable);
	});
});
