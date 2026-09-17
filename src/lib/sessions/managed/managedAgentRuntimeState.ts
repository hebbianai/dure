import type {
	HmuxManagedCreateReceipt,
	HmuxRecoveryExecutionReceipt,
} from "@/lib/ipc";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { fnv1a32Hex } from "@/lib/platform/hash";
import type { Agent, AgentRuntimeBindingV1, Provider } from "@/types";

export type LocalManagedBinding = Extract<
	AgentRuntimeBindingV1,
	{ runtime: "hmux_managed_v1"; source: "local" }
>;

export interface ManagedAgentRecoveryResult {
	providerId?: Provider;
	permissionMode: "default" | "bypass_approvals";
	conversationId: string;
	createIdempotencyKey: string;
	credentialId?: string;
	/** Exact pre-stop Dure route, carried in-process or recovered from the
	 * route-bound Hmux operation id after restart. */
	backendRouteAuthority?: DureBackendRouteAuthorityV1;
	replacement: HmuxManagedCreateReceipt["session"];
	receipt: HmuxRecoveryExecutionReceipt;
}

export interface ManagedRecoveryIdentity {
	recoveryId: string;
}

export function shortManagedRuntimeDigest(value: string): string {
	return fnv1a32Hex(value);
}

export function managedBinding(agent: Agent): LocalManagedBinding {
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
		throw new Error("agent is not bound to a local managed Hmux runtime");
	}
	return binding;
}

export function managedRecoveryIdentity(
	binding: Pick<LocalManagedBinding, "workspaceId" | "sessionId">,
): ManagedRecoveryIdentity {
	const recoverySeed = [
		"managed-recovery-v3",
		"replace_ai_provider_with_explicit_conversation",
		binding.workspaceId,
		binding.sessionId,
	].join("\0");
	const recoverySuffix =
		shortManagedRuntimeDigest(recoverySeed) +
		shortManagedRuntimeDigest(`hmux-recovery\0${recoverySeed}`);
	const recoveryId = `recovery_${recoverySuffix}`;
	return { recoveryId };
}

export function applyManagedAgentRecovery(
	agents: readonly Agent[],
	source: Agent,
	result: ManagedAgentRecoveryResult,
): Agent[] {
	const binding = managedBinding(source);
	if (!result.replacement.stopFence) {
		throw new Error(
			"managed recovery replacement is missing its durable stop fence",
		);
	}
	const { conversationIdentity: _predecessorIdentity, ...successorBinding } =
		binding;
	return agents.map((candidate) =>
		candidate.id === source.id &&
		candidate.sessionId === binding.sessionId &&
		candidate.runtimeBinding?.runtime === "hmux_managed_v1" &&
		candidate.runtimeBinding.source === "local" &&
		candidate.runtimeBinding.sessionId === binding.sessionId &&
		candidate.runtimeBinding.workspaceId === binding.workspaceId
			? {
					...candidate,
					provider: result.providerId ?? source.provider,
					sessionId: result.replacement.sessionId,
					accountId: result.credentialId ?? null,
					credentialId: result.credentialId,
					started: true,
					pendingCmd: undefined,
					pendingCredentialSwitch: undefined,
					conversationId: result.conversationId,
					runtimeBinding: {
						...successorBinding,
						sessionId: result.replacement.sessionId,
						createIdempotencyKey: result.createIdempotencyKey,
						credentialId: result.credentialId,
						credentialGeneration: undefined,
						stopFence: result.replacement.stopFence,
					},
				}
			: candidate,
	);
}
