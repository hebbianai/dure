import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { terminalInputLatency } from "@/lib/terminal/interaction/terminalInputLatency";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { useStore } from "@/store";

/** Read the existing projections and DOM in the owning window; never repair them. */
export function readCliPaneDiagnostics(paneId: string) {
	const state = useStore.getState();
	const panel = mountedDockviewEntries().map(([, api]) => api.getPanel(paneId)).find((panel) => panel !== undefined);
	const agentId = panel ? agentIdFromPane(dockPanelReference(panel)) : undefined;
	const agent = state.agents.find((candidate) => candidate.id === agentId);
	const surfaces = Array.from(
		document.querySelectorAll<HTMLElement>("[data-terminal-surface-id]"),
	).flatMap((surface) => {
		const surfaceId = surface.dataset.terminalSurfaceId;
		return surfaceId?.endsWith(`:pane:${paneId}`) ? [{ surface, surfaceId }] : [];
	});
	return {
		observedAtMs: Date.now(),
		documentFocused: document.hasFocus(),
		activity: agent
			? {
					sessionId: agent.sessionId,
					hostProjection: state.sessionAgentRuntimeState[agent.sessionId] ?? null,
					displayState:
						useAgentAttention.getState().displayStates[agent.id] ?? null,
					presentationActivity: state.agentActivity[agent.id] ?? null,
				}
			: null,
		inputs: surfaces.map(({ surface, surfaceId }) => {
			const input = surface.querySelector("textarea");
			return {
				surfaceId,
				focused: input !== null && document.activeElement === input,
				disabled: input?.disabled ?? null,
				readOnly: input?.readOnly ?? null,
				valueLength: input?.value.length ?? null,
				browserEvents: terminalInputLatency.browserInputSnapshot(surfaceId),
			};
		}),
	};
}
