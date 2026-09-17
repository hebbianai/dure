import {
	type AgentExecutionProfileV1,
	sameAgentExecutionProfileV1,
} from "@/lib/agents/chat/agentConversationContract";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	createDureAgentRuntimeClient,
	type DureAgentRuntimeTransitionResultV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import type { AccountProfile, HmuxManagedStopFenceV1, Provider } from "@/types";

interface ManagedAgentRehostCommitContext {
	accounts: readonly AccountProfile[];
}

export type ManagedAgentNativeRehostCredentialV1 =
	| { kind: "provider_default" }
	| {
			kind: "credential_reference";
			referenceId: string;
			profileDirectoryName?: string;
	  };

interface ManagedAgentNativeRehostGenerationV1 {
	sessionId: string;
	workspaceId: string;
	stopFence: HmuxManagedStopFenceV1;
}

export interface ManagedAgentNativeRehostSuccessorV1 {
	agentId: string;
	operationId: string;
	providerId: Provider;
	launchKind: "exact_resume" | "fresh";
	source: ManagedAgentNativeRehostGenerationV1;
	target: ManagedAgentNativeRehostGenerationV1 & {
		createIdempotencyKey: string;
	};
	targetCredential: ManagedAgentNativeRehostCredentialV1;
	providerConversationRef: string | null;
	routeAuthority: DureBackendRouteAuthorityV1;
}

export type ManagedAgentNativeRehostCommittedTargetV1 = Omit<
	ManagedAgentNativeRehostSuccessorV1,
	"targetCredential"
>;

async function targetExecutionProfile(
	providerId: Provider,
	credential: ManagedAgentNativeRehostCredentialV1,
	routeAuthority: DureBackendRouteAuthorityV1,
): Promise<AgentExecutionProfileV1 | undefined> {
	if (credential.kind === "provider_default") return credential;
	if (!credential.profileDirectoryName) return undefined;
	return registerDureProviderCredentialProfile(
		{
			providerId,
			referenceId: credential.referenceId,
			profileDirectoryName: credential.profileDirectoryName,
		},
		{
			profileId: routeAuthority.profileId,
			routeAuthority,
		},
	);
}

function matchesRequestedRuntimeTarget(
	receipt: DureAgentRuntimeTransitionResultV1,
	successor: ManagedAgentNativeRehostCommittedTargetV1,
): boolean {
	if (receipt.interactionProfile !== "native_cli") return false;
	const conversationMatches =
		successor.launchKind === "fresh"
			? successor.providerConversationRef === null ||
				receipt.providerConversationRef === successor.providerConversationRef
			: successor.providerConversationRef !== null &&
				receipt.providerConversationRef === successor.providerConversationRef;
	const launchMatches =
		receipt.launchIdempotencyKey === successor.target.createIdempotencyKey ||
		(receipt.selectionRevision === 1 && receipt.launchIdempotencyKey === null);
	return (
		receipt.agentId === successor.agentId &&
		receipt.providerId === successor.providerId &&
		receipt.sessionId === successor.target.sessionId &&
		receipt.workspaceId === successor.target.workspaceId &&
		launchMatches &&
		conversationMatches &&
		sameHmuxManagedGeneration(receipt.stopFence, successor.target.stopFence)
	);
}

function credentialFromExecutionProfile(
	profile: AgentExecutionProfileV1,
): ManagedAgentNativeRehostCredentialV1 {
	return profile.kind === "provider_default"
		? { kind: "provider_default" }
		: {
				kind: "credential_reference",
				referenceId: profile.reference_id,
			};
}

/** Recover only a CP-committed canonical credential for this exact final Hmux
 * generation. The provider launch reference remains a separate Hmux domain. */
export function committedManagedAgentNativeRehostCredential(
	receipt: DureAgentRuntimeTransitionResultV1,
	target: ManagedAgentNativeRehostCommittedTargetV1,
): ManagedAgentNativeRehostCredentialV1 | undefined {
	return matchesRequestedRuntimeTarget(receipt, target)
		? credentialFromExecutionProfile(receipt.executionProfile)
		: undefined;
}

function matchesRequestedTarget(
	receipt: DureAgentRuntimeTransitionResultV1,
	successor: ManagedAgentNativeRehostCommittedTargetV1,
	targetCredential: ManagedAgentNativeRehostCredentialV1,
): boolean {
	const credentialMatches =
		targetCredential.kind === "provider_default"
			? receipt.executionProfile.kind === "provider_default"
			: receipt.executionProfile.kind === "credential_reference" &&
				receipt.executionProfile.reference_id === targetCredential.referenceId;
	return matchesRequestedRuntimeTarget(receipt, successor) && credentialMatches;
}

/** Commit one Hmux-durable successor through its exact backend route before
 * any local or remote Agent/pane adapter changes frontend projection state. */
export async function commitManagedAgentNativeRehostSuccessor(
	successor: ManagedAgentNativeRehostSuccessorV1,
): Promise<DureAgentRuntimeTransitionResultV1 | undefined> {
	const client = createDureAgentRuntimeClient({
		profileId: successor.routeAuthority.profileId,
	});
	const inspected = await client.inspectExact(
		successor.agentId,
		successor.routeAuthority,
	);
	if (inspected.state === "unmanaged") {
		return undefined;
	}
	if (inspected.state === "stable") {
		const committedTargetCredential =
			committedManagedAgentNativeRehostCredential(inspected, successor);
		if (committedTargetCredential) {
			const { state: _stable, ...receipt } = inspected;
			return receipt;
		}
	}
	const targetCredential = successor.targetCredential;
	const target = await targetExecutionProfile(
		successor.providerId,
		targetCredential,
		successor.routeAuthority,
	);
	const receipt = await client.reconcileNativeRehost({
		agentId: successor.agentId,
		operationId: successor.operationId,
		providerId: successor.providerId,
		targetCredential:
			targetCredential.kind === "provider_default"
				? { kind: "provider_default" }
				: {
						kind: "credential_reference",
						referenceId: targetCredential.referenceId,
					},
		source: {
			...successor.source.stopFence,
			sessionId: successor.source.sessionId,
			workspaceId: successor.source.workspaceId,
		},
		target: {
			...successor.target.stopFence,
			sessionId: successor.target.sessionId,
			workspaceId: successor.target.workspaceId,
		},
		routeAuthority: successor.routeAuthority,
	});
	if (
		!matchesRequestedTarget(receipt, successor, targetCredential) ||
		(target !== undefined &&
			!sameAgentExecutionProfileV1(receipt.executionProfile, target))
	) {
		throw new Error("managed_rehost_backend_receipt_mismatch");
	}
	return receipt;
}

function localTargetCredential(
	payload: ManagedAgentRehostSyncPayload,
	context: ManagedAgentRehostCommitContext,
): ManagedAgentNativeRehostCredentialV1 {
	const targetCredentialId =
		payload.targetCredentialId === undefined
			? (payload.binding.credentialId ?? null)
			: payload.targetCredentialId;
	if (targetCredentialId === null) return { kind: "provider_default" };
	const account = context.accounts.find(
		(candidate) =>
			candidate.id === targetCredentialId &&
			candidate.provider === payload.providerId,
	);
	return {
		kind: "credential_reference",
		referenceId: targetCredentialId,
		...(account
			? { profileDirectoryName: providerAccountDirectoryName(account) }
			: {}),
	};
}

/** Local sync adapter for the provider-neutral successor commit. */
export async function commitManagedAgentNativeRehost(
	payload: ManagedAgentRehostSyncPayload,
	routeAuthority: DureBackendRouteAuthorityV1,
	context: ManagedAgentRehostCommitContext,
): Promise<DureAgentRuntimeTransitionResultV1 | undefined> {
	const sourceFence = payload.sourceBinding.stopFence;
	const targetFence = payload.binding.stopFence;
	const targetCreateIdempotencyKey = payload.binding.createIdempotencyKey;
	if (
		!payload.operationId ||
		payload.launchKind === "resume_new_host" ||
		!sourceFence ||
		!targetFence ||
		!targetCreateIdempotencyKey
	) {
		throw new Error("managed_rehost_backend_authority_incomplete");
	}
	return commitManagedAgentNativeRehostSuccessor({
		agentId: payload.agentId,
		operationId: payload.operationId,
		providerId: payload.providerId,
		launchKind: payload.launchKind ?? "exact_resume",
		source: {
			sessionId: payload.sourceBinding.sessionId,
			workspaceId: payload.sourceBinding.workspaceId,
			stopFence: sourceFence,
		},
		target: {
			sessionId: payload.binding.sessionId,
			workspaceId: payload.binding.workspaceId,
			createIdempotencyKey: targetCreateIdempotencyKey,
			stopFence: targetFence,
		},
		targetCredential: localTargetCredential(payload, context),
		providerConversationRef: payload.conversationId,
		routeAuthority,
	});
}

/** Publish a Host that exact Resume already launched. This deliberately has
 * no source argument: the backend derives its replaceable source internally,
 * and no historical identity can become launch admission. */
export async function commitManagedAgentNativeResume(
	payload: ManagedAgentRehostSyncPayload,
	routeAuthority: DureBackendRouteAuthorityV1,
	context: ManagedAgentRehostCommitContext,
): Promise<DureAgentRuntimeTransitionResultV1 | undefined> {
	const targetFence = payload.binding.stopFence;
	const launchIdempotencyKey = payload.binding.createIdempotencyKey;
	const providerConversationRef = payload.conversationId;
	if (
		payload.launchKind !== "resume_new_host" ||
		!targetFence ||
		!launchIdempotencyKey ||
		!providerConversationRef
	) {
		throw new Error("managed_resume_backend_authority_incomplete");
	}
	const targetCredential = localTargetCredential(payload, context);
	const client = createDureAgentRuntimeClient({
		profileId: routeAuthority.profileId,
	});
	const inspected = await client.inspectExact(payload.agentId, routeAuthority);
	if (inspected.state === "unmanaged") return undefined;
	const permissionMode =
		payload.permissionMode === "bypass_approvals"
			? "skip_permissions"
			: "default";
	const receipt = await client.publishNativeResume({
		agentId: payload.agentId,
		operationId: payload.operationId,
		providerId: payload.providerId,
		targetCredential:
			targetCredential.kind === "provider_default"
				? { kind: "provider_default" }
				: {
						kind: "credential_reference",
						referenceId: targetCredential.referenceId,
					},
		providerConversationRef,
		permissionMode,
		launchIdempotencyKey,
		target: {
			...targetFence,
			sessionId: payload.binding.sessionId,
			workspaceId: payload.binding.workspaceId,
		},
		routeAuthority,
	});
	const credentialMatches =
		targetCredential.kind === "provider_default"
			? receipt.executionProfile.kind === "provider_default"
			: receipt.executionProfile.kind === "credential_reference" &&
				receipt.executionProfile.reference_id === targetCredential.referenceId;
	if (
		receipt.agentId !== payload.agentId ||
		receipt.providerId !== payload.providerId ||
		receipt.interactionProfile !== "native_cli" ||
		receipt.providerConversationRef !== providerConversationRef ||
		receipt.sessionId !== payload.binding.sessionId ||
		receipt.workspaceId !== payload.binding.workspaceId ||
		receipt.launchIdempotencyKey !== launchIdempotencyKey ||
		receipt.launchSelection.permissionMode !== permissionMode ||
		!sameHmuxManagedGeneration(receipt.stopFence, targetFence) ||
		!credentialMatches
	) {
		throw new Error("managed_resume_backend_receipt_mismatch");
	}
	// The Host already proved that this credential could launch. Registering
	// its reusable backend profile is follow-up bookkeeping and cannot undo a
	// successful Resume.
	void targetExecutionProfile(
		payload.providerId,
		targetCredential,
		routeAuthority,
	).catch(() => undefined);
	return receipt;
}
