import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
	HmuxExistingManagedWriterInspection,
	HmuxManagedConversationIdentity,
	HmuxManagedRehostGeneration,
	HmuxManagedRehostLaunchIdentity,
	HmuxManagedRehostResolution,
} from "@/lib/ipc";
import { hmux } from "@/lib/ipc";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	canonicalManagedAgentCredentialId,
	inspectExistingManagedWriter,
	type ManagedAgentDurableSuccessorSource,
	type ManagedAgentDurableSuccessorTarget,
	managedAgentCredentialLaunchReferences,
	managedAgentDurableSuccessorSyncPayload,
} from "@/lib/sessions/managed/managedAgentExistingWriter";
import {
	committedManagedAgentNativeRehostCredential,
	type ManagedAgentNativeRehostCommittedTargetV1,
} from "@/lib/sessions/managed/managedAgentRehostCommit";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { validManagedRehostOperationId } from "@/lib/sessions/managed/managedRehostOperationId";
import type { HmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";
import type { Agent } from "@/types";

type LocalManagedBinding = HmuxManagedPaneBindingV1 & { source: "local" };

export type ManagedRehostLineageObservation =
	| { readonly state: "not_found" }
	| { readonly state: "retry_required"; readonly operationId: string }
	| {
			readonly state: "resolved";
			readonly operationIds: readonly string[];
			readonly operationId: string;
			readonly sourceGeneration: HmuxManagedRehostGeneration;
			readonly currentGeneration: HmuxManagedRehostGeneration;
			readonly providerId: Extract<
				HmuxManagedRehostResolution,
				{ state: "resolved" }
			>["providerId"];
			readonly permissionMode: Extract<
				HmuxManagedRehostResolution,
				{ state: "resolved" }
			>["permissionMode"];
			/** Missing outer identity is a legacy unknown; `{}` is known fresh. */
			readonly launchIdentity?: Readonly<HmuxManagedRehostLaunchIdentity>;
	  };

interface ManagedAgentDurableSuccessorRuntime {
	readonly resolveManagedRehost: typeof hmux.resolveManagedRehost;
	readonly inspectExistingWriter: typeof inspectExistingManagedWriter;
	readonly inspectConversationIdentity: typeof hmux.inspectManagedConversationIdentity;
	readonly inspectCommittedCredential: typeof inspectCommittedCredential;
	readonly resolveRouteAuthority: typeof resolveSelectedDureBackendRouteAuthority;
	readonly accounts: () => ManagedAgentDurableSuccessorSource["accounts"];
}

const defaultRuntime: ManagedAgentDurableSuccessorRuntime = {
	resolveManagedRehost: hmux.resolveManagedRehost,
	inspectExistingWriter: inspectExistingManagedWriter,
	inspectConversationIdentity: hmux.inspectManagedConversationIdentity,
	inspectCommittedCredential,
	resolveRouteAuthority: resolveSelectedDureBackendRouteAuthority,
	accounts: () => useStore.getState().accounts,
};

function sameSessionIdentity(
	left: { sessionId: string; workspaceId: string },
	right: { sessionId: string; workspaceId: string },
): boolean {
	return (
		left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
	);
}

function bindingMatchesGeneration(
	binding: LocalManagedBinding,
	generation: HmuxManagedRehostGeneration,
): boolean {
	return (
		binding.stopFence !== undefined &&
		sameSessionIdentity(binding, generation) &&
		sameHmuxManagedGeneration(binding.stopFence, generation)
	);
}

function conflict(message: string): PaneCommandError {
	return new PaneCommandError("pane_changed", message);
}

/** Normalize Hmux's root-to-current resolution once. Callers receive either a
 * complete fenced lineage or a non-success state; an identity mismatch never
 * becomes an alternate writer. */
export async function observeManagedRehostLineage(
	binding: LocalManagedBinding,
	resolveManagedRehost: typeof hmux.resolveManagedRehost = defaultRuntime.resolveManagedRehost,
): Promise<ManagedRehostLineageObservation> {
	const resolution = await resolveManagedRehost(
		binding.sessionId,
		binding.workspaceId,
	);
	if (resolution.state === "not_found") {
		if (!sameSessionIdentity(binding, resolution.source)) {
			throw conflict("managed rehost lookup changed its source identity");
		}
		return { state: "not_found" };
	}
	if (resolution.state === "retry_required") {
		if (
			!sameSessionIdentity(binding, resolution.source) ||
			!validManagedRehostOperationId(resolution.operationId)
		) {
			throw conflict("managed rehost retry changed its source identity");
		}
		return {
			state: "retry_required",
			operationId: resolution.operationId,
		};
	}
	const operationIds = resolution.operationIds.filter(
		validManagedRehostOperationId,
	);
	const operationId = operationIds[operationIds.length - 1];
	if (
		operationIds.length !== resolution.operationIds.length ||
		!operationId ||
		!bindingMatchesGeneration(binding, resolution.sourceGeneration) ||
		resolution.currentGeneration.workspaceId !== binding.workspaceId ||
		resolution.currentGeneration.sessionId === binding.sessionId
	) {
		throw conflict("managed rehost resolution changed its exact lineage");
	}
	return {
		state: "resolved",
		operationIds,
		operationId,
		sourceGeneration: resolution.sourceGeneration,
		currentGeneration: resolution.currentGeneration,
		providerId: resolution.providerId,
		permissionMode: resolution.permissionMode,
		...(resolution.launchIdentity === undefined
			? {}
			: { launchIdentity: { ...resolution.launchIdentity } }),
	};
}

function sameGeneration(
	left: HmuxManagedRehostGeneration,
	right: HmuxManagedRehostGeneration,
): boolean {
	return (
		sameSessionIdentity(left, right) && sameHmuxManagedGeneration(left, right)
	);
}

function sameLaunchIdentity(
	left: Readonly<HmuxManagedRehostLaunchIdentity> | undefined,
	right: Readonly<HmuxManagedRehostLaunchIdentity> | undefined,
): boolean {
	return (
		(left === undefined) === (right === undefined) &&
		left?.launchReference === right?.launchReference &&
		left?.conversationId === right?.conversationId
	);
}

function sameManagedRehostLineage(
	left: Extract<ManagedRehostLineageObservation, { state: "resolved" }>,
	right: ManagedRehostLineageObservation,
): boolean {
	return (
		right.state === "resolved" &&
		left.providerId === right.providerId &&
		left.permissionMode === right.permissionMode &&
		sameLaunchIdentity(left.launchIdentity, right.launchIdentity) &&
		left.operationIds.length === right.operationIds.length &&
		left.operationIds.every(
			(operationId, index) => operationId === right.operationIds[index],
		) &&
		sameGeneration(left.sourceGeneration, right.sourceGeneration) &&
		sameGeneration(left.currentGeneration, right.currentGeneration)
	);
}

export function sessionMatchesManagedRehostGeneration(
	session: HmuxExistingManagedWriterInspection["session"],
	generation: HmuxManagedRehostGeneration,
): boolean {
	return (
		session.sessionClass === "managed" &&
		session.lifecycle === "ready" &&
		session.inputAllowed !== false &&
		sameSessionIdentity(session, generation) &&
		sameHmuxManagedGeneration(session.stopFence, generation)
	);
}

export type ManagedAgentDurableSuccessorResolution =
	| Exclude<ManagedRehostLineageObservation, { state: "resolved" }>
	| ({
			readonly state: "resolved";
			readonly operationId: string;
	  } & ManagedAgentDurableSuccessorTarget);

function exactConversationIdentity(
	identity: HmuxManagedConversationIdentity,
	lineage: Extract<ManagedRehostLineageObservation, { state: "resolved" }>,
): string {
	if (
		identity.sessionId !== lineage.currentGeneration.sessionId ||
		identity.workspaceId !== lineage.currentGeneration.workspaceId ||
		identity.providerId !== lineage.providerId ||
		!identity.conversationId
	) {
		throw conflict("managed rehost live conversation changed its exact target");
	}
	return identity.conversationId;
}

async function inspectCommittedCredential(
	source: ManagedAgentDurableSuccessorSource,
	lineage: Extract<ManagedRehostLineageObservation, { state: "resolved" }>,
	writer: HmuxExistingManagedWriterInspection,
	launchKind: "exact_resume" | "fresh",
	providerConversationRef: string | null,
) {
	const target: ManagedAgentNativeRehostCommittedTargetV1 = {
		agentId: source.agentId,
		operationId: lineage.operationId,
		providerId: lineage.providerId,
		launchKind,
		source: {
			sessionId: lineage.sourceGeneration.sessionId,
			workspaceId: lineage.sourceGeneration.workspaceId,
			stopFence: lineage.sourceGeneration,
		},
		target: {
			sessionId: lineage.currentGeneration.sessionId,
			workspaceId: lineage.currentGeneration.workspaceId,
			createIdempotencyKey: writer.idempotencyKey,
			stopFence: lineage.currentGeneration,
		},
		providerConversationRef,
		routeAuthority: source.backendRouteAuthority,
	};
	const inspected = await createDureAgentRuntimeClient({
		profileId: source.backendRouteAuthority.profileId,
	}).inspectExact(source.agentId, source.backendRouteAuthority);
	return inspected.state === "stable"
		? committedManagedAgentNativeRehostCredential(inspected, target)
		: undefined;
}

async function inspectFinalWriter(
	source: ManagedAgentDurableSuccessorSource,
	lineage: Extract<ManagedRehostLineageObservation, { state: "resolved" }>,
	conversationId: string,
	launchReferences: readonly (string | undefined)[],
	inspect: typeof inspectExistingManagedWriter,
): Promise<{
	writer: HmuxExistingManagedWriterInspection;
	launchReference?: string;
}> {
	let firstError: unknown;
	for (const launchReference of launchReferences) {
		try {
			const writer = await inspect(
				source,
				lineage.currentGeneration.sessionId,
				{ conversationId, launchReference },
			);
			return { writer, launchReference };
		} catch (error) {
			firstError ??= error;
		}
	}
	throw firstError;
}

/** Inspect the final writer selected by the complete lineage, then re-read the
 * lineage as the CAS. Intermediate receipts are never projected as the root
 * Agent's successor. */
export async function resolveManagedAgentDurableSuccessor(
	source: ManagedAgentDurableSuccessorSource,
	runtime: Pick<
		ManagedAgentDurableSuccessorRuntime,
		"resolveManagedRehost" | "inspectExistingWriter"
	> &
		Partial<
			Pick<
				ManagedAgentDurableSuccessorRuntime,
				"inspectConversationIdentity" | "inspectCommittedCredential"
			>
		> = defaultRuntime,
	observed?: ManagedRehostLineageObservation,
): Promise<ManagedAgentDurableSuccessorResolution> {
	const binding = source.sourceBinding;
	if (binding.source !== "local") {
		throw conflict("managed rehost source is no longer local");
	}
	const lineage =
		observed ??
		(await observeManagedRehostLineage(binding, runtime.resolveManagedRehost));
	if (lineage.state !== "resolved") return lineage;
	if (
		lineage.providerId !== source.providerId ||
		lineage.permissionMode !== source.permissionMode
	) {
		throw conflict("managed rehost successor changed its launch identity");
	}
	const knownLaunchIdentity = lineage.launchIdentity !== undefined;
	const launchKind =
		knownLaunchIdentity && lineage.launchIdentity?.conversationId === undefined
			? "fresh"
			: "exact_resume";
	let providerConversationRef: string | null;
	let writerConversationId: string;
	if (launchKind === "fresh") {
		providerConversationRef = null;
		writerConversationId = exactConversationIdentity(
			await (
				runtime.inspectConversationIdentity ??
				defaultRuntime.inspectConversationIdentity
			)({
				sessionId: lineage.currentGeneration.sessionId,
				workspaceId: lineage.currentGeneration.workspaceId,
				providerId: lineage.providerId,
				cwd: source.cwd,
			}),
			lineage,
		);
	} else {
		writerConversationId =
			lineage.launchIdentity?.conversationId ?? source.conversationId;
		providerConversationRef = writerConversationId;
	}
	const launchReferences = knownLaunchIdentity
		? [lineage.launchIdentity?.launchReference]
		: managedAgentCredentialLaunchReferences(
				source.providerId,
				source.credentialId,
				source.accounts,
			);
	const { writer, launchReference } = await inspectFinalWriter(
		source,
		lineage,
		writerConversationId,
		launchReferences,
		runtime.inspectExistingWriter,
	);
	if (
		!sessionMatchesManagedRehostGeneration(
			writer.session,
			lineage.currentGeneration,
		)
	) {
		throw conflict("managed rehost successor changed its exact generation");
	}
	let targetCredentialId: string | null;
	if (!knownLaunchIdentity) {
		targetCredentialId = source.credentialId ?? null;
	} else if (launchReference === undefined) {
		targetCredentialId = null;
	} else {
		const mappedCredentialId = canonicalManagedAgentCredentialId(
			source.providerId,
			launchReference,
			source.accounts,
		);
		if (mappedCredentialId !== undefined) {
			targetCredentialId = mappedCredentialId;
		} else {
			const committedCredential = await (
				runtime.inspectCommittedCredential ??
				defaultRuntime.inspectCommittedCredential
			)(source, lineage, writer, launchKind, providerConversationRef);
			if (!committedCredential) {
				throw conflict(
					"managed rehost launch reference has no canonical target credential",
				);
			}
			targetCredentialId =
				committedCredential.kind === "provider_default"
					? null
					: committedCredential.referenceId;
		}
	}
	const current = await observeManagedRehostLineage(
		binding,
		runtime.resolveManagedRehost,
	);
	if (!sameManagedRehostLineage(lineage, current)) {
		throw conflict(
			"managed rehost lineage changed during successor inspection",
		);
	}
	return {
		state: "resolved",
		operationId: lineage.operationId,
		writer,
		launchKind,
		launchReference,
		providerConversationRef,
		targetCredentialId,
	};
}

export interface ReconciledManagedAgentDurableSuccessor {
	readonly payload: ManagedAgentRehostSyncPayload;
	readonly replacement: HmuxExistingManagedWriterInspection["session"];
	readonly conversationId: string;
}

type ManagedAgentDurableSuccessorReconcileRuntime = Pick<
	ManagedAgentDurableSuccessorRuntime,
	"resolveManagedRehost" | "inspectExistingWriter" | "resolveRouteAuthority"
> &
	Partial<
		Pick<
			ManagedAgentDurableSuccessorRuntime,
			"inspectConversationIdentity" | "inspectCommittedCredential" | "accounts"
		>
	>;

interface ManagedAgentDurableSuccessorReconcileOptions {
	readonly runtime?: ManagedAgentDurableSuccessorReconcileRuntime;
	readonly backendRouteAuthority?: DureBackendRouteAuthorityV1;
	readonly lineage?: ManagedRehostLineageObservation;
}

/** Build the normal pane projection for an already-complete root-to-current
 * lineage. Backend and pane mutation remain the responsibility of the common
 * synchronization transaction. */
export async function reconcileManagedAgentDurableSuccessor(
	agent: Agent,
	desktopId: string,
	panelId: string,
	skipPermissions: Parameters<typeof effectiveAgentPermissionMode>[1],
	options: ManagedAgentDurableSuccessorReconcileOptions = {},
): Promise<ReconciledManagedAgentDurableSuccessor | null> {
	const runtime = options.runtime ?? defaultRuntime;
	const binding = agent.runtimeBinding;
	const conversationId = managedConversationId(agent);
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		binding.sessionId !== agent.sessionId ||
		!agent.projectId ||
		!conversationId
	) {
		return null;
	}
	const lineage =
		options.lineage ??
		(await observeManagedRehostLineage(binding, runtime.resolveManagedRehost));
	if (lineage.state !== "resolved") return null;
	const sourcePermissionMode = effectiveAgentPermissionMode(
		agent,
		skipPermissions,
	);
	const backendRouteAuthority =
		options.backendRouteAuthority ??
		(await runtime.resolveRouteAuthority(binding.backendProfileId ?? "local"));
	const source: ManagedAgentDurableSuccessorSource = {
		agentId: agent.id,
		agentName: agent.name,
		projectId: agent.projectId,
		providerId: lineage.providerId,
		sourceBinding: { ...binding },
		sourceConversationId: conversationId,
		sourcePaneState: "present",
		backendRouteAuthority,
		conversationId,
		cwd: agent.worktreePath,
		desktopId,
		panelId,
		permissionMode: lineage.permissionMode,
		sourcePermissionMode,
		credentialId:
			binding.credentialId ??
			agent.credentialId ??
			(typeof agent.accountId === "string" ? agent.accountId : undefined),
		accounts: (runtime.accounts ?? defaultRuntime.accounts)(),
	};
	const successor = await resolveManagedAgentDurableSuccessor(
		source,
		runtime,
		lineage,
	);
	if (successor.state !== "resolved") return null;
	return {
		payload: managedAgentDurableSuccessorSyncPayload(
			source,
			successor,
			successor.operationId,
		),
		replacement: successor.writer.session,
		conversationId: successor.writer.conversationId,
	};
}
