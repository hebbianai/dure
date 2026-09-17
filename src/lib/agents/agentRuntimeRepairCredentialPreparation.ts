import {
	type AgentRuntimeCredentialPreparation,
	resolveAgentRuntimeCredentialPreparation,
} from "@/lib/agents/agentRuntimeCredentialSwitch";
import type {
	DureAgentRuntimeProjectionContextV1,
	DureAgentRuntimeRepairIntentV1,
} from "@/lib/ipc/dureAgentRuntime";
import type { AccountProfile, Agent, SshHostConfig } from "@/types";

export interface AgentRuntimeRepairCredentialPreparationInput {
	readonly required: DureAgentRuntimeRepairIntentV1;
	readonly projectionContext?: DureAgentRuntimeProjectionContextV1;
	readonly agent: Agent | undefined;
	readonly accounts: readonly AccountProfile[];
	readonly sshHosts: readonly SshHostConfig[];
}

/** Resolves preparation material after inspecting the backend repair intent.
 * The intent owns credential identity; frontend state supplies only local
 * account and host material needed to prepare that exact identity. */
export function createAgentRuntimeRepairCredentialPreparation({
	required,
	projectionContext,
	agent,
	accounts,
	sshHosts,
}: AgentRuntimeRepairCredentialPreparationInput): AgentRuntimeCredentialPreparation {
	const sourceExecutionProfile = required.sourceExecutionProfile;
	const targetCredentialId =
		sourceExecutionProfile.kind === "credential_reference"
			? sourceExecutionProfile.reference_id
			: null;
	const prepare = async (
		lease: Parameters<AgentRuntimeCredentialPreparation>[0],
	) =>
		await resolveAgentRuntimeCredentialPreparation({
			agentId: required.agentId,
			backendProfileId: required.backendProfileId,
			routeAuthority: required.routeAuthority,
			action: { targetCredentialId },
			projectionContext,
			agent,
			accounts,
			sshHosts,
		})(lease);
	return Object.assign(prepare, { targetCredentialId });
}
