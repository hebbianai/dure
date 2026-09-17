import { describe, expect, it } from "vitest";
import {
	freshCredentialSwitchEligibility,
	managedCredentialSwitchFailureMessage,
	managedCredentialSwitchIdentityBlock,
} from "@/lib/agents/freshCredentialSwitch";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import {
	managedAgentFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		runtimeBinding: managedBindingFixture({ createIdempotencyKey: undefined }),
		...patch,
	});
}

const zeroTurnRuntime = {
	terminalEpoch: "terminal-1",
	revision: "3",
	observedThroughOutputSeq: "12",
	lifecycle: "running",
	activity: "waiting",
	attention: "none",
	source: "process_lifecycle",
	turnCompletedCount: "0",
} satisfies HmuxAgentRuntimeState;

describe("fresh credential switch eligibility", () => {
	it("accepts a local managed Agent without a conversation", () => {
		expect(
			freshCredentialSwitchEligibility(
				agent({
					conversationIdentity: {
						state: "unavailable",
						code: "conversation_identity_timeout",
						detail: "no rollout exists yet",
					},
				}),
				zeroTurnRuntime,
			),
		).toEqual({ eligible: true });
	});

	it("accepts an idle zero-turn runtime as exact fresh evidence", () => {
		expect(
			freshCredentialSwitchEligibility(agent(), zeroTurnRuntime),
		).toEqual({ eligible: true });
	});

	it("fails closed without Host fresh-state evidence", () => {
		expect(freshCredentialSwitchEligibility(agent())).toEqual({
			eligible: false,
			reason: "fresh_state_unverified",
		});
	});

	it("never treats a lost conversation projection as fresh after a completed turn", () => {
		expect(
			freshCredentialSwitchEligibility(
				agent({ conversationId: undefined }),
				{
					terminalEpoch: "terminal-1",
					revision: "9",
					observedThroughOutputSeq: "1460830",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "provider_event",
					turnCompletedCount: "7",
				},
			),
		).toEqual({ eligible: false, reason: "conversation_already_started" });
	});

	it("does not treat a detached readiness projection as identity authority", () => {
		expect(
			freshCredentialSwitchEligibility(
				agent({
					conversationId: undefined,
					conversationIdentity: {
						state: "ready",
						conversationId: "conversation-1",
					},
				}),
				zeroTurnRuntime,
			),
		).toEqual({ eligible: true });
	});

	it("lets an unverified identity take the fresh replacement path", () => {
		const candidate = agent({
			name: "claude-1",
			provider: "claude",
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_unverified",
				detail: "Cannot confirm the conversation identity",
			},
		});
		expect(freshCredentialSwitchEligibility(candidate, zeroTurnRuntime)).toEqual({
			eligible: true,
		});
		expect(
			managedCredentialSwitchIdentityBlock(candidate, zeroTurnRuntime),
		).toBeUndefined();
	});

	it("lets journaled fresh replacement resolve an unknown initial identity error", () => {
		const candidate = agent({
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_unknown",
				detail: "[object Object]",
			},
		});
		expect(freshCredentialSwitchEligibility(candidate, zeroTurnRuntime)).toEqual({
			eligible: true,
		});
		expect(
			managedCredentialSwitchIdentityBlock(candidate, zeroTurnRuntime),
		).toBeUndefined();
	});

	it("does not reinterpret detached readiness for an established conversation", () => {
		const ambiguous = agent({
			conversationId: "conversation-1",
			conversationIdentity: {
				state: "ready",
				conversationId: "conversation-2",
			},
		});
		expect(managedCredentialSwitchIdentityBlock(ambiguous)).toBeUndefined();
	});

	it("does not append stale pending identity copy to an unrelated pane failure", () => {
		const candidate = agent({
			conversationId: "conversation-1",
			conversationIdentity: {
				state: "pending",
				code: "conversation_identity_required",
				detail: "no rollout exists yet",
			},
		});
		expect(
			managedCredentialSwitchFailureMessage(
				candidate,
				new Error("no pane owns session session-1"),
			),
		).toBe("Error: no pane owns session session-1");
	});

	it.each([
		["an established conversation", agent({ conversationId: "conversation-1" })],
		["a pending credential switch", agent({ pendingCredentialSwitch: {} as never })],
	] as const)("rejects %s", (_label, candidate) => {
		expect(freshCredentialSwitchEligibility(candidate)).toMatchObject({
			eligible: false,
		});
	});
});
