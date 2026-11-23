import { useMemo } from "react";
import type { AgentForkPresenter } from "@/components/agents/AgentContextMenu";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import type { NativeAgentToolbarRuntime } from "@/components/panels/NativeAgentToolbar";
import type { StructuredAgentViewRuntime } from "@/components/panels/StructuredAgentView";
import { useAgentSessionPaneMirror } from "@/components/workspace/useAgentSessionPaneChannel";
import { useAgentSessionWindowLaunchSelection } from "@/components/workspace/useAgentSessionWindowLaunchSelection";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { STRUCTURED_AGENT_PANE_UNAVAILABLE } from "@/lib/agents/chat/structuredAgentPaneSurface";
import { t } from "@/lib/i18n";
import { rehydrateDurableStore } from "@/lib/persistence/durableStoreRehydration";
import {
	agentSessionWindowCredentialPort,
	agentSessionWindowProjectMovePort,
	agentSessionWindowViewPort,
	requestAgentSessionForkPresentation,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import { agentSessionWindowChatPane } from "@/lib/workspace/window/agentSessionWindowPaneMirrors";
import type { Agent } from "@/types";

/** The large window's side of the Agent's one toolbar. It owns no runtime:
 * every control that changes the Agent runs in the window that owns the
 * source pane, over the agent-session bridge, and this window follows the
 * durable Agent that window commits. */
export function useAgentSessionWindowToolbarRuntime(
	agent: Agent,
	source: { windowLabel: string; paneOwnerId?: string },
): NativeAgentToolbarRuntime {
	const [ownedTransitioning, setTransitioning] = useRuntimeOwnedValue<boolean>(
		agentRuntimePresentationOwnerKey(agent),
	);
	const agentId = agent.id;
	const { windowLabel, paneOwnerId } = source;
	const ports = useMemo(() => {
		const route = {
			agentId,
			sourceWindowLabel: windowLabel,
			...(paneOwnerId ? { sourcePaneOwnerId: paneOwnerId } : {}),
		};
		return {
			account: agentSessionWindowCredentialPort(route),
			view: agentSessionWindowViewPort(route),
			projectMove: agentSessionWindowProjectMovePort(route),
		};
	}, [agentId, windowLabel, paneOwnerId]);
	const launchSelection = useAgentSessionWindowLaunchSelection({
		agentId,
		sourceWindowLabel: windowLabel,
		...(paneOwnerId ? { sourcePaneOwnerId: paneOwnerId } : {}),
	});
	return {
		surface: "large_window",
		...(paneOwnerId
			? {}
			: { sourceUnavailableTitle: t("workspace.agentWindow.sourcePaneMissing") }),
		// A launch change the source pane runs is a runtime transition there,
		// so it locks this window's controls as it locks the pane's.
		transitioning:
			(ownedTransitioning ?? false) ||
			launchSelection?.presentation.switching === true,
		setTransitioning,
		conversationViewDisabled: false,
		presentFork: largeWindowForkPresenter(agentId, source),
		account: ports.account,
		view: ports.view,
		projectMove: ports.projectMove,
		...(launchSelection ? { launchSelection } : {}),
	};
}

/** A fork made from the large window opens in the source pane's window. */
function largeWindowForkPresenter(
	agentId: string,
	{ windowLabel, paneOwnerId }: { windowLabel: string; paneOwnerId?: string },
): AgentForkPresenter {
	return async (forkedAgent) => {
		if (!paneOwnerId) {
			throw new Error(t("workspace.agentWindow.forkPresentationFailed"));
		}
		await rehydrateDurableStore();
		await requestAgentSessionForkPresentation({
			agentId,
			forkedAgentId: forkedAgent.id,
			sourceWindowLabel: windowLabel,
			sourcePaneOwnerId: paneOwnerId,
		});
	};
}

/** The large window's side of a Chat Agent's view. It owns no runtime: it
 * renders the surface the source pane publishes, every command runs on that
 * pane's own handlers over the agent-session bridge, and the window follows
 * the durable Agent that pane commits. */
export function useAgentSessionWindowChatRuntime(
	agent: Agent,
	source: { windowLabel: string; paneOwnerId?: string },
): StructuredAgentViewRuntime {
	const [ownedTransitioning, setTransitioning] = useRuntimeOwnedValue<boolean>(
		agentRuntimePresentationOwnerKey(agent),
	);
	const agentId = agent.id;
	const { windowLabel, paneOwnerId } = source;
	const ports = useMemo(() => {
		const route = {
			agentId,
			sourceWindowLabel: windowLabel,
			...(paneOwnerId ? { sourcePaneOwnerId: paneOwnerId } : {}),
		};
		return {
			pane: agentSessionWindowChatPane(route),
			projectMove: agentSessionWindowProjectMovePort(route),
		};
	}, [agentId, windowLabel, paneOwnerId]);
	const presentation = useAgentSessionPaneMirror(ports.pane);
	const sourceMissing = t("workspace.agentWindow.sourcePaneMissing");
	return {
		surface: "large_window",
		...(paneOwnerId ? {} : { sourceUnavailableTitle: sourceMissing }),
		pane: {
			// Until the source pane answers, nothing is offered and every move
			// is locked rather than guessed.
			presentation: presentation ?? STRUCTURED_AGENT_PANE_UNAVAILABLE,
			run: async (command) => {
				if (!ports.pane) throw new Error(sourceMissing);
				return ports.pane.run(command);
			},
		},
		presentFork: largeWindowForkPresenter(agentId, source),
		projectMove: ports.projectMove,
		transitioning: ownedTransitioning ?? false,
		setTransitioning,
	};
}
