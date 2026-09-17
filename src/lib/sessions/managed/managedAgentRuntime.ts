import { effectiveAgentSkipPermissions } from "@/lib/agents/agentPermissionMode";
import {
	assertCredentialOverlayVersion,
	credentialOverlayMinimumVersion,
} from "@/lib/agents/providerCredentials";
import { requireProjectProvider } from "@/lib/agents/providerPreflight";
import { providerSupportsExplicitResume } from "@/lib/agents/providers";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	assertNeverManagedCreateAdvanceResolution,
	ManagedCreateRejectedError,
	ManagedCreateRetrySameError,
} from "@/lib/hmux/managed/managedCreateResolution";
import {
	type HmuxExactManagedCreateReceipt,
	type HmuxManagedCreateReceipt,
	type HmuxSessionSummary,
	hmux,
} from "@/lib/ipc";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import { readinessFromError } from "@/lib/sessions/managed/conversationIdentityReadiness";
import {
	managedRecoveryResultFromReceiptForOperation,
	reconcileManagedAgentRecovery,
} from "@/lib/sessions/managed/managedAgentRecoveryReceipt";
import type { ManagedAgentRecoveryExecutionOptions } from "@/lib/sessions/managed/managedAgentRecoveryRequest";
import { managedRecoveryRouteIdentity } from "@/lib/sessions/managed/managedAgentRecoveryRoute";
import {
	ManagedCredentialReferenceChangedError,
	ManagedCredentialReferenceError,
	ManagedRecoveryRefusedError,
} from "@/lib/sessions/managed/managedAgentRuntimeErrors";
import {
	type ManagedAgentRecoveryResult,
	managedBinding,
	shortManagedRuntimeDigest,
} from "@/lib/sessions/managed/managedAgentRuntimeState";
import {
	applyConversationIdentityReadiness,
	applyManagedConversationIdentity,
	managedConversationId,
} from "@/lib/sessions/managed/managedConversationIdentity";
import { sameManagedCreateSource } from "@/lib/sessions/managed/managedCreateSourceCas";
import { managedCreateSuccessorProjection } from "@/lib/sessions/managed/managedCreateSuccessorProjection";
import {
	managedConversationIdentitySource,
	supportsManagedConversationIdentityInspection,
} from "@/lib/sessions/managed/managedProviderCapabilities";
import { managedProviderCommand } from "@/lib/sessions/managed/managedProviderCommand";
import { runManagedRehostJournalOperation } from "@/lib/sessions/managed/managedRehostJournal";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { useStore } from "@/store";
import type { AccountProfile, Agent } from "@/types";

interface InFlightManagedEnsure {
	readonly initialPrompt?: string;
	readonly operation: Promise<ManagedAgentEnsureReceipt>;
}

const inFlight = new Map<string, InFlightManagedEnsure>();

function isAttachableManagedSession(session: HmuxSessionSummary): boolean {
	return (
		session.sessionClass === "managed" &&
		session.lifecycle === "ready" &&
		(session.manifestLifecycle === "ready" ||
			session.manifestLifecycle === undefined) &&
		(session.health === undefined ||
			session.health === "current_healthy" ||
			session.health === "compatible_old_healthy" ||
			session.health === "unprobed")
	);
}

/** Resolve only a non-secret reference. A future provider adapter may turn
 * this into ephemeral auth material immediately before Host launch. */
export function managedCredentialAccount(
	agent: Agent,
): AccountProfile | undefined {
	const binding = managedBinding(agent);
	const credentialId = binding.credentialId ?? agent.credentialId;
	if (!credentialId) return undefined;
	const account = useStore
		.getState()
		.accounts.find(
			(candidate) =>
				candidate.id === credentialId && candidate.provider === agent.provider,
		);
	if (!account) throw new ManagedCredentialReferenceError(credentialId);
	return account;
}

function fencedCredentialAccount(
	agent: Agent,
	expectedAccount?: AccountProfile,
): AccountProfile | undefined {
	const account = managedCredentialAccount(agent);
	if (
		expectedAccount &&
		(!account ||
			account.id !== expectedAccount.id ||
			account.provider !== expectedAccount.provider ||
			account.dir !== expectedAccount.dir)
	) {
		throw new ManagedCredentialReferenceChangedError(expectedAccount.id);
	}
	return account;
}

/** create payload는 호출자와 무관하게 동일해야 한다 — 같은 idempotencyKey에
 * 다른 geometry가 들어가면 "첫 요청 승리" 또는 payload mismatch가 된다.
 * 실측 크기는 생성 인자가 아니라 attach 후 surface proposal과 resize receipt로
 * 적용한다. options.columns/rows는 호환을 위해 받되 create에는 쓰지 않는다. */
export const MANAGED_BOOTSTRAP_GEOMETRY = { columns: 120, rows: 30 } as const;

export {
	executeManagedBindingRecovery,
	reconcileManagedAgentRecovery,
} from "@/lib/sessions/managed/managedAgentRecoveryReceipt";
export type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntimeState";

export interface ManagedAgentEnsureReceipt extends HmuxManagedCreateReceipt {
	readonly agent: Agent;
	recovery?: ManagedAgentRecoveryResult;
}

function exactCurrentManagedAgent(agent: Agent): Agent | undefined {
	const binding = managedBinding(agent);
	return useStore
		.getState()
		.agents.find(
			(candidate) =>
				candidate.id === agent.id &&
				candidate.provider === agent.provider &&
				candidate.worktreePath === agent.worktreePath &&
				candidate.runtimeBinding?.runtime === "hmux_managed_v1" &&
				candidate.runtimeBinding.sessionId === binding.sessionId &&
				candidate.runtimeBinding.workspaceId === binding.workspaceId,
		);
}

async function captureManagedConversationIdentity(
	agent: Agent,
): Promise<string | undefined> {
	const identitySource = managedConversationIdentitySource(agent.provider);
	if (!identitySource) {
		return managedConversationId(agent);
	}
	const current = exactCurrentManagedAgent(agent);
	if (!current) return undefined;
	const existing = managedConversationId(current);
	if (existing) return existing;
	if (!supportsManagedConversationIdentityInspection(agent.provider)) {
		return undefined;
	}
	const binding = managedBinding(agent);
	let evidence:
		| Awaited<ReturnType<typeof hmux.inspectManagedConversationIdentity>>
		| undefined;
	try {
		evidence = await hmux.inspectManagedConversationIdentity({
			sessionId: binding.sessionId,
			workspaceId: binding.workspaceId,
			providerId: agent.provider,
			cwd: agent.worktreePath,
		});
	} catch (error) {
		const readiness = readinessFromError(error);
		useStore.setState((state) => {
			const agents = applyConversationIdentityReadiness(
				state.agents,
				binding.sessionId,
				readiness,
			);
			return agents === state.agents ? {} : { agents: [...agents] };
		});
		return managedConversationId(exactCurrentManagedAgent(agent) ?? current);
	}
	if (evidence) {
		const resolvedEvidence = evidence;
		useStore.setState((state) => {
			const agents = applyManagedConversationIdentity(
				state.agents,
				resolvedEvidence,
			);
			return agents === state.agents ? {} : { agents: [...agents] };
		});
	}
	const captured = exactCurrentManagedAgent(agent);
	return captured ? managedConversationId(captured) : undefined;
}

/** Read the Host projection, with one exact adapter inspection only when the
 * current snapshot has not projected it yet. This boundary never polls. */
export function ensureManagedConversationIdentity(
	agent: Agent,
): Promise<string | undefined> {
	return captureManagedConversationIdentity(agent);
}

async function preflightManagedProviderLaunch(
	agent: Agent,
	expectedAccount?: AccountProfile,
): Promise<AccountProfile | undefined> {
	const binding = managedBinding(agent);
	let account = fencedCredentialAccount(agent, expectedAccount);
	const providerPreflight = await requireProjectProvider(
		{
			kind: binding.source === "local" ? "local" : "ssh",
			path: agent.worktreePath,
		},
		agent.provider,
		{
			terminalEnv: agent.terminalEnv,
			includeVersion: Boolean(
				account && credentialOverlayMinimumVersion(agent.provider),
			),
		},
	);
	account = fencedCredentialAccount(agent, expectedAccount);
	if (account) {
		assertCredentialOverlayVersion(agent.provider, providerPreflight?.version);
	}
	return account;
}

/** Validate every local prerequisite that can fail before a managed recovery
 * stops its source provider. The backend still revalidates source identity
 * when the replacement is executed. */
export async function preflightManagedAgentRecovery(
	agent: Agent,
	expectedAccount?: AccountProfile,
): Promise<void> {
	if (!managedConversationId(agent)) {
		throw new ManagedRecoveryRefusedError("conversation_identity_required");
	}
	if (!providerSupportsExplicitResume(agent.provider)) {
		throw new ManagedRecoveryRefusedError("explicit_resume_unsupported");
	}
	await preflightManagedProviderLaunch(agent, expectedAccount);
}

/** A fresh successor needs provider/cwd/credential preflight but deliberately
 * has no explicit-resume requirement or conversation identity. */
export function preflightManagedAgentFreshStart(
	agent: Agent,
	expectedAccount?: AccountProfile,
): Promise<AccountProfile | undefined> {
	return preflightManagedProviderLaunch(agent, expectedAccount);
}

export async function ensureManagedAgentRuntime(
	agent: Agent,
	options: {
		columns: number;
		rows: number;
		commandOverride?: string;
		initialPrompt?: string;
		/** Optional transaction authority recheck immediately before create. */
		beforeCreate?: () => void | Promise<void>;
	},
): Promise<ManagedAgentEnsureReceipt> {
	const binding = managedBinding(agent);
	const credentialId = binding.credentialId ?? agent.credentialId;
	// Resolve/gate credentials before preflight or any Hmux lifetime side effect.
	const account = managedCredentialAccount(agent);
	// Legacy local agents may still need their deterministic root create key.
	// Successor identity is never derived here: Advanced is committed only from
	// the Hmux ledger receipt below.
	const idempotencyKey =
		binding.createIdempotencyKey ??
		`spawn_${shortManagedRuntimeDigest([agent.id, binding.workspaceId, binding.sessionId].join("\0"))}`;
	const operationKey = `${binding.workspaceId}\0${binding.sessionId}\0${idempotencyKey}`;
	const existing = inFlight.get(operationKey);
	if (existing) {
		if (
			options.initialPrompt !== undefined &&
			existing.initialPrompt !== undefined &&
			existing.initialPrompt !== options.initialPrompt
		) {
			throw new Error("managed_create_initial_prompt_conflict");
		}
		return existing.operation;
	}

	const operation = (async (): Promise<ManagedAgentEnsureReceipt> => {
		// provider-ready 지배 비용 계측 — preflight(login-shell 2회 spawn)와
		// createManaged(broker→host fork→provider TUI→ready-poll)를 분리해 기록 (bd 6gy).
		// warm은 시작 시점에 판정한다: 완료 시점 판정은 동시 cold 스폰을 오분류한다.
		const spawnWarm = workspacePerformance.agentSpawnWarm(agent.provider);
		const startedAt = performance.now();
		let preflightDoneAt: number | undefined;
		const recordFailure = () => {
			const failedAt = performance.now();
			workspacePerformance.recordAgentReady(agent.provider, {
				warm: spawnWarm,
				ok: false,
				totalMs: failedAt - startedAt,
				preflightMs: (preflightDoneAt ?? failedAt) - startedAt,
				createMs:
					preflightDoneAt === undefined ? 0 : failedAt - preflightDoneAt,
			});
		};
		try {
			const providerPreflight = await requireProjectProvider(
				{ kind: "local", path: agent.worktreePath },
				agent.provider,
				{
					terminalEnv: agent.terminalEnv,
					includeVersion: Boolean(
						account && credentialOverlayMinimumVersion(agent.provider),
					),
				},
			);
			if (account) {
				assertCredentialOverlayVersion(
					agent.provider,
					providerPreflight?.version,
				);
			}
		} catch (error) {
			recordFailure();
			throw error;
		}
		preflightDoneAt = performance.now();
		const launchState = useStore.getState();
		if (
			!sameManagedCreateSource(
				launchState.agents.find((candidate) => candidate.id === agent.id),
				agent,
			)
		) {
			recordFailure();
			throw new Error("managed Hmux create source changed during preflight");
		}
		try {
			await options.beforeCreate?.();
		} catch (error) {
			recordFailure();
			throw error;
		}
		const createState = useStore.getState();
		if (
			!sameManagedCreateSource(
				createState.agents.find((candidate) => candidate.id === agent.id),
				agent,
			)
		) {
			recordFailure();
			throw new Error("managed Hmux create source changed before admission");
		}
		const bypassApprovals = effectiveAgentSkipPermissions(
			agent,
			createState.skipPermissions,
		);
		const command = managedProviderCommand(
			agent,
			options.commandOverride,
			bypassApprovals,
		);
		let resolution: Awaited<ReturnType<typeof hmux.advanceManagedCreate>>;
		try {
			resolution = await hmux.advanceManagedCreate({
				idempotencyKey,
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				providerId: agent.provider,
				conversationId: managedConversationId(agent),
				permissionMode: bypassApprovals ? "bypass_approvals" : "default",
				credentialId,
				credentialDirectory: account?.dir,
				credentialGeneration: binding.credentialGeneration,
				cwd: agent.worktreePath,
				command,
				...(options.initialPrompt === undefined
					? {}
					: { initialPrompt: options.initialPrompt }),
				columns: MANAGED_BOOTSTRAP_GEOMETRY.columns,
				rows: MANAGED_BOOTSTRAP_GEOMETRY.rows,
				terminalEnv: agent.terminalEnv,
				terminalDefaultColors: currentTerminalDefaultColors(),
			});
		} catch (error) {
			recordFailure();
			throw error;
		}
		let receipt: HmuxExactManagedCreateReceipt;
		switch (resolution.state) {
			case "current":
			case "advanced":
				receipt = resolution.receipt;
				break;
			case "retry_same":
				recordFailure();
				throw new ManagedCreateRetrySameError(
					resolution.reason,
					resolution.code,
					resolution.message,
				);
			case "rejected":
				recordFailure();
				throw new ManagedCreateRejectedError(
					resolution.code,
					resolution.message,
				);
			default:
				return assertNeverManagedCreateAdvanceResolution(resolution);
		}
		// "reused"는 이미 살아 있는 세션에 재접속한 것 — provider 스폰 비용이
		// 아니므로 기록하면 재시작·재마운트마다 수 ms 샘플이 p95를 밀어낸다.
		if (receipt.outcome === "created") {
			const createDoneAt = performance.now();
			workspacePerformance.recordAgentReady(agent.provider, {
				warm: spawnWarm,
				ok: true,
				totalMs: createDoneAt - startedAt,
				preflightMs: preflightDoneAt - startedAt,
				createMs: createDoneAt - preflightDoneAt,
			});
		}
		let committedAgent: Agent | undefined;
		useStore.setState((current) => {
			const candidate = current.agents.find((item) => item.id === agent.id);
			const currentBinding = candidate?.runtimeBinding;
			if (
				!candidate ||
				!sameManagedCreateSource(candidate, agent) ||
				currentBinding?.runtime !== "hmux_managed_v1" ||
				currentBinding.source !== "local" ||
				effectiveAgentSkipPermissions(agent, current.skipPermissions) !==
					bypassApprovals
			) {
				return {};
			}
			const projection = managedCreateSuccessorProjection(current, candidate, {
				...currentBinding,
				sessionId: receipt.session.sessionId,
				createIdempotencyKey: receipt.idempotencyKey,
				stopFence: receipt.session.stopFence,
			});
			committedAgent = projection.agents.find(
				(projected) => projected.id === candidate.id,
			);
			return projection;
		});
		if (!committedAgent) {
			throw new ManagedCreateRetrySameError(
				"authority_inconsistent",
				"managed_create_receipt_commit_changed",
				"managed Hmux create source changed before receipt commit",
			);
		}
		void captureManagedConversationIdentity(committedAgent);
		return { ...receipt, agent: committedAgent };
	})();
	inFlight.set(operationKey, {
		initialPrompt: options.initialPrompt,
		operation,
	});
	try {
		return await operation;
	} finally {
		if (inFlight.get(operationKey)?.operation === operation) {
			inFlight.delete(operationKey);
		}
	}
}

/** Execute the durable backend replacement without changing the Agent registry
 * or pane binding. Rehost callers must finish that frontend CAS only after the
 * replacement receipt is fully validated. */
export async function executeManagedAgentRecovery(
	agent: Agent,
	options: ManagedAgentRecoveryExecutionOptions,
): Promise<ManagedAgentRecoveryResult> {
	return executeManagedAgentRecoveryGeneration(agent, options, new Set());
}

function managedRecoveryGenerationKey(agent: Agent): string {
	const binding = managedBinding(agent);
	const fence = binding.stopFence;
	return [
		binding.workspaceId,
		binding.sessionId,
		fence?.runnerPrincipal,
		fence?.runnerInstance,
		fence?.channelEpoch,
		fence?.hostInstanceId,
		fence?.terminalEpoch,
	].join("\0");
}

function managedRecoverySuccessorAgent(
	agent: Agent,
	completed: ManagedAgentRecoveryResult,
): Agent {
	const binding = managedBinding(agent);
	const stopFence = completed.replacement.stopFence;
	if (!stopFence) {
		throw new ManagedRecoveryRefusedError(
			"managed_rehost_successor_fence_missing",
		);
	}
	const {
		conversationIdentity: _conversationIdentity,
		credentialGeneration: _credentialGeneration,
		credentialId: _credentialId,
		...successorBinding
	} = binding;
	return {
		...agent,
		provider: completed.providerId ?? agent.provider,
		sessionId: completed.replacement.sessionId,
		conversationId: completed.conversationId,
		conversationIdentity: undefined,
		accountId: completed.credentialId ?? null,
		credentialId: completed.credentialId,
		skipPermissions: completed.permissionMode === "bypass_approvals",
		started: true,
		pendingCmd: undefined,
		runtimeBinding: {
			...successorBinding,
			sessionId: completed.replacement.sessionId,
			createIdempotencyKey: completed.createIdempotencyKey,
			stopFence,
			...(completed.credentialId
				? { credentialId: completed.credentialId }
				: {}),
		},
	};
}

async function executeManagedAgentRecoveryGeneration(
	agent: Agent,
	options: ManagedAgentRecoveryExecutionOptions,
	visitedGenerations: Set<string>,
): Promise<ManagedAgentRecoveryResult> {
	const binding = managedBinding(agent);
	const generationKey = managedRecoveryGenerationKey(agent);
	if (visitedGenerations.has(generationKey)) {
		throw new ManagedRecoveryRefusedError("managed_rehost_successor_cycle");
	}
	visitedGenerations.add(generationKey);
	const completed = await reconcileManagedAgentRecovery(binding);
	if (completed) {
		const exactSuccessor = await inspectHmuxSessionExact({
			sessionId: completed.replacement.sessionId,
			workspaceId: completed.replacement.workspaceId,
		});
		if (
			exactSuccessor &&
			!sameHmuxManagedGeneration(
				exactSuccessor.stopFence,
				completed.replacement.stopFence,
			)
		) {
			throw new ManagedRecoveryRefusedError(
				"managed_rehost_successor_generation_changed",
			);
		}
		if (
			exactSuccessor &&
			isAttachableManagedSession(exactSuccessor) &&
			exactSuccessor.inputAllowed !== false
		) {
			return { ...completed, replacement: exactSuccessor };
		}
		const continuation = managedRecoverySuccessorAgent(agent, completed);
		const prepareFirstAdmission = options.prepareFirstAdmission;
		return executeManagedAgentRecoveryGeneration(
			continuation,
			{
				...options,
				...(prepareFirstAdmission
					? {
							prepareFirstAdmission: async (backendRouteAuthority) =>
								managedRecoverySuccessorAgent(
									await prepareFirstAdmission(backendRouteAuthority),
									completed,
								),
						}
					: {}),
			},
			visitedGenerations,
		);
	}
	const backendProfileId = binding.backendProfileId ?? "local";
	const backendRouteAuthority =
		await resolveSelectedDureBackendRouteAuthority(backendProfileId);
	const { recoveryId } = managedRecoveryRouteIdentity(
		binding,
		backendRouteAuthority,
	);
	const reconcileRequest = {
		recoveryId,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
	};
	const reconcileCompletion = () =>
		hmux.reconcileManagedRecovery(reconcileRequest);
	const receipt = await runManagedRehostJournalOperation({
		reconcile: reconcileCompletion,
		initiate: async () => {
			const launchAgent = options.prepareFirstAdmission
				? await options.prepareFirstAdmission(backendRouteAuthority)
				: agent;
			const launchBinding = managedBinding(launchAgent);
			if (
				launchBinding.sessionId !== binding.sessionId ||
				launchBinding.workspaceId !== binding.workspaceId ||
				(launchBinding.backendProfileId ?? "local") !== backendProfileId
			) {
				throw new Error(
					"managed recovery source changed before first admission",
				);
			}
			if (!options.preflighted) {
				await preflightManagedAgentRecovery(
					launchAgent,
					options.credentialAccount,
				);
			}
			const conversationId = managedConversationId(launchAgent);
			if (!conversationId)
				throw new Error("managed recovery preflight lost conversation");
			const account = fencedCredentialAccount(
				launchAgent,
				options.credentialAccount,
			);
			const state = useStore.getState();
			const bypassApprovals = effectiveAgentSkipPermissions(
				launchAgent,
				state.skipPermissions,
			);
			const credentialId =
				launchBinding.credentialId ?? launchAgent.credentialId;
			return hmux.executeRecovery({
				recoveryId,
				kind: "managed_provider",
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				expectedSourceFence: binding.stopFence,
				expectedTargetBuildId: options.expectedTargetBuildId,
				requireSocketOwnerAbsent: options.requireSocketOwnerAbsent,
				conversationId,
				adapterSupportsExplicitResume: true,
				confirmed: options.confirmed,
				managedLaunch: {
					providerId: launchAgent.provider,
					permissionMode: bypassApprovals ? "bypass_approvals" : "default",
					credentialId,
					credentialDirectory: account?.dir,
					credentialGeneration: launchBinding.credentialGeneration,
					cwd: launchAgent.worktreePath,
					columns: options.columns,
					rows: options.rows,
					terminalEnvironment: launchAgent.terminalEnv ?? {},
				},
			});
		},
		isCompleted: (candidate) => candidate.outcome === "replaced",
	});
	return {
		...managedRecoveryResultFromReceiptForOperation(
			binding,
			recoveryId,
			receipt,
		),
		backendRouteAuthority,
	};
}
