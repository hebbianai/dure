import { t } from "@/lib/i18n";
import {
	type DureAgentRuntimeLaunchSelectionTargetV1,
	type DureAgentRuntimeLaunchSelectionV1,
	DureAgentRuntimeSourceActiveError,
	type DureAgentRuntimeTransitionResultV1,
	type DureProviderPermissionModeV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { PaneActionExecution } from "@/lib/workspace/pane/paneAction";

export interface AgentRuntimeLaunchFailure {
	readonly detail: string;
	readonly message: string;
}

/** Preserve the backend's known refusal instead of presenting it as an unknown commit. */
export function agentRuntimeLaunchFailure(
	error: unknown,
): AgentRuntimeLaunchFailure {
	return {
		detail: error instanceof Error ? error.message : String(error),
		message:
			error instanceof DureAgentRuntimeSourceActiveError
				? error.message
				: t("agents.runtime.switchFailed"),
	};
}

/** Computes one target from the exact source selection read at action time.
 * Native panes can therefore expose controls without inspecting on mount or
 * guessing the values of fields the user did not change. */
export type AgentRuntimeLaunchSelectionUpdateV1 = (
	source: DureAgentRuntimeLaunchSelectionV1,
) => DureAgentRuntimeLaunchSelectionTargetV1;

/** Read-only pane projection plus the one controller-owned selection action. */
export interface AgentRuntimeLaunchSelectionView {
	/** Committed runtime/conversation recipient; not a revision or execution capability. */
	readonly ownerKey: string | undefined;
	readonly paneId?: string;
	readonly selectionRevision?: number;
	readonly conversationId?: string;
	readonly loaded: boolean;
	readonly hydrationError: boolean;
	readonly model: string | null;
	readonly effort: string | null;
	readonly permissionMode: DureProviderPermissionModeV1;
	readonly switching: boolean;
	readonly error: string | null;
	readonly errorMessage?: string;
	readonly pending?: {
		requestId: string;
		selection: DureAgentRuntimeLaunchSelectionV1;
		error?: string;
	};
	cancelPending?(): boolean;
	applyPendingNow?(): Promise<void>;
	switchSelection(
		update: AgentRuntimeLaunchSelectionUpdateV1,
		expected?: AgentRuntimeLaunchExpectation,
	): Promise<PaneActionExecution>;
	retryHydration(): void;
	dismissError(): void;
}

export interface AgentRuntimeLaunchExpectation {
	readonly expectedSourceRevision?: number;
	readonly expectedConversationId?: string;
}

/** Public action result, projected from the authoritative commit without
 * exposing execution profiles or backend route capabilities. */
export function agentRuntimeLaunchApplied(
	result: DureAgentRuntimeTransitionResultV1,
	sourceRevision?: number,
): PaneActionExecution {
	return {
		outcome:
			result.selectionRevision === sourceRevision ? "unchanged" : "applied",
		value: {
			agentId: result.agentId,
			conversationId: result.providerConversationRef ?? null,
			sessionId:
				result.interactionProfile === "native_cli"
					? result.sessionId
					: result.interactionSessionId,
			selectionRevision: result.selectionRevision,
			interactionProfile: result.interactionProfile,
			settings: result.launchSelection,
		},
	};
}

export function agentRuntimeLaunchRejected(
	error: unknown,
): PaneActionExecution {
	const retained = error instanceof DureAgentRuntimeSourceActiveError;
	return {
		outcome: retained ? "refused" : "failed",
		error: {
			code: retained
				? error.requestError.code
				: "agent_runtime_switch_unconfirmed",
			message: error instanceof Error ? error.message : String(error),
			retryable: retained,
			nextAction: retained
				? "Inspect the current pane before requesting another change."
				: "Inspect the current runtime before retrying; the outcome is not confirmed.",
		},
	};
}

export function resolveAgentRuntimeLaunchSelectionUpdate(
	update: AgentRuntimeLaunchSelectionUpdateV1,
	source: DureAgentRuntimeLaunchSelectionV1,
): DureAgentRuntimeLaunchSelectionTargetV1 {
	return update(source);
}
