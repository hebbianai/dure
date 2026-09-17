import { onboardingImportLayoutPlan } from "@/lib/onboarding/onboardingImportDraft";
import type { OnboardingImportDesktopDraft } from "@/lib/onboarding/onboardingImportDraft";
import { agentDisplayName } from "@/lib/agents/agentDisplayName";
import type { AgentPaneParameters } from "@/lib/workspace/layout/agentPaneParameters";
import type { Agent } from "@/types";

const LAYOUT_WIDTH = 1200;
const LAYOUT_HEIGHT = 800;

interface SerializedLeaf {
	type: "leaf";
	data: {
		id: string;
		views: string[];
		activeView: string;
	};
	size: number;
}

interface SerializedBranch {
	type: "branch";
	data: Array<SerializedLeaf | SerializedBranch>;
	size: number;
}

export interface OnboardingImportAgentPane {
	paneKey: string;
	paneId: string;
	agent: Agent;
}

/** Build the exact persisted Dockview geometry shown by the onboarding preview.
 * Columns are the primary unit; a single pane in the final column fills its
 * complete height instead of leaving an empty grid cell. */
export function serializeOnboardingImportLayout(
	desktop: OnboardingImportDesktopDraft,
	panes: readonly OnboardingImportAgentPane[],
): unknown {
	const plan = onboardingImportLayoutPlan(desktop);
	const panesByKey = new Map(panes.map((pane) => [pane.paneKey, pane]));
	const cellsByColumn = new Map<number, typeof plan.cells>();
	for (const cell of plan.cells) {
		const column = cellsByColumn.get(cell.column) ?? [];
		cellsByColumn.set(cell.column, [...column, cell]);
	}

	const panels: Record<string, unknown> = {};
	const addPanel = (paneKey: string): OnboardingImportAgentPane => {
		const pane = panesByKey.get(paneKey);
		if (!pane) throw new Error(`onboarding pane agent missing: ${paneKey}`);
		panels[pane.paneId] = {
			id: pane.paneId,
			contentComponent: "agent",
			title: agentDisplayName(pane.agent),
			params: {
				agentRef: { agentId: pane.agent.id },
			} satisfies AgentPaneParameters,
		};
		return pane;
	};
	const leaves = new Map<string, SerializedLeaf>();
	for (const cell of plan.cells) {
		const { agent, paneId: panelId } = addPanel(cell.paneKey);
		const groupId = `group:${agent.id}`;
		const leaf: SerializedLeaf = {
			type: "leaf",
			data: { id: groupId, views: [panelId], activeView: panelId },
			size: Math.floor(LAYOUT_HEIGHT / plan.rows),
		};
		leaves.set(cell.paneKey, leaf);
	}

	const tabTarget = plan.cells[plan.cells.length - 1];
	if (tabTarget) {
		const leaf = leaves.get(tabTarget.paneKey);
		if (!leaf) throw new Error("onboarding tab target is missing");
		for (const paneKey of plan.tabbedPaneKeys) {
			leaf.data.views.push(addPanel(paneKey).paneId);
		}
	}

	const columns = [...cellsByColumn.entries()]
		.sort(([left], [right]) => left - right)
		.map(([, cells]) => {
			const rows = [...cells]
				.sort((left, right) => left.row - right.row)
				.map((cell) => leaves.get(cell.paneKey));
			if (rows.some((row) => !row)) {
				throw new Error("onboarding layout row is missing");
			}
			const exactRows = rows as SerializedLeaf[];
			if (exactRows.length === 1) {
				return { ...exactRows[0], size: Math.floor(LAYOUT_WIDTH / plan.columns) };
			}
			return {
				type: "branch" as const,
				data: exactRows,
				size: Math.floor(LAYOUT_WIDTH / plan.columns),
			};
		});

	if (columns.length === 0) throw new Error("onboarding layout has no panes");
	const firstLeaf = leaves.get(plan.cells[0].paneKey);
	if (!firstLeaf) throw new Error("onboarding active group is missing");
	// Dockview requires the serialized grid root to be a branch even when the
	// desktop contains exactly one pane. A leaf root is silently rejected by the
	// Workspace restore fallback and leaves that desktop mounted but empty.
	const root: SerializedBranch = {
		type: "branch",
		data: columns,
		size: LAYOUT_HEIGHT,
	};

	return {
		grid: {
			root,
			width: LAYOUT_WIDTH,
			height: LAYOUT_HEIGHT,
			orientation: "HORIZONTAL",
		},
		panels,
		activeGroup: firstLeaf.data.id,
	};
}
