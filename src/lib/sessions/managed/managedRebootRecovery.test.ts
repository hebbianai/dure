import { describe, expect, it } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";
import type { Agent } from "@/types";
import {
	assessManagedRebootRecovery,
	automaticManagedRebootRecoveryCandidates,
	automaticManagedShellRebootRecoveryCandidates,
	automaticStandaloneRebootRecoveryCandidates,
	findRebootStaleManagedSource,
} from "@/lib/sessions/managed/managedRebootRecovery";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
} from "@/lib/terminal/terminalBinding";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

function summary(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
	return {
		sessionId: "managed-1",
		workspaceId: "workspace-1",
		sessionClass: "managed",
		lifecycle: "unavailable",
		manifestLifecycle: "ready",
		health: "stale_transport",
		hostProcessAlive: false,
		terminalEpoch: "terminal-before-reboot",
		outputSeq: "41",
		capabilities: [],
		...patch,
	};
}

describe("managed reboot recovery classification", () => {
	it("selects only the exact managed Ready manifest with a stale transport", () => {
		const source = findRebootStaleManagedSource(
			[
				summary({ sessionId: "sibling" }),
				summary({ workspaceId: "other-workspace" }),
				summary(),
			],
			{ sessionId: "managed-1", workspaceId: "workspace-1" },
		);

		expect(source?.terminalEpoch).toBe("terminal-before-reboot");
	});

	it.each([
		{ hostProcessAlive: undefined },
		{ hostProcessAlive: true },
		{ health: "current_healthy" as const, lifecycle: "ready" as const },
		{ health: "incompatible_protocol" as const },
		{ manifestLifecycle: "exited" as const, lifecycle: "exited" as const },
		{ sessionClass: "standalone" as const },
	])("refuses non-reboot posture %#", (patch) => {
		expect(
			findRebootStaleManagedSource([summary(patch)], {
				sessionId: "managed-1",
				workspaceId: "workspace-1",
			}),
		).toBeUndefined();
	});

	it.each(
		(["managed", "standalone"] as const).flatMap((sessionClass) =>
			["term:shell-1", "slot", "launcher:previous", "agent:previous"].map(
				(panelId) => ({ sessionClass, panelId }),
			),
		),
	)(
		"recovers actual $sessionClass content at $panelId only after Host absence is confirmed",
		({ sessionClass, panelId }) => {
			const stopFence = stopFenceFixture();
			const binding =
				sessionClass === "managed"
					? hmuxManagedBinding(
							"shell-1",
							"dure-local-shells-v1",
							undefined,
							undefined,
							stopFence,
						)
					: hmuxStandaloneBinding("shell-1", "dure-local-shells-v1");
			const snapshot = {
				layouts: {
					"desktop-1": {
						panels: {
							[panelId]: {
								contentComponent: "terminal",
								params: { sessionId: "shell-1", binding },
							},
						},
					},
				},
				visibleDesktopIds: new Set(["desktop-1"]),
				claimedSessionIds: new Set<string>(),
			};
			const select =
				sessionClass === "managed"
					? automaticManagedShellRebootRecoveryCandidates
					: automaticStandaloneRebootRecoveryCandidates;
			const session = summary({
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				sessionClass,
				stopFence,
				retirementPolicy: {
					kind: "after_graceful_last_client_departure_v1",
					gracePeriodMs: 2_000,
				},
			});
			for (const hostProcessAlive of [undefined, true]) {
				expect(
					select({
						...snapshot,
						sessions: [{ ...session, hostProcessAlive }],
					}),
				).toEqual([]);
			}
			expect(select({ ...snapshot, sessions: [session] })).toHaveLength(1);
			snapshot.layouts["desktop-1"].panels[panelId].contentComponent =
				"launcher";
			expect(select({ ...snapshot, sessions: [session] })).toEqual([]);
		},
	);

	it.each(
		[false, true].flatMap((socketOwnerAbsent) =>
			["agent:agent-1", "slot", "launcher:previous", "agent:previous"].map(
				(panelId) => ({ socketOwnerAbsent, panelId }),
			),
		),
	)(
		"admits an exact visible conversation ($panelId, socket owner absent: $socketOwnerAbsent)",
		({ socketOwnerAbsent, panelId }) => {
			const stopFence = stopFenceFixture({
				terminalEpoch: "terminal-before-reboot",
			});
			const agent = managedAgentFixture({
				id: "agent-1",
				projectId: "project-1",
				sessionId: "managed-1",
				conversationId: "conversation-1",
				started: undefined,
				runtimeBinding: managedBindingFixture({
					sessionId: "managed-1",
					workspaceId: "workspace-1",
					stopFence,
				}),
			});

			expect(
				automaticManagedRebootRecoveryCandidates({
					agents: [agent],
					projects: [
						{
							id: "project-1",
							name: "Repo",
							path: "/repo",
							kind: "local",
							isRepo: true,
						},
					],
					layouts: {
						"desktop-1": {
							panels: {
								[panelId]: {
									contentComponent: "agent",
									params: { agentRef: { agentId: agent.id } },
								},
							},
						},
					},
					sessions: [
						summary({
							stopFence,
							...(socketOwnerAbsent
								? { hostProcessAlive: true, hostSocketOwnerAbsent: true }
								: {}),
						}),
					],
					visibleDesktopIds: new Set(["desktop-1"]),
				}),
			).toEqual([
				{
					identity: JSON.stringify([
						"workspace-1",
						"managed-1",
						"terminal-before-reboot",
					]),
					agentId: "agent-1",
					desktopId: "desktop-1",
					panelId,
					conversationId: "conversation-1",
					...(socketOwnerAbsent ? { requireSocketOwnerAbsent: true } : {}),
				},
			]);
		},
	);

	it("admits an unclaimed visible managed local shell with pending cleanup", () => {
		const stopFence = stopFenceFixture({
			terminalEpoch: "shell-before-reboot",
		});
		const binding = hmuxManagedBinding(
			"shell-1",
			"dure-local-shells-v1",
			undefined,
			undefined,
			stopFence,
		);

		expect(
			automaticManagedShellRebootRecoveryCandidates({
				layouts: {
					"desktop-1": {
						panels: {
							"term:shell-1": {
								contentComponent: "terminal",
								params: {
									sessionId: "shell-1",
									binding,
									managedShellUpgrade: {
										schemaVersion: 1,
										operationId: "upgrade-before-reboot",
									},
								},
							},
						},
					},
				},
				sessions: [
					summary({
						sessionId: "shell-1",
						workspaceId: "dure-local-shells-v1",
						terminalEpoch: "shell-before-reboot",
						stopFence,
					}),
				],
				visibleDesktopIds: new Set(["desktop-1"]),
				claimedSessionIds: new Set(),
			}),
		).toEqual([
			{
				identity: JSON.stringify([
					"dure-local-shells-v1",
					"shell-1",
					"shell-before-reboot",
				]),
				desktopId: "desktop-1",
				panelId: "term:shell-1",
			},
		]);
	});
});

describe("restore-all assessment across every Space", () => {
	const stopFence = stopFenceFixture({
		terminalEpoch: "terminal-before-reboot",
	});
	const project = {
		id: "project-1",
		name: "Repo",
		path: "/repo",
		kind: "local" as const,
		isRepo: true,
	};
	const identity = JSON.stringify([
		"workspace-1",
		"managed-1",
		"terminal-before-reboot",
	]);

	function agent(patch: Partial<Agent> = {}): Agent {
		return managedAgentFixture({
			id: "agent-1",
			projectId: "project-1",
			sessionId: "managed-1",
			conversationId: "conversation-1",
			runtimeBinding: managedBindingFixture({
				sessionId: "managed-1",
				workspaceId: "workspace-1",
				stopFence,
			}),
			...patch,
		});
	}

	function pane(desktopId: string, panelId = "agent:agent-1") {
		return {
			[desktopId]: {
				panels: {
					[panelId]: {
						contentComponent: "agent",
						params: { agentRef: { agentId: "agent-1" } },
					},
				},
			},
		};
	}

	function assess(
		patch: {
			agents?: Agent[];
			layouts?: Record<string, unknown>;
			sessions?: HmuxSessionSummary[];
		} = {},
		desktopIds?: ReadonlySet<string>,
	) {
		return assessManagedRebootRecovery(
			{
				agents: patch.agents ?? [agent()],
				projects: [project],
				layouts: patch.layouts ?? pane("background"),
				sessions: patch.sessions ?? [summary({ stopFence })],
			},
			desktopIds,
		);
	}

	it("restores a pane in a Space no window shows only when every Space is in scope", () => {
		expect(assess({}, new Set(["visible"]))).toEqual([
			{
				outcome: "skipped",
				identity,
				agentId: "agent-1",
				reason: "pane_missing",
			},
		]);
		expect(assess()).toEqual([
			{
				outcome: "restorable",
				candidate: {
					identity,
					agentId: "agent-1",
					desktopId: "background",
					panelId: "agent:agent-1",
					conversationId: "conversation-1",
				},
			},
		]);
		expect(
			automaticManagedRebootRecoveryCandidates({
				agents: [agent()],
				projects: [project],
				layouts: pane("background"),
				sessions: [summary({ stopFence })],
				visibleDesktopIds: new Set(["visible"]),
			}),
		).toEqual([]);
	});

	it("leaves out agents whose Host still runs, Chat agents and remote agents", () => {
		expect(
			assess({ sessions: [summary({ stopFence, hostProcessAlive: true })] }),
		).toEqual([]);
		expect(
			assess({
				sessions: [
					summary({
						stopFence,
						health: "current_healthy",
						lifecycle: "ready",
					}),
				],
			}),
		).toEqual([]);
		expect(
			assess({
				agents: [
					agent({
						interactionProfile: {
							schemaVersion: 1,
							kind: "structured_protocol",
							backendProfileId: "local",
							interactionSessionId: "interaction-1",
						} as Agent["interactionProfile"],
					}),
				],
			}),
		).toEqual([]);
		expect(
			assess({
				agents: [
					agent({
						runtimeBinding: {
							...managedBindingFixture({
								sessionId: "managed-1",
								workspaceId: "workspace-1",
								stopFence,
							}),
							source: "ssh",
							hostId: "ssh-1",
						} as Agent["runtimeBinding"],
					}),
				],
			}),
		).toEqual([]);
	});

	it.each([
		{
			reason: "runtime_generation_changed",
			patch: {
				sessions: [
					summary({
						stopFence: stopFenceFixture({ terminalEpoch: "a-later-terminal" }),
					}),
				],
			},
		},
		{
			reason: "transition_in_progress",
			patch: {
				agents: [
					agent({
						pendingCredentialSwitch: {
							targetCredentialId: "account-2",
						} as Agent["pendingCredentialSwitch"],
					}),
				],
			},
		},
		{
			reason: "no_conversation_id",
			patch: { agents: [agent({ conversationId: undefined })] },
		},
		{
			reason: "provider_without_exact_resume",
			patch: { agents: [agent({ provider: "rovo-dev" })] },
		},
		{ reason: "pane_missing", patch: { layouts: {} } },
		{
			reason: "pane_ambiguous",
			patch: { layouts: { ...pane("first"), ...pane("second", "slot") } },
		},
	])("lists an agent it can't restore with $reason", ({ reason, patch }) => {
		expect(assess(patch as Parameters<typeof assess>[0])).toEqual([
			{ outcome: "skipped", identity, agentId: "agent-1", reason },
		]);
	});
});
