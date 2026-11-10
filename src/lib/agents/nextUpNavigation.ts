import type { DockviewApi } from "dockview-react";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import {
	deriveNextUp,
	type NextUp,
	nextUpEntries,
	nextUpTarget,
} from "@/lib/agents/nextUp";
import { openAgentPanelOnDesktop } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { getDockview, mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { agentIdFromPane } from "@/lib/workspace/layout/agentPaneParameters";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import {
	type HiddenPaneRecord,
	useHiddenPanes,
} from "@/lib/workspace/pane/hiddenPanesStore";
import { useStore } from "@/store";

type AgentRevealTarget =
	| { kind: "pane"; desktopId: string; panelId: string }
	| { kind: "open"; desktopId: string };

export interface AgentRevealFacts {
	activeSpaceId: string;
	spaces: readonly { readonly id: string }[];
	layouts: Readonly<Record<string, unknown>>;
	hidden: Readonly<Record<string, HiddenPaneRecord>>;
	mounted?: Iterable<readonly [string, Pick<DockviewApi, "panels">]>;
}

/** Where revealing each agent lands, by the rule its Spaces row follows: its
 * pane wherever it lives (the active Space first), its hidden pane restored
 * in place, or a new pane in the active Space when it has none. Pane
 * locations are read once for the whole batch. */
export function agentRevealTargets(
	agentIds: readonly string[],
	{
		activeSpaceId,
		spaces,
		layouts,
		hidden,
		mounted = mountedDockviewEntries(),
	}: AgentRevealFacts,
): Map<string, AgentRevealTarget> {
	const spaceIds = new Set(spaces.map((space) => space.id));
	const locations = agentPaneLocations(layouts, mounted).filter((pane) =>
		spaceIds.has(pane.desktopId),
	);
	const targets = new Map<string, AgentRevealTarget>();
	for (const agentId of agentIds) {
		// A hidden pane stays mounted, but only the agent opener restores it and
		// retires its hidden record, so it is not a pane to focus. A record whose
		// Space is gone has nowhere to restore to.
		const record = hidden[agentId];
		const panes = locations.filter(
			(pane) => pane.agentId === agentId && pane.panelId !== record?.paneId,
		);
		const pane =
			panes.find((candidate) => candidate.desktopId === activeSpaceId) ??
			panes[0];
		targets.set(
			agentId,
			pane
				? { kind: "pane", desktopId: pane.desktopId, panelId: pane.panelId }
				: {
						kind: "open",
						desktopId:
							record && spaceIds.has(record.desktopId)
								? record.desktopId
								: activeSpaceId,
					},
		);
	}
	return targets;
}

function currentRevealFacts(): AgentRevealFacts {
	const state = useStore.getState();
	return {
		activeSpaceId: state.activeSpaceId,
		spaces: state.spaces,
		layouts: state.layouts,
		hidden: useHiddenPanes.getState().hidden,
	};
}

/** Brings an agent forward. Bringing its pane into view is also what
 * acknowledges its unread episode. */
export function revealAgent(agentId: string): boolean {
	const agent = useStore
		.getState()
		.agents.find((candidate) => candidate.id === agentId);
	const target = agentRevealTargets([agentId], currentRevealFacts()).get(agentId);
	if (!agent || !target) return false;
	if (target.kind === "pane") navigateToPanel(target.desktopId, target.panelId);
	else openAgentPanelOnDesktop(target.desktopId, agent);
	return true;
}

function readNextUp(): NextUp {
	const attention = useAgentAttention.getState();
	return deriveNextUp({
		agentIds: useStore.getState().agents.map((agent) => agent.id),
		displayStates: attention.displayStates,
		episodes: attention.episodes,
		acks: attention.acks,
		episodeKinds: attention.episodeKinds,
		episodeAt: attention.episodeAt,
		waitingSince: attention.waitingSince,
	});
}

/** Whether anything is waiting in the next-up order. */
export function hasNextUp(): boolean {
	return nextUpEntries(readNextUp()).length > 0;
}

/** Goes to the agent after the focused one in the next-up order. False when
 * nothing is waiting, so the caller can leave the key alone. */
export function goToNextUp(): boolean {
	const target = nextUpTarget(nextUpEntries(readNextUp()), focusedAgentId());
	return target ? revealAgent(target.agentId) : false;
}

function focusedAgentId(): string | undefined {
	const panel = getDockview(useStore.getState().activeSpaceId)?.activePanel;
	return panel ? agentIdFromPane(dockPanelReference(panel)) : undefined;
}
