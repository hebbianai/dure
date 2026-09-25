import {
	type DureAgentRuntimeLaunchSelectionV1,
	DureAgentRuntimeSourceActiveError,
} from "@/lib/ipc/dureAgentRuntime";
import { evaluateDeferredCredentialSwitchIntent } from "@/lib/sessions/credentials/deferredCredentialSwitch";
import {
	cancelDeferredCredentialSwitch,
	scheduleBusyAgentCredentialSwitch,
} from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { managedConversationId } from "@/lib/sessions/managed/managedConversationIdentity";
import { withManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import type { PaneActionExecution } from "@/lib/workspace/pane/paneAction";
import { useStore } from "@/store";
import { agentCredentialReferenceId } from "./agentLaunchCredential";
import {
	type AgentRuntimeLaunchExpectation,
	type AgentRuntimeLaunchSelectionUpdateV1,
	agentRuntimeLaunchApplied,
} from "./agentRuntimeLaunchSelection";
import {
	type AgentRuntimeTransitionObserver,
	transitionAgentRuntime,
} from "./agentRuntimeTransitionAction";

/** Settings share the existing durable account-change queue and stop boundary.
 * Active work and retained input enqueue; neither permits discarding the source. */
export function requestAgentLaunchSelectionChange(
	{
		agentId,
		panelId,
		update,
		expected,
		isCurrent = () => true,
	}: {
		agentId: string;
		panelId: string;
		update: AgentRuntimeLaunchSelectionUpdateV1;
		expected?: AgentRuntimeLaunchExpectation;
		isCurrent?(): boolean;
	},
	observer?: AgentRuntimeTransitionObserver,
): Promise<PaneActionExecution> {
	return withManagedCredentialSwitchTransition(agentId, async () => {
		let sourceRevision: number | undefined;
		let target: DureAgentRuntimeLaunchSelectionV1 | undefined;
		const initial = useStore
			.getState()
			.agents.find((agent) => agent.id === agentId);
		const previous = initial?.pendingCredentialSwitch;
		const conversationId = initial ? managedConversationId(initial) : undefined;
		const assertCurrent = () => {
			const state = useStore.getState();
			const current = state.agents.find((agent) => agent.id === agentId);
			if (
				!isCurrent() ||
				!current ||
				current.pendingCredentialSwitch?.requestId !== previous?.requestId ||
				(previous &&
					evaluateDeferredCredentialSwitchIntent(
						previous,
						current,
						state.accounts,
						state.sessionAgentRuntimeState[current.sessionId],
					).kind === "stale")
			) {
				throw new Error("client_agent_runtime_transition_conflict");
			}
		};
		assertCurrent();
		try {
			const result = await transitionAgentRuntime(
				{
					agentId,
					targetInteractionProfile: "preserve",
					expectedSourceRevision: previous?.sourceSelectionRevision,
					...expected,
					beforeTransition: assertCurrent,
					...(previous &&
					previous.targetCredentialId !== previous.sourceCredentialId
						? {
								credentialAction: {
									targetCredentialId: previous.targetCredentialId,
								},
							}
						: {}),
					targetLaunchSelectionUpdate: (source) => {
						if (
							previous?.sourceSelectionRevision !== undefined &&
							previous.sourceSelectionRevision !== sourceRevision
						) {
							throw new Error("client_agent_runtime_transition_conflict");
						}
						const base = previous?.targetLaunchSelection ?? source;
						const selection = update(base);
						target = {
							...selection,
							permissionMode: selection.permissionMode ?? source.permissionMode,
						};
						return target;
					},
				},
				{
					onSourceProjection: (source) => {
						sourceRevision = source.selectionRevision;
						observer?.onSourceProjection?.(source);
					},
				},
			);
			if (previous) cancelDeferredCredentialSwitch(agentId, previous.requestId);
			return agentRuntimeLaunchApplied(result, sourceRevision);
		} catch (error) {
			if (
				!(error instanceof DureAgentRuntimeSourceActiveError) ||
				error.expectedSourceRevision === undefined ||
				!target ||
				!conversationId
			)
				throw error;
			assertCurrent();
			const scheduled = await scheduleBusyAgentCredentialSwitch(
				agentId,
				initial ? (agentCredentialReferenceId(initial) ?? null) : null,
				panelId,
				error.expectedSourceRevision,
				{ selection: target, conversationId, beforeQueue: assertCurrent },
			);
			if (!scheduled) throw error;
			return {
				outcome: "pending",
				value: { conversationId: scheduled.conversationId, settings: target },
			};
		}
	});
}
