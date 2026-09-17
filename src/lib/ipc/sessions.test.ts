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

import {
	getRemoteProviderConversationDetails,
	prepareTrustedSshTarget,
	reconcileManagedCreateChainStop,
	remoteHmuxCommandInput,
	remoteHmuxDepartGracefully,
	remoteHmuxInitialAgentPrompt,
	remoteHmuxManagedCreateAdvance,
	remoteHmuxManagedCreateChainStop,
	sshCredentialClaimActivate,
	sshCredentialClaimReconcile,
	sshCredentialClaimRetire,
	sshCredentialClaimStage,
	sshSecretCopy,
} from "@/lib/ipc/sessions";

const target = {
	schemaVersion: 1 as const,
	hostId: "host-remote",
	host: "remote.test",
	port: 22,
	user: "agent",
	auth: "auto" as const,
	hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
};

const session = {
	sessionId: "session-remote",
	sessionName: "remote-shell",
	workspaceId: "workspace-remote",
	sessionClass: "standalone" as const,
	lifecycle: "ready" as const,
	providerId: "shell",
	runnerPrincipal: "principal-1",
	runnerInstance: "runner-1",
	channelEpoch: "7",
	hostInstanceId: "host-instance-1",
	terminalEpoch: "terminal-1",
	supportedProtocol: {
		minimum: { major: 1, minor: 0 },
		maximum: { major: 1, minor: 0 },
	},
	capabilities: ["screen_snapshot", "shared_terminal_input"],
};

beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.backendSupports.mockReset().mockResolvedValue(true);
});

describe("SSH secret IPC", () => {
	it("uses only opaque references for native copy", async () => {
		mocks.invoke.mockResolvedValue(undefined);

		await expect(
			sshSecretCopy("host-source:generation-1", "host-target:generation-2"),
		).resolves.toBeUndefined();
		expect(mocks.invoke).toHaveBeenCalledWith("ssh_secret_copy", {
			source: "host-source:generation-1",
			destination: "host-target:generation-2",
		});
	});

	it("delegates credential ownership and collection to one native registry", async () => {
		const claim = {
			schemaVersion: 1 as const,
			id: `ssh-${"a".repeat(32)}`,
			hostId: "host-1",
			registrationGeneration: "registration-1",
		};
		mocks.invoke.mockResolvedValue(undefined);
		await sshCredentialClaimStage([claim]);
		expect(mocks.invoke).toHaveBeenLastCalledWith(
			"ssh_credential_claim_stage",
			{ claims: [claim] },
		);

		await sshCredentialClaimActivate([claim]);
		expect(mocks.invoke).toHaveBeenLastCalledWith(
			"ssh_credential_claim_activate",
			{ claims: [claim] },
		);

		await sshCredentialClaimRetire([claim]);
		expect(mocks.invoke).toHaveBeenLastCalledWith(
			"ssh_credential_claim_retire",
			{ claims: [claim] },
		);

		mocks.invoke.mockResolvedValue({
			deleted: [],
			retained: [claim.id],
			failures: [],
		});
		await sshCredentialClaimReconcile([claim], [claim.id]);
		expect(mocks.invoke).toHaveBeenLastCalledWith(
			"ssh_credential_claim_reconcile",
			{ liveClaims: [claim], referencedIds: [claim.id] },
		);
	});
});

describe("trusted SSH target", () => {
	it("pins one registered endpoint for every remote adapter", async () => {
		mocks.invoke.mockResolvedValue(["SHA256:abcdefghijklmnop"]);
		const host = {
			id: "host-remote",
			name: "Remote",
			host: "remote.test",
			port: 22,
			user: "agent",
			auth: "key" as const,
			keyPath: "/keys/remote",
		};

		const prepared = await prepareTrustedSshTarget([host], host.id);

		expect(prepared).toEqual({
			schemaVersion: 1,
			hostId: host.id,
			host: host.host,
			port: host.port,
			user: host.user,
			auth: host.auth,
			keyPath: host.keyPath,
			hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
		});
	});
});

describe("remote provider conversation details IPC", () => {
	it("carries the exact host, provider, and conversation identity", async () => {
		mocks.invoke.mockResolvedValue({ subagents: [], totalCount: 0 });
		const opts = {
			host: "remote.test",
			port: 22,
			user: "agent",
			auth: "auto" as const,
		};

		await getRemoteProviderConversationDetails(
			"host-remote",
			opts,
			"claude",
			"conversation-remote",
		);

		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_provider_conversation_details",
			{
				hostId: "host-remote",
				opts,
				provider: "claude",
				conversationId: "conversation-remote",
			},
		);
	});
});

describe("remote exact Hmux input IPC", () => {
	it("sends the complete catalog fence and preserves semantic receipts", async () => {
		mocks.invoke.mockResolvedValue({
			hostId: "host-remote",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			terminalEpoch: "terminal-1",
			text: { recordId: "1", state: "written_to_pty" },
			submit: { recordId: "2", state: "written_to_pty" },
		});

		await expect(
			remoteHmuxCommandInput({
				target,
				session,
				text: "status",
				submit: true,
			}),
		).resolves.toEqual({
			terminalEpoch: "terminal-1",
			text: { recordId: "1", state: "written_to_pty" },
			submit: { recordId: "2", state: "written_to_pty" },
		});
		expect(mocks.invoke).toHaveBeenCalledWith("remote_hmux_command_input", {
			request: {
				text: "status",
				submit: true,
				session,
				target: {
					hostId: "host-remote",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "auto",
					hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
				},
			},
		});
	});

	it("rejects a receipt for a different exact host or session", async () => {
		mocks.invoke.mockResolvedValue({
			hostId: "host-other",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			terminalEpoch: "terminal-1",
			text: { recordId: "1", state: "written_to_pty" },
			submit: { recordId: "2", state: "written_to_pty" },
		});

		await expect(
			remoteHmuxCommandInput({
				target,
				session,
				text: "status",
				submit: true,
			}),
		).rejects.toThrow("remote_hmux_input_receipt_invalid");
	});
});

describe("remote Hmux pane departure IPC", () => {
	it("uses the semantic pane command with the complete catalog fence", async () => {
		mocks.invoke.mockResolvedValue({
			state: "session_preserved",
			reason: "not_attached",
		});

		await expect(
			remoteHmuxDepartGracefully(target, session, "pane-owner-1"),
		).resolves.toEqual({
			state: "session_preserved",
			reason: "not_attached",
		});
		expect(mocks.backendSupports).toHaveBeenCalledWith(
			"hmux.remote-pane-departure-v1",
		);
		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_hmux_pane_depart_gracefully",
			{
				request: {
					ownerId: "pane-owner-1",
					session,
					target: {
						hostId: "host-remote",
						host: "remote.test",
						port: 22,
						user: "agent",
						auth: "auto",
						hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
					},
				},
			},
		);
	});
});

describe("remote Host-atomic initial prompt IPC", () => {
	const managedSession = {
		...session,
		sessionClass: "managed" as const,
		providerId: "codex",
	};

	it("sends one prompt with the complete catalog fence", async () => {
		mocks.invoke.mockResolvedValue({
			hostId: "host-remote",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			terminalEpoch: "terminal-1",
			recordId: "3",
			inputBaselineOutputSequence: "2",
			initialAgentRuntimeRevision: "4",
		});

		await expect(
			remoteHmuxInitialAgentPrompt({
				target,
				session: managedSession,
				prompt: "first turn",
			}),
		).resolves.toMatchObject({ recordId: "3" });
		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_hmux_initial_agent_prompt",
			{
				request: {
					prompt: "first turn",
					session: managedSession,
					target: {
						hostId: "host-remote",
						host: "remote.test",
						port: 22,
						user: "agent",
						auth: "auto",
						hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
					},
				},
			},
		);
	});

	it("does not invoke an older remote backend", async () => {
		mocks.backendSupports.mockResolvedValue(false);

		await expect(
			remoteHmuxInitialAgentPrompt({
				target,
				session: managedSession,
				prompt: "first turn",
			}),
		).rejects.toMatchObject({
			code: "remote_hmux_initial_agent_prompt_backend_unavailable",
			deliveryState: "not_written",
		});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it("rejects a prompt receipt for a different exact host or session", async () => {
		mocks.invoke.mockResolvedValue({
			hostId: "host-other",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			terminalEpoch: "terminal-1",
			recordId: "3",
			inputBaselineOutputSequence: "2",
		});

		await expect(
			remoteHmuxInitialAgentPrompt({
				target,
				session: managedSession,
				prompt: "first turn",
			}),
		).rejects.toThrow("remote_hmux_initial_agent_prompt_receipt_invalid");
	});
});

describe("remote managed create IPC", () => {
	it("keeps the exact create identity when the invoke outcome is unknown", async () => {
		mocks.invoke.mockRejectedValue(new Error("backend_transport_remote_error"));

		await expect(
			remoteHmuxManagedCreateAdvance({
				target,
				idempotencyKey: "create-unknown",
				sessionId: "session-unknown",
				workspaceId: "workspace-unknown",
				providerId: "codex",
				permissionMode: "default",
				bridgeNonce: "bridge-unknown",
				cwd: "/workspace",
				command: "codex",
				initialRows: 30,
				initialColumns: 120,
				terminalEnvironment: {},
			}),
		).rejects.toMatchObject({
			code: "managed_create_retry_same",
			reason: "create_retryable",
			backendCode: "managed_create_outcome_unknown",
			message: "backend_transport_remote_error",
		});
		expect(mocks.backendSupports).toHaveBeenCalledOnce();
		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_hmux_managed_create_advance_v1",
			expect.objectContaining({
				request: expect.objectContaining({ idempotencyKey: "create-unknown" }),
			}),
		);
	});

	it("requires the explicit remote advance capability before SSH mutation", async () => {
		mocks.backendSupports.mockResolvedValue(false);

		await expect(
			remoteHmuxManagedCreateAdvance({
				target,
				idempotencyKey: "create-old-remote",
				sessionId: "session-old-remote",
				workspaceId: "workspace-old-remote",
				providerId: "codex",
				permissionMode: "default",
				bridgeNonce: "bridge-old-remote",
				cwd: "/workspace",
				command: "codex",
				initialRows: 30,
				initialColumns: 120,
				terminalEnvironment: {},
			}),
		).rejects.toThrow(
			"remote_hmux_managed_create_advance_v1_backend_unavailable",
		);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});

describe("completed managed close IPC", () => {
	const identity = {
		idempotencyKey: "create-root",
		sessionId: "session-root",
		workspaceId: "workspace-root",
	};
	const request = {
		schema: "hmux-managed-create-reconcile-v1",
		schemaVersion: 1,
		...identity,
	};
	const receipt = {
		schema: "hmux-managed-create-chain-stop-v2",
		schemaVersion: 2,
		chain: [request],
	};

	it.each([undefined, target])(
		"uses the selected host's shared completion command (%j)",
		async (selected) => {
			mocks.invoke.mockResolvedValue(receipt);
			await expect(
				reconcileManagedCreateChainStop({ ...identity, target: selected }),
			).resolves.toBe(receipt);
			const { schemaVersion: _schemaVersion, ...remote } = target;
			expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
				"session_checkout_reconcile_managed_close_v1",
				{
					request,
					target: selected ? remote : null,
				},
			);
		},
	);

	it("returns only an explicit absent completion and propagates transport uncertainty", async () => {
		mocks.invoke
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("response lost"));
		await expect(reconcileManagedCreateChainStop(identity)).resolves.toBeNull();
		await expect(reconcileManagedCreateChainStop(identity)).rejects.toThrow(
			"response lost",
		);
	});

	it.each([
		undefined,
		{},
		{ ...receipt, chain: [{ ...request, sessionId: "other" }] },
	])(
		"rejects an invalid or differently targeted completion (%j)",
		async (value) => {
			mocks.invoke.mockResolvedValue(value);
			await expect(reconcileManagedCreateChainStop(identity)).rejects.toThrow(
				"managed_create_chain_stop_reconcile_receipt_invalid",
			);
		},
	);
});

describe("remote managed create chain-stop IPC", () => {
	it("sends one logical root to the pinned remote target", async () => {
		mocks.invoke.mockResolvedValue({
			schema: "hmux-managed-create-chain-stop-v2",
			schemaVersion: 2,
			chain: [
				{
					schema: "hmux-managed-create-reconcile-v1",
					schemaVersion: 1,
					idempotencyKey: "create-root",
					sessionId: "session-root",
					workspaceId: "workspace-remote",
				},
				{
					schema: "hmux-managed-create-reconcile-v1",
					schemaVersion: 1,
					idempotencyKey: "create-successor",
					sessionId: "session-successor",
					workspaceId: "workspace-remote",
				},
			],
		});

		await remoteHmuxManagedCreateChainStop({
			target,
			idempotencyKey: "create-root",
			sessionId: "session-root",
			workspaceId: "workspace-remote",
		});

		expect(mocks.invoke).toHaveBeenCalledWith(
			"remote_hmux_managed_create_chain_stop_v2",
			{
				request: {
					target: {
						hostId: "host-remote",
						host: "remote.test",
						port: 22,
						user: "agent",
						auth: "auto",
						hostKeyFingerprints: ["SHA256:abcdefghijklmnop"],
					},
					idempotencyKey: "create-root",
					sessionId: "session-root",
					workspaceId: "workspace-remote",
				},
			},
		);
	});
});
