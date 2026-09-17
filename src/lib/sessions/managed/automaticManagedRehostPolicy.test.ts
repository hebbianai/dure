import { describe, expect, it } from "vitest";
import type { HmuxAgentRuntimeState, HmuxSessionSummary } from "@/lib/ipc";
import {
	type AutomaticManagedRehostSnapshot,
	assessAutomaticManagedRehost,
	HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY,
} from "@/lib/sessions/managed/automaticManagedRehostPolicy";
import type { HmuxPaneHealth } from "@/lib/terminal/terminalHealth";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(patch: Partial<Agent> = {}): Agent {
	return managedAgentFixture({
		id: "agent-1",
		name: "codex-1",
		worktreePath: "/repo/.worktrees/codex-1",
		branch: "agent/codex-1",
		sessionId: "session-old",
		conversationId: "conversation-1",
		runtimeBinding: managedBindingFixture({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: undefined,
		}),
		...patch,
	});
}

function session(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
	return {
		sessionId: "session-old",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "compatible_old_healthy",
		inputAllowed: true,
		detachOnly: false,
		terminalEpoch: "epoch-old",
		outputSeq: "42",
		capabilities: [HMUX_MANAGED_IDLE_REPLACEMENT_GUARD_CAPABILITY],
		...patch,
	};
}

function runtime(
	patch: Partial<HmuxAgentRuntimeState> = {},
): HmuxAgentRuntimeState {
	return {
		terminalEpoch: "epoch-old",
		revision: "9",
		observedThroughOutputSeq: "42",
		lifecycle: "running",
		activity: "waiting",
		attention: "none",
		source: "provider_event",
		turnCompletedCount: "3",
		...patch,
	};
}

function health(patch: Partial<HmuxPaneHealth> = {}): HmuxPaneHealth {
	return {
		state: "live",
		terminalEpoch: "epoch-old",
		receivedSequence: "42",
		presentedSequence: "42",
		updatedAt: 100,
		...patch,
	};
}

function snapshot(
	patch: Partial<AutomaticManagedRehostSnapshot> = {},
): AutomaticManagedRehostSnapshot {
	return {
		agent: agent(),
		session: session(),
		runtime: runtime(),
		pane: {
			desktopId: "desktop-offscreen",
			panelId: "agent:agent-1",
			health: health(),
		},
		inputWorking: false,
		visibleDesktopIds: new Set(["desktop-visible"]),
		...patch,
	};
}

describe("automatic managed rehost policy", () => {
	it.each([
		"pane-current",
		"launcher:previous",
		"term:previous",
		"agent:previous",
		"agent:agent-1",
	])(
		"admits the exact old, idle, fully presented off-screen generation in %s",
		(panelId) => {
			const current = snapshot();
			current.pane = { ...current.pane!, panelId };
			expect(assessAutomaticManagedRehost(current)).toEqual({
				eligible: true,
				identity: JSON.stringify([
					"local",
					"workspace-1",
					"session-old",
					"epoch-old",
				]),
				agentId: "agent-1",
				desktopId: "desktop-offscreen",
				panelId,
				source: "local",
				hostId: "local",
				idleReplacementGuard: {
					runtimeRevision: "9",
					outputSequence: "42",
					providerId: "codex",
					conversationId: "conversation-1",
				},
			});
		},
	);

	it("keeps old Hosts without the atomic guard on the manual path", () => {
		expect(
			assessAutomaticManagedRehost(
				snapshot({ session: session({ capabilities: [] }) }),
			),
		).toEqual({
			eligible: false,
			reason: "idle_replacement_guard_unavailable",
		});
	});

	it("admits an exact remote generation only with matching host and stop fence", () => {
		const stopFence = stopFenceFixture({
			runnerPrincipal: "principal",
			runnerInstance: "instance",
			hostInstanceId: "host-old",
			terminalEpoch: "epoch-old",
		});
		const remote = agent({
			sessionKind: "ssh",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "ssh-host",
				sessionId: "session-old",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-old",
				commandBridgeNonce: "bridge-old",
				stopFence,
			},
		});
		expect(
			assessAutomaticManagedRehost(
				snapshot({
					agent: remote,
					session: session({
						runtimeHost: "ssh-host",
						stopFence,
					}),
				}),
			),
		).toMatchObject({
			eligible: true,
			source: "ssh",
			hostId: "ssh-host",
		});

		expect(
			assessAutomaticManagedRehost(
				snapshot({
					agent: remote,
					session: session({
						runtimeHost: "other-host",
						stopFence,
					}),
				}),
			),
		).toEqual({ eligible: false, reason: "source_identity_mismatch" });
	});

	it.each([
		["visible_desktop", { visibleDesktopIds: new Set(["desktop-offscreen"]) }],
		["input_working", { inputWorking: true }],
		["runtime_working", { runtime: runtime({ activity: "working" }) }],
		[
			"runtime_attention",
			{ runtime: runtime({ attention: "approval_required" }) },
		],
		[
			"credential_switch_pending",
			{
				agent: agent({
					pendingCredentialSwitch: {
						schemaVersion: 1,
						requestId: "switch-1",
						targetCredentialId: null,
						targetCredentialDirectory: null,
						sourceSessionId: "session-old",
						sourceWorkspaceId: "workspace-1",
						sourceConversationId: "conversation-1",
						sourceCredentialId: null,
						sourceCreateIdempotencyKey: null,
						sourceCredentialGeneration: null,
						sourceTerminalEpoch: "epoch-old",
						baselineRuntimeRevision: "9",
						baselineTurnCompletedCount: "3",
						panelId: "agent:agent-1",
						requestedAtMs: 1,
					},
				}),
			},
		],
		[
			"pending_output",
			{
				pane: {
					...snapshot().pane!,
					health: health({ presentedSequence: "41" }),
				},
			},
		],
		[
			"pending_output",
			{ runtime: runtime({ observedThroughOutputSeq: "41" }) },
		],
		[
			"source_not_old_healthy",
			{ session: session({ health: "current_healthy" }) },
		],
		["pane_unavailable", { pane: undefined }],
	] as const)("defers %s without relaxing another fence", (reason, patch) => {
		expect(assessAutomaticManagedRehost(snapshot(patch))).toEqual({
			eligible: false,
			reason,
		});
	});

	it("rejects mismatched source identities and transport generations", () => {
		expect(
			assessAutomaticManagedRehost(
				snapshot({
					session: session({ workspaceId: "workspace-other" }),
				}),
			),
		).toEqual({ eligible: false, reason: "source_identity_mismatch" });
		expect(
			assessAutomaticManagedRehost(
				snapshot({
					runtime: runtime({ terminalEpoch: "epoch-other" }),
				}),
			),
		).toEqual({ eligible: false, reason: "runtime_unavailable" });
		expect(
			assessAutomaticManagedRehost(
				snapshot({
					pane: {
						...snapshot().pane!,
						health: health({ terminalEpoch: "epoch-other" }),
					},
				}),
			),
		).toEqual({ eligible: false, reason: "pending_output" });
	});
});
