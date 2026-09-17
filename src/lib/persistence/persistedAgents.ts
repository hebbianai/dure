import { parseAgentCanonicalSpawnV1 } from "@/lib/agents/agentCanonicalSpawn";
import { normalizeAgentDisplayName } from "@/lib/agents/agentDisplayName";
import { initialAgentRuntimeBinding } from "@/lib/agents/agentLaunchCredential";
import { parseAgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { normalizeAgentInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { normalizeDeferredCredentialSwitchIntent } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import { conversationIdentityFromHook } from "@/lib/sessions/managed/managedConversationIdentity";
import { normalizeTerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import { normalizeWorkflowDispatch } from "@/lib/workflows/delegateOnce";
import type {
	Agent,
	AgentRuntimeBindingV1,
	Project,
	SessionKind,
} from "@/types";

function isPersistedSessionKind(value: unknown): value is SessionKind {
	return value === "pty" || value === "ssh";
}

function normalizedAgentRuntimeBinding(
	value: unknown,
): Agent["runtimeBinding"] {
	const binding = normalizeTerminalPaneBindingV1(value);
	// Legacy runtimes retired 2026-08-16 — records carrying them fall through
	// to the managed promotion below instead of rehydrating a legacy binding.
	return binding?.runtime === "hmux_managed_v1" ||
		(binding?.runtime === "hmux_standalone_v1" && binding.source === "local")
		? binding
		: undefined;
}

function explicitlyPersistedConversationIdentity(value: unknown): boolean {
	return (
		!!value &&
		typeof value === "object" &&
		Object.keys(value).includes("conversationIdentity")
	);
}

function withoutConversationIdentity(
	binding: AgentRuntimeBindingV1 | undefined,
): AgentRuntimeBindingV1 | undefined {
	if (binding?.runtime !== "hmux_managed_v1") {
		return binding;
	}
	const { conversationIdentity: _invalid, ...rest } = binding;
	return rest;
}

/** Normalize persisted agents as one coherence boundary. Host provenance and
 * the convenience conversationId must agree exactly or both are discarded. */
export function normalizePersistedAgents(
	value: unknown,
	projects: readonly Project[] = [],
): Agent[] {
	if (!Array.isArray(value)) return [];
	return (value as Agent[]).map((agent): Agent | undefined => {
		const hasCanonicalSpawn = Object.keys(agent).includes("canonicalSpawn");
		const { canonicalSpawn: rawCanonicalSpawn, ...persistedAgent } = agent;
		const canonicalSpawn = parseAgentCanonicalSpawnV1(rawCanonicalSpawn);
		if (hasCanonicalSpawn && !canonicalSpawn) return undefined;
		const rawBinding = agent.runtimeBinding;
		const rawInteractionProfile = agent.interactionProfile;
		let runtimeBinding = normalizedAgentRuntimeBinding(rawBinding);
		if (!runtimeBinding) {
			// Pre-managed (or legacy-bound) records promote onto the managed
			// runtime at load: their next spawn resumes provider-natively via
			// the persisted started/conversationId semantics. A record whose
			// project is gone stays unbound and fails visibly at spawn.
			const project = projects.find(
				(candidate) => candidate.id === agent.projectId,
			);
			runtimeBinding = project
				? initialAgentRuntimeBinding({
						project,
						sessionId: agent.sessionId,
						credentialId: agent.credentialId,
					})
				: undefined;
		}
		const conversationId = conversationIdentityFromHook({
			conversationId: agent.conversationId,
		});
		const hasPersistedProvenance =
			explicitlyPersistedConversationIdentity(rawBinding);
		const identity =
			runtimeBinding?.runtime === "hmux_managed_v1"
				? runtimeBinding.conversationIdentity
				: undefined;
		const coherentProvenance =
			identity !== undefined &&
			conversationId === identity.conversationId &&
			agent.sessionId === identity.sessionId &&
			agent.provider === identity.providerId &&
			runtimeBinding?.runtime === "hmux_managed_v1" &&
			runtimeBinding.sessionId === identity.sessionId &&
			runtimeBinding.workspaceId === identity.workspaceId;

		if (hasPersistedProvenance && !coherentProvenance) {
			runtimeBinding = withoutConversationIdentity(runtimeBinding);
		}
		const pendingCredentialSwitch = normalizeDeferredCredentialSwitchIntent(
			agent.pendingCredentialSwitch,
		);
		const workflowDispatch = normalizeWorkflowDispatch(agent.workflowDispatch);
		const bindinglessLegacyNative =
			rawBinding === undefined &&
			rawInteractionProfile == null &&
			isPersistedSessionKind(agent.sessionKind) &&
			typeof agent.sessionId === "string" &&
			agent.sessionId.trim().length > 0;
		const projectedRuntimeBinding =
			rawBinding !== undefined || bindinglessLegacyNative
				? runtimeBinding
				: undefined;
		const interactionProfile = projectedRuntimeBinding
			? undefined
			: normalizeAgentInteractionProfileV1(rawInteractionProfile);
		const executionProfile = parseAgentExecutionProfileV1(
			agent.executionProfile,
		);
		return {
			...persistedAgent,
			...(canonicalSpawn ? { canonicalSpawn } : {}),
			displayName: normalizeAgentDisplayName(agent.name, agent.displayName),
			...(rawBinding !== undefined || projectedRuntimeBinding !== undefined
				? { runtimeBinding: projectedRuntimeBinding }
				: {}),
			interactionProfile,
			executionProfile,
			conversationId:
				hasPersistedProvenance && !coherentProvenance
					? undefined
					: conversationId,
			pendingCredentialSwitch,
			workflowDispatch,
		};
	}).filter((agent): agent is Agent => agent !== undefined);
}
