import { agentRuntimeTransitionRoute } from "@/lib/agents/agentRuntimeProfileSwitch";
import { resolveSelectedDureBackendRouteAuthority } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	resolveExactDureBackendSshHost,
} from "@/lib/ipc/dureBackendRoute";
import {
	commitManagedAgentNativeRehostSuccessor,
	type ManagedAgentNativeRehostCredentialV1,
} from "@/lib/sessions/managed/managedAgentRehostCommit";
import type { RemoteHmuxManagedPaneBindingV1 } from "@/lib/terminal/terminalBinding";
import type { Agent, Project, SshHostConfig } from "@/types";

const REMOTE_PROFILE_DIRECTORY = /^\.dure\/accounts\/([^/]+)$/;

/** Resolve only the explicit Agent-runtime route already carried by a remote
 * binding. Missing routes identify legacy terminal-only Agents; a present
 * route must resolve to this exact SSH project and never falls back. */
export async function resolveRemoteManagedAgentRehostRoute(
	agent: Agent,
	project: Project,
	hosts: readonly SshHostConfig[],
): Promise<DureBackendRouteAuthorityV1 | undefined> {
	const binding = agent.runtimeBinding;
	const route = agentRuntimeTransitionRoute(agent, project);
	if (!route) return undefined;
	if (
		binding?.runtime !== "hmux_managed_v1" ||
		binding.source !== "ssh" ||
		binding.backendProfileId !== route.backendProfileId ||
		!project.sshHostId
	) {
		throw new Error("remote_managed_rehost_backend_route_conflict");
	}
	const authority = await resolveSelectedDureBackendRouteAuthority(
		route.backendProfileId,
	);
	resolveExactDureBackendSshHost(
		authority,
		project.sshHostId,
		hosts,
		(code) => {
			throw new Error(code);
		},
	);
	return authority;
}

function targetCredential(
	referenceId: string | null,
	profileDirectory: string | undefined,
): ManagedAgentNativeRehostCredentialV1 {
	if (referenceId === null) return { kind: "provider_default" };
	const directoryName = profileDirectory?.match(REMOTE_PROFILE_DIRECTORY)?.[1];
	if (profileDirectory !== undefined && !directoryName) {
		throw new Error("remote_managed_rehost_target_profile_unavailable");
	}
	return {
		kind: "credential_reference",
		referenceId,
		...(directoryName ? { profileDirectoryName: directoryName } : {}),
	};
}

/** SSH Agent adapter for the provider-neutral successor commit. */
export async function commitRemoteManagedAgentNativeRehost(input: {
	agent: Agent;
	operationId: string;
	sourceBinding: RemoteHmuxManagedPaneBindingV1 & {
		stopFence: NonNullable<RemoteHmuxManagedPaneBindingV1["stopFence"]>;
	};
	targetBinding: RemoteHmuxManagedPaneBindingV1 & {
		stopFence: NonNullable<RemoteHmuxManagedPaneBindingV1["stopFence"]>;
	};
	targetCredentialId: string | null;
	targetCredentialProfileDirectory: string | undefined;
	providerConversationRef: string;
	routeAuthority: DureBackendRouteAuthorityV1;
}) {
	return commitManagedAgentNativeRehostSuccessor({
		agentId: input.agent.id,
		operationId: input.operationId,
		providerId: input.agent.provider,
		launchKind: "exact_resume",
		source: {
			sessionId: input.sourceBinding.sessionId,
			workspaceId: input.sourceBinding.workspaceId,
			stopFence: input.sourceBinding.stopFence,
		},
		target: {
			sessionId: input.targetBinding.sessionId,
			workspaceId: input.targetBinding.workspaceId,
			createIdempotencyKey: input.targetBinding.createIdempotencyKey,
			stopFence: input.targetBinding.stopFence,
		},
		targetCredential: targetCredential(
			input.targetCredentialId,
			input.targetCredentialProfileDirectory,
		),
		providerConversationRef: input.providerConversationRef,
		routeAuthority: input.routeAuthority,
	});
}
