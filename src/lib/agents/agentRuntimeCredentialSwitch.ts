import type { AgentExecutionProfileV1 } from "@/lib/agents/chat/agentConversationContract";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { preflightRemoteAccountLaunch } from "@/lib/agents/remoteAccountOverlay";
import type { DureAgentRuntimeProjectionContextV1 } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	resolveDureBackendSshHost,
	resolveExactDureBackendSshHost,
} from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import type { AccountProfile, Agent, Provider, SshHostConfig } from "@/types";

export interface AgentRuntimeCredentialPreparationInput {
	agentId: string;
	provider: Provider;
	backendProfileId: string;
	account?: AccountProfile;
	remote?: {
		host: SshHostConfig;
		workingDirectory: string;
	};
}

interface AgentRuntimePreparationLease {
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	checkpoint(): void;
	assertRouteAuthority(): Promise<void>;
}

/** Runs only after an explicit action resolves its exact backend authority.
 * The supplied checkpoint fences that route before every externally visible
 * preparation stage. */
export type AgentRuntimeCredentialPreparation = ((
	lease: AgentRuntimePreparationLease,
) => Promise<AgentExecutionProfileV1>) & {
	readonly targetCredentialId: string | null;
};

export interface AgentRuntimeCredentialAction {
	readonly targetCredentialId: string | null;
}

export interface AgentRuntimeCredentialActionContext {
	readonly agentId: string;
	readonly backendProfileId: string;
	readonly routeAuthority: DureBackendRouteAuthorityV1;
	readonly action: AgentRuntimeCredentialAction;
	readonly projectionContext?: DureAgentRuntimeProjectionContextV1;
	readonly agent: Agent | undefined;
	readonly accounts: readonly AccountProfile[];
	readonly sshHosts: readonly SshHostConfig[];
}

interface AgentRuntimeCredentialSwitchDependencies {
	register: typeof registerDureProviderCredentialProfile;
	preflightRemote: typeof preflightRemoteAccountLaunch;
}

const defaultDependencies: AgentRuntimeCredentialSwitchDependencies = {
	register: registerDureProviderCredentialProfile,
	preflightRemote: preflightRemoteAccountLaunch,
};

function routeFailure(code: string, message: string): never {
	throw new DureBackendRequestError(code, message, {
		kind: "authority_changed",
	});
}

/** Builds one lease-fenced credential preparation shared by profile and
 * credential switches. Remote provisioning completes before registration, so
 * no transition can stop the source before its exact target generation exists. */
export function createAgentRuntimeCredentialPreparation(
	input: AgentRuntimeCredentialPreparationInput,
	dependencies: AgentRuntimeCredentialSwitchDependencies = defaultDependencies,
): AgentRuntimeCredentialPreparation {
	const prepare = async (lease: AgentRuntimePreparationLease) => {
		lease.checkpoint();
		if (lease.routeAuthority.profileId !== input.backendProfileId) {
			return routeFailure(
				"client_backend_profile_mismatch",
				"backend route and runtime profile disagree",
			);
		}
		if (input.remote) {
			lease.checkpoint();
			await lease.assertRouteAuthority();
			lease.checkpoint();
			const remoteHost = resolveExactDureBackendSshHost(
				lease.routeAuthority,
				input.remote.host.id,
				[input.remote.host],
				routeFailure,
			);
			lease.checkpoint();
			await dependencies.preflightRemote(
				remoteHost,
				input.provider,
				input.remote.workingDirectory,
				input.account,
				{
					requireCredential: true,
					beforeOverlay: async () => {
						lease.checkpoint();
						await lease.assertRouteAuthority();
						lease.checkpoint();
					},
				},
			);
			lease.checkpoint();
		}
		lease.checkpoint();
		let executionProfile: AgentExecutionProfileV1 = {
			kind: "provider_default",
		};
		if (input.account) {
			// Registration admits this exact route at the native request boundary;
			// a separate route query duplicates that check before the actual write.
			executionProfile = await dependencies.register(
				{
					providerId: input.provider,
					referenceId: input.account.id,
					profileDirectoryName: providerAccountDirectoryName(input.account),
				},
				{
					profileId: input.backendProfileId,
					routeAuthority: lease.routeAuthority,
				},
			);
		}
		lease.checkpoint();
		return executionProfile;
	};
	return Object.assign(prepare, {
		targetCredentialId: input.account?.id ?? null,
	});
}

/** Resolve credential material only after the action has observed its exact
 * runtime route. The UI contributes the selected credential id; provider and
 * workspace come from the typed projection, while local/SSH routing comes
 * only from the observed route authority. */
export function resolveAgentRuntimeCredentialPreparation({
	agentId,
	backendProfileId,
	routeAuthority,
	action,
	projectionContext,
	agent,
	accounts,
	sshHosts,
}: AgentRuntimeCredentialActionContext): AgentRuntimeCredentialPreparation {
	const provider = projectionContext?.agent.providerId ?? agent?.provider;
	if (!provider) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	const account =
		action.targetCredentialId === null
			? undefined
			: accounts.find(
					(candidate) =>
						candidate.id === action.targetCredentialId &&
						candidate.provider === provider,
				);
	if (action.targetCredentialId !== null && !account) {
		throw new Error("credential_reference_unavailable");
	}
	if (routeAuthority.target.source === "ssh") {
		const workingDirectory =
			projectionContext?.workspace.rootPath ?? agent?.worktreePath;
		if (!workingDirectory) {
			throw new Error("client_agent_runtime_transition_conflict");
		}
		const host = resolveDureBackendSshHost(
			routeAuthority,
			sshHosts,
			routeFailure,
		);
		return createAgentRuntimeCredentialPreparation({
			agentId,
			provider,
			backendProfileId,
			account,
			remote: { host, workingDirectory },
		});
	}
	return createAgentRuntimeCredentialPreparation({
		agentId,
		provider,
		backendProfileId,
		account,
	});
}
