import {
	compareCanonicalDecimalStrings,
	isCanonicalDecimalString,
} from "@/lib/decimalString";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { nonEmptyString } from "@/lib/payloadGuards";
import type { ManagedAgentCredentialSwitchInspection } from "@/lib/sessions/managed/managedAgentInspectionTypes";
import type {
	AccountProfile,
	Agent,
	DeferredCredentialSwitchIntentV1,
} from "@/types";
import {
	isProviderEffortSelection,
	isProviderModelSelection,
} from "../../../../cli/lib/contracts/provider-launch-selection.mjs";

export type DeferredCredentialSwitchDecision =
	| { kind: "waiting" }
	| { kind: "ready" }
	| { kind: "checkpoint"; intent: DeferredCredentialSwitchIntentV1 }
	| { kind: "rebaseline"; intent: DeferredCredentialSwitchIntentV1 }
	| { kind: "stale"; reason: string };

/** Reject malformed durable data rather than letting a partial replacement
 * request cross the provider-stop boundary. */
export function normalizeDeferredCredentialSwitchIntent(
	value: unknown,
): DeferredCredentialSwitchIntentV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const intent = value as Partial<DeferredCredentialSwitchIntentV1>;
	const targetCredentialId = intent.targetCredentialId;
	const targetCredentialDirectory = intent.targetCredentialDirectory;
	const sourceCredentialId = intent.sourceCredentialId;
	const sourceCreateIdempotencyKey = intent.sourceCreateIdempotencyKey;
	const sourceCredentialGeneration = intent.sourceCredentialGeneration;
	const completionRuntimeRevision = intent.completionRuntimeRevision;
	const completionTurnCompletedCount = intent.completionTurnCompletedCount;
	const completionReason = intent.completionReason;
	const launch = intent.targetLaunchSelection;
	if (
		intent.schemaVersion !== 1 ||
		(launch !== undefined &&
			(!launch ||
				typeof launch !== "object" ||
				Array.isArray(launch) ||
				intent.sourceSelectionRevision === undefined ||
				!(launch.model === null || isProviderModelSelection(launch.model)) ||
				!(launch.effort === null || isProviderEffortSelection(launch.effort)) ||
				!["default", "auto_edit", "skip_permissions"].includes(
					launch.permissionMode,
				))) ||
		!nonEmptyString(intent.requestId) ||
		!(targetCredentialId === null || nonEmptyString(targetCredentialId)) ||
		!(
			targetCredentialDirectory === null ||
			nonEmptyString(targetCredentialDirectory)
		) ||
		(targetCredentialId === null) !== (targetCredentialDirectory === null) ||
		!nonEmptyString(intent.sourceSessionId) ||
		!nonEmptyString(intent.sourceWorkspaceId) ||
		!nonEmptyString(intent.sourceConversationId) ||
		!(sourceCredentialId === null || nonEmptyString(sourceCredentialId)) ||
		!(
			sourceCreateIdempotencyKey === null ||
			nonEmptyString(sourceCreateIdempotencyKey)
		) ||
		!(
			sourceCredentialGeneration === null ||
			(typeof sourceCredentialGeneration === "number" &&
				Number.isSafeInteger(sourceCredentialGeneration) &&
				sourceCredentialGeneration >= 0)
		) ||
		!nonEmptyString(intent.sourceTerminalEpoch) ||
		!(
			intent.sourceSelectionRevision === undefined ||
			(Number.isSafeInteger(intent.sourceSelectionRevision) &&
				intent.sourceSelectionRevision >= 0)
		) ||
		!isCanonicalDecimalString(intent.baselineRuntimeRevision) ||
		!isCanonicalDecimalString(intent.baselineTurnCompletedCount) ||
		(completionRuntimeRevision === undefined) !==
			(completionTurnCompletedCount === undefined) ||
		(completionReason !== undefined &&
			completionRuntimeRevision === undefined) ||
		!(
			completionRuntimeRevision === undefined ||
			isCanonicalDecimalString(completionRuntimeRevision)
		) ||
		!(
			completionTurnCompletedCount === undefined ||
			isCanonicalDecimalString(completionTurnCompletedCount)
		) ||
		!(
			completionReason === undefined || completionReason === "user_requested"
		) ||
		!nonEmptyString(intent.panelId) ||
		typeof intent.requestedAtMs !== "number" ||
		!Number.isFinite(intent.requestedAtMs) ||
		intent.requestedAtMs < 0 ||
		!(intent.lastError === undefined || nonEmptyString(intent.lastError))
	) {
		return undefined;
	}
	return {
		...(intent as DeferredCredentialSwitchIntentV1),
		...(launch ? { targetLaunchSelection: { ...launch } } : {}),
	};
}

function managedCredentialReplacementHasActiveTurn(
	runtime: HmuxAgentRuntimeState,
	inputWorking = false,
): boolean {
	return (
		inputWorking ||
		runtime.activity === "working" ||
		runtime.attention === "approval_required"
	);
}

export function isAuthoritativeIdleRuntimeState(
	runtime: HmuxAgentRuntimeState,
): boolean {
	return (
		runtime.lifecycle === "running" &&
		runtime.activity === "waiting" &&
		(runtime.source === "provider_event" ||
			runtime.source === "orchestration_event") &&
		runtime.attention === "none" &&
		runtime.attentionId == null
	);
}

/** Build a durable intent only when this Host can prove the end of the active
 * turn. Older Hosts and already-idle providers retain the immediate path. */
export function createDeferredCredentialSwitchIntent(
	inspection: ManagedAgentCredentialSwitchInspection,
	runtime: HmuxAgentRuntimeState | undefined,
	requestId: string,
	requestedAtMs: number,
	options?: { inputWorking?: boolean },
): DeferredCredentialSwitchIntentV1 | null {
	if (
		runtime?.lifecycle !== "running" ||
		!isCanonicalDecimalString(runtime.revision) ||
		!isCanonicalDecimalString(runtime.turnCompletedCount) ||
		!managedCredentialReplacementHasActiveTurn(runtime, options?.inputWorking)
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		requestId,
		targetCredentialId: inspection.targetCredentialId,
		targetCredentialDirectory: inspection.targetAccount?.dir ?? null,
		sourceSessionId: inspection.sourceBinding.sessionId,
		sourceWorkspaceId: inspection.sourceBinding.workspaceId,
		sourceConversationId: inspection.conversationId,
		sourceCredentialId: inspection.sourceCredentialId ?? null,
		sourceCreateIdempotencyKey:
			inspection.sourceBinding.createIdempotencyKey ?? null,
		sourceCredentialGeneration:
			inspection.sourceBinding.credentialGeneration ?? null,
		sourceTerminalEpoch: runtime.terminalEpoch,
		baselineRuntimeRevision: runtime.revision,
		baselineTurnCompletedCount: runtime.turnCompletedCount,
		panelId: inspection.panelId,
		requestedAtMs,
	};
}

function sourceFenceError(
	intent: DeferredCredentialSwitchIntentV1,
	agent: Agent,
): string | undefined {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		return "source_runtime_changed";
	}
	if (
		agent.sessionId !== intent.sourceSessionId ||
		binding.sessionId !== intent.sourceSessionId
	) {
		return "source_session_changed";
	}
	if (binding.workspaceId !== intent.sourceWorkspaceId) {
		return "source_workspace_changed";
	}
	if ((agent.conversationId?.trim() ?? null) !== intent.sourceConversationId) {
		return "source_conversation_changed";
	}
	if (
		(binding.credentialId ?? agent.credentialId ?? null) !==
		intent.sourceCredentialId
	) {
		return "source_credential_changed";
	}
	if (
		(binding.createIdempotencyKey ?? null) !== intent.sourceCreateIdempotencyKey
	) {
		return "source_creation_changed";
	}
	if (
		(binding.credentialGeneration ?? null) !== intent.sourceCredentialGeneration
	) {
		return "source_credential_generation_changed";
	}
	return undefined;
}

function targetFenceError(
	intent: DeferredCredentialSwitchIntentV1,
	agent: Agent,
	accounts: readonly AccountProfile[],
): string | undefined {
	if (intent.targetCredentialId === null) {
		return intent.targetCredentialDirectory === null
			? undefined
			: "target_credential_changed";
	}
	const account = accounts.find(
		(candidate) =>
			candidate.id === intent.targetCredentialId &&
			candidate.provider === agent.provider,
	);
	return account?.dir === intent.targetCredentialDirectory
		? undefined
		: "target_credential_changed";
}

/** The current Host projection selects a candidate boundary; the Host still
 * atomically checks conversation, generation, output and drafts before stop.
 * Neither silent output nor a successful-turn counter proves quiescence. */
export function evaluateDeferredCredentialSwitchIntent(
	intent: DeferredCredentialSwitchIntentV1,
	agent: Agent,
	accounts: readonly AccountProfile[],
	runtime: HmuxAgentRuntimeState | undefined,
	options?: {
		inputWorking?: boolean;
	},
): DeferredCredentialSwitchDecision {
	const sourceError = sourceFenceError(intent, agent);
	if (sourceError) return { kind: "stale", reason: sourceError };
	const targetError = targetFenceError(intent, agent, accounts);
	if (targetError) return { kind: "stale", reason: targetError };
	// Runtime projection arrives after durable Zustand hydration during reload.
	if (!runtime) return { kind: "waiting" };
	if (runtime.terminalEpoch !== intent.sourceTerminalEpoch) {
		return { kind: "stale", reason: "source_terminal_epoch_changed" };
	}
	if (
		!isCanonicalDecimalString(runtime.revision) ||
		!isCanonicalDecimalString(runtime.turnCompletedCount)
	) {
		return { kind: "stale", reason: "completion_signal_unavailable" };
	}
	const baselineOrdering = compareCanonicalDecimalStrings(
		runtime.turnCompletedCount,
		intent.baselineTurnCompletedCount,
	);
	if (baselineOrdering < 0) {
		return { kind: "stale", reason: "completion_counter_reset" };
	}
	const checkpointRevision = intent.completionRuntimeRevision;
	const checkpointCount = intent.completionTurnCompletedCount;
	const checkpointReason = intent.completionReason;
	if (runtime.lifecycle === "exited") {
		return checkpointRevision !== undefined &&
			checkpointCount !== undefined &&
			compareCanonicalDecimalStrings(
				runtime.turnCompletedCount,
				checkpointCount,
			) >= 0
			? { kind: "ready" }
			: { kind: "stale", reason: "source_provider_exited" };
	}
	if (runtime.lifecycle !== "running") {
		return { kind: "stale", reason: "source_provider_unavailable" };
	}
	if (
		checkpointReason === "user_requested" &&
		checkpointRevision !== undefined &&
		checkpointCount !== undefined
	) {
		return { kind: "ready" };
	}
	if (
		checkpointCount !== undefined &&
		compareCanonicalDecimalStrings(
			runtime.turnCompletedCount,
			checkpointCount,
		) < 0
	) {
		return { kind: "stale", reason: "completion_checkpoint_reset" };
	}
	if (
		checkpointRevision !== undefined &&
		compareCanonicalDecimalStrings(runtime.revision, checkpointRevision) < 0
	) {
		return { kind: "stale", reason: "completion_checkpoint_revision_reset" };
	}
	// A busy refusal rebaselines here, so the same snapshot cannot cause a
	// retry loop. A real later idle event also covers interrupted/failed turns.
	if (
		compareCanonicalDecimalStrings(
			runtime.revision,
			intent.baselineRuntimeRevision,
		) <= 0
	) {
		return { kind: "waiting" };
	}
	if (!isAuthoritativeIdleRuntimeState(runtime)) {
		if (
			runtime.activity === "working" &&
			(baselineOrdering > 0 || checkpointRevision !== undefined)
		) {
			return rebaselineIntent(intent, runtime);
		}
		return { kind: "waiting" };
	}
	if (
		checkpointRevision !== runtime.revision ||
		checkpointCount !== runtime.turnCompletedCount
	) {
		return checkpointIntent(intent, runtime);
	}
	// The Host completion and the frontend working→waiting projection are
	// separate store writes. Preserve the exact checkpoint while the local bit
	// catches up. Genuine later input advances the Host revision and is handled
	// by the rebaseline branch above.
	if (options?.inputWorking && baselineOrdering > 0) {
		return { kind: "waiting" };
	}
	return { kind: "ready" };
}

function checkpointIntent(
	intent: DeferredCredentialSwitchIntentV1,
	runtime: HmuxAgentRuntimeState,
	completionReason?: DeferredCredentialSwitchIntentV1["completionReason"],
): DeferredCredentialSwitchDecision {
	if (!isCanonicalDecimalString(runtime.turnCompletedCount)) {
		return { kind: "stale", reason: "completion_signal_unavailable" };
	}
	return {
		kind: "checkpoint",
		intent: {
			...intent,
			completionRuntimeRevision: runtime.revision,
			completionTurnCompletedCount: runtime.turnCompletedCount,
			...(completionReason ? { completionReason } : {}),
			lastError: undefined,
		},
	};
}

export function rebaselineIntent(
	intent: DeferredCredentialSwitchIntentV1,
	runtime: HmuxAgentRuntimeState,
): DeferredCredentialSwitchDecision {
	if (!isCanonicalDecimalString(runtime.turnCompletedCount)) {
		return { kind: "stale", reason: "completion_signal_unavailable" };
	}
	const {
		completionRuntimeRevision: _completionRuntimeRevision,
		completionTurnCompletedCount: _completionTurnCompletedCount,
		completionReason: _completionReason,
		...pending
	} = intent;
	return {
		kind: "rebaseline",
		intent: {
			...pending,
			baselineRuntimeRevision: runtime.revision,
			baselineTurnCompletedCount: runtime.turnCompletedCount,
			lastError: undefined,
		},
	};
}
