// A lead's new worker panes stack in a column to the lead's right, in start
// order. Only the new pane's position is chosen: existing panes keep their
// place (design/SOUL.md: nothing rearranges silently).
import type { DockviewApi } from "dockview-react";
import {
	createAgentRunLeadResolver,
	type RunParentedAgent,
} from "@/lib/agents/agentRunParent";
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

/** Where a new pane for `worker` goes when its lead has a pane in this grid:
 * beside the lead, after the lead's latest-started worker that has a grid
 * pane here (store order is start order). Undefined when the Agent is not a
 * worker or its lead has no pane here, so the caller keeps its own placement;
 * a worker is never sent to an unrelated group. */
export function workerColumnPosition(
	api: DockviewApi,
	worker: RunParentedAgent,
	agents: readonly RunParentedAgent[],
	minimumHeight: number,
): PanelPosition | undefined {
	if (!worker.runParent) return undefined;
	const leadOf = createAgentRunLeadResolver(agents);
	const lead = leadOf(worker);
	const leadGroup = lead && gridGroupOf(api, lead.id);
	if (!lead || !leadGroup) return undefined;
	let lastWorkerGroup: ReturnType<typeof gridGroupOf>;
	for (const agent of agents) {
		if (agent.id === worker.id || leadOf(agent)?.id !== lead.id) continue;
		const group = gridGroupOf(api, agent.id);
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
