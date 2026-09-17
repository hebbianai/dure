import { describe, expect, it, vi } from "vitest";
import {
	type ManagedAgentRehostTransactionRuntime,
	runManagedAgentRehostTransaction,
} from "@/lib/sessions/managed/managedAgentRehostTransaction";

const sourceBinding = {
	runtime: "hmux_managed_v1",
	source: "local",
	hostId: "local",
	sessionId: "session-old",
	workspaceId: "workspace-1",
} as const;

const replacement = {
	sessionId: "session-new",
	workspaceId: "workspace-1",
	sessionClass: "managed",
	lifecycle: "ready",
	hostBuildVersion: "build-current",
	terminalEpoch: "terminal-new",
	outputSeq: "0",
	capabilities: [],
} as const;

const inspection = {
	agentId: "agent-1",
	agentName: "agent",
	projectId: "project-1",
	providerId: "codex",
	sourceBinding,
	sourceConversationId: "conversation-1",
	sourceLifecycle: "ready",
	sourcePaneState: "present",
	conversationId: "conversation-1",
	cwd: "/repo",
	desktopId: "desktop-1",
	panelId: "agent:agent-1",
	permissionMode: "default",
	terminalEnvironment: {},
	plan: {
		sessionId: "session-old",
		sourceBuildId: "build-old",
		targetBuildId: "build-current",
		action: "replace_ai_provider_with_explicit_conversation",
		allowed: true,
		requiresConfirmation: true,
	},
} as const;

const payload = {
	schemaVersion: 2,
	operationId: "operation-1",
	launchKind: "exact_resume",
	agentId: "agent-1",
	agentName: "agent",
	projectId: "project-1",
	providerId: "codex",
	sourceBinding,
	sourceConversationId: "conversation-1",
	sourcePaneState: "present",
	sourcePermissionMode: "default",
	cwd: "/repo",
	conversationId: "conversation-1",
	permissionMode: "default",
	desktopId: "desktop-1",
	panelId: "agent:agent-1",
	binding: {
		...sourceBinding,
		sessionId: "session-new",
		createIdempotencyKey: "create-new",
	},
	targetCredentialId: null,
} as const;

const recovery = {
	permissionMode: "default",
	conversationId: "conversation-1",
	createIdempotencyKey: "create-new",
	replacement,
	receipt: {
		sourceSessionId: "session-old",
		targetBuildId: "build-current",
		action: "replace_ai_provider_with_explicit_conversation",
		outcome: "replaced",
		replayed: false,
	},
} as const;

function transactionRuntime(
	overrides: Partial<ManagedAgentRehostTransactionRuntime> = {},
): ManagedAgentRehostTransactionRuntime {
	return {
		resolveTarget: vi.fn(() => ({
			agent: { id: "agent-1" },
			binding: sourceBinding,
		})),
		reconcile: vi.fn().mockResolvedValue(null),
		inspect: vi.fn().mockResolvedValue(inspection),
		reconcileOperation: vi.fn().mockResolvedValue(null),
		execute: vi.fn().mockResolvedValue({ recovery }),
		syncPayload: vi.fn().mockReturnValue(payload),
		commitReceipt: vi.fn().mockResolvedValue({
			projection: "applied",
			presentation: "pending",
			pane: null,
			payload,
		}),
		commitReconciledReceipt: vi.fn(),
		emit: vi.fn(),
		setMetadata: vi.fn(),
		...overrides,
	} as unknown as ManagedAgentRehostTransactionRuntime;
}

describe("managed Agent rehost transaction", () => {
	it.each([undefined, "agent:agent-1", "pane:stable-slot"])(
		"preserves the caller's optional presentation constraint (hint=%s)",
		async (panelId) => {
			const runtime = transactionRuntime();
			await runManagedAgentRehostTransaction(
				{ name: "requested-name", panelId, confirmed: true },
				runtime,
			);
			expect(runtime.resolveTarget).toHaveBeenCalledExactlyOnceWith(
				"requested-name",
			);
			expect(runtime.reconcile).toHaveBeenCalledExactlyOnceWith(
				"agent-1",
				panelId,
			);
			expect(runtime.inspect).toHaveBeenCalledExactlyOnceWith(
				"agent-1",
				panelId,
				undefined,
			);
		},
	);

	it("returns completion without waiting for a delayed notification", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runtime = transactionRuntime({ emit: vi.fn(() => pending) });
		const completed = vi.fn();
		const operation = runManagedAgentRehostTransaction(
			{ name: "agent", confirmed: true },
			runtime,
		).then(completed);
		try {
			await vi.waitFor(() =>
				expect(completed).toHaveBeenCalledWith(
					expect.objectContaining({ state: "completed" }),
				),
			);
			expect(runtime.execute).toHaveBeenCalledOnce();
			expect(runtime.emit).toHaveBeenCalledOnce();
		} finally {
			release();
			await operation;
		}
	});

	it.each(["execute", "reconcile"])(
		"returns the committed %s result when WebView notification fails",
		async (path) => {
			const committed = {
				projection: "applied",
				presentation: "pending",
				pane: null,
				payload,
			} as const;
			const runtime = transactionRuntime({
				emit: vi.fn().mockRejectedValue(new Error("WebView disconnected")),
				...(path === "reconcile"
					? {
							reconcile: vi.fn().mockResolvedValue({
								payload,
								replacement,
								conversationId: "conversation-1",
							}),
							commitReconciledReceipt: vi.fn().mockResolvedValue(committed),
						}
					: {}),
			});

			await expect(
				runManagedAgentRehostTransaction(
					{ name: "agent", confirmed: true },
					runtime,
				),
			).resolves.toMatchObject({
				state: "completed",
				rehost: { replacementSession: replacement, presentation: "pending" },
			});

			expect(runtime.execute).toHaveBeenCalledTimes(path === "execute" ? 1 : 0);
			expect(runtime.emit).toHaveBeenCalledOnce();
		},
	);

	it("projects a durable successor before stale inspection can reject it", async () => {
		const pane = {
			desktopId: "desktop-1",
			panelId: "agent:agent-1",
			sessionId: "session-new",
			workspaceId: "workspace-1",
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			cwd: "/repo",
			conversationId: "conversation-1",
		} as const;
		const reconciliation = {
			payload,
			replacement,
			conversationId: "conversation-1",
		};
		const runtime = transactionRuntime({
			reconcile: vi.fn().mockResolvedValue(reconciliation),
			inspect: vi.fn().mockRejectedValue(new Error("stale inspection")),
			commitReconciledReceipt: vi.fn().mockResolvedValue({
				projection: "applied",
				presentation: "applied",
				pane,
				payload,
			}),
		});

		const result = await runManagedAgentRehostTransaction(
			{ name: "agent", confirmed: true },
			runtime,
		);

		expect(result).toMatchObject({
			state: "completed",
			rehost: {
				outcome: "rehosted",
				replayed: true,
				replacementSession: replacement,
				presentation: "applied",
			},
			pane,
		});
		expect(runtime.inspect).not.toHaveBeenCalled();
		expect(runtime.execute).not.toHaveBeenCalled();
		expect(runtime.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			payload,
		);
	});

	it("returns confirmation without crossing the backend transaction", async () => {
		const runtime = transactionRuntime();

		const result = await runManagedAgentRehostTransaction(
			{ name: "agent", confirmed: false },
			runtime,
		);

		expect(result).toMatchObject({
			state: "confirmation_required",
			rehost: {
				outcome: "refused",
				requiresConfirmation: true,
				sourceSessionId: "session-old",
			},
		});
		expect(runtime.execute).not.toHaveBeenCalled();
		expect(runtime.commitReceipt).not.toHaveBeenCalled();
	});

	it("returns an idempotent pane receipt when the source is already current", async () => {
		const runtime = transactionRuntime({
			inspect: vi.fn().mockResolvedValue({
				...inspection,
				plan: {
					...inspection.plan,
					sourceBuildId: "build-current",
				},
			}),
		});

		const result = await runManagedAgentRehostTransaction(
			{ name: "agent", confirmed: true },
			runtime,
		);

		expect(result).toMatchObject({
			state: "completed",
			rehost: { outcome: "already_current", replayed: false },
			pane: {
				panelId: "agent:agent-1",
				sessionId: "session-old",
			},
		});
		expect(runtime.execute).not.toHaveBeenCalled();
		expect(runtime.commitReceipt).not.toHaveBeenCalled();
	});

	it("projects one backend execution receipt for UI and CLI consumers", async () => {
		const execution = {
			recovery,
			dispatchProjection: {
				target: {
					schemaVersion: 1,
					taskId: "task-1",
					dispatchId: "dispatch-1",
					generation: 2,
				},
			},
		} as const;
		const runtime = transactionRuntime({
			execute: vi.fn().mockResolvedValue(execution),
		});

		const result = await runManagedAgentRehostTransaction(
			{ name: "agent", panelId: "agent:agent-1", confirmed: true },
			runtime,
		);

		expect(result).toMatchObject({
			state: "completed",
			rehost: {
				outcome: "rehosted",
				replayed: false,
				presentation: "pending",
				replacementSession: replacement,
			},
		});
		expect(runtime.execute).toHaveBeenCalledOnce();
		expect(runtime.syncPayload).toHaveBeenCalledWith(inspection, execution);
		expect(runtime.commitReceipt).toHaveBeenCalledWith(payload);
		expect(runtime.setMetadata).toHaveBeenCalledWith(replacement);
		expect(runtime.emit).toHaveBeenCalledWith(
			"agent:managed-rehosted:v2",
			payload,
		);
	});

	it("replays an explicitly selected operation through the same projection", async () => {
		const runtime = transactionRuntime({
			reconcileOperation: vi.fn().mockResolvedValue(recovery),
		});

		const result = await runManagedAgentRehostTransaction(
			{
				name: "agent",
				operationId: "operation-1",
				confirmed: false,
			},
			runtime,
		);

		expect(result).toMatchObject({
			state: "completed",
			rehost: { outcome: "rehosted", replayed: true },
		});
		expect(runtime.reconcile).not.toHaveBeenCalled();
		expect(runtime.reconcileOperation).toHaveBeenCalledWith(
			sourceBinding,
			"operation-1",
		);
		expect(runtime.execute).not.toHaveBeenCalled();
	});
});
