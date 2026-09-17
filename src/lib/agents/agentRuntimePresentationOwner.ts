import { HMUX_MANAGED_GENERATION_FIELDS } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type { Agent } from "@/types";

/** Stable presentation ownership derived only from the committed Agent
 * projection. It invalidates pane-local state; it never authorizes a runtime
 * action or substitutes for a backend revision/fence check. */
export function agentRuntimePresentationOwnerKey(agent: Agent): string {
	const executionProfile =
		agent.executionProfile?.kind === "credential_reference"
			? [
					"credential_reference",
					agent.executionProfile.reference_id,
					agent.executionProfile.credential_generation,
				]
			: ["provider_default"];
	const profile = agent.interactionProfile;
	if (profile?.kind === "structured_protocol") {
		return JSON.stringify([
			"structured_protocol",
			agent.id,
			agent.provider,
			executionProfile,
			profile.backendProfileId,
			profile.interactionSessionId,
		]);
	}

	const binding = agent.runtimeBinding;
	if (binding?.runtime === "hmux_managed_v1") {
		return JSON.stringify([
			"native_cli",
			agent.id,
			agent.provider,
			executionProfile,
			agent.sessionId,
			binding.source,
			binding.hostId,
			binding.backendProfileId ?? null,
			binding.sessionId,
			binding.workspaceId,
			binding.createIdempotencyKey ?? null,
			binding.stopFence
				? HMUX_MANAGED_GENERATION_FIELDS.map(
						(field) => binding.stopFence?.[field] ?? null,
					)
				: null,
		]);
	}

	return JSON.stringify([
		"native_cli",
		agent.id,
		agent.provider,
		executionProfile,
		agent.sessionId,
		binding?.runtime ?? null,
		binding?.sessionId ?? null,
		binding?.workspaceId ?? null,
	]);
}
