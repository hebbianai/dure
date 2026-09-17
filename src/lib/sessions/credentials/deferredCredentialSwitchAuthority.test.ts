import { describe, expect, it } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { evaluateDeferredCredentialSwitchIntent } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { DeferredCredentialSwitchIntentV1 } from "@/types";

const agent = agentFixture({
	id: "agent-claude",
	provider: "claude",
	sessionId: "session-source",
	conversationId: "conversation-1",
	credentialId: "account-source",
	runtimeBinding: managedBindingFixture({
		sessionId: "session-source",
		createIdempotencyKey: "create-source",
		credentialId: "account-source",
	}),
});

const target = {
	id: "account-target",
	provider: "claude" as const,
	name: "target",
	dir: "/profiles/claude-target",
};

const pending: DeferredCredentialSwitchIntentV1 = {
	schemaVersion: 1,
	requestId: "switch-1",
	targetCredentialId: target.id,
	targetCredentialDirectory: target.dir,
	sourceSessionId: "session-source",
	sourceWorkspaceId: "workspace-1",
	sourceConversationId: "conversation-1",
	sourceCredentialId: "account-source",
	sourceCreateIdempotencyKey: "create-source",
	sourceCredentialGeneration: null,
	sourceTerminalEpoch: "terminal-source",
	sourceSelectionRevision: 8,
	baselineRuntimeRevision: "4",
	baselineTurnCompletedCount: "0",
	panelId: "agent:agent-claude",
	requestedAtMs: 1,
};

const controllerWaiting: HmuxAgentRuntimeState = {
	terminalEpoch: "terminal-source",
	revision: "4",
	observedThroughOutputSeq: "1004",
	lifecycle: "running",
	activity: "waiting",
	attention: "none",
	source: "controller_input",
	turnCompletedCount: "0",
};

describe("deferred credential switch Host authority", () => {
	it("does not replay a hydrated controller-idle checkpoint as a safe stop", () => {
		// Older watchers could persist this checkpoint after ten silent seconds.
		// The same projection is not eligible at the Host's stop boundary.
		const restored = {
			...pending,
			completionRuntimeRevision: "4",
			completionTurnCompletedCount: "0",
		};
		expect(
			evaluateDeferredCredentialSwitchIntent(
				restored,
				agent,
				[target],
				controllerWaiting,
			),
		).toEqual({ kind: "waiting" });
	});

	it.each(["provider_event", "orchestration_event"] as const)(
		"consumes a real %s idle event without a timer or successful-count increment",
		(source) => {
			const authored = { ...controllerWaiting, revision: "5", source };
			const decision = evaluateDeferredCredentialSwitchIntent(
				pending,
				agent,
				[target],
				authored,
			);
			expect(decision.kind).toBe("checkpoint");
			if (decision.kind !== "checkpoint") throw new Error("missing boundary");
			expect(decision.intent.completionTurnCompletedCount).toBe("0");
			expect(
				evaluateDeferredCredentialSwitchIntent(
					decision.intent,
					agent,
					[target],
					authored,
				),
			).toEqual({ kind: "ready" });
		},
	);

	it("retains the separate explicit user-authorized interruption path", () => {
		expect(
			evaluateDeferredCredentialSwitchIntent(
				{
					...pending,
					completionRuntimeRevision: "4",
					completionTurnCompletedCount: "0",
					completionReason: "user_requested",
				},
				agent,
				[target],
				controllerWaiting,
			),
		).toEqual({ kind: "ready" });
	});
});
