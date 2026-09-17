import { describe, expect, it, vi } from "vitest";
import {
	executeManagedAgentPermissionModeRelaunch,
	type ManagedAgentPermissionModeRelaunchRuntime,
} from "@/lib/sessions/managed/managedAgentPermissionModeRelaunch";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehost";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority(
	"backend-local",
	"generation-1",
);

const sourceFence = stopFenceFixture({
	runnerPrincipal: "principal-old",
	runnerInstance: "runner-old",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});
const targetFence = stopFenceFixture({
	runnerPrincipal: "principal-new",
	runnerInstance: "runner-new",
	channelEpoch: "8",
	hostInstanceId: "host-new",
	terminalEpoch: "terminal-new",
});

function inspection(): ManagedAgentRehostInspection {
	return {
		agentId: "agent-1",
		agentName: "worker",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: managedBindingFixture({
			sessionId: "session-old",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-old",
			stopFence: sourceFence,
		}),
		sourceConversationId: "conversation-1",
		sourceLifecycle: "ready",
		sourcePaneState: "present",
		conversationId: "conversation-1",
		cwd: "/repo/worktree",
		desktopId: "desktop-1",
		panelId: "agent:agent-1",
		permissionMode: "default",
		terminalEnvironment: {},
		plan: {
			sessionId: "session-old",
			sourceBuildId: "build-current",
			targetBuildId: "build-current",
			action: "replace_ai_provider_with_explicit_conversation",
			allowed: true,
			requiresConfirmation: true,
		},
	};
}

function execution(
	replayed = false,
	permissionMode: "default" | "bypass_approvals" = "bypass_approvals",
) {
	const replacement = {
		sessionId: "session-new",
		workspaceId: "workspace-1",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		terminalEpoch: "terminal-new",
		stopFence: targetFence,
		outputSeq: "0",
		capabilities: [],
	};
	return {
		recovery: {
			providerId: "codex" as const,
			permissionMode,
			conversationId: "conversation-1",
			createIdempotencyKey: "permission-relaunch-1",
			backendRouteAuthority: routeAuthority,
			replacement,
			receipt: {
				sourceSessionId: "session-old",
				targetBuildId: "build-current",
				action: "replace_ai_provider_with_explicit_conversation" as const,
				outcome: "replaced" as const,
				replayed,
				operationId: "permission-relaunch-1",
				conversationId: "conversation-1",
				sourceStopReceipt: {
					schema: "hmux-managed-stop-v1" as const,
					schemaVersion: 2 as const,
					stopId: "permission-relaunch-1:stop",
					sessionId: "session-old",
					workspaceId: "workspace-1",
					runnerPrincipal: sourceFence.runnerPrincipal,
					runnerInstance: sourceFence.runnerInstance,
					channelEpoch: 7,
					hostInstanceId: sourceFence.hostInstanceId,
					terminalEpoch: sourceFence.terminalEpoch,
					outcome: "stopped" as const,
					exitReason: "managed_rehost",
				},
				replacementTarget: {
					idempotencyKey: "permission-relaunch-1",
					sessionId: "session-new",
					workspaceId: "workspace-1",
					providerId: "codex",
					permissionMode,
					...targetFence,
				},
				replacementSession: replacement,
			},
		},
	};
}

function runtime(
	overrides: Partial<ManagedAgentPermissionModeRelaunchRuntime> = {},
) {
	const dispatchTarget = {
		authority: { workspaceId: "workspace-1" },
		runId: `run.${"a".repeat(64)}`,
		taskId: `task.${"a".repeat(64)}`,
		dispatchId: `dispatch.${"a".repeat(64)}`,
		generation: 1,
	};
	const value: ManagedAgentPermissionModeRelaunchRuntime = {
		rebindDispatchSession: vi.fn(async (_routeAuthority, request) => ({
			schemaVersion: 1 as const,
			operationId: request.operationId,
			outcome: "rebound" as const,
			source: request.source,
			target: request.target,
			runId: dispatchTarget.runId,
			taskId: dispatchTarget.taskId,
			dispatchId: dispatchTarget.dispatchId,
			generation: 1,
		})),
		execute: vi.fn(async (_inspection, options) => {
			await options.beforeStop();
			return execution();
		}),
		syncPayload: vi.fn(
			() => ({ binding: { sessionId: "session-new" } }) as never,
		),
		commitReceipt: vi.fn(async (payload) => ({
			projection: "applied" as const,
			presentation: "applied" as const,
			pane: {
				desktopId: "desktop-1",
				panelId: "agent:agent-1",
				sessionId: "session-new",
				workspaceId: "workspace-1",
				runtime: "hmux_managed_v1" as const,
				source: "local" as const,
				hostId: "local" as const,
				cwd: "/repo/worktree",
				conversationId: "conversation-1",
			},
			payload,
		})),
		emit: vi.fn(),
		setMetadata: vi.fn(),
		now: () => 1_200,
		...overrides,
	};
	return value;
}

describe("managed Agent permission-mode relaunch", () => {
	it("refuses an unchanged mode before stopping the source", async () => {
		let sourceStopped = false;
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				await options.beforeStop();
				sourceStopped = true;
				return execution();
			}),
		});

		await expect(
			executeManagedAgentPermissionModeRelaunch(inspection(), "default", deps),
		).rejects.toThrow("permission_mode_unchanged");
		expect(sourceStopped).toBe(false);
		expect(deps.rebindDispatchSession).not.toHaveBeenCalled();
		expect(deps.commitReceipt).not.toHaveBeenCalled();
	});

	it("changes the provider generation and rebinds the exact active Dispatch", async () => {
		const deps = runtime();
		const result = await executeManagedAgentPermissionModeRelaunch(
			inspection(),
			"skip_permissions",
			deps,
		);

		expect(deps.execute).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				permissionMode: "bypass_approvals",
				beforeStop: expect.any(Function),
			}),
		);
		expect(deps.rebindDispatchSession).toHaveBeenCalledWith(
			routeAuthority,
			expect.objectContaining({
				operationId: "permission-relaunch-1",
				source: expect.objectContaining({
					sessionId: "session-old",
					terminalEpoch: "terminal-old",
				}),
				target: expect.objectContaining({
					sessionId: "session-new",
					terminalEpoch: "terminal-new",
				}),
			}),
		);
		expect(result).toMatchObject({
			presentation: "applied",
			receipt: {
				schema: "dure-agent-permission-mode-relaunch-v1",
				schemaVersion: 1,
				outcome: "relaunched",
				currentMode: "default",
				targetMode: "skip_permissions",
				restartImpact: "provider_process_restarted",
				sourceSessionId: "session-old",
				targetSessionId: "session-new",
			},
			pane: { sessionId: "session-new" },
		});
	});

	it("keeps a permission relaunch committed while its pane is unmounted", async () => {
		const deps = runtime({
			commitReceipt: vi.fn(async (payload) => ({
				projection: "applied" as const,
				presentation: "pending" as const,
				pane: null,
				payload,
			})),
		});

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspection(),
				"skip_permissions",
				deps,
			),
		).resolves.toMatchObject({
			presentation: "pending",
			receipt: { outcome: "relaunched", targetSessionId: "session-new" },
		});
		expect(deps.emit).toHaveBeenCalledOnce();
	});

	it("relaunches a bypassed provider back into the default mode", async () => {
		const inspected = inspection();
		inspected.permissionMode = "bypass_approvals";
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				await options.beforeStop();
				return execution(false, "default");
			}),
		});

		const result = await executeManagedAgentPermissionModeRelaunch(
			inspected,
			"default",
			deps,
		);

		expect(deps.execute).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ permissionMode: "default" }),
		);
		expect(result.receipt).toMatchObject({
			currentMode: "skip_permissions",
			targetMode: "default",
		});
	});

	it("reuses the shared rehost Dispatch handoff without rebinding twice", async () => {
		const completed = execution();
		const dispatch = {
			schemaVersion: 1 as const,
			operationId: "permission-relaunch-1",
			outcome: "rebound" as const,
			source: {
				sessionId: "session-old",
				workspaceId: "workspace-1",
				providerId: "codex" as const,
				...sourceFence,
			},
			target: {
				sessionId: "session-new",
				workspaceId: "workspace-1",
				providerId: "codex" as const,
				...targetFence,
			},
			runId: `run.${"a".repeat(64)}`,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				await options.beforeStop();
				return { ...completed, dispatch };
			}),
		});

		await executeManagedAgentPermissionModeRelaunch(
			inspection(),
			"skip_permissions",
			deps,
		);

		expect(deps.rebindDispatchSession).not.toHaveBeenCalled();
	});

	it("propagates a missing exact source from the shared rehost execution", async () => {
		const inspected = inspection();
		inspected.sourceBinding.stopFence = undefined;
		const deps = runtime({
			execute: vi
				.fn()
				.mockRejectedValue(
					new Error(
						"orchestrated managed rehost requires an exact source generation",
					),
				),
		});

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).rejects.toThrow("exact source generation");
		expect(deps.execute).toHaveBeenCalledOnce();
		expect(deps.rebindDispatchSession).not.toHaveBeenCalled();
	});

	it("recovers response loss from the journal when post-stop client hints are stale or missing", async () => {
		let journaled = false;
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				if (!journaled) {
					await options.beforeStop();
					journaled = true;
					throw new Error("response lost after replacement launch");
				}
				return execution(true);
			}),
		});
		const inspected = inspection();

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).rejects.toThrow("response lost");
		inspected.permissionMode = "bypass_approvals";
		inspected.sourceBinding.stopFence = undefined;
		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).resolves.toMatchObject({ receipt: { replayed: true } });
		expect(deps.rebindDispatchSession).toHaveBeenCalledOnce();
	});

	it("continues a journal whose source stopped before replacement launch", async () => {
		let sourceStopped = false;
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				if (!sourceStopped) {
					await options.beforeStop();
					sourceStopped = true;
					throw new Error("fault after source stop");
				}
				return execution(true);
			}),
		});
		const inspected = inspection();

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).rejects.toThrow("source stop");
		expect(deps.commitReceipt).not.toHaveBeenCalled();
		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).resolves.toMatchObject({ pane: { sessionId: "session-new" } });
	});

	it("recovers a pane projection failure after the durable rebind", async () => {
		const commitReceipt = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(async (payload) => ({
				projection: "applied" as const,
				presentation: "applied" as const,
				pane: {
					desktopId: "desktop-1",
					panelId: "agent:agent-1",
					sessionId: "session-new",
					workspaceId: "workspace-1",
					runtime: "hmux_managed_v1" as const,
					source: "local" as const,
					hostId: "local" as const,
					cwd: "/repo/worktree",
				},
				payload,
			}));
		let replay = false;
		const deps = runtime({
			commitReceipt,
			execute: vi.fn(async (_inspection, options) => {
				if (!replay) await options.beforeStop();
				const result = execution(replay);
				replay = true;
				return result;
			}),
		});
		const inspected = inspection();

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).rejects.toMatchObject({ code: "pane_changed" });
		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspected,
				"skip_permissions",
				deps,
			),
		).resolves.toMatchObject({ receipt: { replayed: true } });
		expect(deps.rebindDispatchSession).toHaveBeenCalledTimes(2);
	});

	it("uses only the Hmux journal receipt after source retirement", async () => {
		const inspected = inspection();
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				await options.beforeStop();
				inspected.providerId = "claude";
				inspected.sourceBinding.workspaceId = "stale-client-workspace";
				return execution();
			}),
		});

		await executeManagedAgentPermissionModeRelaunch(
			inspected,
			"skip_permissions",
			deps,
		);
		expect(deps.rebindDispatchSession).toHaveBeenCalledWith(
			routeAuthority,
			expect.objectContaining({
				source: expect.objectContaining({
					providerId: "codex",
					workspaceId: "workspace-1",
				}),
				target: expect.objectContaining({
					providerId: "codex",
					workspaceId: "workspace-1",
				}),
			}),
		);
	});

	it("refuses a client target that disagrees with the journal before rebinding Dispatch", async () => {
		const mismatched = execution(false, "default");
		const deps = runtime({
			execute: vi.fn(async (_inspection, options) => {
				await options.beforeStop();
				return mismatched;
			}),
		});

		await expect(
			executeManagedAgentPermissionModeRelaunch(
				inspection(),
				"skip_permissions",
				deps,
			),
		).rejects.toThrow("journaled permission mode is default");
		expect(deps.rebindDispatchSession).not.toHaveBeenCalled();
		expect(deps.commitReceipt).not.toHaveBeenCalled();
	});
});
