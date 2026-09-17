// Designated store-wiring point for the profile router and both agent surfaces.
// Runtime transitions themselves live in one provider-neutral action; this
// hook only projects their committed state into the mounted pane.

import { useCallback, useRef, useState } from "react";
import { useAgentRuntimeLaunchSelectionHydration } from "@/components/panels/useAgentRuntimeLaunchSelectionHydration";
import { useStructuredAgentRuntimeInvalidation } from "@/components/panels/useStructuredAgentRuntimeInvalidation";
import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import type { AgentRuntimeLaunchPresentation } from "@/lib/agents/agentRuntimeLaunchPresentation";
import {
	type AgentRuntimeLaunchExpectation,
	type AgentRuntimeLaunchFailure,
	type AgentRuntimeLaunchSelectionUpdateV1,
	type AgentRuntimeLaunchSelectionView,
	agentRuntimeLaunchFailure,
	agentRuntimeLaunchRejected,
} from "@/lib/agents/agentRuntimeLaunchSelection";
import { requestAgentLaunchSelectionChange } from "@/lib/agents/agentRuntimeLaunchSelectionChange";
import { agentRuntimePaneActionOwnerKey } from "@/lib/agents/agentRuntimePaneAction";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import {
	type AgentRuntimeTransitionObserver,
	type AgentRuntimeTransitionRequest,
	recoverStructuredAgentRuntimeProjection,
	transitionAgentRuntime,
} from "@/lib/agents/agentRuntimeTransitionAction";
import type { DureAgentRuntimeSourceStopPolicyV1 } from "@/lib/ipc/dureAgentRuntime";
import { sameDureBackendRouteAuthority } from "@/lib/ipc/dureBackendRoute";
import {
	applyDeferredCredentialSwitchNow,
	cancelDeferredCredentialSwitch,
} from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { useStore } from "@/store";
import type { Agent } from "@/types";

type PanelRuntimeTransitionRequest = Omit<
	AgentRuntimeTransitionRequest,
	"agentId"
> & {
	requestedAgentId: string;
};

interface LaunchActionState {
	readonly request: number;
	readonly ownerKey: string | null;
	readonly boundary?: AgentRuntimeLaunchPresentation;
	readonly switching: boolean;
	readonly error: AgentRuntimeLaunchFailure | null;
}

function launchActionBoundaryMatches(
	current: AgentRuntimeLaunchPresentation | undefined,
	action: LaunchActionState,
) {
	if (!action.boundary) {
		return !current || current.ownerKey !== action.ownerKey;
	}
	return (
		current?.ownerKey === action.boundary.ownerKey &&
		current.selectionRevision === action.boundary.selectionRevision &&
		sameDureBackendRouteAuthority(
			current.routeAuthority,
			action.boundary.routeAuthority,
		)
	);
}

export function useAgentPanelState(agentId: string, panelId: string) {
	const agent = useStore((state) =>
		state.agents.find((candidate) => candidate.id === agentId),
	);
	const structuredBackendProfileId =
		agent?.interactionProfile?.backendProfileId;
	const structuredInteractionSessionId =
		agent?.interactionProfile?.interactionSessionId;
	const runtimePresentationOwnerKey = agent
		? agentRuntimePresentationOwnerKey(agent)
		: null;
	const {
		launchState,
		setLaunchState,
		retryHydration: retryLaunchHydration,
	} = useAgentRuntimeLaunchSelectionHydration({
		agentId,
		ownerKey: runtimePresentationOwnerKey,
		backendProfileId: structuredBackendProfileId,
		interactionSessionId: structuredInteractionSessionId,
		isCurrentSource: isCurrentStructuredLaunchSelectionSource,
		recoverRuntimeProjection: recoverStructuredAgentRuntimeProjection,
	});
	const transitionRuntime = useCallback(
		async (
			{ requestedAgentId, ...request }: PanelRuntimeTransitionRequest,
			observer?: AgentRuntimeTransitionObserver,
		) => {
			if (requestedAgentId !== agentId) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			return await transitionAgentRuntime({ ...request, agentId }, observer);
		},
		[agentId],
	);
	const onStructuredRuntimeInvalidated = useStructuredAgentRuntimeInvalidation({
		agentId,
		setLaunchState,
		getAgent: getAgentById,
		recover: recoverStructuredAgentRuntimeProjection,
	});
	const switchAgentToStructuredChat = useCallback(
		async (
			requestedAgentId: string,
			targetCredentialId: string | null,
			sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1 = "preserve",
			expectedSourceRevision?: number,
		) => {
			if (requestedAgentId !== agentId) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			await transitionRuntime({
				requestedAgentId,
				targetInteractionProfile: "structured_protocol",
				sourceStopPolicy,
				expectedSourceRevision,
				credentialAction: { targetCredentialId },
			});
		},
		[agentId, panelId, transitionRuntime],
	);
	const switchStructuredAgentToNativeTerminal = useCallback(
		async (
			requestedAgentId: string,
			sourceStopPolicy: DureAgentRuntimeSourceStopPolicyV1 = "preserve",
			expectedSourceRevision?: number,
		) => {
			await transitionRuntime({
				requestedAgentId,
				targetInteractionProfile: "native_cli",
				sourceStopPolicy,
				expectedSourceRevision,
			});
		},
		[transitionRuntime],
	);
	const switchAgentCredential = useCallback(
		async (
			requestedAgentId: string,
			targetCredentialId: string | null,
			sourcePanelId: string,
		) => {
			if (requestedAgentId !== agentId) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
			return await requestAgentCredentialTransition({
				agentId,
				targetCredentialId,
				sourcePanelId,
			});
		},
		[agentId],
	);
	const launchActionRequest = useRef(0);
	const activeLaunchAction = useRef<LaunchActionState | undefined>(undefined);
	const [launchActionState, setLaunchActionState] =
		useState<LaunchActionState>();
	const switchLaunchSelection = useCallback(
		(
			update: AgentRuntimeLaunchSelectionUpdateV1,
			expected?: AgentRuntimeLaunchExpectation,
		) => {
			const current = getAgentById(agentId);
			const actionOwnerKey = current
				? agentRuntimePresentationOwnerKey(current)
				: null;
			const actionRequest = ++launchActionRequest.current;
			const actionPresentation =
				useStore.getState().agentRuntimeLaunchPresentation[agentId];
			const boundary =
				actionPresentation?.ownerKey === actionOwnerKey
					? actionPresentation
					: undefined;
			const action: LaunchActionState = {
				request: actionRequest,
				ownerKey: actionOwnerKey,
				...(boundary ? { boundary } : {}),
				switching: true,
				error: null,
			};
			activeLaunchAction.current = action;
			setLaunchActionState(action);
			const isCurrentAction = () => {
				const active = activeLaunchAction.current;
				if (!active || active.request !== actionRequest) return false;
				const latest = getAgentById(agentId);
				if (
					launchActionRequest.current !== actionRequest ||
					!latest ||
					agentRuntimePresentationOwnerKey(latest) !== active.ownerKey
				) {
					return false;
				}
				const presentation =
					useStore.getState().agentRuntimeLaunchPresentation[agentId];
				return launchActionBoundaryMatches(presentation, active);
			};
			const onSourceProjection = (source: AgentRuntimeLaunchPresentation) => {
				const active = activeLaunchAction.current;
				if (!active || active.request !== actionRequest) return;
				const observed: LaunchActionState = {
					...active,
					ownerKey: source.ownerKey,
					boundary: source,
				};
				activeLaunchAction.current = observed;
				setLaunchActionState(observed);
			};
			return requestAgentLaunchSelectionChange(
				{
					agentId,
					panelId,
					update,
					expected,
					isCurrent: isCurrentAction,
				},
				{ onSourceProjection },
			)
				.catch((error) => {
					if (!isCurrentAction()) return agentRuntimeLaunchRejected(error);
					setLaunchActionState((state) => {
						if (!state || state.request !== actionRequest) return state;
						const failed = {
							...state,
							switching: false,
							error: agentRuntimeLaunchFailure(error),
						};
						activeLaunchAction.current = failed;
						return failed;
					});
					return agentRuntimeLaunchRejected(error);
				})
				.finally(() => {
					if (!isCurrentAction()) return;
					setLaunchActionState((state) => {
						if (!state || state.request !== actionRequest || !state.switching) {
							return state;
						}
						const settled = { ...state, switching: false };
						activeLaunchAction.current = settled;
						return settled;
					});
				});
		},
		[agentId, panelId],
	);
	const committedLaunchPresentation = useStore(
		(state) => state.agentRuntimeLaunchPresentation[agentId],
	);
	const launchActionIsCurrent =
		launchActionState?.ownerKey === runtimePresentationOwnerKey &&
		launchActionBoundaryMatches(committedLaunchPresentation, launchActionState);
	const dismissLaunchError = useCallback(
		() =>
			setLaunchActionState((state) => {
				if (!state) return state;
				const dismissed = { ...state, error: null };
				activeLaunchAction.current = dismissed;
				return dismissed;
			}),
		[],
	);
	const launchSelection: AgentRuntimeLaunchSelectionView = {
		...(agent?.pendingCredentialSwitch?.targetLaunchSelection
			? {
					pending: {
						requestId: agent.pendingCredentialSwitch.requestId,
						selection: agent.pendingCredentialSwitch.targetLaunchSelection,
						error: agent.pendingCredentialSwitch.lastError,
					},
					cancelPending: () =>
						cancelDeferredCredentialSwitch(
							agentId,
							agent.pendingCredentialSwitch?.requestId,
						),
					applyPendingNow: () =>
						applyDeferredCredentialSwitchNow(
							agentId,
							agent.pendingCredentialSwitch?.requestId,
						),
				}
			: {}),
		ownerKey: agent ? agentRuntimePaneActionOwnerKey(agent) : undefined,
		paneId: panelId,
		...(launchState.loaded
			? { selectionRevision: launchState.selectionRevision }
			: {}),
		conversationId: agent ? managedConversationId(agent) : undefined,
		loaded: launchState.loaded,
		hydrationError: launchState.hydrationError,
		model: launchState.model,
		effort: launchState.effort,
		permissionMode: launchState.permissionMode,
		switching: launchActionIsCurrent && launchActionState?.switching === true,
		error: launchActionIsCurrent
			? (launchActionState?.error?.detail ?? null)
			: null,
		errorMessage: launchActionIsCurrent
			? launchActionState?.error?.message
			: undefined,
		switchSelection: switchLaunchSelection,
		retryHydration: retryLaunchHydration,
		dismissError: dismissLaunchError,
	};

	return {
		agent,
		backendManaged: agent?.runtimeBinding?.runtime === "hmux_managed_v1",
		launchSelection,
		onStructuredRuntimeInvalidated,
		switchAgentToStructuredChat,
		switchStructuredAgentToNativeTerminal,
		switchAgentCredential,
	};
}

export function useNativeAgentPanelState(agent: Agent) {
	const agentId = agent.id;
	const agentCwd = useStore((state) => state.sessionCwd[agent.sessionId]);
	const terminalTitle = useStore(
		(state) => state.sessionTitle[agent.sessionId],
	);
	const activity = useStore(
		(state) => state.agentActivity[agentId] ?? "connecting",
	);
	const agentRuntimeState = useStore(
		(state) => state.sessionAgentRuntimeState[agent.sessionId],
	);
	const sshError = useStore((state) => state.sshMessages[agent.sessionId]);
	const setAgentActivity = useStore((state) => state.setAgentActivity);
	const accounts = useStore((state) => state.accounts);
	const sshHosts = useStore((state) => state.sshHosts);
	const project = useStore((state) =>
		state.projects.find((candidate) => candidate.id === agent.projectId),
	);
	const restartReq = useStore((state) => state.restartRequests[agentId] ?? 0);
	return {
		agentCwd,
		terminalTitle,
		activity,
		agentRuntimeState,
		sshError,
		setAgentActivity,
		accounts,
		sshHosts,
		project,
		restartReq,
		getActiveSpaceId,
		getAgentById,
		getProjectSshHost,
		getProjectSshHostId,
	};
}

export function useStructuredAgentPanelState(agent: Agent) {
	const agentCwd = useStore((state) => state.sessionCwd[agent.sessionId]);
	const project = useStore((state) =>
		state.projects.find((candidate) => candidate.id === agent.projectId),
	);
	const accounts = useStore((state) => state.accounts);
	const sshHosts = useStore((state) => state.sshHosts);
	const setAgentActivity = useStore((state) => state.setAgentActivity);
	return {
		agentCwd,
		project,
		accounts,
		sshHosts,
		setAgentActivity,
		getActiveSpaceId,
	};
}

/** The usage-limit handoff opt-in (Settings › General). Read through this
 * cluster hook so the chat surface never imports the store directly. */
export function useAutoSwitchAccounts(): boolean {
	return useStore((state) => state.autoSwitchAccounts);
}

function getActiveSpaceId() {
	return useStore.getState().activeSpaceId;
}

function getAgentById(agentId: string) {
	return useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
}

function isCurrentStructuredLaunchSelectionSource(
	agentId: string,
	backendProfileId: string,
	interactionSessionId: string,
) {
	const profile = getAgentById(agentId)?.interactionProfile;
	return (
		profile?.kind === "structured_protocol" &&
		profile.backendProfileId === backendProfileId &&
		profile.interactionSessionId === interactionSessionId
	);
}

function getProjectSshHost(projectId: string | undefined) {
	const state = useStore.getState();
	const project = state.projects.find(
		(candidate) => candidate.id === projectId,
	);
	return state.sshHosts.find((host) => host.id === project?.sshHostId);
}

function getProjectSshHostId(projectId: string | undefined) {
	return useStore
		.getState()
		.projects.find((project) => project.id === projectId)?.sshHostId;
}
