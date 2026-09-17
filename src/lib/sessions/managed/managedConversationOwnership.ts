import { effectiveAgentPermissionMode } from "@/lib/agents/agentPermissionMode";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
	type HmuxExistingManagedWriterInspection,
	type HmuxManagedRehostResolution,
	type HmuxSessionSummary,
	hmux,
} from "@/lib/ipc";
import { managedAgentCredentialLaunchReferences } from "@/lib/sessions/managed/managedAgentExistingWriter";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { useStore } from "@/store";
import type { AccountProfile, Agent, Project, Provider } from "@/types";

export class ManagedConversationOwnershipUnavailableError extends Error {
	readonly code = "conversation_ownership_unavailable";

	constructor(readonly reason: string) {
		super(`managed conversation ownership is unavailable: ${reason}`);
		this.name = "ManagedConversationOwnershipUnavailableError";
	}
}

interface OwnershipState {
	agents: readonly Agent[];
	projects: readonly Project[];
	accounts: readonly AccountProfile[];
	skipPermissions: Readonly<Partial<Record<Provider, boolean>>>;
}

interface OwnershipRuntime {
	state(): OwnershipState;
	inspectSession(input: {
		sessionId: string;
		workspaceId: string;
	}): Promise<HmuxSessionSummary | undefined>;
	resolveSuccessor(
		sessionId: string,
		workspaceId: string,
	): Promise<HmuxManagedRehostResolution>;
	inspectWriter(input: {
		sessionId: string;
		workspaceId: string;
		providerId: Provider;
		conversationId: string;
		cwd: string;
		permissionMode: "default" | "bypass_approvals";
		launchReference?: string;
	}): Promise<HmuxExistingManagedWriterInspection>;
}

const runtime: OwnershipRuntime = {
	state: useStore.getState,
	inspectSession: inspectHmuxSessionExact,
	resolveSuccessor: hmux.resolveManagedRehost,
	inspectWriter: hmux.inspectExistingManagedWriter,
};

interface ConversationCandidate {
	agent: Agent;
	permissionMode: "default" | "bypass_approvals";
	launchReferences: readonly (string | undefined)[];
	fingerprint: string;
}

export interface ManagedConversationLaunchPermit {
	readonly schemaVersion: 1;
	readonly providerId: Provider;
	readonly conversationId: string;
	readonly candidateFingerprints: readonly string[];
}

export type ManagedConversationOwnership =
	| { state: "active"; agent: Agent }
	| { state: "pending"; agent: Agent; permit: ManagedConversationLaunchPermit }
	| { state: "vacant"; permit: ManagedConversationLaunchPermit };

function bindingFingerprint(agent: Agent): readonly unknown[] {
	const binding = agent.runtimeBinding;
	if (!binding) return ["legacy_implicit", agent.sessionKind, agent.sessionId];
	if (binding.runtime !== "hmux_managed_v1") {
		return [binding.runtime, binding.source, binding.hostId, binding.sessionId];
	}
	if (binding.source !== "local") {
		return [
			binding.runtime,
			binding.source,
			binding.hostId,
			binding.sessionId,
			binding.workspaceId,
			binding.createIdempotencyKey,
			binding.commandBridgeNonce,
			binding.credentialId,
			binding.credentialProfileDirectory,
			binding.stopFence?.runnerPrincipal,
			binding.stopFence?.runnerInstance,
			binding.stopFence?.channelEpoch,
			binding.stopFence?.hostInstanceId,
			binding.stopFence?.terminalEpoch,
		];
	}
	return [
		binding.runtime,
		binding.source,
		binding.hostId,
		binding.sessionId,
		binding.workspaceId,
		binding.createIdempotencyKey,
		binding.credentialId,
		binding.credentialGeneration,
		binding.stopFence?.runnerPrincipal,
		binding.stopFence?.runnerInstance,
		binding.stopFence?.channelEpoch,
		binding.stopFence?.hostInstanceId,
		binding.stopFence?.terminalEpoch,
	];
}

function candidateFingerprint(
	agent: Agent,
	projectKind: Project["kind"] | undefined,
	permissionMode: "default" | "bypass_approvals",
	launchReferences: readonly (string | undefined)[],
): string {
	return JSON.stringify([
		agent.id,
		agent.provider,
		agent.projectId,
		projectKind,
		agent.worktreePath,
		agent.sessionId,
		agent.sessionKind,
		managedConversationId(agent),
		agent.started,
		agent.credentialId,
		launchReferences,
		permissionMode,
		bindingFingerprint(agent),
	]);
}

/** A legacy root has no final-edge launch identity. These are only candidates
 * whose canonical Agent credential and provider-directory alias are already
 * established by the current store snapshot; Hmux must still prove the exact
 * one before it can identify a writer. */
function verifiedRootLaunchReferences(
	agent: Agent,
	accounts: readonly AccountProfile[],
): readonly (string | undefined)[] {
	const binding = agent.runtimeBinding;
	const credentialId =
		binding?.runtime === "hmux_managed_v1"
			? (binding.credentialId ??
				agent.credentialId ??
				(typeof agent.accountId === "string" ? agent.accountId : undefined))
			: undefined;
	return managedAgentCredentialLaunchReferences(
		agent.provider,
		credentialId,
		accounts,
	);
}

function conversationCandidates(
	state: OwnershipState,
	providerId: Provider,
	conversationId: string,
	excludeAgentId?: string,
): ConversationCandidate[] {
	const projects = new Map(
		state.projects.map((project) => [project.id, project]),
	);
	return state.agents
		.flatMap((agent): ConversationCandidate[] => {
			const project = projects.get(agent.projectId);
			if (
				agent.id === excludeAgentId ||
				(agent.runtimeBinding
					? agent.runtimeBinding.source !== "local"
					: project?.kind === "ssh") ||
				agent.provider !== providerId ||
				managedConversationId(agent) !== conversationId
			) {
				return [];
			}
			const permissionMode = effectiveAgentPermissionMode(
				agent,
				state.skipPermissions,
			);
			const launchReferences = verifiedRootLaunchReferences(
				agent,
				state.accounts,
			);
			return [
				{
					agent,
					permissionMode,
					launchReferences,
					fingerprint: candidateFingerprint(
						agent,
						project?.kind,
						permissionMode,
						launchReferences,
					),
				},
			];
		})
		.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
}

function fingerprints(candidates: readonly ConversationCandidate[]): string[] {
	return candidates.map((candidate) => candidate.fingerprint);
}

function sameFingerprints(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((fingerprint, index) => fingerprint === right[index])
	);
}

function definitivelyAbsent(session: HmuxSessionSummary): boolean {
	return (
		session.lifecycle === "exited" ||
		session.manifestLifecycle === "exited" ||
		session.health === "exited" ||
		session.hostProcessAlive === false
	);
}

function assertNoDurableSuccessor(
	resolution: HmuxManagedRehostResolution,
	binding: Extract<
		Agent["runtimeBinding"],
		{ runtime: "hmux_managed_v1"; source: "local" }
	>,
): void {
	if (resolution.state !== "not_found") {
		const detail =
			resolution.state === "retry_required"
				? `durable successor ${resolution.operationId} is incomplete`
				: "the conversation has a durable successor";
		throw new ManagedConversationOwnershipUnavailableError(detail);
	}
	if (
		resolution.source.sessionId !== binding.sessionId ||
		resolution.source.workspaceId !== binding.workspaceId
	) {
		throw new ManagedConversationOwnershipUnavailableError(
			"successor lookup returned a different source",
		);
	}
}

function assertWriter(
	candidate: ConversationCandidate,
	conversationId: string,
	inspection: HmuxExistingManagedWriterInspection,
	launchReference: string | undefined,
): void {
	const binding = candidate.agent.runtimeBinding;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "local" ||
		inspection.session.sessionId !== binding.sessionId ||
		inspection.session.workspaceId !== binding.workspaceId ||
		inspection.session.sessionClass !== "managed" ||
		inspection.session.lifecycle !== "ready" ||
		inspection.session.inputAllowed !== true ||
		!inspection.session.stopFence ||
		inspection.conversationId !== conversationId ||
		inspection.permissionMode !== candidate.permissionMode ||
		inspection.launchReference !== launchReference ||
		(binding.createIdempotencyKey !== undefined &&
			inspection.idempotencyKey !== binding.createIdempotencyKey) ||
		(binding.stopFence !== undefined &&
			!sameHmuxManagedGeneration(
				binding.stopFence,
				inspection.session.stopFence,
			))
	) {
		throw new ManagedConversationOwnershipUnavailableError(
			"exact managed writer changed generation",
		);
	}
}

async function inspectCandidate(
	candidate: ConversationCandidate,
	conversationId: string,
	deps: OwnershipRuntime,
): Promise<"active" | "pending" | "absent"> {
	const binding = candidate.agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new ManagedConversationOwnershipUnavailableError(
			"owner candidate has no exact local managed identity",
		);
	}
	if (
		candidate.agent.started === false &&
		binding.createIdempotencyKey &&
		!binding.stopFence
	) {
		// A retained create is resumed through its original Hmux ledger key.
		// It is neither a live writer nor permission to register another Agent.
		return "pending";
	}

	assertNoDurableSuccessor(
		await deps.resolveSuccessor(binding.sessionId, binding.workspaceId),
		binding,
	);

	const exact = await deps.inspectSession({
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
	});
	if (!exact || definitivelyAbsent(exact)) {
		assertNoDurableSuccessor(
			await deps.resolveSuccessor(binding.sessionId, binding.workspaceId),
			binding,
		);
		return "absent";
	}
	let writer: HmuxExistingManagedWriterInspection | undefined;
	let firstError: unknown;
	for (const launchReference of candidate.launchReferences) {
		try {
			const inspected = await deps.inspectWriter({
				sessionId: binding.sessionId,
				workspaceId: binding.workspaceId,
				providerId: candidate.agent.provider,
				conversationId,
				cwd: candidate.agent.worktreePath,
				permissionMode: candidate.permissionMode,
				launchReference,
			});
			assertWriter(candidate, conversationId, inspected, launchReference);
			writer = inspected;
			break;
		} catch (error) {
			if (error instanceof ManagedConversationOwnershipUnavailableError) {
				throw error;
			}
			firstError ??= error;
		}
	}
	if (!writer) {
		throw new ManagedConversationOwnershipUnavailableError(
			`exact writer could not be verified: ${String(firstError)}`,
		);
	}
	assertNoDurableSuccessor(
		await deps.resolveSuccessor(binding.sessionId, binding.workspaceId),
		binding,
	);
	return "active";
}

async function resolveWithRuntime(
	input: {
		providerId: Provider;
		conversationId: string;
		excludeAgentId?: string;
	},
	deps: OwnershipRuntime,
): Promise<ManagedConversationOwnership> {
	const conversationId = input.conversationId.trim();
	const before = conversationCandidates(
		deps.state(),
		input.providerId,
		conversationId,
		input.excludeAgentId,
	);
	const outcomes = await Promise.all(
		before.map((candidate) =>
			inspectCandidate(candidate, conversationId, deps),
		),
	);
	const after = conversationCandidates(
		deps.state(),
		input.providerId,
		conversationId,
		input.excludeAgentId,
	);
	if (!sameFingerprints(fingerprints(before), fingerprints(after))) {
		throw new ManagedConversationOwnershipUnavailableError(
			"owner registrations changed during exact inspection",
		);
	}
	const owners = outcomes.flatMap((outcome, index) =>
		outcome !== "absent" ? [{ state: outcome, agent: after[index].agent }] : [],
	);
	if (owners.length > 1) {
		throw new ManagedConversationOwnershipUnavailableError(
			"multiple exact conversation owners are present",
		);
	}
	const owner = owners[0];
	if (owner?.state === "active") return { state: "active", agent: owner.agent };
	const permit: ManagedConversationLaunchPermit = {
		schemaVersion: 1,
		providerId: input.providerId,
		conversationId,
		candidateFingerprints: fingerprints(
			after.filter((candidate) => candidate.agent.id !== owner?.agent.id),
		),
	};
	return owner
		? { state: "pending", agent: owner.agent, permit }
		: { state: "vacant", permit };
}

/** Resolve local conversation registrations. Hmux proves live writers; an
 * unfinished registration may only continue its existing create identity. */
export function resolveManagedConversationOwnership(input: {
	providerId: Provider;
	conversationId: string;
}): Promise<ManagedConversationOwnership> {
	return resolveWithRuntime(input, runtime);
}

export function assertManagedConversationLaunchPermit(
	permit: ManagedConversationLaunchPermit,
	state: OwnershipState,
): void {
	const current = fingerprints(
		conversationCandidates(state, permit.providerId, permit.conversationId),
	);
	if (!sameFingerprints(permit.candidateFingerprints, current)) {
		throw new ManagedConversationOwnershipUnavailableError(
			"owner registrations changed before launch staging",
		);
	}
}

/** Re-run exact liveness after provider preflight and immediately before Hmux
 * create. The transaction's own staged Agent is excluded; every source
 * candidate must still be the same conclusively absent identity. */
export async function revalidateManagedConversationLaunchPermit(
	permit: ManagedConversationLaunchPermit,
	transactionAgentId: string,
): Promise<void> {
	const resolution = await resolveWithRuntime(
		{
			providerId: permit.providerId,
			conversationId: permit.conversationId,
			excludeAgentId: transactionAgentId,
		},
		runtime,
	);
	if (
		resolution.state !== "vacant" ||
		!sameFingerprints(
			permit.candidateFingerprints,
			resolution.permit.candidateFingerprints,
		)
	) {
		throw new ManagedConversationOwnershipUnavailableError(
			"an exact conversation owner became live before create",
		);
	}
}
