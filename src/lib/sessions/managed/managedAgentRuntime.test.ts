import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/types";

const mocks = vi.hoisted(() => ({
	createManaged: vi.fn(),
	executeRecovery: vi.fn(),
	reconcileManagedRecovery: vi.fn(),
	resolveManagedRehost: vi.fn(),
	resolveRouteAuthority: vi.fn(),
	inspectManagedConversationIdentity: vi.fn(),
	listSessions: vi.fn(),
	requireProjectProvider: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	hmux: {
		advanceManagedCreate: mocks.createManaged,
		executeRecovery: mocks.executeRecovery,
		reconcileManagedRecovery: mocks.reconcileManagedRecovery,
		resolveManagedRehost: mocks.resolveManagedRehost,
		inspectManagedConversationIdentity:
			mocks.inspectManagedConversationIdentity,
		listSessions: mocks.listSessions,
	},
}));
vi.mock("@/lib/ipc/dureBackend", () => ({
	resolveSelectedDureBackendRouteAuthority: mocks.resolveRouteAuthority,
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: async (target: {
		sessionId: string;
		workspaceId: string;
	}) =>
		(await mocks.listSessions()).find(
			(session: { sessionId: string; workspaceId: string }) =>
				session.sessionId === target.sessionId &&
				session.workspaceId === target.workspaceId,
		),
}));

vi.mock("@/lib/agents/providerPreflight", () => ({
	requireProjectProvider: mocks.requireProjectProvider,
}));

import { reconcileManagedAgentRecoveryOperation } from "@/lib/sessions/managed/managedAgentRecoveryReceipt";
import { managedRecoveryRouteIdentity } from "@/lib/sessions/managed/managedAgentRecoveryRoute";
import {
	ensureManagedAgentRuntime,
	ensureManagedConversationIdentity,
	executeManagedAgentRecovery,
	executeManagedBindingRecovery,
	managedCredentialAccount,
	preflightManagedAgentRecovery,
	reconcileManagedAgentRecovery,
} from "@/lib/sessions/managed/managedAgentRuntime";
import { managedRecoveryIdentity } from "@/lib/sessions/managed/managedAgentRuntimeState";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const stopFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
});

function recoveryTarget(
	sessionId: string,
	workspaceId: string,
	idempotencyKey: string,
	providerId = "codex",
) {
	return {
		idempotencyKey,
		sessionId,
		workspaceId,
		providerId,
		permissionMode: "default" as const,
		runnerPrincipal: stopFence.runnerPrincipal,
		runnerInstance: stopFence.runnerInstance,
		channelEpoch: stopFence.channelEpoch,
		hostInstanceId: stopFence.hostInstanceId,
		terminalEpoch: stopFence.terminalEpoch,
	};
}

function recoverySourceStop(
	operationId: string,
	sessionId: string,
	workspaceId: string,
) {
	return {
		schema: "hmux-managed-stop-v1" as const,
		schemaVersion: 2 as const,
		stopId: `managed_rehost_stop_${operationId}`,
		sessionId,
		workspaceId,
		runnerPrincipal: stopFence.runnerPrincipal,
		runnerInstance: stopFence.runnerInstance,
		channelEpoch: Number(stopFence.channelEpoch),
		hostInstanceId: stopFence.hostInstanceId,
		terminalEpoch: stopFence.terminalEpoch,
		outcome: "stopped" as const,
		exitReason: "managed_provider_stop",
	};
}

function managedAgent(patch: Partial<Agent> = {}): Agent {
	// The legacy initial/root bootstrap still derives its deterministic key.
	// Advanced tests below always start from an explicit source key and accept
	// only the successor returned by Hmux.
	return agentFixture({
		id: "agent-managed",
		name: "codex-1",
		worktreePath: "/repo/worktree",
		branch: "agent/codex-1",
		sessionId: "agent-managed",
		runtimeBinding: managedBindingFixture({
			sessionId: "agent-managed",
			workspaceId: "project-1",
			createIdempotencyKey: undefined,
			stopFence,
		}),
		...patch,
	});
}

type ManagedSessionFixture = {
	sessionId: string;
	workspaceId: string;
	sessionClass: "managed";
	lifecycle: string;
	manifestLifecycle?: string;
	health?: string;
	terminalEpoch: string;
	stopFence: typeof stopFence;
	outputSeq: string;
	capabilities: string[];
};

// Canonical ready managed session snapshot used by create/list/recovery mocks.
function managedSession(
	patch: Partial<ManagedSessionFixture> = {},
): ManagedSessionFixture {
	return {
		sessionId: "agent-managed",
		workspaceId: "project-1",
		sessionClass: "managed",
		lifecycle: "ready",
		terminalEpoch: "terminal-1",
		stopFence,
		outputSeq: "0",
		capabilities: [],
		...patch,
	};
}

function currentCreateResolution(receipt: Record<string, unknown>): {
	state: "current";
	receipt: Record<string, unknown>;
} {
	return { state: "current", receipt };
}

// Resolves createManaged with a "created" receipt echoing the idempotency key.
function mockCreateManagedCreated(patch: Partial<ManagedSessionFixture> = {}) {
	mocks.createManaged.mockImplementation(
		async (request: { idempotencyKey: string }) =>
			currentCreateResolution({
				session: managedSession(patch),
				idempotencyKey: request.idempotencyKey,
				outcome: "created",
			}),
	);
}

// Exact conversation identity as returned by managed identity inspection.
function inspectedIdentity(providerId: string, conversationId: string) {
	return {
		sessionId: "agent-managed",
		workspaceId: "project-1",
		providerId,
		conversationId,
	};
}

type CredentialAccount = {
	id: string;
	provider: "codex" | "claude";
	name: string;
	dir: string;
};

const claudeWorkAccount: CredentialAccount = {
	id: "account-claude-work",
	provider: "claude",
	name: "work",
	dir: "/profiles/claude-work",
};

type ManagedLaunchRequest = {
	providerId: string;
	credentialId?: string;
};

type RecoveryRequest = {
	recoveryId: string;
	sessionId: string;
	workspaceId: string;
	conversationId?: string;
	managedLaunch?: ManagedLaunchRequest;
};

type RecoveryLaunchRequest = RecoveryRequest & {
	managedLaunch: ManagedLaunchRequest;
};

// Minimal replacement session snapshot for receipts that omit epoch fields.
function replacementStub(sessionId: string, workspaceId: string) {
	return {
		sessionId,
		workspaceId,
		sessionClass: "managed",
		lifecycle: "ready",
		stopFence,
	};
}

function recoveryReplacementSessionId(request: RecoveryRequest): string {
	return `managed_rehost_${request.recoveryId}`;
}

// Canonical "replaced" recovery receipt derived from the mock request. Options
// carry each test's fixed values so every call keeps its original receipt
// shape; launchReference mirrors the launch credential when one is present.
function replacedReceipt(
	request: RecoveryRequest,
	options: {
		idempotencyKey: string;
		targetSessionId?: string;
		conversationId?: string;
		sourceSessionId?: string;
		launchReference?: string;
		replayed?: boolean;
		replacementSession?: object;
	},
) {
	const targetSessionId =
		options.targetSessionId ?? recoveryReplacementSessionId(request);
	const launchReference =
		options.launchReference ?? request.managedLaunch?.credentialId;
	return {
		sourceSessionId: options.sourceSessionId ?? request.sessionId,
		targetBuildId: "current-build",
		action: "replace_ai_provider_with_explicit_conversation",
		outcome: "replaced",
		replayed: options.replayed ?? false,
		operationId: request.recoveryId,
		sourceStopReceipt: recoverySourceStop(
			request.recoveryId,
			request.sessionId,
			request.workspaceId,
		),
		conversationId: options.conversationId ?? request.conversationId,
		...(launchReference ? { launchReference } : {}),
		replacementTarget: recoveryTarget(
			targetSessionId,
			request.workspaceId,
			options.idempotencyKey,
			request.managedLaunch?.providerId,
		),
		...(options.replacementSession
			? { replacementSession: options.replacementSession }
			: {}),
	};
}

// Stores one account plus a managed agent bound to that credential.
function setCredentialedAgent(
	account: CredentialAccount,
	patch: Partial<Agent> = {},
): Agent {
	const agent = managedAgent({
		credentialId: account.id,
		runtimeBinding: {
			...managedAgent().runtimeBinding,
			credentialId: account.id,
		} as Agent["runtimeBinding"],
		...patch,
	});
	useStore.setState({ accounts: [account], agents: [agent] });
	return agent;
}

beforeEach(() => {
	mocks.createManaged.mockReset();
	mocks.executeRecovery.mockReset();
	mocks.reconcileManagedRecovery.mockReset().mockResolvedValue(null);
	mocks.resolveManagedRehost
		.mockReset()
		.mockImplementation(async (sessionId: string, workspaceId: string) => ({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: { sessionId, workspaceId },
		}));
	mocks.resolveRouteAuthority
		.mockReset()
		.mockImplementation(async (profileId: string) => ({
			schemaVersion: 1,
			profileId,
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: `backend-${profileId}`, generation: "generation-1" },
			target: { source: "local", hostId: "local" },
		}));
	mocks.inspectManagedConversationIdentity
		.mockReset()
		.mockResolvedValue(undefined);
	mocks.listSessions.mockReset().mockResolvedValue([]);
	mocks.requireProjectProvider.mockReset().mockResolvedValue(undefined);
	useStore.setState({
		projects: [
			{
				id: "project-1",
				name: "repo",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		agents: [managedAgent()],
		accounts: [],
		activeAccounts: {},
		skipPermissions: {},
		sessionCwd: {},
	});
});

describe("managed agent create contract", () => {
	it.each([
		["codex", false, false],
		["claude", false, false],
		["codex", true, false],
		["claude", true, true],
	] as const)(
		"requests version evidence for %s with account=%s only when required",
		async (provider, withAccount, includeVersion) => {
			const patch = {
				provider,
				conversationId: "conversation-exact",
				terminalEnv: { NO_COLOR: null },
			};
			const agent = withAccount
				? setCredentialedAgent(
						{
							id: "account-work",
							provider,
							name: "Work",
							dir: `/profiles/${provider}-work`,
						},
						patch,
					)
				: managedAgent(patch);
			useStore.setState({ agents: [agent] });
			mocks.requireProjectProvider.mockResolvedValue({
				version: "2.1.212 (Claude Code)",
			});
			mockCreateManagedCreated();
			await ensureManagedAgentRuntime(agent, { columns: 120, rows: 30 });
			await preflightManagedAgentRecovery(agent);
			expect(mocks.requireProjectProvider).toHaveBeenCalledTimes(2);
			for (const call of mocks.requireProjectProvider.mock.calls) {
				expect(call).toEqual([
					{ kind: "local", path: agent.worktreePath },
					provider,
					{ terminalEnv: { NO_COLOR: null }, includeVersion },
				]);
			}
		},
	);

	it.each(["codex", "claude"] as const)(
		"creates %s from its binding without a project registry row",
		async (provider) => {
			const agent = managedAgent({ provider });
			useStore.setState({ projects: [], agents: [agent] });
			mockCreateManagedCreated();
			await expect(
				ensureManagedAgentRuntime(agent, { columns: 120, rows: 30 }),
			).resolves.toMatchObject({ outcome: "created" });
			expect(mocks.createManaged).toHaveBeenCalledWith(
				expect.objectContaining({
					providerId: provider,
					cwd: agent.worktreePath,
					workspaceId: "project-1",
				}),
			);
		},
	);

	it.each(["codex", "claude"] as const)(
		"prepares %s recovery without a project registry row",
		async (provider) => {
			const agent = managedAgent({
				provider,
				conversationId: "conversation-1",
			});
			useStore.setState({ projects: [], agents: [agent] });
			await expect(
				preflightManagedAgentRecovery(agent),
			).resolves.toBeUndefined();
		},
	);

	it("validates a selected Codex profile before backend-owned preparation", async () => {
		const account: CredentialAccount = {
			id: "account-crispy",
			provider: "codex",
			name: "crispy",
			dir: "/profiles/codex-crispy",
		};
		const agent = setCredentialedAgent(account, {
			conversationId: "conversation-exact",
		});

		await preflightManagedAgentRecovery(agent);

		expect(mocks.requireProjectProvider).toHaveBeenCalledOnce();
	});

	it("refuses an old Claude CLI before backend-owned preparation", async () => {
		const agent = setCredentialedAgent(claudeWorkAccount, {
			name: "claude-1",
			provider: "claude",
			conversationId: "conversation-exact",
		});
		mocks.requireProjectProvider.mockResolvedValue({
			version: "2.1.211 (Claude Code)",
		});

		await expect(preflightManagedAgentRecovery(agent)).rejects.toMatchObject({
			code: "credential_overlay_version_unsupported",
		});
	});

	it("admits a selected Claude profile on the reviewed CLI version", async () => {
		const agent = setCredentialedAgent(claudeWorkAccount, {
			name: "claude-1",
			provider: "claude",
			conversationId: "conversation-exact",
		});
		mocks.requireProjectProvider.mockResolvedValue({
			version: "2.1.212 (Claude Code)",
		});

		await preflightManagedAgentRecovery(agent);

		expect(mocks.requireProjectProvider).toHaveBeenCalledOnce();
	});

	it("coalesces StrictMode duplicate prepare calls into one idempotent create", async () => {
		let release:
			| ((value: {
					state: "current";
					receipt: {
						session: ManagedSessionFixture;
						idempotencyKey: string;
						outcome: "created";
					};
			  }) => void)
			| undefined;
		mocks.createManaged.mockImplementation(
			(request: { idempotencyKey: string }) =>
				new Promise((resolve) => {
					release = (value) => resolve(value);
					queueMicrotask(() =>
						release?.({
							state: "current",
							receipt: {
								session: managedSession({
									capabilities: ["provider_runtime_environment_v1"],
								}),
								idempotencyKey: request.idempotencyKey,
								outcome: "created",
							},
						}),
					);
				}),
		);
		const agent = managedAgent();

		const [first, second] = await Promise.all([
			ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
			ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		]);

		expect(mocks.createManaged).toHaveBeenCalledTimes(1);
		expect(first.idempotencyKey).toBe(second.idempotencyKey);
		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "agent-managed",
				workspaceId: "project-1",
				cwd: "/repo/worktree",
				command: "codex -c check_for_update_on_startup=false",
				credentialId: undefined,
			}),
		);
		expect(mocks.createManaged.mock.calls[0][0].command).not.toContain(
			"CODEX_HOME=",
		);
	});

	it("lets a surface join a prompt-bearing launch without dropping its prompt", async () => {
		mocks.createManaged.mockImplementation(
			async (request: { idempotencyKey: string }) =>
				currentCreateResolution({
					session: managedSession(),
					idempotencyKey: request.idempotencyKey,
					outcome: "created",
					initialPromptAccepted: true,
				}),
		);
		const agent = managedAgent();

		const launch = ensureManagedAgentRuntime(agent, {
			columns: 120,
			rows: 30,
			initialPrompt: "ship it",
		});
		const surface = ensureManagedAgentRuntime(agent, {
			columns: 120,
			rows: 30,
		});
		const [launched, joined] = await Promise.all([launch, surface]);

		expect(mocks.createManaged).toHaveBeenCalledOnce();
		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({ initialPrompt: "ship it" }),
		);
		expect(launched.initialPromptAccepted).toBe(true);
		expect(joined.initialPromptAccepted).toBe(true);
	});

	it("joins a surface-owned launch and leaves the prompt for PTY fallback", async () => {
		mocks.createManaged.mockImplementation(
			async (request: { idempotencyKey: string }) =>
				currentCreateResolution({
					session: managedSession(),
					idempotencyKey: request.idempotencyKey,
					outcome: "created",
				}),
		);
		const agent = managedAgent();

		const surface = ensureManagedAgentRuntime(agent, {
			columns: 120,
			rows: 30,
		});
		const launch = ensureManagedAgentRuntime(agent, {
			columns: 120,
			rows: 30,
			initialPrompt: "ship it",
		});
		const [joined, launched] = await Promise.all([surface, launch]);

		expect(mocks.createManaged).toHaveBeenCalledOnce();
		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.not.objectContaining({ initialPrompt: expect.anything() }),
		);
		expect(joined.initialPromptAccepted).not.toBe(true);
		expect(launched.initialPromptAccepted).not.toBe(true);
	});

	it("creates a never-started exact conversation with its exact provider identity", async () => {
		const agent = managedAgent({
			started: false,
			conversationId: "conversation-selected",
		});
		useStore.setState({ agents: [agent] });
		mockCreateManagedCreated();

		await ensureManagedAgentRuntime(agent, { columns: 120, rows: 40 });

		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-selected",
				command:
					"codex -c check_for_update_on_startup=false resume conversation-selected",
			}),
		);
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toMatchObject({
			started: true,
			conversationId: "conversation-selected",
			runtimeBinding: { stopFence },
		});
	});

	it("revalidates transaction authority after preflight and before managed create", async () => {
		const agent = managedAgent({
			started: false,
			conversationId: "conversation-selected",
		});
		useStore.setState({ agents: [agent] });
		const changed = new Error("conversation owner became live");
		const beforeCreate = vi.fn(async () => {
			throw changed;
		});

		await expect(
			ensureManagedAgentRuntime(agent, {
				columns: 120,
				rows: 40,
				beforeCreate,
			}),
		).rejects.toBe(changed);

		expect(beforeCreate).toHaveBeenCalledOnce();
		expect(mocks.requireProjectProvider).toHaveBeenCalledOnce();
		expect(mocks.createManaged).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("does not commit a receipt after the Agent retargets to another generation", async () => {
		let release: ((value: unknown) => void) | undefined;
		mocks.createManaged.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		const agent = managedAgent();
		const pending = ensureManagedAgentRuntime(agent, {
			columns: 100,
			rows: 40,
		});
		await vi.waitFor(() => expect(mocks.createManaged).toHaveBeenCalledOnce());
		const newerFence = { ...stopFence, terminalEpoch: "terminal-2" };
		useStore.setState({
			agents: [
				managedAgent({
					runtimeBinding: {
						...managedAgent().runtimeBinding,
						stopFence: newerFence,
					} as Agent["runtimeBinding"],
				}),
			],
		});
		release?.(
			currentCreateResolution({
				session: managedSession(),
				idempotencyKey: mocks.createManaged.mock.calls[0][0].idempotencyKey,
				outcome: "created",
			}),
		);

		await expect(pending).rejects.toMatchObject({
			code: "managed_create_retry_same",
			reason: "authority_inconsistent",
			backendCode: "managed_create_receipt_commit_changed",
			message: "managed Hmux create source changed before receipt commit",
		});
		expect(useStore.getState().agents[0].runtimeBinding).toMatchObject({
			stopFence: newerFence,
		});
	});

	it("keeps an explicit safe Agent permission override above the global bypass", async () => {
		const agent = managedAgent({ skipPermissions: false });
		useStore.setState({ agents: [agent], skipPermissions: { codex: true } });
		mockCreateManagedCreated();

		await ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				permissionMode: "default",
				command: "codex -c check_for_update_on_startup=false",
			}),
		);
	});

	it("persists a live Codex conversation identity for the next reboot", async () => {
		const agent = managedAgent();
		useStore.setState({ agents: [agent] });
		mockCreateManagedCreated({ outputSeq: "1" });
		mocks.inspectManagedConversationIdentity.mockResolvedValue(
			inspectedIdentity("codex", "019fa342-4698-78b2-a47d-784690b3c756"),
		);

		await ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		await vi.waitFor(() => {
			expect(useStore.getState().agents[0].conversationId).toBe(
				"019fa342-4698-78b2-a47d-784690b3c756",
			);
		});
		expect(mocks.inspectManagedConversationIdentity).toHaveBeenCalledWith({
			sessionId: "agent-managed",
			workspaceId: "project-1",
			providerId: "codex",
			cwd: "/repo/worktree",
		});
	});

	it("does not poll when the Host identity is not projected yet", async () => {
		const agent = managedAgent();
		useStore.setState({ agents: [agent] });
		mocks.inspectManagedConversationIdentity.mockResolvedValue(undefined);

		await expect(
			ensureManagedConversationIdentity(agent),
		).resolves.toBeUndefined();
		expect(mocks.inspectManagedConversationIdentity).toHaveBeenCalledOnce();
	});

	it("recovers a Claude identity when the SessionStart hook projection is missing", async () => {
		const agent = managedAgent({
			name: "claude-1",
			provider: "claude",
		});
		useStore.setState({ agents: [agent] });
		mocks.inspectManagedConversationIdentity.mockResolvedValue(
			inspectedIdentity("claude", "67db31e4-9b8c-4df4-bb96-4e9d85027f39"),
		);

		await expect(ensureManagedConversationIdentity(agent)).resolves.toBe(
			"67db31e4-9b8c-4df4-bb96-4e9d85027f39",
		);
		expect(mocks.inspectManagedConversationIdentity).toHaveBeenCalledWith({
			sessionId: "agent-managed",
			workspaceId: "project-1",
			providerId: "claude",
			cwd: "/repo/worktree",
		});
		expect(useStore.getState().agents[0].conversationId).toBe(
			"67db31e4-9b8c-4df4-bb96-4e9d85027f39",
		);
	});

	it("records pending identity once and leaves convergence to the Host stream", async () => {
		const agent = managedAgent({
			name: "claude-new",
			provider: "claude",
		});
		useStore.setState({ agents: [agent] });
		mocks.inspectManagedConversationIdentity.mockRejectedValue(
			new Error(
				"conversation_identity_required: Claude live session is not available yet",
			),
		);

		await expect(
			ensureManagedConversationIdentity(agent),
		).resolves.toBeUndefined();
		expect(mocks.inspectManagedConversationIdentity).toHaveBeenCalledOnce();
		expect(useStore.getState().agents[0].conversationIdentity).toEqual({
			state: "pending",
			code: "conversation_identity_required",
			detail: "Claude live session is not available yet",
		});
	});

	it("records an unavailable identity and does not retry ambiguous evidence", async () => {
		const agent = managedAgent();
		useStore.setState({ agents: [agent] });
		mocks.inspectManagedConversationIdentity.mockRejectedValue(
			new Error("conversation_identity_ambiguous: multiple open rollouts"),
		);

		await expect(
			ensureManagedConversationIdentity(agent),
		).resolves.toBeUndefined();

		expect(mocks.inspectManagedConversationIdentity).toHaveBeenCalledTimes(1);
		expect(useStore.getState().agents[0].conversationIdentity).toEqual({
			state: "unavailable",
			code: "conversation_identity_ambiguous",
			detail: "multiple open rollouts",
		});
	});

	it("uses a stored exact identity without reinterpreting stale readiness", async () => {
		const agent = managedAgent({
			provider: "claude",
			conversationId: "67db31e4-9b8c-4df4-bb96-4e9d85027f39",
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_unverified",
				detail: "Claude project directory is unavailable",
			},
		});
		useStore.setState({ agents: [agent] });

		await expect(ensureManagedConversationIdentity(agent)).resolves.toBe(
			"67db31e4-9b8c-4df4-bb96-4e9d85027f39",
		);
		expect(mocks.inspectManagedConversationIdentity).not.toHaveBeenCalled();
	});

	it("does not let failed reinspection override the stored exact conversation", async () => {
		const agent = managedAgent({
			conversationId: "conversation-exact",
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_ambiguous",
				detail: "multiple root rollouts",
			},
		});

		await expect(preflightManagedAgentRecovery(agent)).resolves.toBeUndefined();
		expect(mocks.requireProjectProvider).toHaveBeenCalledOnce();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("uses the stored exact conversation when live reinspection times out", async () => {
		const agent = managedAgent({
			conversationId: "conversation-exact",
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_timeout",
				detail: "exact identity was not observed after 40 attempts",
			},
		});

		await expect(preflightManagedAgentRecovery(agent)).resolves.toBeUndefined();

		expect(mocks.requireProjectProvider).toHaveBeenCalledOnce();
	});

	it("requires a Host identity when recovery has no exact conversation", async () => {
		const agent = managedAgent({
			conversationId: undefined,
			conversationIdentity: {
				state: "unavailable",
				code: "conversation_identity_timeout",
				detail: "bounded inspection expired",
			},
		});

		await expect(preflightManagedAgentRecovery(agent)).rejects.toMatchObject({
			code: "conversation_identity_required",
		});
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("atomically replaces the source Agent and keyed projection with the ledger successor", async () => {
		const account: CredentialAccount = {
			id: "credential-work",
			provider: "codex",
			name: "Work",
			dir: "/profiles/codex-work",
		};
		const agent = managedAgent({
			started: true,
			sessionId: "source-session",
			runtimeBinding: managedBindingFixture({
				sessionId: "source-session",
				workspaceId: "project-1",
				createIdempotencyKey: "source-create",
				credentialId: "credential-work",
				credentialGeneration: 17,
			}),
		});
		useStore.setState({
			accounts: [account],
			agents: [agent],
			sessionCwd: { "source-session": "/repo/worktree" },
			sessionAgent: { "source-session": "codex" },
			sessionTitle: { "source-session": "old generation" },
			sshMessages: { "source-session": "old transport" },
		});
		mocks.createManaged.mockResolvedValue({
			state: "advanced",
			receipt: {
				session: managedSession({ sessionId: "ledger-successor-session" }),
				idempotencyKey: "ledger-successor-create",
				outcome: "created",
			},
		});

		const ensured = await ensureManagedAgentRuntime(agent, {
			columns: 120,
			rows: 40,
		});

		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "source-create",
				sessionId: "source-session",
			}),
		);
		const committed = useStore.getState();
		expect(ensured.agent).toBe(committed.agents[0]);
		expect(committed.agents[0]).toMatchObject({
			sessionId: "ledger-successor-session",
			runtimeBinding: {
				sessionId: "ledger-successor-session",
				createIdempotencyKey: "ledger-successor-create",
				credentialId: "credential-work",
				credentialGeneration: 17,
			},
		});
		expect(committed.sessionCwd).toEqual({
			"ledger-successor-session": "/repo/worktree",
		});
		expect(committed.sessionAgent).not.toHaveProperty("source-session");
		expect(committed.sessionTitle).not.toHaveProperty("source-session");
		expect(committed.sshMessages).not.toHaveProperty("source-session");
	});

	it("does not treat a never-started exact conversation create as source recovery", async () => {
		const createFailure = new Error(
			"hmux_managed_launch_failed: exact conversation create failed",
		);
		const agent = managedAgent({
			started: false,
			conversationId: "conversation-selected",
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-managed",
				workspaceId: "project-1",
				createIdempotencyKey: "agent-managed",
			}),
		});
		useStore.setState({ agents: [agent] });
		mocks.createManaged.mockRejectedValue(createFailure);
		mocks.listSessions.mockResolvedValue([]);

		await expect(
			ensureManagedAgentRuntime(agent, { columns: 120, rows: 40 }),
		).rejects.toBe(createFailure);
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("keeps the exact runtime identity and credential when managed create says retry same", async () => {
		const account: CredentialAccount = {
			id: "account-crispy",
			provider: "codex",
			name: "crispy",
			dir: "/profiles/codex-crispy",
		};
		const agent = setCredentialedAgent(account, {
			started: false,
			conversationId: "conversation-selected",
		});
		useStore.setState({ agents: [agent] });
		const before = structuredClone(useStore.getState().agents[0]);
		mocks.createManaged.mockResolvedValue({
			state: "retry_same",
			reason: "pending",
			code: "hmux_managed_create_pending",
			message: "the exact create is still pending",
		});

		await expect(
			ensureManagedAgentRuntime(agent, { columns: 120, rows: 40 }),
		).rejects.toMatchObject({
			code: "managed_create_retry_same",
			reason: "pending",
		});
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(useStore.getState().agents[0]).toEqual(before);
	});

	it("recovers the exact pre-stop route from Hmux's durable operation id after reboot", async () => {
		const agent = managedAgent({ conversationId: "conversation-stable" });
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("test requires a local managed binding");
		}
		const backendRouteAuthority = {
			schemaVersion: 1 as const,
			profileId: "local",
			revision: `sha256:${"a".repeat(64)}`,
			backend: { id: "backend-local", generation: "generation-1" },
			target: { source: "local" as const, hostId: "local" as const },
		};
		const { recoveryId } = managedRecoveryRouteIdentity(
			binding,
			backendRouteAuthority,
		);
		const targetSessionId = "managed-rehost-route-target";
		mocks.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: [recoveryId],
			sourceGeneration: {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				...stopFence,
			},
			currentGeneration: {
				sessionId: targetSessionId,
				workspaceId: binding.workspaceId,
				...stopFence,
			},
			providerId: "codex",
			permissionMode: "default",
		});
		mocks.reconcileManagedRecovery.mockImplementation(
			async (request: RecoveryRequest) =>
				replacedReceipt(request, {
					replayed: true,
					conversationId: "conversation-stable",
					targetSessionId,
					idempotencyKey: "managed-rehost-route-target",
					replacementSession: managedSession({ sessionId: targetSessionId }),
				}),
		);

		const recovered = await reconcileManagedAgentRecovery(binding);

		expect(recovered?.backendRouteAuthority).toEqual(backendRouteAuthority);
		expect(mocks.reconcileManagedRecovery).toHaveBeenCalledWith({
			recoveryId,
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
		});
		expect(mocks.resolveRouteAuthority).toHaveBeenCalledWith("local");

		mocks.resolveRouteAuthority.mockResolvedValueOnce({
			...backendRouteAuthority,
			revision: `sha256:${"b".repeat(64)}`,
			backend: { id: "backend-reselected", generation: "generation-2" },
		});
		const changedSelection = await reconcileManagedAgentRecovery(binding);
		expect(changedSelection?.backendRouteAuthority).toBeUndefined();
	});

	it("does not replay a retired intermediate when a completed multi-hop successor needs final projection", async () => {
		const agent = managedAgent({ conversationId: undefined });
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("test requires a local managed binding");
		}
		mocks.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "resolved",
			operationIds: ["rehost-root-to-middle", "rehost-middle-to-final"],
			sourceGeneration: {
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				...stopFence,
			},
			currentGeneration: {
				sessionId: "managed-rehost-final",
				workspaceId: binding.workspaceId,
				...stopFence,
			},
			providerId: "codex",
			permissionMode: "default",
		});

		await expect(
			executeManagedAgentRecovery(agent, {
				columns: 120,
				rows: 40,
				confirmed: true,
			}),
		).rejects.toMatchObject({
			code: "managed_rehost_successor_projection_required",
		});
		expect(mocks.reconcileManagedRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
	});

	it("does not enter legacy recovery when not-found echoes another source", async () => {
		const agent = managedAgent({ conversationId: undefined });
		mocks.resolveManagedRehost.mockResolvedValue({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: {
				sessionId: "another-source",
				workspaceId: "project-1",
			},
		});

		await expect(
			executeManagedAgentRecovery(agent, {
				columns: 120,
				rows: 40,
				confirmed: true,
			}),
		).rejects.toMatchObject({
			code: "managed_rehost_successor_projection_required",
		});
		expect(mocks.reconcileManagedRecovery).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
		expect(mocks.resolveRouteAuthority).not.toHaveBeenCalled();
	});

	it("passes a Codex credential reference and directory separately from the bare Host command", async () => {
		const credentialId = "credential-work";
		const account = {
			id: credentialId,
			provider: "codex" as const,
			name: "Work",
			dir: "/Users/test/.hebbian/accounts/codex-work",
		};
		const agent = managedAgent({
			credentialId,
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-credential-work",
				workspaceId: "project-1",
				createIdempotencyKey: undefined,
				credentialId,
			}),
		});
		useStore.setState({ accounts: [account], agents: [agent] });
		mocks.createManaged.mockImplementation(
			async (request: {
				idempotencyKey: string;
				credentialId?: string;
				credentialGeneration?: number;
			}) =>
				currentCreateResolution({
					session: managedSession({
						sessionId: "agent-credential-work",
						terminalEpoch: "terminal-credential-work",
						capabilities: ["provider_state_environment_v1"],
					}),
					idempotencyKey: request.idempotencyKey,
					credentialId: request.credentialId,
					credentialGeneration: request.credentialGeneration,
					outcome: "created",
				}),
		);

		expect(managedCredentialAccount(agent)).toEqual(account);
		await ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 });

		expect(mocks.createManaged).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "agent-credential-work",
				credentialId,
				credentialDirectory: account.dir,
				command: "codex -c check_for_update_on_startup=false",
			}),
		);
		expect(mocks.createManaged.mock.calls[0][0].command).not.toContain(
			"CODEX_HOME",
		);
	});

	it("fails a missing Codex credential reference before preflight or Host launch", async () => {
		const credentialId = "credential-missing";
		const agent = managedAgent({
			credentialId,
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-credential-missing",
				workspaceId: "project-1",
				createIdempotencyKey: undefined,
				credentialId,
			}),
		});

		expect(() => managedCredentialAccount(agent)).toThrow(
			/credential reference is unavailable/,
		);
		await expect(
			ensureManagedAgentRuntime(agent, { columns: 100, rows: 40 }),
		).rejects.toMatchObject({ code: "credential_reference_unavailable" });
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
		expect(mocks.createManaged).not.toHaveBeenCalled();
	});

	it("replaces an exited managed provider with one explicit conversation id", async () => {
		const agent = managedAgent({ conversationId: "conversation-stable" });
		useStore.setState({ agents: [agent] });
		mocks.executeRecovery.mockImplementation(
			async (request: RecoveryLaunchRequest) =>
				replacedReceipt(request, {
					idempotencyKey: "managed_rehost_exact",
					replacementSession: replacementStub(
						recoveryReplacementSessionId(request),
						request.workspaceId,
					),
				}),
		);
		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
		});
		const replacement = result.replacement;

		expect(replacement.sessionId).toBe(
			recoveryReplacementSessionId(mocks.executeRecovery.mock.calls[0][0]),
		);
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "agent-managed",
				workspaceId: "project-1",
				conversationId: "conversation-stable",
				adapterSupportsExplicitResume: true,
				confirmed: true,
				managedLaunch: expect.objectContaining({
					providerId: "codex",
					cwd: "/repo/worktree",
					credentialId: undefined,
				}),
			}),
		);
		expect(
			mocks.executeRecovery.mock.calls[0][0].managedLaunch,
		).not.toHaveProperty("command");
	});

	it("supersedes a completed recovery whose exact successor went stale after reboot", async () => {
		const agent = managedAgent({ conversationId: "conversation-stable" });
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("test requires a local managed binding");
		}
		const backendRouteAuthority = await mocks.resolveRouteAuthority("local");
		const firstRecoveryId = managedRecoveryRouteIdentity(
			binding,
			backendRouteAuthority,
		).recoveryId;
		const staleSuccessorId = "managed-rehost-before-reboot";
		const staleSuccessor = managedSession({
			sessionId: staleSuccessorId,
			lifecycle: "unavailable",
			manifestLifecycle: "ready",
			health: "stale_transport",
		});
		mocks.resolveManagedRehost.mockImplementation(
			async (sessionId: string, workspaceId: string) =>
				sessionId === binding.sessionId
					? {
							schema: "hmux-managed-rehost-resolution-v1",
							schemaVersion: 1,
							state: "resolved",
							operationIds: [firstRecoveryId],
							sourceGeneration: {
								sessionId: binding.sessionId,
								workspaceId: binding.workspaceId,
								...stopFence,
							},
							currentGeneration: {
								sessionId: staleSuccessorId,
								workspaceId: binding.workspaceId,
								...stopFence,
							},
							providerId: "codex",
							permissionMode: "default",
						}
					: {
							schema: "hmux-managed-rehost-resolution-v1",
							schemaVersion: 1,
							state: "not_found",
							source: { sessionId, workspaceId },
						},
		);
		mocks.reconcileManagedRecovery.mockImplementation(
			async (request: RecoveryRequest) =>
				request.recoveryId === firstRecoveryId
					? replacedReceipt(request, {
							replayed: true,
							conversationId: "conversation-stable",
							targetSessionId: staleSuccessorId,
							idempotencyKey: "create-before-reboot",
							replacementSession: staleSuccessor,
						})
					: null,
		);
		mocks.listSessions.mockResolvedValue([staleSuccessor]);
		mocks.executeRecovery.mockImplementation(
			async (request: RecoveryLaunchRequest) =>
				replacedReceipt(request, {
					idempotencyKey: "create-after-reboot",
					replacementSession: managedSession({
						sessionId: recoveryReplacementSessionId(request),
						health: "current_healthy",
					}),
				}),
		);
		const prepareFirstAdmission = vi.fn(async () => agent);

		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
			preflighted: true,
			prepareFirstAdmission,
		});

		expect(result.replacement.sessionId).not.toBe(staleSuccessorId);
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: staleSuccessorId,
				workspaceId: binding.workspaceId,
				expectedSourceFence: stopFence,
				conversationId: "conversation-stable",
			}),
		);
		expect(prepareFirstAdmission).toHaveBeenCalledOnce();
	});

	it("runs the first-admission fence only after journal reconcile and before backend admission", async () => {
		const agent = managedAgent({ conversationId: "conversation-stable" });
		const prepareFirstAdmission = vi.fn(async () => agent);
		mocks.executeRecovery.mockImplementation(
			async (request: RecoveryLaunchRequest) =>
				replacedReceipt(request, { idempotencyKey: "managed_rehost_ordered" }),
		);

		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
			requireSocketOwnerAbsent: true,
			preflighted: true,
			prepareFirstAdmission,
		});

		expect(
			mocks.reconcileManagedRecovery.mock.invocationCallOrder[0],
		).toBeLessThan(prepareFirstAdmission.mock.invocationCallOrder[0]);
		expect(prepareFirstAdmission.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.executeRecovery.mock.invocationCallOrder[0],
		);
		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				requireSocketOwnerAbsent: true,
				conversationId: "conversation-stable",
			}),
		);
		expect(result.replacement).toMatchObject({
			sessionId: recoveryReplacementSessionId(
				mocks.executeRecovery.mock.calls[0][0],
			),
			lifecycle: "unavailable",
			health: "unprobed",
		});
	});

	it("admits a terminal-owned binding from the Host recipe after reconcile misses", async () => {
		const agent = managedAgent();
		const binding = agent.runtimeBinding;
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("test requires a local managed binding");
		}
		const projectedBinding = {
			...binding,
			conversationIdentity: {
				schemaVersion: 1 as const,
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				...stopFence,
				revision: "1",
				observedThroughOutputSeq: "42",
				providerId: "codex" as const,
				conversationId: "conversation-from-host",
				source: "provider_event" as const,
			},
		};
		mocks.executeRecovery.mockImplementation(async (request: RecoveryRequest) =>
			replacedReceipt(request, {
				conversationId: "conversation-from-host",
				targetSessionId: "managed-target",
				idempotencyKey: "managed-target-create",
			}),
		);

		const result = await executeManagedBindingRecovery(projectedBinding);

		expect(
			mocks.reconcileManagedRecovery.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.executeRecovery.mock.invocationCallOrder[0]);
		expect(mocks.executeRecovery).toHaveBeenCalledWith({
			recoveryId: expect.stringMatching(/^recovery_/),
			kind: "managed_provider",
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			conversationId: "conversation-from-host",
			adapterSupportsExplicitResume: true,
			confirmed: true,
		});
		expect(result).toMatchObject({
			conversationId: "conversation-from-host",
			createIdempotencyKey: "managed-target-create",
			replacement: { sessionId: "managed-target" },
		});
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
	});

	it("consumes a completion that wins while first-admission hints fail", async () => {
		const agent = managedAgent({ conversationId: "conversation-stale-hint" });
		mocks.reconcileManagedRecovery
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(async (request: RecoveryRequest) =>
				replacedReceipt(request, {
					replayed: true,
					conversationId: "conversation-canonical",
					targetSessionId: "managed_rehost_concurrent_target",
					idempotencyKey: "managed_rehost_concurrent",
				}),
			);

		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
			preflighted: true,
			prepareFirstAdmission: async () => {
				throw new Error("stale client hint");
			},
		});

		expect(result.conversationId).toBe("conversation-canonical");
		expect(mocks.reconcileManagedRecovery).toHaveBeenCalledTimes(2);
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("preserves the canonical source credential when a replay carries an opaque launch reference", async () => {
		const agent = managedAgent({
			conversationId: undefined,
			runtimeBinding: managedBindingFixture({
				sessionId: "agent-managed",
				workspaceId: "project-1",
				credentialId: "credential-source",
				stopFence,
			}),
		});
		useStore.setState({ agents: [agent] });
		mocks.reconcileManagedRecovery.mockImplementation(
			async (request: RecoveryRequest) =>
				replacedReceipt(request, {
					sourceSessionId: agent.sessionId,
					replayed: true,
					conversationId: "conversation-journaled",
					launchReference: "credential-journaled",
					targetSessionId: "managed_rehost_journaled_target",
					idempotencyKey: "managed_rehost_journaled",
					replacementSession: replacementStub(
						"managed_rehost_journaled_target",
						"project-1",
					),
				}),
		);
		mocks.listSessions.mockResolvedValue([
			managedSession({ sessionId: "managed_rehost_journaled_target" }),
		]);

		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
		});

		expect(result.conversationId).toBe("conversation-journaled");
		expect(result.credentialId).toBe("credential-source");
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("keeps an explicit operation replay in the Agent credential domain", async () => {
		const binding = managedBindingFixture({
			sessionId: "agent-managed",
			workspaceId: "project-1",
			credentialId: "credential-source",
			stopFence,
		});
		const operationId = managedRecoveryIdentity(binding).recoveryId;
		mocks.reconcileManagedRecovery.mockImplementation(
			async (request: RecoveryRequest) =>
				replacedReceipt(request, {
					replayed: true,
					conversationId: "conversation-journaled",
					launchReference: "credential+opaque-final",
					targetSessionId: "managed_rehost_explicit_target",
					idempotencyKey: "managed_rehost_explicit",
				}),
		);

		const result = await reconcileManagedAgentRecoveryOperation(
			binding,
			operationId,
		);

		expect(result?.credentialId).toBe("credential-source");
		expect(result?.receipt.launchReference).toBe("credential+opaque-final");
	});

	it("resumes one exact Claude conversation with a private profile outside the command", async () => {
		const agent = setCredentialedAgent(claudeWorkAccount, {
			name: "claude-1",
			provider: "claude",
			conversationId: "conversation-claude-exact",
		});
		mocks.requireProjectProvider.mockResolvedValue({
			version: "2.1.212 (Claude Code)",
		});
		mocks.executeRecovery.mockImplementation(
			async (request: RecoveryLaunchRequest) =>
				replacedReceipt(request, {
					idempotencyKey: "managed_rehost_account",
					replacementSession: replacementStub(
						recoveryReplacementSessionId(request),
						request.workspaceId,
					),
				}),
		);

		await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
		});

		expect(mocks.executeRecovery).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conversation-claude-exact",
				managedLaunch: expect.objectContaining({
					providerId: "claude",
					credentialId: claudeWorkAccount.id,
					credentialDirectory: claudeWorkAccount.dir,
				}),
			}),
		);
		expect(
			mocks.executeRecovery.mock.calls[0][0].managedLaunch,
		).not.toHaveProperty("command");
	});

	it("rejects managed recovery without identity before preflight or launch", async () => {
		await expect(
			executeManagedAgentRecovery(managedAgent(), {
				columns: 120,
				rows: 40,
				confirmed: true,
			}),
		).rejects.toMatchObject({ code: "conversation_identity_required" });
		expect(mocks.requireProjectProvider).not.toHaveBeenCalled();
		expect(mocks.executeRecovery).not.toHaveBeenCalled();
	});

	it("preserves a refused backend receipt for UI diagnostics", async () => {
		const agent = managedAgent({ conversationId: "conversation-exact" });
		const receipt = {
			sourceSessionId: agent.sessionId,
			targetBuildId: "current-build",
			action: "none" as const,
			outcome: "refused" as const,
			replayed: false,
			reason: "recovery_source_process_live" as const,
		};
		mocks.executeRecovery.mockResolvedValue(receipt);

		await expect(
			executeManagedAgentRecovery(agent, {
				columns: 120,
				rows: 40,
				confirmed: true,
			}),
		).rejects.toMatchObject({
			code: "recovery_source_process_live",
			receipt,
		});
	});

	it("prefers a concurrent journal completion over a first-admission refusal", async () => {
		const agent = managedAgent({ conversationId: "conversation-stale" });
		const refused = {
			sourceSessionId: agent.sessionId,
			targetBuildId: "current-build",
			action: "none" as const,
			outcome: "refused" as const,
			replayed: false,
			reason: "recovery_source_changed" as const,
		};
		mocks.executeRecovery.mockResolvedValueOnce(refused);
		mocks.reconcileManagedRecovery
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(async (request: RecoveryRequest) =>
				replacedReceipt(request, {
					replayed: true,
					conversationId: "conversation-canonical",
					targetSessionId: "managed_rehost_concurrent_refusal",
					idempotencyKey: "managed_rehost_concurrent_refusal",
				}),
			);

		const result = await executeManagedAgentRecovery(agent, {
			columns: 120,
			rows: 40,
			confirmed: true,
		});

		expect(result.conversationId).toBe("conversation-canonical");
		expect(mocks.executeRecovery).toHaveBeenCalledOnce();
		expect(mocks.reconcileManagedRecovery).toHaveBeenCalledTimes(3);
	});

	it("gives duplicate recovery attempts one stable journal operation", async () => {
		const agent = managedAgent({ conversationId: "conversation-stable" });
		useStore.setState({ agents: [agent] });
		mocks.executeRecovery.mockImplementation(
			async (request: RecoveryLaunchRequest) =>
				replacedReceipt(request, {
					idempotencyKey: "managed_rehost_duplicate",
					replacementSession: replacementStub(
						recoveryReplacementSessionId(request),
						request.workspaceId,
					),
				}),
		);

		await Promise.all([
			executeManagedAgentRecovery(agent, {
				columns: 120,
				rows: 40,
				confirmed: true,
				expectedTargetBuildId: "build-observed-first",
			}),
			executeManagedAgentRecovery(agent, {
				columns: 120,
				rows: 40,
				confirmed: true,
				expectedTargetBuildId: "build-observed-on-retry",
			}),
		]);

		expect(mocks.executeRecovery).toHaveBeenCalledTimes(2);
		const [first, second] = mocks.executeRecovery.mock.calls.map(
			([request]) => request,
		);
		expect(first.recoveryId).toBe(second.recoveryId);
		expect(first.managedLaunch).not.toHaveProperty("idempotencyKey");
		expect(first.managedLaunch).not.toHaveProperty("targetSessionId");
		expect(second.managedLaunch).not.toHaveProperty("idempotencyKey");
		expect(second.managedLaunch).not.toHaveProperty("targetSessionId");
	});
});
