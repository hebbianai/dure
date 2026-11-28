import type { DockviewApi } from "dockview-react";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import type { AgentRelationFacts } from "@/lib/agents/relations/agentRelationFacts";
import { track } from "@/lib/ipc/telemetry";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { workerColumnPosition } from "@/lib/workspace/dock/workerColumnPlacement";
import type { AgentPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import {
	clearPaneHiddenAfterRestore,
	useHiddenPanes,
} from "@/lib/workspace/pane/hiddenPanesStore";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import {
	type PanelPosition,
	type PanePresentation,
	placementOptions,
} from "@/lib/workspace/pane/panePlacement";
import { restorePanePreservingLayout } from "@/lib/workspace/pane/paneVisibility";
import type { Agent } from "@/types";

const AGENT_PANE_MINIMUM_SIZE = { width: 480, height: 300 } as const;

const NO_RELATION_FACTS: AgentRelationFacts = { agents: [], shells: [] };

export function openAgentPanelOnDockview(
	options: Parameters<typeof presentAgentPanelOnDockview>[0],
): string | false {
	const presentation = presentAgentPanelOnDockview(options);
	return presentation ? presentation.panel.id : false;
}

export function presentAgentPanelOnDockview({
	desktopId,
	api,
	agent,
	position,
	preferredPanelId,
	relationFacts = NO_RELATION_FACTS,
}: {
	readonly desktopId: string;
	readonly api: DockviewApi;
	readonly agent: Agent;
	readonly position?: PanelPosition;
	readonly preferredPanelId?: string;
	/** The client's relation facts, so a worker's new pane joins its lead's
	 * column. */
	readonly relationFacts?: AgentRelationFacts;
}): PanePresentation | false {
	const existing = findAgentPanel(api, agent.id);
	const record = useHiddenPanes.getState().hidden[agent.id];
	const hidden = record?.desktopId === desktopId ? record : undefined;
	const panelId =
		existing?.id ??
		hidden?.paneId ??
		position?.replacement?.id ??
		createPaneId();
	const anchor = hidden?.anchor;
	const restoredPosition: PanelPosition | undefined =
		anchor &&
		("floating" in anchor
			? { floating: anchor.floating }
			: api.getPanel(anchor.referencePanelId)
				? {
						referencePanel: anchor.referencePanelId,
						direction: anchor.direction,
					}
				: undefined);
	const opened = commitExplicitDockviewMutation({
		desktopId,
		api,
		mutate: () => {
			if (existing)
				return restorePanePreservingLayout(api, panelId) ? existing : false;
			const panel = addPanePreservingSizes(api, {
				id: panelId,
				component: "agent",
				title: agentDisplayName(agent),
				params: {
					agentRef: { agentId: agent.id },
				} satisfies AgentPaneParameters,
				...placementOptions(
					position ??
						restoredPosition ??
						workerColumnPosition(
							api,
							desktopId,
							agent,
							relationFacts,
							AGENT_PANE_MINIMUM_SIZE.height,
						) ??
						autoSplitPosition(api, {
							preferredPanelId,
							minimumSize: AGENT_PANE_MINIMUM_SIZE,
						}),
				),
			});
			return panel;
		},
		targetChangedError: () =>
			new PaneCommandError(
				"pane_changed",
				`desktop ${desktopId} changed while opening ${panelId}`,
			),
	});
	if (opened && hidden) clearPaneHiddenAfterRestore(agent.id);
	if (!opened) return false;
	const paneOwnership =
		existing || hidden || position?.replacement
			? "pre_existing"
			: "created_by_request";
	if (paneOwnership === "created_by_request") {
		track("agent_pane_opened", { provider: agent.provider });
	}
	return { panel: opened, paneOwnership };
}
