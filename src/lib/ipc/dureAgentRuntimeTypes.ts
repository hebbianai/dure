import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/agents/agentRuntimeLaunchSelectionTypes";
import type {
	AgentExecutionProfileV1,
	AgentInteractionBindingV1,
} from "@/lib/agents/chat/agentConversationContract";
import type { Provider } from "@/lib/agents/providerContracts";
import type { HmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { DureBackendIdentity } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import type {
	ProviderPermissionMode,
	RuntimeInteractionProfile,
	RuntimeLaunchSelectionTarget,
	RuntimeProjectionContextV1,
	RuntimeSourceStopPolicy,
} from "../../../cli/lib/contracts/agent-runtime.mjs";

export type AgentRuntimeInteractionProfileV1 = RuntimeInteractionProfile;

interface RuntimeTransitionProjectionV1 {
	agentId: string;
	providerId: Provider;
	executionProfile: AgentExecutionProfileV1;
	providerConversationRef: string | null;
	launchSelection: DureAgentRuntimeLaunchSelectionV1;
}

export interface StructuredRuntimeTransitionProjectionV1
	extends RuntimeTransitionProjectionV1 {
	interactionProfile: "structured_protocol";
	interactionSessionId: string;
	/** Present on authoritative inspect/transition receipts from current
	 * backends. Optional only for rolling typed consumers of older receipts. */
	binding?: AgentInteractionBindingV1;
}

export interface NativeRuntimeTransitionProjectionV1
	extends RuntimeTransitionProjectionV1 {
	interactionProfile: "native_cli";
	sessionId: string;
	workspaceId: string;
	launchIdempotencyKey: string | null;
	stopFence: HmuxManagedGenerationV1;
}

export type AgentRuntimeTransitionProjectionV1 =
	| StructuredRuntimeTransitionProjectionV1
	| NativeRuntimeTransitionProjectionV1;

export type DureAgentRuntimeSourceStopPolicyV1 = RuntimeSourceStopPolicy;

export type DureProviderPermissionModeV1 = ProviderPermissionMode;

export type DureAgentRuntimeProjectionContextV1 =
	RuntimeProjectionContextV1<Provider>;

/** Transition target: null model/effort clear to the provider default; an
 * omitted permissionMode inherits the committed one. */
export type DureAgentRuntimeLaunchSelectionTargetV1 =
	RuntimeLaunchSelectionTarget;

export type DureAgentRuntimeTransitionResultV1 =
	AgentRuntimeTransitionProjectionV1 & {
		backend: DureBackendIdentity;
		backendProfileId: string;
		routeAuthority: DureBackendRouteAuthorityV1;
		selectionRevision: number;
	};

type AgentRuntimeTransitionStageV1 =
	| "admitted"
	| "source_stopped"
	| "target_started";

export type DureAgentRuntimeTargetFailureKindV1 =
	| "target_invalid"
	| "runtime_unavailable"
	| "credential_unavailable"
	| "credential_stale"
	| "launch_failed"
	| "identity_mismatch"
	| "authority_publish_failed";

export interface DureAgentRuntimeSourceSnapshotV1 {
	readonly selectionRevision: number;
	readonly interactionProfile: AgentRuntimeInteractionProfileV1;
	readonly launchSelection: DureAgentRuntimeLaunchSelectionV1;
}

interface DureAgentRuntimeRepairRequiredV1
	extends RuntimeTransitionObservationV1 {
	state: "repair_required";
	failureKind: DureAgentRuntimeTargetFailureKindV1;
	providerCode: string;
}

export interface DureAgentRuntimeIntentSelectionV1 {
	sourceSelectionRevision: number;
	sourceInteractionProfile: AgentRuntimeInteractionProfileV1;
	sourceExecutionProfile: AgentExecutionProfileV1;
	sourceLaunchSelection: DureAgentRuntimeLaunchSelectionV1;
	targetLaunchSelection: DureAgentRuntimeLaunchSelectionV1;
}

export interface DureAgentRuntimeRepairIntentV1
	extends DureAgentRuntimeRepairRequiredV1,
		DureAgentRuntimeIntentSelectionV1 {}

export type DureAgentRuntimeTransitionIntentV1 =
	DureAgentRuntimeRepairCandidateV1 & DureAgentRuntimeIntentSelectionV1;

interface RuntimeTransitionObservationV1 {
	agentId: string;
	operationId: string;
	journalRevision: number;
	targetInteractionProfile: AgentRuntimeInteractionProfileV1;
	targetExecutionProfile: AgentExecutionProfileV1;
	backend: DureBackendIdentity;
	backendProfileId: string;
	routeAuthority: DureBackendRouteAuthorityV1;
}

export type DureAgentRuntimeInspectResultV1 =
	| {
			state: "unmanaged";
			agentId: string;
			backend: DureBackendIdentity;
			backendProfileId: string;
			routeAuthority: DureBackendRouteAuthorityV1;
	  }
	| {
			state: "closed";
			agentId: string;
			operationId: string;
			stage: "admitted" | "stopped";
			/** Present on current backends. Their absence identifies a rolling
			 * legacy backend whose closed source cannot yet be restarted safely. */
			source?: DureAgentRuntimeSourceSnapshotV1;
			backend: DureBackendIdentity;
			backendProfileId: string;
			routeAuthority: DureBackendRouteAuthorityV1;
	  }
	| (RuntimeTransitionObservationV1 &
			(
				| { state: "transitioning"; stage: AgentRuntimeTransitionStageV1 }
				| { state: "dormant"; stage: "source_stopped" }
			))
	| DureAgentRuntimeRepairRequiredV1
	| ({ state: "stable" } & DureAgentRuntimeTransitionResultV1);

type DureAgentRuntimeAdmittedTransitionV1 = Extract<
	DureAgentRuntimeInspectResultV1,
	{ state: "transitioning" }
> & { stage: "admitted" };

export type DureAgentRuntimeRepairCandidateV1 =
	| DureAgentRuntimeRepairRequiredV1
	| DureAgentRuntimeAdmittedTransitionV1;

export type DureAgentRuntimeProjectionInspectResultV1 =
	| Extract<DureAgentRuntimeInspectResultV1, { state: "unmanaged" }>
	| (Extract<DureAgentRuntimeInspectResultV1, { state: "closed" }> & {
			projectionContext?: DureAgentRuntimeProjectionContextV1;
	  })
	| (Extract<
			DureAgentRuntimeInspectResultV1,
			{ state: "transitioning" | "dormant" | "repair_required" }
	  > & {
			projectionContext: DureAgentRuntimeProjectionContextV1;
	  })
	| ({
			state: "stable";
			projectionContext: DureAgentRuntimeProjectionContextV1;
	  } & DureAgentRuntimeTransitionResultV1);
