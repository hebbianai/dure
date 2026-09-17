import type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/agents/agentRuntimeLaunchSelectionTypes";

export type { DureAgentRuntimeLaunchSelectionV1 } from "@/lib/agents/agentRuntimeLaunchSelectionTypes";

import type {
	AgentRuntimeInteractionProfileV1,
	DureAgentRuntimeIntentSelectionV1,
	DureAgentRuntimeProjectionContextV1,
	DureAgentRuntimeProjectionInspectResultV1,
	DureAgentRuntimeRepairCandidateV1,
	DureAgentRuntimeSourceSnapshotV1,
	DureAgentRuntimeTargetFailureKindV1,
	DureAgentRuntimeTransitionResultV1,
	DureProviderPermissionModeV1,
} from "./dureAgentRuntimeTypes";

export type {
	AgentRuntimeInteractionProfileV1,
	AgentRuntimeTransitionProjectionV1,
	DureAgentRuntimeInspectResultV1,
	DureAgentRuntimeLaunchSelectionTargetV1,
	DureAgentRuntimeProjectionContextV1,
	DureAgentRuntimeProjectionInspectResultV1,
	DureAgentRuntimeRepairIntentV1,
	DureAgentRuntimeSourceStopPolicyV1,
	DureAgentRuntimeTransitionIntentV1,
	DureAgentRuntimeTransitionResultV1,
	DureProviderPermissionModeV1,
	NativeRuntimeTransitionProjectionV1,
	StructuredRuntimeTransitionProjectionV1,
} from "./dureAgentRuntimeTypes";

import {
	type AgentExecutionProfileV1,
	isAgentCredentialReferenceV1,
	parseAgentExecutionProfileV1,
	parseAgentInteractionBindingV1,
	sameAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import { PROVIDER_IDS } from "@/lib/agents/providerCatalog";
import type { HmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { parseHmuxManagedGenerationV1 } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { t } from "@/lib/i18n";
import {
	createRuntimeObservationClient,
	type DureAgentRuntimeObservationClient,
} from "@/lib/ipc/dureAgentRuntimeObservationClient";
import {
	createDureBackendRequester,
	DureBackendAuthorityFence,
	type DureBackendIdentity,
	type DureBackendInvoke,
	DureBackendRequestError,
} from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	isDureBackendProfileIdV1,
	isDureDomainIdV1,
} from "@/lib/ipc/dureProtocolIdentity";
import {
	nonEmptyString,
	nonNegativeInteger,
	positiveInteger,
	asRecord as record,
} from "@/lib/payloadGuards";
import type { Provider } from "@/types";
import {
	agentRuntimeTransitionBody,
	agentRuntimeWakeTarget,
	parseAgentRuntimeInspectionEnvelope,
	parseAgentRuntimeTransitionEnvelope,
	type RuntimeProjectionContextV1,
	type RuntimeReceiptEnvelope,
	type RuntimeTransitionIntent,
	hasRequiredRuntimeFields as requiredFields,
} from "../../../cli/lib/contracts/agent-runtime.mjs";
import {
	isProviderEffortSelection,
	isProviderModelSelection,
} from "../../../cli/lib/contracts/provider-launch-selection.mjs";

const PROVIDER_DIAGNOSTIC_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

/** The selected source still owns active work or retained input. Destructive
 * replacement requires a fresh transition with explicit discard authority. */
export class DureAgentRuntimeSourceActiveError extends Error {
	readonly condition = "source_active" as const;

	constructor(
		readonly requestError: DureBackendRequestError,
		readonly expectedSourceRevision?: number,
	) {
		super(
			t(
				requestError.code === "agent_runtime_source_retained"
					? "agents.runtime.sourceRetained"
					: "agents.runtime.sourceActive",
			),
		);
		this.name = "DureAgentRuntimeSourceActiveError";
	}
}

function normalizeTransitionError(error: unknown): unknown {
	if (!(error instanceof DureBackendRequestError)) return error;
	if (
		error.code === "agent_runtime_source_busy" ||
		error.code === "agent_runtime_source_retained"
	) {
		return new DureAgentRuntimeSourceActiveError(error);
	}
	if (error.code === "agent_runtime_structured_profile_unavailable") {
		const detail = error.details?.detail;
		const message =
			typeof detail === "string" &&
			detail.length <= 512 &&
			!/\p{Cc}/u.test(detail)
				? detail
				: t("agents.runtime.chatUnavailable");
		return new DureBackendRequestError(
			error.code,
			message,
			error.failure,
			error.details,
		);
	}
	return error;
}

interface DureAgentRuntimeTransitionRequestV1
	extends RuntimeTransitionIntent<AgentExecutionProfileV1> {
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

export interface DureAgentRuntimeClient
	extends DureAgentRuntimeObservationClient {
	inspectTransitionIntent<Candidate extends DureAgentRuntimeRepairCandidateV1>(
		required: Candidate,
	): Promise<Candidate & DureAgentRuntimeIntentSelectionV1>;
	transition(
		request: DureAgentRuntimeTransitionRequestV1,
	): Promise<DureAgentRuntimeTransitionResultV1>;
	reconcileNativeRehost(
		request: DureAgentRuntimeNativeRehostRequestV1,
	): Promise<DureAgentRuntimeTransitionResultV1>;
	publishNativeResume(
		request: DureAgentRuntimeNativeResumeRequestV1,
	): Promise<DureAgentRuntimeTransitionResultV1>;
	stop(
		agentId: string,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
	remove(
		agentId: string,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void>;
}

interface DureAgentRuntimeNativeRehostRequestV1 {
	readonly agentId: string;
	readonly operationId: string;
	readonly providerId: Provider;
	readonly targetCredential:
		| { readonly kind: "provider_default" }
		| {
				readonly kind: "credential_reference";
				readonly referenceId: string;
		  };
	readonly source: HmuxManagedGenerationV1 & {
		readonly sessionId: string;
		readonly workspaceId: string;
	};
	readonly target: HmuxManagedGenerationV1 & {
		readonly sessionId: string;
		readonly workspaceId: string;
	};
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

interface DureAgentRuntimeNativeResumeRequestV1 {
	readonly agentId: string;
	readonly operationId: string;
	readonly providerId: Provider;
	readonly targetCredential:
		| { readonly kind: "provider_default" }
		| {
				readonly kind: "credential_reference";
				readonly referenceId: string;
		  };
	readonly providerConversationRef: string;
	readonly permissionMode: DureProviderPermissionModeV1;
	readonly launchIdempotencyKey: string;
	readonly target: HmuxManagedGenerationV1 & {
		readonly sessionId: string;
		readonly workspaceId: string;
	};
	readonly routeAuthority: DureBackendRouteAuthorityV1;
}

function parseInspectedLaunchSelection(
	value: unknown,
): DureAgentRuntimeLaunchSelectionV1 | undefined {
	const selection = record(value);
	if (
		!selection ||
		!requiredFields(
			selection,
			["permissionMode"],
			...(selection.model === undefined ? [] : (["model"] as const)),
			...(selection.effort === undefined ? [] : (["effort"] as const)),
		) ||
		(selection.model !== undefined &&
			!isProviderModelSelection(selection.model)) ||
		(selection.effort !== undefined &&
			!isProviderEffortSelection(selection.effort)) ||
		(selection.permissionMode !== "default" &&
			selection.permissionMode !== "auto_edit" &&
			selection.permissionMode !== "skip_permissions")
	) {
		return undefined;
	}
	return {
		model: typeof selection.model === "string" ? selection.model : null,
		effort: typeof selection.effort === "string" ? selection.effort : null,
		permissionMode: selection.permissionMode,
	};
}

function parseRuntimeSourceSnapshot(
	value: unknown,
): DureAgentRuntimeSourceSnapshotV1 | undefined {
	const source = record(value);
	const launchSelection = parseInspectedLaunchSelection(
		source?.launchSelection,
	);
	if (
		!source ||
		!requiredFields(source, [
			"selectionRevision",
			"interactionProfile",
			"launchSelection",
		]) ||
		!positiveInteger(source.selectionRevision) ||
		(source.interactionProfile !== "native_cli" &&
			source.interactionProfile !== "structured_protocol") ||
		!launchSelection
	) {
		return undefined;
	}
	return {
		selectionRevision: source.selectionRevision,
		interactionProfile: source.interactionProfile,
		launchSelection,
	};
}

function provider(value: unknown): value is Provider {
	return PROVIDER_IDS.some((candidate) => candidate === value);
}

function targetFailureKind(
	value: unknown,
): value is DureAgentRuntimeTargetFailureKindV1 {
	return (
		value === "target_invalid" ||
		value === "runtime_unavailable" ||
		value === "credential_unavailable" ||
		value === "credential_stale" ||
		value === "launch_failed" ||
		value === "identity_mismatch" ||
		value === "authority_publish_failed"
	);
}

function contractError() {
	return new DureBackendRequestError(
		"agent_runtime_transition_response_invalid",
		t("agents.runtime.switchFailed"),
		{ kind: "contract" },
	);
}

function parseProjectionContext(
	context: RuntimeProjectionContextV1,
): DureAgentRuntimeProjectionContextV1 {
	if (!provider(context.agent.providerId)) throw contractError();
	return {
		...context,
		agent: {
			...context.agent,
			providerId: context.agent.providerId as Provider,
		},
	};
}

function parseTransitionResult(
	raw: Record<string, unknown>,
	expectedAgentId: string,
	expectedInteractionProfile: AgentRuntimeInteractionProfileV1 | undefined,
	backend: DureBackendIdentity,
	routeAuthority: DureBackendRouteAuthorityV1,
	requireConversation = true,
): DureAgentRuntimeTransitionResultV1 {
	const result = parseAgentRuntimeTransitionEnvelope(raw, expectedAgentId);
	if (!result) throw contractError();
	return parseRuntimeReceipt(
		result.receipt,
		expectedAgentId,
		expectedInteractionProfile,
		backend,
		routeAuthority,
		requireConversation,
	);
}

function parseRuntimeReceipt(
	receipt: RuntimeReceiptEnvelope,
	expectedAgentId: string,
	expectedInteractionProfile: AgentRuntimeInteractionProfileV1 | undefined,
	backend: DureBackendIdentity,
	routeAuthority: DureBackendRouteAuthorityV1,
	requireConversation: boolean,
): DureAgentRuntimeTransitionResultV1 {
	const executionProfile = parseAgentExecutionProfileV1(
		receipt.executionProfile,
	);
	if (
		!requiredFields(
			receipt,
			[
				"schemaVersion",
				"agentId",
				"selectionRevision",
				"providerId",
				"executionProfile",
				"permissionMode",
				"providerConversationRef",
				"authority",
				"launchIdempotencyKey",
			],
			// The backend omits absent launch selections entirely.
			...(receipt.model === undefined ? [] : (["model"] as const)),
			...(receipt.effort === undefined ? [] : (["effort"] as const)),
		) ||
		(receipt.model !== undefined && !isProviderModelSelection(receipt.model)) ||
		(receipt.effort !== undefined &&
			!isProviderEffortSelection(receipt.effort)) ||
		(receipt.permissionMode !== "default" &&
			receipt.permissionMode !== "auto_edit" &&
			receipt.permissionMode !== "skip_permissions") ||
		!provider(receipt.providerId) ||
		!executionProfile ||
		!(
			receipt.providerConversationRef === null ||
			nonEmptyString(receipt.providerConversationRef)
		) ||
		(requireConversation && receipt.providerConversationRef === null)
	) {
		throw contractError();
	}
	const common = {
		backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		agentId: expectedAgentId,
		selectionRevision: receipt.selectionRevision,
		providerId: receipt.providerId,
		executionProfile,
		providerConversationRef: receipt.providerConversationRef,
		launchSelection: {
			model: typeof receipt.model === "string" ? receipt.model : null,
			effort: typeof receipt.effort === "string" ? receipt.effort : null,
			permissionMode: receipt.permissionMode,
		},
	} as const;
	const authority = record(receipt.authority);
	const interactionProfile = authority?.interactionProfile;
	// Native authority is already fenced by the exact Host generation. Its
	// credential reference may remain generation-unclaimed when Resume launched
	// successfully without a credential-registry dependency; structured
	// authority still requires an exact backend-owned generation.
	if (
		(interactionProfile !== "structured_protocol" &&
			interactionProfile !== "native_cli") ||
		(expectedInteractionProfile !== undefined &&
			expectedInteractionProfile !== interactionProfile) ||
		(executionProfile.kind === "credential_reference" &&
			executionProfile.credential_generation === null &&
			(interactionProfile !== "native_cli" ||
				(receipt.selectionRevision > 1 &&
					receipt.launchIdempotencyKey === null)))
	) {
		throw contractError();
	}
	if (interactionProfile === "structured_protocol") {
		const binding = parseAgentInteractionBindingV1(authority?.binding);
		if (
			!authority ||
			!requiredFields(authority, ["interactionProfile", "binding"]) ||
			authority.interactionProfile !== "structured_protocol" ||
			receipt.launchIdempotencyKey !== null ||
			!binding ||
			binding.agentId !== expectedAgentId ||
			binding.providerId !== receipt.providerId ||
			binding.providerConversationRef !== receipt.providerConversationRef ||
			!sameAgentExecutionProfileV1(binding.executionProfile, executionProfile)
		) {
			throw contractError();
		}
		return {
			...common,
			interactionProfile: "structured_protocol",
			interactionSessionId: binding.interactionSessionId,
			binding,
		};
	}
	const checkpoint = record(authority?.authority);
	const binding = record(checkpoint?.binding);
	const stopFence = parseHmuxManagedGenerationV1(
		checkpoint && {
			runnerPrincipal: checkpoint.runnerPrincipal,
			runnerInstance: checkpoint.runnerInstance,
			channelEpoch: checkpoint.channelEpoch,
			hostInstanceId: checkpoint.hostInstanceId,
			terminalEpoch: checkpoint.terminalEpoch,
		},
	);
	const expectedCredentialId =
		executionProfile.kind === "credential_reference"
			? executionProfile.reference_id
			: null;
	if (
		!authority ||
		!requiredFields(authority, ["interactionProfile", "authority"]) ||
		authority.interactionProfile !== "native_cli" ||
		!checkpoint ||
		!requiredFields(checkpoint, [
			"schemaVersion",
			"binding",
			"runtimeWorkspaceId",
			"runnerPrincipal",
			"runnerInstance",
			"channelEpoch",
			"hostInstanceId",
			"terminalEpoch",
			"updatedAtMs",
		]) ||
		checkpoint.schemaVersion !== 1 ||
		!binding ||
		!requiredFields(binding, [
			"agentId",
			"runtimeKindId",
			"sessionId",
			"providerConversationId",
			"credentialReferenceId",
			"bindingGeneration",
			"boundAtMs",
		]) ||
		binding.agentId !== expectedAgentId ||
		binding.runtimeKindId !== "runtime.hmux" ||
		!isDureDomainIdV1(binding.sessionId) ||
		binding.providerConversationId !== receipt.providerConversationRef ||
		binding.credentialReferenceId !== expectedCredentialId ||
		!positiveInteger(binding.bindingGeneration) ||
		!nonNegativeInteger(binding.boundAtMs) ||
		!isDureDomainIdV1(checkpoint.runtimeWorkspaceId) ||
		!nonNegativeInteger(checkpoint.updatedAtMs) ||
		!stopFence ||
		!(
			receipt.launchIdempotencyKey === null ||
			isDureDomainIdV1(receipt.launchIdempotencyKey)
		) ||
		(requireConversation && receipt.launchIdempotencyKey === null)
	) {
		throw contractError();
	}
	return {
		...common,
		interactionProfile: "native_cli",
		sessionId: binding.sessionId,
		workspaceId: checkpoint.runtimeWorkspaceId,
		launchIdempotencyKey: receipt.launchIdempotencyKey,
		stopFence,
	};
}

function parseInspectResult(
	raw: Record<string, unknown>,
	expectedAgentId: string,
	backend: DureBackendIdentity,
	routeAuthority: DureBackendRouteAuthorityV1,
): DureAgentRuntimeProjectionInspectResultV1 {
	const result = parseAgentRuntimeInspectionEnvelope(raw, expectedAgentId);
	if (!result) throw contractError();
	const common = {
		backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
	} as const;
	if (result.state === "stable") {
		const receipt = parseRuntimeReceipt(
			result.receipt,
			expectedAgentId,
			undefined,
			backend,
			routeAuthority,
			false,
		);
		const stable = {
			state: "stable",
			...receipt,
		} as const;
		return {
			...stable,
			projectionContext: parseProjectionContext(result.projectionContext),
		};
	}
	if (result.state === "unmanaged") {
		return { state: "unmanaged", agentId: expectedAgentId, ...common };
	}
	if (result.state === "closed") {
		if (
			!isDureDomainIdV1(result.operationId) ||
			(result.stage !== "admitted" && result.stage !== "stopped")
		) {
			throw contractError();
		}
		const closed = {
			state: "closed",
			agentId: expectedAgentId,
			operationId: result.operationId,
			stage: result.stage,
			...common,
		} as const;
		if (result.projectionContext === undefined) return closed;
		const source = parseRuntimeSourceSnapshot(result.source);
		if (!source) throw contractError();
		const current = {
			...closed,
			source,
		};
		return {
			...current,
			projectionContext: parseProjectionContext(result.projectionContext),
		};
	}
	const executionProfile = parseAgentExecutionProfileV1(
		result.targetExecutionProfile,
	);
	const failure = record(result.targetFailure);
	if (
		!isDureDomainIdV1(result.operationId) ||
		!positiveInteger(result.journalRevision) ||
		(result.stage !== "admitted" &&
			result.stage !== "source_stopped" &&
			result.stage !== "repair_required" &&
			result.stage !== "target_started") ||
		(result.targetInteractionProfile !== "native_cli" &&
			result.targetInteractionProfile !== "structured_protocol") ||
		!executionProfile ||
		(executionProfile.kind === "credential_reference" &&
			executionProfile.credential_generation === null) ||
		(result.stage === "repair_required"
			? !failure ||
				!requiredFields(failure, ["kind", "providerCode"]) ||
				!targetFailureKind(failure.kind) ||
				!nonEmptyString(failure.providerCode) ||
				!PROVIDER_DIAGNOSTIC_CODE.test(failure.providerCode)
			: failure !== undefined)
	) {
		throw contractError();
	}
	if (result.stage === "repair_required") {
		const required = {
			state: "repair_required",
			agentId: expectedAgentId,
			operationId: result.operationId,
			journalRevision: result.journalRevision,
			targetInteractionProfile: result.targetInteractionProfile,
			targetExecutionProfile: executionProfile,
			failureKind: failure!.kind as DureAgentRuntimeTargetFailureKindV1,
			providerCode: failure!.providerCode as string,
			...common,
		} as const;
		return {
			...required,
			projectionContext: parseProjectionContext(result.projectionContext),
		};
	}
	const transitioning = {
		state: "transitioning",
		agentId: expectedAgentId,
		operationId: result.operationId,
		stage: result.stage,
		journalRevision: result.journalRevision,
		targetInteractionProfile: result.targetInteractionProfile,
		targetExecutionProfile: executionProfile,
		...common,
	} as const;
	if (agentRuntimeWakeTarget(result)) {
		return {
			...transitioning,
			state: "dormant",
			stage: "source_stopped",
			projectionContext: parseProjectionContext(result.projectionContext),
		};
	}
	return {
		...transitioning,
		projectionContext: parseProjectionContext(result.projectionContext),
	};
}

function parseTransitionIntentResult<
	Candidate extends DureAgentRuntimeRepairCandidateV1,
>(
	result: Record<string, unknown>,
	required: Candidate,
	backend: DureBackendIdentity,
	routeAuthority: DureBackendRouteAuthorityV1,
): Candidate & DureAgentRuntimeIntentSelectionV1 {
	const sourceExecutionProfile = parseAgentExecutionProfileV1(
		result.sourceExecutionProfile,
	);
	const targetExecutionProfile = parseAgentExecutionProfileV1(
		result.targetExecutionProfile,
	);
	const sourceLaunchSelection = parseInspectedLaunchSelection(
		result.sourceLaunchSelection,
	);
	const targetLaunchSelection = parseInspectedLaunchSelection(
		result.targetLaunchSelection,
	);
	const failure = record(result.targetFailure);
	if (
		!requiredFields(
			result,
			[
				"state",
				"schemaVersion",
				"agentId",
				"operationId",
				"journalRevision",
				"sourceSelectionRevision",
				"sourceInteractionProfile",
				"sourceExecutionProfile",
				"sourceLaunchSelection",
				"targetInteractionProfile",
				"targetExecutionProfile",
				"targetLaunchSelection",
			],
			...(required.state === "repair_required" ? ["targetFailure"] : []),
		) ||
		result.state !==
			(required.state === "repair_required" ? "repair_required" : "admitted") ||
		result.schemaVersion !== 1 ||
		result.agentId !== required.agentId ||
		result.operationId !== required.operationId ||
		result.journalRevision !== required.journalRevision ||
		!positiveInteger(result.sourceSelectionRevision) ||
		(result.sourceInteractionProfile !== "native_cli" &&
			result.sourceInteractionProfile !== "structured_protocol") ||
		!sourceExecutionProfile ||
		!targetExecutionProfile ||
		!sourceLaunchSelection ||
		!targetLaunchSelection ||
		result.targetInteractionProfile !== required.targetInteractionProfile ||
		!sameAgentExecutionProfileV1(
			targetExecutionProfile,
			required.targetExecutionProfile,
		) ||
		(required.state === "repair_required" &&
			(!failure ||
				!requiredFields(failure, ["kind", "providerCode"]) ||
				failure.kind !== required.failureKind ||
				failure.providerCode !== required.providerCode))
	) {
		throw contractError();
	}
	const selection: DureAgentRuntimeIntentSelectionV1 = {
		sourceSelectionRevision: result.sourceSelectionRevision,
		sourceInteractionProfile: result.sourceInteractionProfile,
		sourceExecutionProfile,
		sourceLaunchSelection,
		targetLaunchSelection,
	};
	return Object.assign({}, required, selection, {
		backend,
		routeAuthority,
		targetExecutionProfile,
	});
}

export function createDureAgentRuntimeClient(options?: {
	profileId?: string;
	invokeCommand?: DureBackendInvoke;
}): DureAgentRuntimeClient {
	const backendProfileId = options?.profileId ?? "local";
	if (!isDureBackendProfileIdV1(backendProfileId)) throw contractError();
	const authority = new DureBackendAuthorityFence();
	const backendRequest = createDureBackendRequester({
		profileId: backendProfileId,
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "agent_runtime_transition_response_invalid",
		invalidResponseMessage: "agents.runtime.switchFailed",
		backendChangedCode: "agent_runtime_transition_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "agent_runtime_transition_transport_failed",
		requestFailedMessage: "agents.runtime.switchFailed",
		authority,
	});
	const stopRequest = createDureBackendRequester({
		profileId: backendProfileId,
		invokeCommand: options?.invokeCommand,
		invalidResponseCode: "agent_runtime_stop_response_invalid",
		invalidResponseMessage: "agents.remove.cleanupUnsafe",
		backendChangedCode: "agent_runtime_stop_backend_changed",
		backendChangedMessage: "ipc.dureBackend.generationChanged",
		requestFailedCode: "agent_runtime_stop_transport_failed",
		requestFailedMessage: "agents.remove.cleanupUnsafe",
		authority,
	});
	async function closeRuntime(
		operation: "agent_runtime.stop" | "agent_runtime.remove",
		agentId: string,
		routeAuthority: DureBackendRouteAuthorityV1,
	): Promise<void> {
		if (
			!isDureDomainIdV1(agentId) ||
			routeAuthority.profileId !== backendProfileId
		) {
			throw new DureBackendRequestError(
				"agent_runtime_stop_request_invalid",
				t("agents.remove.cleanupUnsafe"),
				{ kind: "contract" },
			);
		}
		const response = await stopRequest(
			operation,
			{ schemaVersion: 1, agentId },
			{ kind: "exact", authority: routeAuthority },
		);
		if (
			!requiredFields(response.result, ["schemaVersion", "stopped"]) ||
			response.result.schemaVersion !== 1 ||
			response.result.stopped !== true
		) {
			throw new DureBackendRequestError(
				"agent_runtime_stop_response_invalid",
				t("agents.remove.cleanupUnsafe"),
				{ kind: "contract" },
			);
		}
	}

	return {
		...createRuntimeObservationClient({
			profileId: backendProfileId,
			request: backendRequest,
			invalid: contractError,
			normalizeError: normalizeTransitionError,
			parse: (response, agentId) =>
				parseInspectResult(
					response.result,
					agentId,
					response.backend,
					response.routeAuthority,
				),
		}),
		async inspectTransitionIntent(required) {
			if (
				(required.state !== "repair_required" &&
					!(
						required.state === "transitioning" && required.stage === "admitted"
					)) ||
				required.backendProfileId !== backendProfileId ||
				required.routeAuthority.profileId !== backendProfileId ||
				!isDureDomainIdV1(required.agentId) ||
				!isDureDomainIdV1(required.operationId) ||
				!positiveInteger(required.journalRevision)
			) {
				throw contractError();
			}
			const response = await backendRequest(
				"agent_runtime.repair_intent.inspect.v1",
				{
					schemaVersion: 1,
					agentId: required.agentId,
					operationId: required.operationId,
					expectedJournalRevision: required.journalRevision,
				},
				{ kind: "exact", authority: required.routeAuthority },
			);
			return parseTransitionIntentResult(
				response.result,
				required,
				response.backend,
				response.routeAuthority,
			);
		},
		async transition({
			agentId,
			targetInteractionProfile,
			expectedSourceRevision,
			targetExecutionProfile,
			targetLaunchSelection,
			sourceStopPolicy = "preserve",
			routeAuthority,
		}) {
			if (
				!isDureDomainIdV1(agentId) ||
				(expectedSourceRevision !== undefined &&
					!positiveInteger(expectedSourceRevision)) ||
				routeAuthority.profileId !== backendProfileId
			) {
				throw contractError();
			}
			if (
				targetExecutionProfile?.kind === "credential_reference" &&
				targetExecutionProfile.credential_generation === null
			) {
				throw contractError();
			}
			if (
				targetLaunchSelection &&
				((targetLaunchSelection.model !== null &&
					!isProviderModelSelection(targetLaunchSelection.model)) ||
					(targetLaunchSelection.effort !== null &&
						!isProviderEffortSelection(targetLaunchSelection.effort)))
			) {
				throw contractError();
			}
			if (sourceStopPolicy !== "preserve" && sourceStopPolicy !== "discard") {
				throw contractError();
			}
			const response = await backendRequest(
				"agent_runtime.transition",
				agentRuntimeTransitionBody({
					agentId,
					targetInteractionProfile,
					expectedSourceRevision,
					sourceStopPolicy,
					targetExecutionProfile,
					targetLaunchSelection,
				}),
				{ kind: "exact", authority: routeAuthority },
			).catch((error: unknown) => {
				throw normalizeTransitionError(error);
			});
			return parseTransitionResult(
				response.result,
				agentId,
				targetInteractionProfile,
				response.backend,
				response.routeAuthority,
			);
		},
		async reconcileNativeRehost(request) {
			if (
				!isDureDomainIdV1(request.agentId) ||
				!isDureDomainIdV1(request.operationId) ||
				request.routeAuthority.profileId !== backendProfileId ||
				(request.targetCredential.kind === "credential_reference" &&
					!isAgentCredentialReferenceV1(request.targetCredential.referenceId))
			) {
				throw contractError();
			}
			const response = await backendRequest(
				"agent_runtime.native_rehost.reconcile",
				{
					schemaVersion: 1,
					agentId: request.agentId,
					operationId: request.operationId,
					providerId: request.providerId,
					targetCredential: request.targetCredential,
					source: request.source,
					target: request.target,
				},
				{ kind: "exact", authority: request.routeAuthority },
			);
			return parseTransitionResult(
				response.result,
				request.agentId,
				"native_cli",
				response.backend,
				response.routeAuthority,
				false,
			);
		},
		async publishNativeResume(request) {
			if (
				!isDureDomainIdV1(request.agentId) ||
				!isDureDomainIdV1(request.operationId) ||
				!isDureDomainIdV1(request.launchIdempotencyKey) ||
				!isDureDomainIdV1(request.providerConversationRef) ||
				request.routeAuthority.profileId !== backendProfileId ||
				(request.targetCredential.kind === "credential_reference" &&
					!isAgentCredentialReferenceV1(request.targetCredential.referenceId))
			) {
				throw contractError();
			}
			const response = await backendRequest(
				"agent_runtime.native_resume.publish",
				{
					schemaVersion: 1,
					agentId: request.agentId,
					operationId: request.operationId,
					providerId: request.providerId,
					targetCredential: request.targetCredential,
					providerConversationRef: request.providerConversationRef,
					permissionMode: request.permissionMode,
					launchIdempotencyKey: request.launchIdempotencyKey,
					target: request.target,
				},
				{ kind: "exact", authority: request.routeAuthority },
			);
			return parseTransitionResult(
				response.result,
				request.agentId,
				"native_cli",
				response.backend,
				response.routeAuthority,
				false,
			);
		},
		stop: (agentId, routeAuthority) =>
			closeRuntime("agent_runtime.stop", agentId, routeAuthority),
		remove: (agentId, routeAuthority) =>
			closeRuntime("agent_runtime.remove", agentId, routeAuthority),
	};
}
