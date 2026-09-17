import { describe, expect, it } from "vitest";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntimeState";
import {
	applyManagedAgentRecovery,
	managedBinding,
	managedRecoveryIdentity,
} from "@/lib/sessions/managed/managedAgentRuntimeState";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent, HmuxManagedStopFenceV1 } from "@/types";

const sourceFence: HmuxManagedStopFenceV1 = stopFenceFixture({
	runnerPrincipal: "principal-old",
	runnerInstance: "runner-old",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});

function agent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		id: "agent-1",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-old",
		started: true,
		pendingCmd: "codex resume old",
		pendingCredentialSwitch: {
			schemaVersion: 1,
			requestId: "switch-1",
			targetCredentialId: "credential-next",
			targetCredentialDirectory: null,
			sourceSessionId: "session-old",
			sourceWorkspaceId: "workspace-1",
			sourceConversationId: "conversation-1",
			sourceCredentialId: null,
			sourceCreateIdempotencyKey: "create-old",
			sourceCredentialGeneration: null,
			sourceTerminalEpoch: "terminal-old",
			baselineRuntimeRevision: "3",
			baselineTurnCompletedCount: "0",
			completionTurnCompletedCount: "1",
			completionReason: "user_requested",
			panelId: "agent:agent-1",
			requestedAtMs: 1,
		},
		runtimeBinding: managedBindingFixture({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-old",
			stopFence: sourceFence,
			conversationIdentity: {
				schemaVersion: 1,
				sessionId: "session-old",
				workspaceId: "workspace-1",
				runnerPrincipal: sourceFence.runnerPrincipal,
				runnerInstance: sourceFence.runnerInstance,
				channelEpoch: sourceFence.channelEpoch,
				hostInstanceId: sourceFence.hostInstanceId,
				terminalEpoch: sourceFence.terminalEpoch,
				revision: "3",
				observedThroughOutputSeq: "8",
				providerId: "codex",
				conversationId: "conversation-1",
				source: "provider_event",
			},
		}),
		...patch,
	});
}

function recoveryResult(
	stopFence: HmuxManagedStopFenceV1 | null = stopFenceFixture({
		runnerPrincipal: "principal-new",
		runnerInstance: "runner-new",
		channelEpoch: "8",
		hostInstanceId: "host-new",
		terminalEpoch: "terminal-new",
	}),
): ManagedAgentRecoveryResult {
	return {
		providerId: "codex",
		permissionMode: "default",
		conversationId: "conversation-1",
		createIdempotencyKey: "create-new",
		replacement: {
			sessionId: "session-new",
			workspaceId: "workspace-1",
			sessionClass: "managed",
			lifecycle: "ready",
			terminalEpoch: "terminal-new",
			stopFence: stopFence ?? undefined,
			outputSeq: "0",
			capabilities: [],
		},
		receipt: {
			sourceSessionId: "session-old",
			action: "replace_ai_provider_with_explicit_conversation",
			outcome: "replaced",
			replayed: false,
			replacementSession: undefined,
		},
	};
}

describe("managed agent runtime state", () => {
	it("derives one recovery operation from the source session and workspace", () => {
		const source = agent();
		const fenced = managedBinding(source);
		const first = managedRecoveryIdentity(fenced);
		expect(managedRecoveryIdentity(fenced)).toEqual(first);

		const legacy = managedBinding(
			agent({ runtimeBinding: { ...fenced, stopFence: undefined } }),
		);
		expect(managedRecoveryIdentity(legacy)).toEqual(first);
		const changedFence = {
			...fenced,
			stopFence: { ...sourceFence, terminalEpoch: "changed" },
		};
		expect(managedRecoveryIdentity(changedFence)).toEqual(first);
		expect(first.recoveryId).toMatch(/^recovery_[0-9a-f]{16}$/);
		expect(first).toEqual({ recoveryId: first.recoveryId });
	});

	it("atomically installs the fenced successor and clears predecessor-only state", () => {
		const source = agent();
		const other = agent({ id: "agent-2", sessionId: "session-other" });
		const result = recoveryResult();
		const recovered = applyManagedAgentRecovery(
			[source, other],
			source,
			result,
		);

		expect(recovered[1]).toBe(other);
		expect(recovered[0]).toMatchObject({
			sessionId: "session-new",
			conversationId: "conversation-1",
			started: true,
			pendingCmd: undefined,
			pendingCredentialSwitch: undefined,
			runtimeBinding: {
				sessionId: "session-new",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-new",
				stopFence: result.replacement.stopFence,
			},
		});
		expect(
			recovered[0]?.runtimeBinding?.runtime === "hmux_managed_v1" &&
				recovered[0].runtimeBinding.source === "local"
				? recovered[0].runtimeBinding.conversationIdentity
				: "invalid binding",
		).toBeUndefined();
	});

	it("refuses a successor without its durable stop fence", () => {
		const source = agent();
		expect(() =>
			applyManagedAgentRecovery([source], source, recoveryResult(null)),
		).toThrow("managed recovery replacement is missing its durable stop fence");
	});

	it("refuses non-local-managed agents", () => {
		expect(() =>
			managedBinding(
				agent({
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_session_v1",
						source: "local",
						hostId: "local",
						sessionId: "legacy",
					} as unknown as Agent["runtimeBinding"],
				}),
			),
		).toThrow("agent is not bound to a local managed Hmux runtime");
	});
});
