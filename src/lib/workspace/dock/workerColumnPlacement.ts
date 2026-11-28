// A lead's new worker panes stack in a column to the lead's right, in start
// order. The lead is an Agent's pane or a plain shell pane. Only the new
// pane's position is chosen: existing panes keep their place (design/SOUL.md:
// nothing rearranges silently).
import type { DockviewApi, IDockviewPanel } from "dockview-react";
import type { RunParentedAgent } from "@/lib/agents/agentRunParent";
import {
	type AgentRelationFacts,
	agentRelationsOf,
} from "@/lib/agents/relations/agentRelationFacts";
import { findAgentPanel } from "@/lib/workspace/dock/dockPanelParameters";
import { restoreMaximizedPane } from "@/lib/workspace/pane/paneMaximize";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";

interface WorkerColumnGroup {
	readonly id: string;
	readonly height: number;
}

interface WorkerColumnChoice {
	readonly referenceGroupId: string;
	readonly direction: "right" | "below" | "within";
}

/** The first worker opens the column to the right of the lead's group. Each
 * later worker splits the column's last group while both halves stay at least
 * `minimumHeight` tall, and otherwise joins that group as a tab. A group not
 * measured yet is split. */
function pickWorkerColumnPlacement(
	leadGroupId: string,
	lastWorkerGroup: WorkerColumnGroup | undefined,
	minimumHeight: number,
): WorkerColumnChoice {
	if (!lastWorkerGroup) {
		return { referenceGroupId: leadGroupId, direction: "right" };
	}
	const { id, height } = lastWorkerGroup;
	const measured = Number.isFinite(height) && height > 0;
	return {
		referenceGroupId: id,
		direction: !measured || height / 2 >= minimumHeight ? "below" : "within",
	};
}

function gridGroupOf(panel: IDockviewPanel | undefined) {
	const group = panel?.group;
	return group?.api.location.type === "grid" && group.api.isVisible !== false
		? group
		: undefined;
}

/** The pane of a relation node in this Space: an Agent's pane, or the shell
 * pane a shell node names when it is in this Space. */
function relationNodePanel(
	api: DockviewApi,
	desktopId: string,
	shells: AgentRelationFacts["shells"],
): (key: string) => IDockviewPanel | undefined {
	const shellPanels = new Map(
		shells.flatMap((shell) =>
			shell.desktopId === desktopId ? [[shell.key, shell.panelId]] : [],
		),
	);
	return (key) => {
		const panelId = shellPanels.get(key);
		return panelId === undefined ? findAgentPanel(api, key) : api.getPanel(panelId);
	};
}

/** Where a new pane for `worker` goes when its lead — its display manager —
 * has a pane in this grid: beside the lead, after the lead's latest-started
 * worker that has a grid pane here (store order is start order). Undefined
 * when the Agent has no manager or its lead has no pane here, so the caller
 * keeps its own placement; a worker is never sent to an unrelated group. */
export function workerColumnPosition(
	api: DockviewApi,
	desktopId: string,
	worker: RunParentedAgent,
	facts: AgentRelationFacts,
	minimumHeight: number,
): PanelPosition | undefined {
	// A worker not registered yet starts after every Agent there is.
	const relations = agentRelationsOf(
		facts.agents.some((agent) => agent.id === worker.id)
			? facts
			: { ...facts, agents: [...facts.agents, worker] },
	);
	const leadId = relations.managerOf(worker.id);
	if (leadId === undefined) return undefined;
	const panelOf = relationNodePanel(api, desktopId, facts.shells);
	const leadGroup = gridGroupOf(panelOf(leadId));
	if (!leadGroup) return undefined;
	let lastWorkerGroup: ReturnType<typeof gridGroupOf>;
	for (const memberId of relations.managedBy(leadId)) {
		if (memberId === worker.id) continue;
		const group = gridGroupOf(panelOf(memberId));
		if (group && group.id !== leadGroup.id) lastWorkerGroup = group;
	}
	// Measure the real layout, as autoSplitPosition does.
	restoreMaximizedPane(api);
	const choice = pickWorkerColumnPlacement(
		leadGroup.id,
		lastWorkerGroup && {
			id: lastWorkerGroup.id,
			height: lastWorkerGroup.api.height,
		},
		minimumHeight,
	);
	return {
		referenceGroup: choice.referenceGroupId,
		direction: choice.direction,
	};
}
