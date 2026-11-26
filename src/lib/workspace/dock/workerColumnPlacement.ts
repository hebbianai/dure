// A lead's new worker panes stack in a column to the lead's right, in start
// order. Only the new pane's position is chosen: existing panes keep their
// place (design/SOUL.md: nothing rearranges silently).
import type { DockviewApi } from "dockview-react";
import type { RunParentedAgent } from "@/lib/agents/agentRunParent";
import { agentRelationsOf } from "@/lib/agents/relations/agentRelationFacts";
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

function gridGroupOf(api: DockviewApi, agentId: string) {
	const group = findAgentPanel(api, agentId)?.group;
	return group?.api.location.type === "grid" && group.api.isVisible !== false
		? group
		: undefined;
}

/** Where a new pane for `worker` goes when its lead — its display manager —
 * has a pane in this grid: beside the lead, after the lead's latest-started
 * worker that has a grid pane here (store order is start order). Undefined
 * when the Agent has no manager or its lead has no pane here, so the caller
 * keeps its own placement; a worker is never sent to an unrelated group. */
export function workerColumnPosition(
	api: DockviewApi,
	worker: RunParentedAgent,
	agents: readonly RunParentedAgent[],
	minimumHeight: number,
): PanelPosition | undefined {
	// A worker not registered yet starts after every Agent there is.
	const relations = agentRelationsOf(
		agents.some((agent) => agent.id === worker.id)
			? agents
			: [...agents, worker],
	);
	const leadId = relations.managerOf(worker.id);
	if (leadId === undefined) return undefined;
	const leadGroup = gridGroupOf(api, leadId);
	if (!leadGroup) return undefined;
	let lastWorkerGroup: ReturnType<typeof gridGroupOf>;
	for (const agentId of relations.managedBy(leadId)) {
		if (agentId === worker.id) continue;
		const group = gridGroupOf(api, agentId);
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
