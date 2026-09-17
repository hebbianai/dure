import { useEffect } from "react";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { isPanelApiInView } from "@/lib/workspace/layout/agentPaneLocations";

export interface AgentPaneAttentionApi {
	readonly isActive: boolean;
	readonly isVisible: boolean;
	onDidActiveChange(listener: () => void): { dispose(): void };
	onDidVisibilityChange(listener: () => void): { dispose(): void };
}

/** A visible, focused pane acknowledges each attention episode exactly where
 * notification suppression makes the same user-presence decision. */
export function useAgentPaneAttentionAck(
	agentId: string,
	api: AgentPaneAttentionApi,
): void {
	const attentionEpisode = useAgentAttention(
		(state) => state.episodes[agentId] ?? 0,
	);
	useEffect(() => {
		const acknowledgeIfVisible = () => {
			if (isPanelApiInView(api, document.hasFocus())) {
				useAgentAttention.getState().ack(agentId);
			}
		};
		acknowledgeIfVisible();
		const activeDisposable = api.onDidActiveChange(acknowledgeIfVisible);
		const visibleDisposable = api.onDidVisibilityChange(acknowledgeIfVisible);
		window.addEventListener("focus", acknowledgeIfVisible);
		return () => {
			activeDisposable.dispose();
			visibleDisposable.dispose();
			window.removeEventListener("focus", acknowledgeIfVisible);
		};
	}, [agentId, api, attentionEpisode]);
}
