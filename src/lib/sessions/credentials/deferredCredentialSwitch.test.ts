import { describe, expect, it } from "vitest";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import {
	createDeferredCredentialSwitchIntent,
	evaluateDeferredCredentialSwitchIntent,
	normalizeDeferredCredentialSwitchIntent,
} from "@/lib/sessions/credentials/deferredCredentialSwitch";
import type { ManagedAgentCredentialSwitchInspection } from "@/lib/sessions/managed/managedAgentRehost";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { AccountProfile, Agent } from "@/types";

const account: AccountProfile = {
	id: "account-crispy",
	provider: "codex",
	name: "crispy",
	dir: "/profiles/codex-crispy",
};

function sourceBinding() {
	return managedBindingFixture({
		sessionId: "session-old",
		createIdempotencyKey: "create-old",
		credentialId: "account-default",
		credentialGeneration: 4,
	});
}

function managedAgent(patch: Partial<Agent> = {}): Agent {
	return agentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "session-old",
		conversationId: "conversation-1",
		credentialId: "account-default",
		runtimeBinding: sourceBinding(),
		started: true,
		...patch,
	});
}

function inspection(): ManagedAgentCredentialSwitchInspection {
	return {
		agentId: "agent-managed",
		agentName: "codex-1",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: sourceBinding(),
		sourceCredentialId: "account-default",
		sourceConversationId: "conversation-1",
		targetCredentialId: account.id,
		targetAccount: account,
		conversationId: "conversation-1",
		cwd: "/repo/worktree",
		desktopId: "desktop-1",
		panelId: "agent:agent-managed",
		permissionMode: "default",
		terminalEnvironment: {},
	};
}

function runtime(
	patch: Partial<HmuxAgentRuntimeState> = {},
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "terminal-old",
		revision: "12",
		observedThroughOutputSeq: "20",
		lifecycle: "running",
		activity: "working",
		attention: "none",
		source: "provider_event",
		turnCompletedCount: "7",
		...patch,
	};
}

describe("deferred managed credential switch decision", () => {
	it("persists every non-secret replacement and source fence while a turn is active", () => {
		const intent = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"deferred-1",
			1234,
		);

		expect(intent).toMatchObject({
			schemaVersion: 1,
			requestId: "deferred-1",
			targetCredentialId: "account-crispy",
			targetCredentialDirectory: "/profiles/codex-crispy",
			sourceSessionId: "session-old",
			sourceWorkspaceId: "workspace-1",
			sourceConversationId: "conversation-1",
			sourceCredentialId: "account-default",
			sourceCreateIdempotencyKey: "create-old",
			sourceCredentialGeneration: 4,
			sourceTerminalEpoch: "terminal-old",
			baselineRuntimeRevision: "12",
			baselineTurnCompletedCount: "7",
			panelId: "agent:agent-managed",
			requestedAtMs: 1234,
		});
	});

	it("keeps idle and old-host sources on the existing immediate path", () => {
		expect(
			createDeferredCredentialSwitchIntent(
				inspection(),
				runtime({ activity: "waiting" }),
				"idle",
				1,
			),
		).toBeNull();
		expect(
			createDeferredCredentialSwitchIntent(
				inspection(),
				runtime({
					activity: "waiting",
					attention: "input_required",
				}),
				"untouched-claude",
				1,
			),
		).toBeNull();
		expect(
			createDeferredCredentialSwitchIntent(
				inspection(),
				runtime({ activity: "waiting", attention: "error" }),
				"idle-error",
				1,
			),
		).toBeNull();
		expect(
			createDeferredCredentialSwitchIntent(
				inspection(),
				runtime({ turnCompletedCount: undefined }),
				"old-host",
				1,
			),
		).toBeNull();
	});

	it("treats locally-dispatched input as active before the Host echo arrives", () => {
		expect(
			createDeferredCredentialSwitchIntent(
				inspection(),
				runtime({ activity: "waiting" }),
				"local-input",
				1,
				{ inputWorking: true },
			),
		).not.toBeNull();
	});

	it("does not treat approval or waiting heuristics as turn completion", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime({ activity: "waiting", attention: "approval_required" }),
			"approval",
			1,
		);
		expect(pending).not.toBeNull();
		if (!pending) throw new Error("expected pending intent");

		expect(
			evaluateDeferredCredentialSwitchIntent(
				pending,
				managedAgent(),
				[account],
				runtime({ activity: "waiting", attention: "none" }),
			),
		).toEqual({ kind: "waiting" });
	});

	it("checkpoints an exact orchestration idle boundary", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"orchestration-idle",
			1,
		);
		if (!pending) throw new Error("expected pending intent");
		const orchestrationIdle = runtime({
			revision: "13",
			activity: "waiting",
			attention: "none",
			source: "orchestration_event",
		});

		const checkpoint = evaluateDeferredCredentialSwitchIntent(
			pending,
			managedAgent(),
			[account],
			orchestrationIdle,
		);
		expect(checkpoint).toMatchObject({
			kind: "checkpoint",
			intent: {
				completionRuntimeRevision: "13",
				completionTurnCompletedCount: "7",
			},
		});
		if (checkpoint.kind !== "checkpoint") {
			throw new Error("expected idle checkpoint");
		}
		expect(checkpoint.intent.completionReason).toBeUndefined();
		expect(
			evaluateDeferredCredentialSwitchIntent(
				checkpoint.intent,
				managedAgent(),
				[account],
				orchestrationIdle,
			),
		).toEqual({ kind: "ready" });
	});

	it.each([
		{ source: "controller_input" as const, activity: "waiting" as const },
		{ source: "controller_input" as const, activity: "working" as const },
		{ attention: "error" as const },
		{ attention: "input_required" as const },
		{ attention: "approval_required" as const },
		{ attentionId: "attention-1" },
	])(
		"does not authorize a stop from a non-quiescent Host projection %#",
		(patch) => {
			const pending = createDeferredCredentialSwitchIntent(
				inspection(),
				runtime(),
				"unsafe",
				1,
			);
			if (!pending) throw new Error("expected pending intent");
			expect(
				evaluateDeferredCredentialSwitchIntent(
					pending,
					managedAgent(),
					[account],
					runtime({ revision: "13", activity: "waiting", ...patch }),
				),
			).toEqual({ kind: "waiting" });
		},
	);

	it("checkpoints the exact Host completion event before becoming ready", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"ready",
			1,
		);
		if (!pending) throw new Error("expected pending intent");

		const checkpoint = evaluateDeferredCredentialSwitchIntent(
			pending,
			managedAgent(),
			[account],
			runtime({
				revision: "13",
				activity: "waiting",
				turnCompletedCount: "8",
			}),
		);
		expect(checkpoint).toMatchObject({
			kind: "checkpoint",
			intent: {
				completionRuntimeRevision: "13",
				completionTurnCompletedCount: "8",
			},
		});
		if (checkpoint.kind !== "checkpoint") {
			throw new Error("expected completion checkpoint");
		}
		expect(
			evaluateDeferredCredentialSwitchIntent(
				checkpoint.intent,
				managedAgent(),
				[account],
				runtime({
					revision: "13",
					activity: "waiting",
					turnCompletedCount: "8",
				}),
			),
		).toEqual({ kind: "ready" });
	});

	it("rebaselines a completion whose current state remains working", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"new-turn",
			1,
		);
		if (!pending) throw new Error("expected pending intent");

		const decision = evaluateDeferredCredentialSwitchIntent(
			pending,
			managedAgent(),
			[account],
			runtime({ revision: "14", turnCompletedCount: "8" }),
		);
		expect(decision).toMatchObject({
			kind: "rebaseline",
			intent: {
				baselineRuntimeRevision: "14",
				baselineTurnCompletedCount: "8",
			},
		});
	});

	it("keeps a completion checkpoint while local activity catches up", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"local-race",
			1,
		);
		if (!pending) throw new Error("expected pending intent");

		const checkpoint = evaluateDeferredCredentialSwitchIntent(
			pending,
			managedAgent(),
			[account],
			runtime({
				revision: "13",
				activity: "waiting",
				turnCompletedCount: "8",
			}),
		);
		if (checkpoint.kind !== "checkpoint") {
			throw new Error("expected completion checkpoint");
		}
		expect(
			evaluateDeferredCredentialSwitchIntent(
				checkpoint.intent,
				managedAgent(),
				[account],
				runtime({
					revision: "13",
					activity: "waiting",
					turnCompletedCount: "8",
				}),
				{ inputWorking: true },
			),
		).toEqual({ kind: "waiting" });
		expect(
			evaluateDeferredCredentialSwitchIntent(
				checkpoint.intent,
				managedAgent(),
				[account],
				runtime({
					revision: "13",
					activity: "waiting",
					turnCompletedCount: "8",
				}),
			),
		).toEqual({ kind: "ready" });
	});

	it("fails closed when a source fence or selected account directory changes", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"stale",
			1,
		);
		if (!pending) throw new Error("expected pending intent");
		const completed = runtime({
			revision: "13",
			activity: "waiting",
			turnCompletedCount: "8",
		});

		expect(
			evaluateDeferredCredentialSwitchIntent(
				pending,
				managedAgent({ conversationId: "conversation-2" }),
				[account],
				completed,
			),
		).toEqual({ kind: "stale", reason: "source_conversation_changed" });
		expect(
			evaluateDeferredCredentialSwitchIntent(
				pending,
				managedAgent(),
				[{ ...account, dir: "/profiles/replaced" }],
				completed,
			),
		).toEqual({ kind: "stale", reason: "target_credential_changed" });
	});

	it("replays a checkpointed replacement when reload observes an exited source", () => {
		const pending = createDeferredCredentialSwitchIntent(
			inspection(),
			runtime(),
			"replay",
			1,
		);
		if (!pending) throw new Error("expected pending intent");
		const checkpoint = evaluateDeferredCredentialSwitchIntent(
			pending,
			managedAgent(),
			[account],
			runtime({
				revision: "13",
				activity: "waiting",
				turnCompletedCount: "8",
			}),
		);
		if (checkpoint.kind !== "checkpoint") {
			throw new Error("expected completion checkpoint");
		}

		expect(
			evaluateDeferredCredentialSwitchIntent(
				checkpoint.intent,
				managedAgent(),
				[account],
				runtime({
					revision: "14",
					lifecycle: "exited",
					activity: "waiting",
					turnCompletedCount: "8",
				}),
			),
		).toEqual({ kind: "ready" });
	});
});

describe("persisted revisioned deferred requests", () => {
	it.each([
		{ model: "gpt-6-astra", effort: "xhigh" },
		{ model: "gpt-6-astra", effort: "xhigh", permissionMode: "invented" },
		{ model: 7, effort: "xhigh", permissionMode: "skip_permissions" },
	])(
		"rejects an incomplete or invalid persisted settings target %j",
		(targetLaunchSelection) => {
			const intent = createDeferredCredentialSwitchIntent(
				inspection(),
				runtime(),
				"request-1",
				1,
			);
			expect(
				normalizeDeferredCredentialSwitchIntent({
					...intent,
					sourceSelectionRevision: 7,
					targetLaunchSelection,
				}),
			).toBeUndefined();
		},
	);
	it.each([-1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 1])(
		"rejects malformed source revision %s",
		(revision) => {
			const intent = createDeferredCredentialSwitchIntent(
				inspection(),
				runtime(),
				"request-1",
				1,
			);
			expect(
				normalizeDeferredCredentialSwitchIntent({
					...intent,
					sourceSelectionRevision: revision,
				}),
			).toBeUndefined();
		},
	);
});
