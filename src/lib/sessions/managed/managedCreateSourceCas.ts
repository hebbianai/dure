import type {
	Agent,
	AgentRuntimeBindingV1,
	TerminalEnvironment,
} from "@/types";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";

const TERMINAL_ENV_KEYS = [
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	"FORCE_COLOR",
] as const;

function sameTerminalEnvironment(
	left: TerminalEnvironment | undefined,
	right: TerminalEnvironment | undefined,
): boolean {
	return TERMINAL_ENV_KEYS.every((key) => left?.[key] === right?.[key]);
}

function sameOptionalRecord(
	left: object | undefined,
	right: object | undefined,
): boolean {
	if (!left || !right) return left === right;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	return [...keys].every((key) => leftRecord[key] === rightRecord[key]);
}

function sameManagedBinding(
	left: AgentRuntimeBindingV1 | undefined,
	right: AgentRuntimeBindingV1 | undefined,
): boolean {
	if (
		left?.runtime !== "hmux_managed_v1" ||
		right?.runtime !== "hmux_managed_v1" ||
		left.source !== right.source ||
		left.hostId !== right.hostId ||
		left.sessionId !== right.sessionId ||
		left.workspaceId !== right.workspaceId
	) {
		return false;
	}
	if (left.source === "ssh" && right.source === "ssh") {
		return (
			left.createIdempotencyKey === right.createIdempotencyKey &&
			left.commandBridgeNonce === right.commandBridgeNonce &&
			left.backendProfileId === right.backendProfileId &&
			left.credentialId === right.credentialId &&
			left.credentialProfileDirectory === right.credentialProfileDirectory &&
			sameHmuxManagedGeneration(left.stopFence, right.stopFence) &&
			sameOptionalRecord(left.conversationIdentity, right.conversationIdentity)
		);
	}
	if (left.source === "local" && right.source === "local") {
		return (
			left.createIdempotencyKey === right.createIdempotencyKey &&
			left.backendProfileId === right.backendProfileId &&
			left.credentialId === right.credentialId &&
			left.credentialGeneration === right.credentialGeneration &&
			sameHmuxManagedGeneration(left.stopFence, right.stopFence) &&
			sameOptionalRecord(left.conversationIdentity, right.conversationIdentity)
		);
	}
	return false;
}

/** Exact optimistic lock for a managed create that crossed an async boundary.
 * A receipt may only mutate the Agent snapshot whose launch inputs produced it. */
export function sameManagedCreateSource(
	current: Agent | undefined,
	expected: Agent,
): boolean {
	return (
		current !== undefined &&
		current.id === expected.id &&
		current.provider === expected.provider &&
		current.projectId === expected.projectId &&
		current.worktreePath === expected.worktreePath &&
		current.sessionId === expected.sessionId &&
		current.sessionKind === expected.sessionKind &&
		current.pendingCmd === expected.pendingCmd &&
		current.accountId === expected.accountId &&
		current.skipPermissions === expected.skipPermissions &&
		current.credentialId === expected.credentialId &&
		current.conversationId === expected.conversationId &&
		sameTerminalEnvironment(current.terminalEnv, expected.terminalEnv) &&
		sameManagedBinding(current.runtimeBinding, expected.runtimeBinding)
	);
}
