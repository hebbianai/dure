import { useMemo } from "react";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import type { NativeAgentToolbarRuntime } from "@/components/panels/NativeAgentToolbar";
import { useAgentSessionWindowLaunchSelection } from "@/components/workspace/useAgentSessionWindowLaunchSelection";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { t } from "@/lib/i18n";
import { rehydrateDurableStore } from "@/lib/persistence/durableStoreRehydration";
import {
	agentSessionWindowCredentialPort,
	agentSessionWindowProjectMovePort,
	agentSessionWindowViewPort,
	requestAgentSessionForkPresentation,
} from "@/lib/workspace/window/agentSessionWindowCommand";
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
		presentFork: async (forkedAgent) => {
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
		},
		account: ports.account,
		view: ports.view,
		projectMove: ports.projectMove,
		...(launchSelection ? { launchSelection } : {}),
	};
}
