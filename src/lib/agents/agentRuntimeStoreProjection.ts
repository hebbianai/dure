import { projectAgentRuntimeLaunchPresentation } from "@/lib/agents/agentRuntimeLaunchPresentation";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { AgentRuntimeActionProjectionV1 } from "@/lib/agents/agentRuntimeProfileSwitch";
import type { useStore } from "@/store";
import type { Agent } from "@/types";

type AgentRuntimeStoreState = ReturnType<typeof useStore.getState>;

/** Projects one committed runtime generation into the IDE store. The backend
 * transition remains authoritative; this only removes presentation records
 * owned by the retired terminal generation. */
export function agentRuntimeTransitionStatePatch(
	state: AgentRuntimeStoreState,
	current: Agent,
	projected: Agent,
	transition: AgentRuntimeActionProjectionV1,
): Partial<AgentRuntimeStoreState> {
	const incoming = {
		ownerKey: agentRuntimePresentationOwnerKey(projected),
		routeAuthority: transition.routeAuthority,
		selectionRevision: transition.selectionRevision,
		launchSelection: transition.launchSelection,
	};
	const launchPresentation = projectAgentRuntimeLaunchPresentation(
		state.agentRuntimeLaunchPresentation[current.id],
		incoming,
	);
	// Order the complete projection, not only its launch controls.
	if (
		launchPresentation !== incoming &&
		launchPresentation.selectionRevision > incoming.selectionRevision
	) {
		return {};
	}
	// The same selection can gain provider observations (e.g. the first
	// conversation ID), but cannot repeat launch cleanup over later UI intent.
	const sameSelection =
		launchPresentation !== incoming &&
		launchPresentation.ownerKey === agentRuntimePresentationOwnerKey(current);
	// On reload the presentation cache is empty. The persisted request still
	// identifies its source selection; hydration must not cancel that request.
	const pending = current.pendingCredentialSwitch;
	const samePendingSource =
		pending?.sourceSelectionRevision === incoming.selectionRevision &&
		incoming.ownerKey === agentRuntimePresentationOwnerKey(current);
	const selected = sameSelection
		? {
				...projected,
				pendingCmd: current.pendingCmd,
				pendingCredentialSwitch: current.pendingCredentialSwitch,
				skipPermissions: current.skipPermissions,
			}
		: samePendingSource
			? { ...projected, pendingCredentialSwitch: pending }
			: projected;
	const agents = state.agents.map((agent) =>
		agent.id === selected.id ? selected : agent,
	);
	const agentRuntimeLaunchPresentation =
		launchPresentation === state.agentRuntimeLaunchPresentation[current.id]
			? state.agentRuntimeLaunchPresentation
			: {
					...state.agentRuntimeLaunchPresentation,
					[current.id]: launchPresentation,
				};
	const currentProfile = current.interactionProfile?.kind ?? "native_cli";
	const retiredSessionId =
		currentProfile !== transition.interactionProfile ||
		(transition.interactionProfile === "native_cli" &&
			current.sessionId !== transition.sessionId)
			? current.sessionId
			: undefined;
	const retiredProjection = retiredSessionId
		? {
				sessionAgentRuntimeObservers: omitSessionRecord(
					state.sessionAgentRuntimeObservers,
					retiredSessionId,
				),
				sessionAgentRuntimeState: omitSessionRecord(
					state.sessionAgentRuntimeState,
					retiredSessionId,
				),
				sessionCwd: omitSessionRecord(state.sessionCwd, retiredSessionId),
				sessionAgent: omitSessionRecord(state.sessionAgent, retiredSessionId),
				sessionTitle: omitSessionRecord(state.sessionTitle, retiredSessionId),
				sessionActivity: omitSessionRecord(
					state.sessionActivity,
					retiredSessionId,
				),
				sessionAgentPin: omitSessionRecord(
					state.sessionAgentPin,
					retiredSessionId,
				),
				sshStates: omitSessionRecord(state.sshStates, retiredSessionId),
				sshMessages: omitSessionRecord(state.sshMessages, retiredSessionId),
			}
		: {};
	if (transition.interactionProfile !== "native_cli") {
		return { agents, agentRuntimeLaunchPresentation, ...retiredProjection };
	}
	const sessionCwd = {
		...state.sessionCwd,
		...(retiredProjection.sessionCwd ?? {}),
	};
	if (retiredSessionId) delete sessionCwd[retiredSessionId];
	sessionCwd[transition.sessionId] = projected.worktreePath;
	return {
		agents,
		agentRuntimeLaunchPresentation,
		...retiredProjection,
		sessionCwd,
		...(sameSelection
			? {}
			: {
					agentActivity: {
						...state.agentActivity,
						[current.id]: "connecting" as const,
					},
				}),
	};
}

function omitSessionRecord<T>(record: Record<string, T>, sessionId: string) {
	if (!(sessionId in record)) return record;
	const next = { ...record };
	delete next[sessionId];
	return next;
}
