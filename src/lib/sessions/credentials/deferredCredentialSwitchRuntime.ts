import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { freshCredentialSwitchEligibility } from "@/lib/agents/freshCredentialSwitch";
import { isCanonicalDecimalString } from "@/lib/decimalString";
import { t } from "@/lib/i18n";
import {
	type DureAgentRuntimeLaunchSelectionV1,
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeSourceStopPolicyV1,
} from "@/lib/ipc/dureAgentRuntime";
import {
	createDeferredCredentialSwitchIntent,
	type DeferredCredentialSwitchDecision,
	evaluateDeferredCredentialSwitchIntent,
	rebaselineIntent,
} from "@/lib/sessions/credentials/deferredCredentialSwitch";
import {
	commitManagedCredentialReplacement,
	reconcileManagedCredentialReplacement,
} from "@/lib/sessions/credentials/managedCredentialReplacementRuntime";
import { requestRemoteManagedCredentialSwitch } from "@/lib/sessions/credentials/remoteManagedCredentialSwitch";
import { switchFreshManagedAgentCredential } from "@/lib/sessions/managed/managedAgentFreshStart";
import {
	inspectInterruptedManagedAgentCredentialSwitch,
	inspectManagedAgentCredentialSwitch,
	type ManagedAgentCredentialSwitchInspection,
} from "@/lib/sessions/managed/managedAgentRehost";
import { withManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import { useStore } from "@/store";
import type { DeferredCredentialSwitchIntentV1 } from "@/types";

export type ManagedCredentialSwitchRequestResult =
	| { kind: "scheduled"; conversationId: string }
	| { kind: "completed"; conversationId: string | null };

const credentialSwitchExecutions = new Set<string>();

function hasPendingLocalInput(
	agentId: string,
	sessionId: string,
	agentActivity: Readonly<Record<string, string>>,
): boolean {
	return (
		agentActivity[agentId] === "working" &&
		useAgentAttention.getState().armedCompletions[sessionId] === true
	);
}

class DeferredCredentialSwitchRaceError extends Error {
	constructor(readonly decision: DeferredCredentialSwitchDecision) {
		super(`deferred credential switch is no longer ready: ${decision.kind}`);
		this.name = "DeferredCredentialSwitchRaceError";
	}
}

function nextRequestId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`deferred-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
}

function replaceIntent(
	agentId: string,
	intent: DeferredCredentialSwitchIntentV1,
): void {
	useStore.setState((state) => ({
		agents: state.agents.map((agent) =>
			agent.id === agentId
				? { ...agent, pendingCredentialSwitch: intent }
				: agent,
		),
	}));
}

function clearIntent(agentId: string, requestId?: string): boolean {
	let cleared = false;
	useStore.setState((state) => ({
		agents: state.agents.map((agent) => {
			if (
				agent.id !== agentId ||
				!agent.pendingCredentialSwitch ||
				(requestId !== undefined &&
					agent.pendingCredentialSwitch.requestId !== requestId)
			) {
				return agent;
			}
			cleared = true;
			return { ...agent, pendingCredentialSwitch: undefined };
		}),
	}));
	return cleared;
}

function updateIntentIfCurrent(
	agentId: string,
	requestId: string,
	update: (
		intent: DeferredCredentialSwitchIntentV1,
	) => DeferredCredentialSwitchIntentV1,
): boolean {
	let changed = false;
	useStore.setState((state) => ({
		agents: state.agents.map((agent) => {
			const intent = agent.pendingCredentialSwitch;
			if (agent.id !== agentId || intent?.requestId !== requestId) return agent;
			changed = true;
			return { ...agent, pendingCredentialSwitch: update(intent) };
		}),
	}));
	return changed;
}

function markIntentError(
	agentId: string,
	requestId: string,
	error: unknown,
): boolean {
	if (error instanceof DureAgentRuntimeSourceActiveError) {
		error = error.requestError;
	}
	const candidate =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: error instanceof Error
				? error.message
				: String(error);
	const message = /^[a-z0-9_]+$/.test(candidate)
		? candidate
		: "deferred_credential_switch_failed";
	return updateIntentIfCurrent(agentId, requestId, (intent) => ({
		...intent,
		lastError: message,
	}));
}

function assertInspectionMatchesIntent(
	inspection: ManagedAgentCredentialSwitchInspection,
	intent: DeferredCredentialSwitchIntentV1,
	agentId: string,
): void {
	if (
		inspection.agentId !== agentId ||
		inspection.sourceBinding.sessionId !== intent.sourceSessionId ||
		inspection.sourceBinding.workspaceId !== intent.sourceWorkspaceId ||
		inspection.conversationId !== intent.sourceConversationId ||
		(inspection.sourceCredentialId ?? null) !== intent.sourceCredentialId ||
		(inspection.sourceBinding.createIdempotencyKey ?? null) !==
			intent.sourceCreateIdempotencyKey ||
		(inspection.sourceBinding.credentialGeneration ?? null) !==
			intent.sourceCredentialGeneration ||
		inspection.targetCredentialId !== intent.targetCredentialId ||
		(inspection.targetAccount?.dir ?? null) !==
			intent.targetCredentialDirectory ||
		inspection.panelId !== intent.panelId
	) {
		throw new Error("deferred_credential_switch_inspection_changed");
	}
}

function readyDecision(
	agentId: string,
	requestId: string,
): DeferredCredentialSwitchDecision {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const intent = agent?.pendingCredentialSwitch;
	if (!agent || intent?.requestId !== requestId) {
		return { kind: "stale", reason: "deferred_credential_switch_cancelled" };
	}
	return evaluateDeferredCredentialSwitchIntent(
		intent,
		agent,
		state.accounts,
		state.sessionAgentRuntimeState[intent.sourceSessionId],
		{
			inputWorking: hasPendingLocalInput(
				agentId,
				intent.sourceSessionId,
				state.agentActivity,
			),
		},
	);
}

function assertReady(agentId: string, requestId: string): void {
	const decision = readyDecision(agentId, requestId);
	if (decision.kind !== "ready") {
		throw new DeferredCredentialSwitchRaceError(decision);
	}
}

async function commitCredentialReplacement(
	inspection: ManagedAgentCredentialSwitchInspection,
	intent?: DeferredCredentialSwitchIntentV1,
): Promise<void> {
	// An automatic completion boundary can fire while the user is reading another
	// pane — and several can land together after a reload. Only a switch the user
	// just asked for may take focus.
	const unattended =
		intent !== undefined && intent.completionReason !== "user_requested";
	await commitManagedCredentialReplacement(inspection, {
		...(unattended ? { activate: false } : {}),
		afterCommit: () => {
			if (intent) clearIntent(inspection.agentId, intent.requestId);
			else clearIntent(inspection.agentId);
		},
		...(intent
			? {
					beforeStop: () => assertReady(inspection.agentId, intent.requestId),
				}
			: {}),
	});
}

async function executeIntent(
	agentId: string,
	intent: DeferredCredentialSwitchIntentV1,
): Promise<void> {
	return withManagedCredentialSwitchTransition(agentId, async () => {
		assertReady(agentId, intent.requestId);
		if (intent.sourceSelectionRevision !== undefined) {
			const { switchAgentRuntimeCredential, transitionAgentRuntime } =
				await import("@/lib/agents/agentRuntimeTransitionAction");
			const options = {
				expectedSourceRevision: intent.sourceSelectionRevision,
				expectedConversationId: intent.sourceConversationId,
				sourceStopPolicy: (intent.completionReason === "user_requested"
					? "discard"
					: "preserve") as DureAgentRuntimeSourceStopPolicyV1,
				beforeTransition: () => assertReady(agentId, intent.requestId),
			};
			if (intent.targetLaunchSelection) {
				await transitionAgentRuntime({
					agentId,
					targetInteractionProfile: "preserve",
					...options,
					targetLaunchSelection: intent.targetLaunchSelection,
					...(intent.targetCredentialId !== intent.sourceCredentialId
						? {
								credentialAction: {
									targetCredentialId: intent.targetCredentialId,
								},
							}
						: {}),
				});
			} else {
				await switchAgentRuntimeCredential(
					agentId,
					intent.targetCredentialId,
					options,
				);
			}
			clearIntent(agentId, intent.requestId);
			return;
		}
		let inspection: ManagedAgentCredentialSwitchInspection;
		try {
			inspection = await inspectManagedAgentCredentialSwitch(
				agentId,
				intent.targetCredentialId,
				intent.panelId,
			);
		} catch (error) {
			if (
				intent.completionRuntimeRevision === undefined ||
				intent.completionTurnCompletedCount === undefined
			) {
				throw error;
			}
			inspection = await inspectInterruptedManagedAgentCredentialSwitch(
				agentId,
				intent,
			);
		}
		assertInspectionMatchesIntent(inspection, intent, agentId);
		assertReady(inspection.agentId, intent.requestId);
		await commitCredentialReplacement(inspection, intent);
	});
}

function samePendingSource(
	intent: DeferredCredentialSwitchIntentV1,
	inspection: ManagedAgentCredentialSwitchInspection,
): boolean {
	return (
		intent.sourceSessionId === inspection.sourceBinding.sessionId &&
		intent.sourceWorkspaceId === inspection.sourceBinding.workspaceId &&
		intent.sourceConversationId === inspection.conversationId &&
		intent.sourceCredentialId === (inspection.sourceCredentialId ?? null) &&
		intent.sourceCreateIdempotencyKey ===
			(inspection.sourceBinding.createIdempotencyKey ?? null) &&
		intent.sourceCredentialGeneration ===
			(inspection.sourceBinding.credentialGeneration ?? null)
	);
}

/** A backend busy refusal can only enqueue. Missing Host completion evidence
 * leaves the source running; it must never fall through to immediate replacement. */
export async function scheduleBusyAgentCredentialSwitch(
	agentId: string,
	targetCredentialId: string | null,
	panelId: string,
	sourceSelectionRevision: number,
	launch?: {
		selection: DureAgentRuntimeLaunchSelectionV1;
		conversationId: string;
		beforeQueue?(): void;
	},
): Promise<{ kind: "scheduled"; conversationId: string } | null> {
	const agent = useStore.getState().agents.find((item) => item.id === agentId);
	if (
		agent?.runtimeBinding?.runtime !== "hmux_managed_v1" ||
		agent.runtimeBinding.source !== "local"
	)
		return null;
	const previous = agent.pendingCredentialSwitch;
	if (launch) {
		if (
			!useStore.getState().sessionAgentRuntimeState[
				agent.runtimeBinding.sessionId
			]
		)
			return null;
		if (
			previous &&
			(previous.sourceSelectionRevision === undefined ||
				previous.sourceSelectionRevision === sourceSelectionRevision) &&
			previous.sourceConversationId === launch.conversationId
		) {
			targetCredentialId = previous.targetCredentialId;
		}
	}
	const inspection = await inspectManagedAgentCredentialSwitch(
		agentId,
		targetCredentialId,
		panelId,
	);
	if (launch && inspection.conversationId !== launch.conversationId)
		return null;
	const runtime =
		useStore.getState().sessionAgentRuntimeState[
			inspection.sourceBinding.sessionId
		];
	const intent = createDeferredCredentialSwitchIntent(
		inspection,
		runtime,
		nextRequestId(),
		Date.now(),
		{ inputWorking: true },
	);
	if (!intent) return null;
	launch?.beforeQueue?.();
	const state = useStore.getState();
	const current = state.agents.find((item) => item.id === agentId);
	if (
		!current ||
		current.pendingCredentialSwitch?.requestId !== previous?.requestId ||
		evaluateDeferredCredentialSwitchIntent(
			intent,
			current,
			state.accounts,
			runtime,
		).kind === "stale"
	)
		return null;
	const targetLaunchSelection =
		launch?.selection ??
		(previous?.sourceSelectionRevision === sourceSelectionRevision &&
		samePendingSource(previous, inspection)
			? previous.targetLaunchSelection
			: undefined);
	replaceIntent(agentId, {
		...intent,
		sourceSelectionRevision,
		...(targetLaunchSelection ? { targetLaunchSelection } : {}),
	});
	return { kind: "scheduled", conversationId: inspection.conversationId };
}

export async function requestManagedCredentialSwitch(
	agentId: string,
	targetCredentialId: string | null,
	panelId?: string,
): Promise<ManagedCredentialSwitchRequestResult> {
	const initialState = useStore.getState();
	const initialAgent = initialState.agents.find(
		(candidate) => candidate.id === agentId,
	);
	if (
		initialAgent?.runtimeBinding?.runtime === "hmux_managed_v1" &&
		initialAgent.runtimeBinding.source === "ssh"
	) {
		try {
			const result = await withManagedCredentialSwitchTransition(agentId, () =>
				requestRemoteManagedCredentialSwitch(
					agentId,
					targetCredentialId,
					panelId,
				),
			);
			return { kind: "completed", conversationId: result.conversationId };
		} catch (error) {
			if (String(error).includes("hmux_remote_runtime_update_required")) {
				throw new Error(
					`${t("sessions.credentials.remoteRuntimeUpdateRequired")}\n\n${String(error)}`,
				);
			}
			throw error;
		}
	}
	const reconciliation = panelId
		? await reconcileManagedCredentialReplacement(agentId, panelId)
		: null;
	const currentAgent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	if (
		reconciliation &&
		currentAgent?.sessionId !==
			reconciliation.payload.sourceBinding.sessionId &&
		currentAgent?.runtimeBinding?.runtime === "hmux_managed_v1" &&
		currentAgent.runtimeBinding.source === "local" &&
		(currentAgent.runtimeBinding.credentialId ??
			currentAgent.credentialId ??
			null) === targetCredentialId
	) {
		return {
			kind: "completed",
			conversationId:
				currentAgent.conversationId?.trim() ?? reconciliation.conversationId,
		};
	}
	const currentRuntime =
		currentAgent?.runtimeBinding?.runtime === "hmux_managed_v1"
			? useStore.getState().sessionAgentRuntimeState[
					currentAgent.runtimeBinding.sessionId
				]
			: undefined;
	const freshEligibility = freshCredentialSwitchEligibility(
		currentAgent,
		currentRuntime,
	);
	if (freshEligibility.eligible) {
		await withManagedCredentialSwitchTransition(agentId, () =>
			switchFreshManagedAgentCredential(agentId, targetCredentialId, panelId),
		);
		return { kind: "completed", conversationId: null };
	}
	const inspection = await inspectManagedAgentCredentialSwitch(
		agentId,
		targetCredentialId,
		panelId,
	);
	const stateBeforeRequest = useStore.getState();
	const runtime =
		stateBeforeRequest.sessionAgentRuntimeState[
			inspection.sourceBinding.sessionId
		];
	const existing = stateBeforeRequest.agents.find(
		(candidate) => candidate.id === inspection.agentId,
	)?.pendingCredentialSwitch;
	const requestId = nextRequestId();
	const intent = createDeferredCredentialSwitchIntent(
		inspection,
		runtime,
		requestId,
		Date.now(),
		{
			inputWorking: hasPendingLocalInput(
				inspection.agentId,
				inspection.sourceBinding.sessionId,
				stateBeforeRequest.agentActivity,
			),
		},
	);
	if (intent) {
		replaceIntent(inspection.agentId, intent);
		return { kind: "scheduled", conversationId: inspection.conversationId };
	}
	if (
		existing &&
		existing.targetCredentialId === inspection.targetCredentialId &&
		existing.panelId === inspection.panelId &&
		samePendingSource(existing, inspection)
	) {
		const retryIntent = {
			...existing,
			requestId,
			targetCredentialDirectory: inspection.targetAccount?.dir ?? null,
			lastError: undefined,
		};
		replaceIntent(inspection.agentId, retryIntent);
		const state = useStore.getState();
		const agent = state.agents.find(
			(candidate) => candidate.id === inspection.agentId,
		);
		if (!agent) throw new Error("deferred credential switch agent disappeared");
		const decision = evaluateDeferredCredentialSwitchIntent(
			retryIntent,
			agent,
			state.accounts,
			state.sessionAgentRuntimeState[retryIntent.sourceSessionId],
			{
				inputWorking: hasPendingLocalInput(
					inspection.agentId,
					retryIntent.sourceSessionId,
					state.agentActivity,
				),
			},
		);
		if (decision.kind === "ready") {
			await executeIntent(inspection.agentId, retryIntent);
			return { kind: "completed", conversationId: inspection.conversationId };
		}
		if (decision.kind === "rebaseline") {
			replaceIntent(inspection.agentId, decision.intent);
			return { kind: "scheduled", conversationId: inspection.conversationId };
		}
		if (decision.kind === "checkpoint") {
			replaceIntent(inspection.agentId, decision.intent);
			await executeIntent(inspection.agentId, decision.intent);
			return { kind: "completed", conversationId: inspection.conversationId };
		}
		if (decision.kind === "waiting") {
			return { kind: "scheduled", conversationId: inspection.conversationId };
		}
		markIntentError(
			inspection.agentId,
			retryIntent.requestId,
			new Error(decision.reason),
		);
		throw new Error(decision.reason);
	}
	await commitCredentialReplacement(inspection);
	return { kind: "completed", conversationId: inspection.conversationId };
}

export function cancelDeferredCredentialSwitch(
	agentId: string,
	requestId?: string,
): boolean {
	return clearIntent(agentId, requestId);
}

/** Persist the user's explicit permission to interrupt the current turn, then
 * run the same fenced replacement saga used by automatic completion. */
export async function applyDeferredCredentialSwitchNow(
	agentId: string,
	requestId?: string,
): Promise<void> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const intent = agent?.pendingCredentialSwitch;
	if (!agent || !intent) throw new Error("deferred_credential_switch_missing");
	if (requestId !== undefined && intent.requestId !== requestId) {
		throw new Error("deferred_credential_switch_cancelled");
	}
	const runtime = state.sessionAgentRuntimeState[intent.sourceSessionId];
	if (
		!runtime ||
		runtime.terminalEpoch !== intent.sourceTerminalEpoch ||
		(runtime.lifecycle !== "running" && runtime.lifecycle !== "exited") ||
		!isCanonicalDecimalString(runtime.revision) ||
		!isCanonicalDecimalString(runtime.turnCompletedCount)
	) {
		const error = new Error("deferred_credential_switch_runtime_unavailable");
		markIntentError(agentId, intent.requestId, error);
		throw error;
	}
	if (credentialSwitchExecutions.has(agentId)) {
		throw new Error("deferred_credential_switch_in_progress");
	}
	const immediateIntent: DeferredCredentialSwitchIntentV1 = {
		...intent,
		completionRuntimeRevision: runtime.revision,
		completionTurnCompletedCount: runtime.turnCompletedCount,
		completionReason: "user_requested",
		lastError: undefined,
	};
	credentialSwitchExecutions.add(agentId);
	replaceIntent(agentId, immediateIntent);
	try {
		await executeIntent(agentId, immediateIntent);
	} catch (error) {
		markIntentError(agentId, immediateIntent.requestId, error);
		throw error;
	} finally {
		credentialSwitchExecutions.delete(agentId);
	}
}

/** Main-window-only service. Durable intents survive reload; per-agent
 * in-flight ownership plus the persisted request fence suppress duplicate
 * runtime events and cross-turn retries. */
export function installDeferredCredentialSwitchWatch(): () => void {
	const inFlightAgentIds = credentialSwitchExecutions;
	const interruptedRetryAttempts = new Set<string>();
	let disposed = false;

	const handleFailure = (
		agentId: string,
		intent: DeferredCredentialSwitchIntentV1,
		error: unknown,
	) => {
		if (
			error instanceof DureAgentRuntimeSourceActiveError &&
			error.requestError.code === "agent_runtime_source_busy"
		) {
			const runtime =
				useStore.getState().sessionAgentRuntimeState[intent.sourceSessionId];
			if (runtime) {
				const decision = rebaselineIntent(intent, runtime);
				if (decision.kind === "rebaseline") {
					updateIntentIfCurrent(
						agentId,
						intent.requestId,
						() => decision.intent,
					);
					return;
				}
			}
		}
		if (error instanceof DeferredCredentialSwitchRaceError) {
			const decision = error.decision;
			if (decision.kind === "rebaseline" || decision.kind === "checkpoint") {
				updateIntentIfCurrent(agentId, intent.requestId, () => decision.intent);
				return;
			}
			if (decision.kind === "waiting" || decision.kind === "ready") return;
			error = new Error(decision.reason);
		}
		markIntentError(agentId, intent.requestId, error);
	};

	function recompute(): void {
		if (disposed) return;
		const state = useStore.getState();
		for (const agent of state.agents) {
			const intent = agent.pendingCredentialSwitch;
			if (!intent || inFlightAgentIds.has(agent.id)) continue;
			const runtime = state.sessionAgentRuntimeState[intent.sourceSessionId];
			const interruptedAfterSourceExit =
				intent.lastError !== undefined &&
				intent.completionRuntimeRevision !== undefined &&
				intent.completionTurnCompletedCount !== undefined &&
				runtime?.lifecycle === "exited";
			if (
				intent.lastError &&
				(!interruptedAfterSourceExit ||
					interruptedRetryAttempts.has(intent.requestId))
			) {
				continue;
			}
			if (interruptedAfterSourceExit) {
				// One attempt per watcher lifetime is enough to replay the backend's
				// exact journal after a reload/deploy, without turning a persistent
				// refusal into another reconnect loop.
				interruptedRetryAttempts.add(intent.requestId);
			}
			const decision = evaluateDeferredCredentialSwitchIntent(
				intent,
				agent,
				state.accounts,
				runtime,
				{
					inputWorking: hasPendingLocalInput(
						agent.id,
						intent.sourceSessionId,
						state.agentActivity,
					),
				},
			);
			if (decision.kind === "waiting") continue;
			if (decision.kind === "checkpoint") {
				updateIntentIfCurrent(
					agent.id,
					intent.requestId,
					() => decision.intent,
				);
				continue;
			}
			if (decision.kind === "rebaseline") {
				updateIntentIfCurrent(
					agent.id,
					intent.requestId,
					() => decision.intent,
				);
				continue;
			}
			if (decision.kind === "stale") {
				const error = new Error(decision.reason);
				markIntentError(agent.id, intent.requestId, error);
				continue;
			}

			inFlightAgentIds.add(agent.id);
			void executeIntent(agent.id, intent)
				.catch((error) => handleFailure(agent.id, intent, error))
				.finally(() => {
					inFlightAgentIds.delete(agent.id);
					recompute();
				});
		}
	}

	const unsubscribe = useStore.subscribe((state, previous) => {
		if (
			state.agents !== previous.agents ||
			state.accounts !== previous.accounts ||
			state.agentActivity !== previous.agentActivity ||
			state.sessionAgentRuntimeState !== previous.sessionAgentRuntimeState
		) {
			recompute();
		}
	});
	const unsubscribeAttention = useAgentAttention.subscribe(
		(state, previous) => {
			if (state.armedCompletions !== previous.armedCompletions) recompute();
		},
	);
	recompute();
	return () => {
		disposed = true;
		interruptedRetryAttempts.clear();
		unsubscribe();
		unsubscribeAttention();
	};
}
