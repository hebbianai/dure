import { describe, expect, it, vi } from "vitest";
import {
	type CliHmuxRehostRuntime,
	handleCliHmuxRehost,
} from "@/lib/cli/cliHmuxRehost";

const inspection = {
	agentName: "hmux",
	conversationId: "conversation-1",
	permissionMode: "default",
	sourceLifecycle: "ready",
	sourceBinding: {
		sessionId: "session-old",
		workspaceId: "workspace-1",
	},
	plan: {
		action: "rehost",
		sourceBuildId: "build-old",
		targetBuildId: "build-current",
	},
} as never;

describe("CLI managed Hmux rehost", () => {
	it.each(["applied", "pending"] as const)(
		"returns the shared Fresh completion with %s presentation",
		async (presentation) => {
			const freshInspection = {
				agentName: "generation-conflict",
				sourceBinding: {
					sessionId: "session-failed",
					workspaceId: "workspace-1",
				},
				sourceDiscoveryState: "exited",
			} as never;
			const execution = {
				replacement: { sessionId: "session-fresh" },
				receipt: {
					action: "replace_ai_provider_with_fresh_conversation",
					outcome: "replaced",
					replayed: false,
					targetBuildId: "build-current",
				},
			} as never;
			const payload = { binding: { sessionId: "session-fresh" } } as never;
			const pane = {
				desktopId: "desktop-1",
				panelId: "agent:agent-1",
				sessionId: "session-fresh",
				workspaceId: "workspace-1",
			} as never;
			const deps = {
				claim: vi.fn().mockResolvedValue(true),
				inspect: vi.fn(),
				inspectFresh: vi.fn().mockResolvedValue(freshInspection),
				executeFresh: vi.fn().mockResolvedValue(execution),
				completeFresh: vi.fn().mockResolvedValue({
					projection: "applied",
					presentation,
					pane: presentation === "applied" ? pane : null,
					payload,
				}),
			} as unknown as CliHmuxRehostRuntime;

			const result = await handleCliHmuxRehost(
				{
					name: "generation-conflict",
					targetPanelId: "agent:agent-1",
					freshStart: true,
					confirmRestart: true,
				},
				"fresh-start-request",
				deps,
			);

			expect(result).toMatchObject({
				ok: true,
				rehost: {
					action: "replace_ai_provider_with_fresh_conversation",
					outcome: "rehosted_fresh",
					sourceSessionId: "session-failed",
					replacementSession: { sessionId: "session-fresh" },
					presentation,
				},
			});
			if (presentation === "applied") expect(result).toMatchObject({ pane });
			else expect(result).not.toHaveProperty("pane");
			expect(deps.inspect).not.toHaveBeenCalled();
			expect(deps.inspectFresh).toHaveBeenCalledWith(
				"generation-conflict",
				"agent:agent-1",
			);
			expect(deps.executeFresh).toHaveBeenCalledWith(freshInspection);
			expect(deps.executeFresh).toHaveBeenCalledOnce();
			expect(deps.completeFresh).toHaveBeenCalledWith(
				freshInspection,
				execution,
			);
			expect(deps.completeFresh).toHaveBeenCalledOnce();
		},
	);

	it("previews a permission-mode relaunch without crossing the restart boundary", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			inspect: vi.fn().mockResolvedValue(inspection),
			permissionModeRelaunch: vi.fn(),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{ name: "hmux", permissionMode: "skip_permissions" },
			"permission-mode-preview",
			deps,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "update_requires_confirmation" },
			permissionModeRelaunch: {
				schema: "dure-agent-permission-mode-relaunch-v1",
				schemaVersion: 1,
				outcome: "preview",
				currentMode: "default",
				targetMode: "skip_permissions",
				restartImpact: "provider_process_restarted",
				requiresConfirmation: true,
			},
		});
		expect(deps.permissionModeRelaunch).not.toHaveBeenCalled();
	});

	it("relaunches a same-build Agent with a typed target permission mode", async () => {
		const sameBuildInspection = {
			...(inspection as unknown as Record<string, unknown>),
			plan: {
				action: "rehost",
				sourceBuildId: "build-current",
				targetBuildId: "build-current",
			},
		} as never;
		const pane = {
			desktopId: "desktop-1",
			panelId: "agent:agent-1",
			sessionId: "session-new",
			workspaceId: "workspace-1",
		} as never;
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			inspect: vi.fn().mockResolvedValue(sameBuildInspection),
			permissionModeRelaunch: vi.fn().mockResolvedValue({
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
				presentation: "applied",
				pane,
			}),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{
				name: "hmux",
				permissionMode: "skip_permissions",
				confirmRestart: true,
			},
			"permission-mode-request",
			deps,
		);

		expect(deps.permissionModeRelaunch).toHaveBeenCalledWith(
			sameBuildInspection,
			"skip_permissions",
		);
		expect(result).toMatchObject({
			ok: true,
			permissionModeRelaunch: {
				schema: "dure-agent-permission-mode-relaunch-v1",
				schemaVersion: 1,
				outcome: "relaunched",
				currentMode: "default",
				targetMode: "skip_permissions",
				restartImpact: "provider_process_restarted",
				sourceSessionId: "session-old",
				targetSessionId: "session-new",
			},
			pane,
		});
	});

	it("claims the request before the rehost transaction", async () => {
		const order: string[] = [];
		const deps = {
			claim: vi.fn(async () => {
				order.push("claim");
				return true;
			}),
			rehost: vi.fn(async () => {
				order.push("rehost");
				return {
					state: "confirmation_required",
					rehost: { outcome: "refused" },
				} as never;
			}),
		} as unknown as CliHmuxRehostRuntime;

		await handleCliHmuxRehost({ name: "hmux" }, "request-1", deps);

		expect(order).toEqual(["claim", "rehost"]);
		expect(deps.claim).toHaveBeenCalledOnce();
	});

	it("uses the shared rehost transaction before stale client inspection can hide its receipt", async () => {
		const pane = {
			desktopId: "desktop-1",
			panelId: "agent:agent-1",
			sessionId: "session-new",
			workspaceId: "workspace-1",
		} as never;
		const rehost = {
			action: "replace_ai_provider_with_explicit_conversation",
			outcome: "rehosted",
			sourceSessionId: "session-old",
			sourceWorkspaceId: "workspace-1",
			targetBuildId: "build-current",
			conversationId: "conversation-1",
			replayed: true,
			replacementSession: { sessionId: "session-new" },
			presentation: "applied",
		};
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn().mockResolvedValue({
				state: "completed",
				rehost,
				pane,
			}),
			inspect: vi.fn().mockRejectedValue(new Error("stale client inspection")),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{ name: "hmux", confirmRestart: true },
			"request-shared-transaction",
			deps,
		);

		expect(result).toEqual({ ok: true, rehost, pane });
		expect(deps.rehost).toHaveBeenCalledWith({
			name: "hmux",
			confirmed: true,
		});
		expect(deps.inspect).not.toHaveBeenCalled();
	});

	it("does not inspect or mutate when another window owns the request", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(false),
			inspect: vi.fn(),
			rehost: vi.fn(),
		} as unknown as CliHmuxRehostRuntime;

		await expect(
			handleCliHmuxRehost({ name: "hmux" }, "request-2", deps),
		).resolves.toBeNull();
		expect(deps.inspect).not.toHaveBeenCalled();
		expect(deps.rehost).not.toHaveBeenCalled();
	});

	it("hands a completed same-build rehost successor back to the exact Agent pane", async () => {
		const pane = {
			desktopId: "desktop-1",
			panelId: "agent:agent-1",
			sessionId: "session-new",
			workspaceId: "workspace-1",
		} as never;
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn().mockResolvedValue({
				state: "completed",
				rehost: {
					action: "replace_ai_provider_with_explicit_conversation",
					outcome: "rehosted",
					sourceSessionId: "session-old",
					sourceWorkspaceId: "workspace-1",
					conversationId: "conversation-1",
					replayed: true,
					replacementSession: { sessionId: "session-new" },
					presentation: "applied",
				},
				pane,
			}),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{
				name: "hmux",
				operationId: "fix_main_stalled_output_20260813_v1",
			},
			"request-3",
			deps,
		);

		expect(result).toMatchObject({
			ok: true,
			rehost: { outcome: "rehosted", replayed: true },
			pane,
		});
		expect(deps.rehost).toHaveBeenCalledWith({
			name: "hmux",
			confirmed: false,
			operationId: "fix_main_stalled_output_20260813_v1",
		});
	});

	it("keeps a replayed recovery committed while pane projection converges", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn().mockResolvedValue({
				state: "completed",
				rehost: {
					action: "replace_ai_provider_with_explicit_conversation",
					outcome: "rehosted",
					sourceSessionId: "session-old",
					sourceWorkspaceId: "workspace-1",
					targetBuildId: "build-current",
					conversationId: "conversation-1",
					replayed: true,
					replacementSession: { sessionId: "session-new" },
					presentation: "pending",
				},
			}),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{ name: "hmux", operationId: "operation-1" },
			"request-replay-pending-projection",
			deps,
		);

		expect(result).toMatchObject({
			ok: true,
			rehost: {
				outcome: "rehosted",
				replayed: true,
				presentation: "pending",
				replacementSession: { sessionId: "session-new" },
			},
		});
		expect(result).not.toHaveProperty("pane");
	});

	it("does not reverse a committed rehost when pane projection is pending", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn().mockResolvedValue({
				state: "completed",
				rehost: {
					action: "replace_ai_provider_with_explicit_conversation",
					outcome: "rehosted",
					sourceSessionId: "session-old",
					sourceWorkspaceId: "workspace-1",
					targetBuildId: "build-current",
					conversationId: "conversation-1",
					replayed: false,
					replacementSession: { sessionId: "session-new" },
					presentation: "pending",
				},
			}),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{ name: "hmux", confirmRestart: true },
			"request-pending-projection",
			deps,
		);

		expect(result).toMatchObject({
			ok: true,
			rehost: {
				outcome: "rehosted",
				presentation: "pending",
				replacementSession: { sessionId: "session-new" },
			},
		});
		expect(result).not.toHaveProperty("pane");
	});

	it("refuses an arbitrary existing writer without durable rehost lineage", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn(),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{
				name: "hmux",
				conversationId: "conversation-1",
				existingSessionId: "session-existing",
			},
			"request-4",
			deps,
		);

		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "invalid_request",
				message: expect.stringContaining(
					"no durable source-to-target operation",
				),
			},
		});
		expect(deps.rehost).not.toHaveBeenCalled();
	});

	it("refuses to combine an existing writer handoff with a recovery operation", async () => {
		const deps = {
			claim: vi.fn().mockResolvedValue(true),
			rehost: vi.fn(),
		} as unknown as CliHmuxRehostRuntime;

		const result = await handleCliHmuxRehost(
			{
				name: "hmux",
				existingSessionId: "session-existing",
				operationId: "operation-1",
			},
			"request-5",
			deps,
		);

		expect(result).toMatchObject({
			ok: false,
			error: { code: "invalid_request" },
		});
		expect(deps.rehost).not.toHaveBeenCalled();
	});
});
