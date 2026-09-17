import { sameAgentCanonicalSpawn } from "@/lib/agents/agentCanonicalSpawn";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { hasOnlyKeys, isRecord, nonEmptyString } from "@/lib/payloadGuards";
import { sameWorktreeLocation } from "@/lib/scm/worktrees/worktreeLocation";
import { sessionKindExecutionProfile } from "@/lib/terminal/sessionKindExecutionProfile";
import { isTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { type Agent, PROVIDERS } from "@/types";

const PROVIDER_IDS = new Set(Object.keys(PROVIDERS));
const SESSION_KINDS = new Set<Agent["sessionKind"]>(["pty", "ssh"]);

/** Captured fields interpreted by the phase-specific target and projection predicates. */
export interface AgentRemovalRegistrationIdentity {
	readonly id: string;
	readonly canonicalSpawn?: NonNullable<Agent["canonicalSpawn"]>;
	readonly provider: Agent["provider"];
	readonly projectId: string;
	readonly worktreePath: string;
	readonly sessionKind: Agent["sessionKind"];
	readonly sessionId: string;
	readonly runtimeBinding: Agent["runtimeBinding"];
	readonly backendProfileId?: string;
	readonly interactionSessionId?: string;
}

export interface ManagedAgentRemovalRegistrationIdentity
	extends AgentRemovalRegistrationIdentity {
	readonly runtimeBinding: Extract<
		NonNullable<Agent["runtimeBinding"]>,
		{ runtime: "hmux_managed_v1" }
	>;
}

export function agentRemovalRegistrationIdentity(
	agent: Agent,
): AgentRemovalRegistrationIdentity {
	const profile = agent.interactionProfile;
	const binding = agent.runtimeBinding;
	return {
		id: agent.id,
		...(agent.canonicalSpawn
			? { canonicalSpawn: { ...agent.canonicalSpawn } }
			: {}),
		provider: agent.provider,
		projectId: agent.projectId,
		worktreePath: agent.worktreePath,
		sessionKind: agent.sessionKind,
		sessionId: agent.sessionId,
		runtimeBinding: binding
			? {
					...binding,
					...(binding.runtime === "hmux_managed_v1" && binding.stopFence
						? { stopFence: { ...binding.stopFence } }
						: {}),
				}
			: undefined,
		...(profile?.kind === "structured_protocol"
			? {
					backendProfileId: profile.backendProfileId,
					interactionSessionId: profile.interactionSessionId,
				}
			: {}),
	};
}

/** Parses one exact managed registration at the WebView event boundary. */
export function parseManagedAgentRemovalRegistrationIdentity(
	value: unknown,
): ManagedAgentRemovalRegistrationIdentity | undefined {
	if (!isRecord(value)) return undefined;
	const providerId = value.provider;
	const sessionKind =
		nonEmptyString(value.sessionKind) &&
		SESSION_KINDS.has(value.sessionKind as Agent["sessionKind"])
			? (value.sessionKind as Agent["sessionKind"])
			: undefined;
	const binding = value.runtimeBinding;
	const backendProfileId = value.backendProfileId;
	const interactionSessionId = value.interactionSessionId;
	if (
		!nonEmptyString(value.id) ||
		typeof providerId !== "string" ||
		!PROVIDER_IDS.has(providerId) ||
		!nonEmptyString(value.projectId) ||
		!nonEmptyString(value.worktreePath) ||
		!sessionKind ||
		!nonEmptyString(value.sessionId) ||
		!isTerminalPaneBindingV1(binding) ||
		binding.runtime !== "hmux_managed_v1" ||
		(backendProfileId !== undefined && !nonEmptyString(backendProfileId)) ||
		(interactionSessionId !== undefined &&
			!nonEmptyString(interactionSessionId)) ||
		(backendProfileId === undefined) !== (interactionSessionId === undefined) ||
		!hasOnlyKeys(value, [
			"id",
			"provider",
			"projectId",
			"worktreePath",
			"sessionKind",
			"sessionId",
			"runtimeBinding",
			"backendProfileId",
			"interactionSessionId",
		])
	) {
		return undefined;
	}
	return {
		id: value.id,
		provider: providerId as Agent["provider"],
		projectId: value.projectId,
		worktreePath: value.worktreePath,
		sessionKind,
		sessionId: value.sessionId,
		runtimeBinding: binding,
		...(backendProfileId && interactionSessionId
			? { backendProfileId, interactionSessionId }
			: {}),
	};
}

function sameRuntimeBinding(
	current: Agent["runtimeBinding"],
	expected: Agent["runtimeBinding"],
): boolean {
	if (!current || !expected) return current === expected;
	const currentRecord = current as unknown as Record<string, unknown>;
	const expectedRecord = expected as unknown as Record<string, unknown>;
	if (
		current.schemaVersion !== expected.schemaVersion ||
		current.runtime !== expected.runtime ||
		current.source !== expected.source ||
		current.hostId !== expected.hostId ||
		current.sessionId !== expected.sessionId
	) {
		return false;
	}
	if (
		current.runtime === "hmux_managed_v1" &&
		expected.runtime === "hmux_managed_v1"
	) {
		const sameLaunch =
			current.workspaceId === expected.workspaceId &&
			current.createIdempotencyKey === expected.createIdempotencyKey &&
			current.backendProfileId === expected.backendProfileId;
		if (!sameLaunch) return false;
		if (current.source === "local" && expected.source === "local") {
			return (
				current.credentialId === expected.credentialId &&
				current.credentialGeneration === expected.credentialGeneration
			);
		}
		return (
			current.source === "ssh" &&
			expected.source === "ssh" &&
			current.commandBridgeNonce === expected.commandBridgeNonce &&
			current.credentialId === expected.credentialId &&
			current.credentialProfileDirectory ===
				expected.credentialProfileDirectory &&
			sameHmuxManagedGeneration(current.stopFence, expected.stopFence)
		);
	}
	if (
		current.runtime === "hmux_standalone_v1" &&
		expected.runtime === "hmux_standalone_v1"
	) {
		return (
			current.workspaceId === expected.workspaceId &&
			currentRecord.commandBridgeNonce === expectedRecord.commandBridgeNonce
		);
	}
	return (
		currentRecord.workspaceId === expectedRecord.workspaceId &&
		currentRecord.createIdempotencyKey ===
			expectedRecord.createIdempotencyKey &&
		currentRecord.commandBridgeNonce === expectedRecord.commandBridgeNonce
	);
}

/** Matches the logical target before stop; local process generations may refresh. */
export function sameAgentRemovalTarget(
	current: Agent,
	expected: AgentRemovalRegistrationIdentity,
): boolean {
	const profile = current.interactionProfile;
	return (
		current.id === expected.id &&
		((current.canonicalSpawn === undefined &&
			expected.canonicalSpawn === undefined) ||
			sameAgentCanonicalSpawn(current.canonicalSpawn, expected.canonicalSpawn)) &&
		current.provider === expected.provider &&
		current.projectId === expected.projectId &&
		sameWorktreeLocation(
			current.worktreePath,
			expected.worktreePath,
			sessionKindExecutionProfile(current.sessionKind).worktreePathDialect,
		) &&
		current.sessionKind === expected.sessionKind &&
		current.sessionId === expected.sessionId &&
		sameRuntimeBinding(current.runtimeBinding, expected.runtimeBinding) &&
		(profile?.kind === "structured_protocol"
			? profile.backendProfileId === expected.backendProfileId &&
				profile.interactionSessionId === expected.interactionSessionId
			: expected.backendProfileId === undefined &&
				expected.interactionSessionId === undefined)
	);
}

/** Matches the exact stored projection after a non-receipted stop. */
export function sameAgentRemovalProjection(
	current: Agent,
	expected: AgentRemovalRegistrationIdentity,
): boolean {
	if (!sameAgentRemovalTarget(current, expected)) return false;
	const currentBinding = current.runtimeBinding;
	const expectedBinding = expected.runtimeBinding;
	if (
		currentBinding?.runtime !== "hmux_managed_v1" ||
		expectedBinding?.runtime !== "hmux_managed_v1" ||
		currentBinding.source !== "local" ||
		expectedBinding.source !== "local"
	) {
		return true;
	}
	if (!currentBinding.stopFence || !expectedBinding.stopFence) {
		return currentBinding.stopFence === expectedBinding.stopFence;
	}
	return sameHmuxManagedGeneration(
		currentBinding.stopFence,
		expectedBinding.stopFence,
	);
}
