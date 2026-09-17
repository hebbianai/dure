import { agentRuntimeTransitionRoute } from "@/lib/agents/agentRuntimeProfileSwitch";
import { providerAccountDirectoryName } from "@/lib/agents/providers";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	type DureBackendRouteAuthorityV1,
	resolveExactDureBackendSshHost,
} from "@/lib/ipc/dureBackendRoute";
import { registerDureProviderCredentialProfile } from "@/lib/ipc/dureProviderCredentialProfile";
import { createDureWorkflowTransport } from "@/lib/ipc/dureWorkflow";
import type {
	HmuxManagedPaneBindingV1,
	RemoteHmuxManagedPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import { useStore } from "@/store";
import type { Agent } from "@/types";

type WorkflowTransportFactory = typeof createDureWorkflowTransport;
type CheckpointBindingCommit = typeof commitManagedAgentCheckpointBinding;

/** Adopts one exact legacy-Hmux checkpoint or surfaces why the backend cannot
 * own it. The existing Terminal remains usable when this action fails. */
export async function adoptCurrentManagedAgentCheckpoint(
	agentId: string,
	routeAuthority: DureBackendRouteAuthorityV1,
	commit: CheckpointBindingCommit = commitManagedAgentCheckpointBinding,
): Promise<void> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const project = state.projects.find(
		(candidate) => candidate.id === agent?.projectId,
	);
	const binding = agent?.runtimeBinding;
	if (
		!agent ||
		!project ||
		agent.interactionProfile !== undefined ||
		binding?.runtime !== "hmux_managed_v1" ||
		!binding.stopFence
	) {
		throw new DureBackendRequestError(
			"agent_runtime_checkpoint_adoption_unsupported",
			"agent_runtime_checkpoint_adoption_unsupported",
			{ kind: "operation", disposition: "terminal" },
		);
	}
	const route = agentRuntimeTransitionRoute(agent, project);
	if (!route || route.backendProfileId !== routeAuthority.profileId) {
		throw new Error("client_agent_runtime_transition_conflict");
	}
	if (binding.source === "local") {
		if (project.kind !== "local" || routeAuthority.target.source !== "local") {
			throw new Error("client_backend_host_mismatch");
		}
	} else {
		if (
			project.kind !== "ssh" ||
			!project.sshHostId ||
			binding.hostId !== project.sshHostId
		) {
			throw new Error("client_backend_host_mismatch");
		}
		resolveExactDureBackendSshHost(
			routeAuthority,
			project.sshHostId,
			state.sshHosts,
			(code) => {
				throw new Error(code);
			},
		);
	}
	await commit(routeAuthority, agentId, binding);
}

/** Commits the frontend's accepted Hmux successor to the backend-owned native
 * runtime authority. The Hmux stop fence remains the proof; pane state is only
 * the trigger for this idempotent convergence. */
export async function commitManagedAgentCheckpointBinding(
	routeAuthority: DureBackendRouteAuthorityV1,
	agentId: string,
	binding: HmuxManagedPaneBindingV1 | RemoteHmuxManagedPaneBindingV1,
	createTransport: WorkflowTransportFactory = createDureWorkflowTransport,
): Promise<Agent> {
	const state = useStore.getState();
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	if (!agent) {
		throw new Error("managed_agent_checkpoint_binding_agent_unavailable");
	}
	if (!binding.stopFence) {
		throw new Error("managed_agent_checkpoint_binding_fence_unavailable");
	}
	const profileId =
		binding.backendProfileId ??
		(binding.source === "local" ? "local" : undefined);
	if (!profileId || routeAuthority.profileId !== profileId) {
		throw new Error("managed_agent_checkpoint_binding_route_profile_mismatch");
	}
	if (binding.credentialId) {
		const account = state.accounts.find(
			(candidate) =>
				candidate.id === binding.credentialId &&
				candidate.provider === agent.provider,
		);
		const profileDirectoryName =
			binding.source === "ssh"
				? binding.credentialProfileDirectory?.split("/").pop()
				: account
					? providerAccountDirectoryName(account)
					: undefined;
		if (profileDirectoryName) {
			await registerDureProviderCredentialProfile(
				{
					providerId: agent.provider,
					referenceId: binding.credentialId,
					profileDirectoryName,
				},
				{ profileId, routeAuthority },
			);
		}
	}
	await createTransport({
		profileId,
	}).ensureCoordinatorBinding(routeAuthority, {
		schemaVersion: 1,
		agentId: agent.id,
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		displayName: agent.displayName?.trim() || agent.name,
		worktreePath: agent.worktreePath,
		stopFence: binding.stopFence,
	});
	return agent;
}
