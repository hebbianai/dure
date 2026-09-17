import { launchDiscoveredLocalConversationPane } from "@/lib/sessions/launch/discoveredConversationLaunch";
import type { RecentSessionDragPayload } from "@/lib/sessions/recentSessionDrag";
import { recentSessionAgentExecutionMatches } from "@/lib/sessions/recentSessionPanePresence";
import { openAgentPanel, openAgentPanelOnDesktop } from "@/lib/workspace/dock";
import { mountedDockviewEntries } from "@/lib/workspace/dock/dockRegistry";
import { navigateToPanel } from "@/lib/workspace/dock/panelFocusHandoff";
import { agentPaneLocations } from "@/lib/workspace/layout/agentPaneLocations";
import {
	movePanelToDesktopDrop,
	movePanelWithinDesktopDrop,
} from "@/lib/workspace/pane/paneDropCoordinator";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import type { Agent } from "@/types";

export interface RecentSessionPaneTarget {
	desktopId: string;
	position?: PanelPosition;
}

function agentPane(agentId: string) {
	return agentPaneLocations(
		useStore.getState().layouts,
		mountedDockviewEntries(),
	).find((pane) => pane.agentId === agentId);
}

async function placeAgentPane(
	agent: Agent,
	target: RecentSessionPaneTarget,
	paneExistedBeforeLaunch: boolean,
): Promise<void> {
	const existing = agentPane(agent.id);
	if (existing) {
		const { desktopId: existingDesktopId, panelId } = existing;
		if (target.position) {
			if (existingDesktopId === target.desktopId) {
				if (paneExistedBeforeLaunch) {
					movePanelWithinDesktopDrop(
						{ panelId, fromDesktopId: existingDesktopId },
						target.desktopId,
						target.position,
					);
				}
				navigateToPanel(existingDesktopId, panelId);
				return;
			}
			const receipt = await movePanelToDesktopDrop(
				{ panelId, fromDesktopId: existingDesktopId },
				target.desktopId,
				target.position,
			);
			if (!receipt.movedPanelIds.includes(panelId)) {
				throw new Error(
					receipt.error?.code ?? "recent_session_pane_move_was_not_committed",
				);
			}
			navigateToPanel(target.desktopId, panelId);
			return;
		}
		navigateToPanel(existingDesktopId, panelId);
		return;
	}
	if (target.position) {
		if (!openAgentPanel(target.desktopId, agent, target.position)) {
			throw new Error("recent_session_drop_target_is_not_mounted");
		}
		return;
	}
	openAgentPanelOnDesktop(target.desktopId, agent);
}

/** Resolve the exact current owner at activation time, then reveal, create, or
 * move its single pane. Click callers omit position and only navigate; drag
 * callers provide the existing Workspace drop position. */
export async function launchRecentSessionPane(
	payload: RecentSessionDragPayload,
	target: RecentSessionPaneTarget,
): Promise<Agent> {
	const initial = useStore.getState();
	if (payload.ownerAgentId) {
		const owner = initial.agents.find(
			(candidate) => candidate.id === payload.ownerAgentId,
		);
		const project = initial.projects.find(
			(candidate) => candidate.id === owner?.projectId,
		);
		if (
			!owner ||
			!recentSessionAgentExecutionMatches(owner, project, payload)
		) {
			throw new Error("recent_session_owner_changed");
		}
		const hadPane = agentPane(owner.id) !== undefined;
		await placeAgentPane(owner, target, hadPane);
		return owner;
	}
	if (payload.executionLocation !== "local") {
		throw new Error("recent_session_remote_registration_required");
	}

	const panesBeforeLaunch = new Set(
		agentPaneLocations(initial.layouts, mountedDockviewEntries()).map(
			(pane) => pane.agentId,
		),
	);
	// Provider history supplies the exact conversation and cwd. Other Agents in
	// that folder are not launch prerequisites; the launch resolves only the
	// selected conversation's current owner before admitting a new Hmux session.
	const opened = await launchDiscoveredLocalConversationPane({
		provider: payload.provider,
		conversationId: payload.conversationId,
		cwd: payload.cwd,
		workspaceRoot: payload.workspaceRoot,
		desktopId: target.desktopId,
		existingOwner: "return",
		...(target.position ? { position: target.position } : {}),
	});
	await placeAgentPane(opened, target, panesBeforeLaunch.has(opened.id));
	return opened;
}
