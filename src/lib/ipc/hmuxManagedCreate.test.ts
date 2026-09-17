import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	backendSupports: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/ipc/core", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc/core")>();
	return { ...original, backendSupports: mocks.backendSupports };
});

import { hmux } from "@/lib/ipc/hmux";

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.backendSupports.mockReset().mockResolvedValue(true);
});

describe("local managed create IPC", () => {
	it("keeps the exact create identity when the invoke outcome is unknown", async () => {
		mocks.invoke.mockRejectedValue(new Error("backend_transport_remote_error"));

		await expect(
			hmux.advanceManagedCreate({
				idempotencyKey: "create-unknown",
				sessionId: "session-unknown",
				workspaceId: "workspace-unknown",
				providerId: "codex",
				permissionMode: "default",
				cwd: "/workspace",
				command: "codex",
				columns: 120,
				rows: 30,
				terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
			}),
		).rejects.toMatchObject({
			code: "managed_create_retry_same",
			reason: "create_retryable",
			backendCode: "managed_create_outcome_unknown",
			message: "backend_transport_remote_error",
		});
		expect(mocks.invoke).toHaveBeenCalledOnce();
	});

	it.each([undefined, true])(
		"requires the advance capability before mutation (replaceCurrent=%s)",
		async (replaceCurrent) => {
			mocks.backendSupports.mockResolvedValue(false);

			await expect(
				hmux.advanceManagedCreate({
					replaceCurrent,
					idempotencyKey: "create-old-backend",
					sessionId: "session-old-backend",
					workspaceId: "workspace-old-backend",
					providerId: "codex",
					permissionMode: "default",
					cwd: "/workspace",
					command: "codex",
					columns: 120,
					rows: 30,
					terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
				}),
			).rejects.toThrow("hmux_managed_create_advance_v1_backend_unavailable");
			expect(mocks.invoke).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ launchPromptSupported: true, expectedPrompt: "ship it" },
		{ launchPromptSupported: false, expectedPrompt: undefined },
	])(
		"feature-gates launch prompt payloads (supported=$launchPromptSupported)",
		async ({ launchPromptSupported, expectedPrompt }) => {
			mocks.backendSupports
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(launchPromptSupported);
			mocks.invoke.mockRejectedValue(new Error("fixture stop after invoke"));

			await expect(
				hmux.advanceManagedCreate({
					idempotencyKey: "create-prompt",
					sessionId: "session-prompt",
					workspaceId: "workspace-prompt",
					providerId: "codex",
					permissionMode: "default",
					cwd: "/workspace",
					command: "codex",
					initialPrompt: "ship it",
					columns: 120,
					rows: 30,
					terminalDefaultColors: {
						foregroundRgb: 0,
						backgroundRgb: 0,
					},
				}),
			).rejects.toBeDefined();

			const request = mocks.invoke.mock.calls[0]?.[1]?.request;
			expect(request?.initialPrompt).toBe(expectedPrompt);
		},
	);

	it("sends explicit Resume after checking the current adapter capability", async () => {
		mocks.invoke.mockResolvedValue({
			state: "advanced",
			receipt: {
				idempotencyKey: "create-resume-target",
				cwd: "/workspace",
				outcome: "created",
				session: {
					sessionId: "session-resume-target",
					workspaceId: "workspace-resume",
					sessionClass: "managed",
					lifecycle: "ready",
					manifestLifecycle: "ready",
					health: "current_healthy",
					hostBuildVersion: "0.1.4+test",
					clientSelection: "direct_rust",
					inputAllowed: true,
					detachOnly: false,
					terminalEpoch: "terminal-resume-target",
					stopFence: {
						runnerPrincipal: "principal-resume-target",
						runnerInstance: "runner-resume-target",
						channelEpoch: "1",
						hostInstanceId: "host-resume-target",
						terminalEpoch: "terminal-resume-target",
					},
					outputSeq: "0",
					capabilities: [],
				},
			},
		});

		await expect(
			hmux.advanceManagedCreate({
				replaceCurrent: true,
				idempotencyKey: "create-resume-source",
				sessionId: "session-resume-source",
				workspaceId: "workspace-resume",
				providerId: "codex",
				conversationId: "conversation-resume",
				permissionMode: "default",
				cwd: "/workspace",
				command: "codex resume conversation-resume",
				columns: 120,
				rows: 30,
				terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
			}),
		).resolves.toMatchObject({
			state: "advanced",
			receipt: { idempotencyKey: "create-resume-target" },
		});

		expect(mocks.backendSupports).toHaveBeenCalledWith(
			"hmux.managed-create-advance-v1",
		);
		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_managed_create_advance_v1",
			{
				request: expect.objectContaining({
					replaceCurrent: true,
					idempotencyKey: "create-resume-source",
				}),
			},
		);
	});

	it("invokes only the explicitly destructive advance command", async () => {
		mocks.invoke.mockResolvedValue({
			state: "current",
			receipt: {
				idempotencyKey: "create-advance",
				cwd: "/workspace",
				outcome: "created",
				session: {
					sessionId: "session-advance",
					workspaceId: "workspace-advance",
					sessionClass: "managed",
					lifecycle: "ready",
					manifestLifecycle: "ready",
					health: "current_healthy",
					hostBuildVersion: "0.1.4+test",
					clientSelection: "direct_rust",
					inputAllowed: true,
					detachOnly: false,
					terminalEpoch: "terminal-advance",
					stopFence: {
						runnerPrincipal: "principal-advance",
						runnerInstance: "runner-advance",
						channelEpoch: "1",
						hostInstanceId: "host-advance",
						terminalEpoch: "terminal-advance",
					},
					outputSeq: "0",
					capabilities: [],
				},
			},
		});

		await hmux.advanceManagedCreate({
			idempotencyKey: "create-advance",
			sessionId: "session-advance",
			workspaceId: "workspace-advance",
			providerId: "codex",
			permissionMode: "default",
			cwd: "/workspace",
			command: "codex",
			columns: 120,
			rows: 30,
			terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
		});

		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_managed_create_advance_v1",
			{
				request: expect.objectContaining({ idempotencyKey: "create-advance" }),
			},
		);
	});

	it("returns the backend-owned successor without synthesizing an identity", async () => {
		mocks.invoke.mockResolvedValue({
			state: "advanced",
			receipt: {
				idempotencyKey: "create-ledger-successor",
				cwd: "/workspace",
				outcome: "created",
				session: {
					sessionId: "session-ledger-successor",
					workspaceId: "workspace-source",
					sessionClass: "managed",
					lifecycle: "ready",
					manifestLifecycle: "ready",
					health: "current_healthy",
					hostBuildVersion: "0.1.4+test",
					clientSelection: "direct_rust",
					inputAllowed: true,
					detachOnly: false,
					terminalEpoch: "terminal-successor",
					stopFence: {
						runnerPrincipal: "principal-successor",
						runnerInstance: "runner-successor",
						channelEpoch: "1",
						hostInstanceId: "host-successor",
						terminalEpoch: "terminal-successor",
					},
					outputSeq: "0",
					capabilities: [],
				},
			},
		});

		await expect(
			hmux.advanceManagedCreate({
				idempotencyKey: "create-source",
				sessionId: "session-source",
				workspaceId: "workspace-source",
				providerId: "codex",
				permissionMode: "default",
				cwd: "/workspace",
				command: "codex",
				columns: 120,
				rows: 30,
				terminalDefaultColors: { foregroundRgb: 0, backgroundRgb: 0 },
			}),
		).resolves.toMatchObject({
			state: "advanced",
			receipt: {
				idempotencyKey: "create-ledger-successor",
				session: { sessionId: "session-ledger-successor" },
			},
		});
		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_managed_create_advance_v1",
			{
				request: expect.objectContaining({
					idempotencyKey: "create-source",
					sessionId: "session-source",
				}),
			},
		);
	});
});

describe("local managed create chain-stop IPC", () => {
	it("invokes the logical root command and accepts its effective successor", async () => {
		mocks.invoke.mockResolvedValue({
			schema: "hmux-managed-create-chain-stop-v2",
			schemaVersion: 2,
			chain: [
				{
					schema: "hmux-managed-create-reconcile-v1",
					schemaVersion: 1,
					idempotencyKey: "create-root",
					sessionId: "session-root",
					workspaceId: "workspace-1",
				},
				{
					schema: "hmux-managed-create-reconcile-v1",
					schemaVersion: 1,
					idempotencyKey: "create-successor",
					sessionId: "session-successor",
					workspaceId: "workspace-1",
				},
			],
		});

		await expect(
			hmux.stopManagedCreateChain("create-root", "session-root", "workspace-1"),
		).resolves.toMatchObject({
			chain: expect.arrayContaining([
				expect.objectContaining({ sessionId: "session-successor" }),
			]),
		});
		expect(mocks.invoke).toHaveBeenCalledWith(
			"hmux_managed_create_chain_stop_v2",
			{
				idempotencyKey: "create-root",
				sessionId: "session-root",
				workspaceId: "workspace-1",
			},
		);
	});

	it("does not substitute exact stop when the backend capability is absent", async () => {
		mocks.backendSupports.mockResolvedValue(false);

		await expect(
			hmux.stopManagedCreateChain("create-root", "session-root", "workspace-1"),
		).rejects.toThrow("hmux_managed_create_chain_stop_v2_backend_unavailable");
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});
