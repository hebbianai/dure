import {
	type AgentExecutionProfileV1,
	sameAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import type {
	AgentRuntimeInteractionProfileV1,
	DureAgentRuntimeLaunchSelectionTargetV1,
	DureAgentRuntimeLaunchSelectionV1,
	DureAgentRuntimeRepairIntentV1,
	DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { sameDureBackendRouteAuthority } from "@/lib/ipc/dureBackendRoute";

export type AgentRuntimeRepairExecutionTargetV1 =
	| {
			readonly kind: "profile";
			readonly profile: AgentExecutionProfileV1;
	  }
	| {
			readonly kind: "credential";
			readonly referenceId: string | null;
			readonly preparedProfile?: AgentExecutionProfileV1;
	  };

interface AgentRuntimeRepairCredentialTargetV1 {
	readonly targetCredentialId: string | null;
}

export function agentRuntimeRepairExecutionTarget(
	targetExecutionProfile: AgentExecutionProfileV1 | undefined,
	credentialTarget: AgentRuntimeRepairCredentialTargetV1 | undefined,
	preparedProfile?: AgentExecutionProfileV1,
): AgentRuntimeRepairExecutionTargetV1 | undefined {
	if (credentialTarget) {
		return {
			kind: "credential",
			referenceId: credentialTarget.targetCredentialId,
			...(preparedProfile ? { preparedProfile } : {}),
		};
	}
	return targetExecutionProfile
		? { kind: "profile", profile: targetExecutionProfile }
		: undefined;
}

export interface AgentRuntimeRepairTargetV1 {
	readonly agentId: string;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly expectedSourceRevision?: number;
	readonly interactionProfile: AgentRuntimeInteractionProfileV1;
	readonly execution?: AgentRuntimeRepairExecutionTargetV1;
	readonly launchSelection?: DureAgentRuntimeLaunchSelectionTargetV1;
}

interface AgentRuntimeRepairExpectedTargetV1 {
	readonly interactionProfile: AgentRuntimeInteractionProfileV1;
	readonly executionProfile: AgentExecutionProfileV1;
	readonly launchSelection: DureAgentRuntimeLaunchSelectionV1;
}

export type AgentRuntimeReplacementTargetV1 =
	| { readonly kind: "prepare_execution_profile" }
	| {
			readonly kind: "ready";
			readonly target: AgentRuntimeRepairExpectedTargetV1;
	  };

export type PreparedAgentRuntimeReplacementTargetV1 = Extract<
	AgentRuntimeReplacementTargetV1,
	{ kind: "ready" }
>;

function sameLaunchSelection(
	left: DureAgentRuntimeLaunchSelectionV1,
	right: DureAgentRuntimeLaunchSelectionV1,
): boolean {
	return (
		left.model === right.model &&
		left.effort === right.effort &&
		left.permissionMode === right.permissionMode
	);
}

function requestedLaunchSelection(
	required: DureAgentRuntimeRepairIntentV1,
	requested: DureAgentRuntimeLaunchSelectionTargetV1 | undefined,
): DureAgentRuntimeLaunchSelectionV1 {
	if (!requested) return required.sourceLaunchSelection;
	return {
		model: requested.model,
		effort: requested.effort,
		permissionMode:
			requested.permissionMode ?? required.sourceLaunchSelection.permissionMode,
	};
}

function executionReference(profile: AgentExecutionProfileV1): string | null {
	return profile.kind === "credential_reference" ? profile.reference_id : null;
}

function sameExecutionIdentity(
	left: AgentExecutionProfileV1,
	right: AgentExecutionProfileV1,
): boolean {
	if (left.kind === "provider_default") {
		return right.kind === "provider_default";
	}
	return (
		right.kind === "credential_reference" &&
		left.reference_id === right.reference_id
	);
}

function mustRefreshCredential(
	required: DureAgentRuntimeRepairIntentV1,
): boolean {
	return (
		required.failureKind === "credential_stale" ||
		required.failureKind === "credential_unavailable"
	);
}

function requestedExecutionProfile(
	required: DureAgentRuntimeRepairIntentV1,
	target: AgentRuntimeRepairTargetV1,
): AgentExecutionProfileV1 | "prepare" {
	const execution = target.execution;
	if (!execution) {
		return mustRefreshCredential(required) &&
			sameExecutionIdentity(
				required.sourceExecutionProfile,
				required.targetExecutionProfile,
			)
			? "prepare"
			: required.sourceExecutionProfile;
	}
	if (execution.kind === "profile") return execution.profile;
	if (execution.preparedProfile) return execution.preparedProfile;
	if (
		executionReference(required.targetExecutionProfile) ===
			execution.referenceId &&
		!mustRefreshCredential(required)
	) {
		return required.targetExecutionProfile;
	}
	return "prepare";
}

/** Resolves credential material and the user's desired target. The backend
 * owns how a stopped transition is replaced; this does not select a retry or
 * supersede algorithm. */
export function resolveAgentRuntimeReplacementTarget(
	required: DureAgentRuntimeRepairIntentV1,
	target: AgentRuntimeRepairTargetV1,
): AgentRuntimeReplacementTargetV1 | undefined {
	if (
		required.agentId !== target.agentId ||
		!sameDureBackendRouteAuthority(
			required.routeAuthority,
			target.routeAuthority,
		) ||
		(target.expectedSourceRevision !== undefined &&
			required.sourceSelectionRevision !== target.expectedSourceRevision)
	) {
		return undefined;
	}

	const executionProfile = requestedExecutionProfile(required, target);
	if (executionProfile === "prepare") {
		return { kind: "prepare_execution_profile" };
	}
	const expected = {
		interactionProfile: target.interactionProfile,
		executionProfile,
		launchSelection: requestedLaunchSelection(required, target.launchSelection),
	};
	return { kind: "ready", target: expected };
}

export function agentRuntimeReplacementResultMatches(
	required: DureAgentRuntimeRepairIntentV1,
	plan: PreparedAgentRuntimeReplacementTargetV1,
	result: DureAgentRuntimeTransitionResultV1,
): boolean {
	return (
		result.agentId === required.agentId &&
		result.selectionRevision > required.sourceSelectionRevision &&
		sameDureBackendRouteAuthority(
			result.routeAuthority,
			required.routeAuthority,
		) &&
		result.interactionProfile === plan.target.interactionProfile &&
		sameAgentExecutionProfileV1(
			result.executionProfile,
			plan.target.executionProfile,
		) &&
		sameLaunchSelection(result.launchSelection, plan.target.launchSelection)
	);
}
