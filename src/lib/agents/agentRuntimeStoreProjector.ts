import type { AgentRuntimeLaunchPresentation } from "@/lib/agents/agentRuntimeLaunchPresentation";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	type AgentRuntimeActionProjectionV1,
	projectRuntimeTransition,
	resolveAgentRuntimeProjectionProject,
} from "@/lib/agents/agentRuntimeProfileSwitch";
import { agentRuntimeTransitionStatePatch } from "@/lib/agents/agentRuntimeStoreProjection";
import { useStore } from "@/store";

/** Commits one complete backend runtime snapshot into the sole IDE Agent
 * projection path. Explicit actions and lifecycle recovery share this writer
 * so credentials, launch controls, and retired terminal records cannot drift. */
export function projectAgentRuntimeTransition(
	agentId: string,
	transition: AgentRuntimeActionProjectionV1,
): AgentRuntimeLaunchPresentation {
	const snapshot = useStore.getState();
	const current = snapshot.agents.find((agent) => agent.id === agentId);
	if (!current) {
		throw new Error("client_agent_runtime_transition_missing");
	}
	const currentLaunchPresentation =
		snapshot.agentRuntimeLaunchPresentation[agentId];
	const projectionContext =
		"projectionContext" in transition
			? transition.projectionContext
			: undefined;
	const project = projectionContext
		? resolveAgentRuntimeProjectionProject(
				current,
				snapshot.projects,
				projectionContext,
				transition.routeAuthority,
				snapshot.sshHosts,
			)
		: snapshot.projects.find((candidate) => candidate.id === current.projectId);
	const projected = projectRuntimeTransition(
		current,
		transition,
		transition.backendProfileId,
		project,
		projectionContext
			? {
					projectionContext,
					routeAuthority: transition.routeAuthority,
					sshHosts: snapshot.sshHosts,
				}
			: undefined,
	);
	const patch = agentRuntimeTransitionStatePatch(
		snapshot,
		current,
		projected,
		transition,
	);
	if (!patch.agents) return currentLaunchPresentation;
	let projectionError: Error | undefined;
	useStore.setState((state) => {
		if (state.agents.find((agent) => agent.id === agentId) !== current) {
			projectionError = new Error("client_agent_runtime_transition_conflict");
			return {};
		}
		return patch;
	});
	if (projectionError) throw projectionError;
	return {
		ownerKey: agentRuntimePresentationOwnerKey(projected),
		routeAuthority: transition.routeAuthority,
		selectionRevision: transition.selectionRevision,
		launchSelection: transition.launchSelection,
	};
}
