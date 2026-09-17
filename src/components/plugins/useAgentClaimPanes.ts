import { useCallback, useSyncExternalStore } from "react";
import { AgentClaimPaneRegistry } from "@/lib/plugins/agentClaimPaneRegistry";
import { useHiddenPanes } from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

const panes = new AgentClaimPaneRegistry();
let consumers = 0;
let stopObserving: (() => void) | undefined;

function refresh() {
	const state = useStore.getState();
	panes.replaceSources({
		layouts: state.layouts,
		spaces: state.spaces,
		agents: state.agents,
		hidden: useHiddenPanes.getState().hidden,
	});
}

/** All mounted badge consumers share one source observation. Cold layouts
 * and hidden panes still participate in duplicate-branch matching. */
export function useMountedAgentClaimPanes(agentId: string, paneId: string) {
	const subscribe = useCallback(
		(listener: () => void) => {
			if (consumers++ === 0) {
				const stopMain = useStore.subscribe(refresh);
				const stopHidden = useHiddenPanes.subscribe(refresh);
				stopObserving = () => {
					stopHidden();
					stopMain();
				};
				refresh();
			}
			const releasePane = panes.mount(agentId, paneId);
			const unlisten = panes.subscribe(listener);
			return () => {
				unlisten();
				releasePane();
				if (--consumers === 0) {
					stopObserving?.();
					stopObserving = undefined;
					panes.replaceSources({
						layouts: {},
						spaces: [],
						agents: [],
						hidden: {},
					});
				}
			};
		},
		[agentId, paneId],
	);
	return useSyncExternalStore(subscribe, panes.getSnapshot, panes.getSnapshot);
}
