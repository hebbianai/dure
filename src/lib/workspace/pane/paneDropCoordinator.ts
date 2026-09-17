import { agentForChatPane } from "@/lib/agents/chat/agentChatDraftInput";
import { withAgentChatDraftMoves } from "@/lib/agents/chat/agentChatDraftMoveCoordinator";
import { moveChatPaneFromDestination } from "@/lib/agents/chat/agentChatPaneDrop";
import {
	type DesktopPaneMoveItem,
	type MovePanelsToDesktopReceipt,
	moveFailure,
} from "@/lib/workspace/desktop/desktopPaneMove";
import { dockviewRegistry } from "@/lib/workspace/dock/dockRegistry";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import {
	rememberPaneFloatAnchor,
	takePaneFloatAnchor,
} from "@/lib/workspace/pane/paneFloatAnchor";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import { recordPaneMoveSnapshot } from "@/lib/workspace/pane/paneMoveUndo";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import { useStore } from "@/store";
import { commitDesktopPaneDrop } from "./paneDropCommit";

export type PaneDropPosition = PanelPosition;

type DockviewEdge = "left" | "right" | "top" | "bottom";

function dockviewEdge(direction: string | undefined): DockviewEdge | null {
	if (direction === "left" || direction === "right") return direction;
	if (direction === "above") return "top";
	if (direction === "below") return "bottom";
	return null;
}

/** Dockview 바깥(Spaces)에서 시작한 한 pane을 현재 데스크탑 안에서
 * 재배치한다. 공개 moveTo/addFloatingGroup API만 쓰며 무의미한 자기 그룹
 * drop은 성공으로 가장하지 않는다. */
export function movePanelWithinDesktopDrop(
	item: DesktopPaneMoveItem,
	targetDesktopId: string,
	position: PaneDropPosition,
): boolean {
	if (item.fromDesktopId !== targetDesktopId) return false;
	const api = dockviewRegistry.get(targetDesktopId);
	const panel = api?.getPanel(item.panelId);
	if (!api || !panel) return false;

	const edge = position.floating ? null : dockviewEdge(position.direction);
	if (!position.floating && !edge) return false;
	const reference = position.referenceGroup as
		| { id?: unknown }
		| string
		| undefined;
	const referenceId =
		typeof reference === "string"
			? reference
			: typeof reference?.id === "string"
				? reference.id
				: undefined;
	const targetGroup = referenceId ? api.getGroup(referenceId) : undefined;
	if (referenceId && !targetGroup) return false;
	if (targetGroup?.id === panel.group.id) return false;

	try {
		const before = api.toJSON();
		commitExplicitDockviewMutation({
			desktopId: targetDesktopId,
			api,
			mutate: () => {
				if (position.floating) {
					rememberPaneFloatAnchor(targetDesktopId, panel.id);
					api.addFloatingGroup(panel, {
						width: 560,
						height: 420,
						...position.floating,
					});
					return;
				}
				if (!edge) throw new Error("pane_drop_position_invalid");
				if (targetGroup) {
					panel.api.moveTo({ group: targetGroup as never, position: edge });
				} else {
					panel.group.api.moveTo({ position: edge });
				}
			},
			targetChangedError: () => new Error("pane_drop_target_changed"),
		});
		recordPaneMoveSnapshot(api, before);
		return true;
	} catch (error) {
		console.error(`[pane reorder:${targetDesktopId}]`, error);
		return false;
	}
}

/**
 * Cross-window drop transaction. The target Dockview accepts and serializes
 * the pane first. Only then does one durable update add that exact target
 * layout and remove the source, so target rejection leaves the source intact.
 */
export function movePanelToDesktopDrop(
	item: DesktopPaneMoveItem,
	targetDesktopId: string,
	position: PaneDropPosition,
): Promise<MovePanelsToDesktopReceipt> {
	return enqueuePaneMove(async () => {
		const agent = agentForChatPane({
			desktopId: item.fromDesktopId,
			panelId: item.panelId,
		});
		if (agent) {
			if (useStore.getState().chatDraftMoves[agent.id])
				throw new Error("This draft already has an unfinished move.");
			if (!dockviewRegistry.get(item.fromDesktopId)?.getPanel(item.panelId))
				return moveChatPaneFromDestination(
					agent,
					item,
					targetDesktopId,
					position,
				);
			return withAgentChatDraftMoves([item], targetDesktopId, () =>
				commitDesktopPaneDrop(item, targetDesktopId, position),
			);
		}
		return commitDesktopPaneDrop(item, targetDesktopId, position);
	}).catch((error) => {
		console.error(`[pane window drop:${targetDesktopId}]`, error);
		return moveFailure("move_execution_failed", targetDesktopId);
	});
}

/** Return a floating (overlay) pane to the grid — the explicit escape from
 * float, next to the pin/split actions on the pane chrome (2026-09-01 report:
 * the only way back was the undiscoverable shift+drag redock gesture). The
 * pane splits off the last grid group; with no grid group left it becomes the
 * grid root. Same public moveTo + explicit-commit idiom as drops above. */
export function dockFloatingPaneToGrid(
	desktopId: string,
	panelId: string,
): boolean {
	const api = dockviewRegistry.get(desktopId);
	const panel = api?.getPanel(panelId);
	if (!api || !panel) return false;
	if (panel.group.api.location.type !== "floating") return false;
	// The float-time anchor names the original neighbor, side, and footprint;
	// only when it is gone does the last grid group's right become the
	// fallback slot.
	const anchor = takePaneFloatAnchor(desktopId, panelId);
	const referenceGroup = anchor
		? api.getPanel(anchor.referencePanelId)?.group
		: undefined;
	const anchorGroup =
		referenceGroup?.api.location.type === "grid" ? referenceGroup : undefined;
	const gridGroups = api.groups.filter(
		(group) => group.api.location.type === "grid",
	);
	const gridGroup = gridGroups[gridGroups.length - 1];
	try {
		const before = api.toJSON();
		commitExplicitDockviewMutation({
			desktopId,
			api,
			mutate: () => {
				const anchorEdge = anchor ? dockviewEdge(anchor.direction) : null;
				if (anchor && anchorGroup && anchorEdge) {
					panel.api.moveTo({
						group: anchorGroup as never,
						position: anchorEdge,
					});
					if (anchor.size) {
						panel.group.api.setSize(
							anchor.direction === "left" || anchor.direction === "right"
								? { width: anchor.size.width }
								: { height: anchor.size.height },
						);
					}
				} else if (gridGroup) {
					panel.api.moveTo({ group: gridGroup as never, position: "right" });
				} else {
					panel.group.api.moveTo({ position: "right" });
				}
			},
			targetChangedError: () => new Error("pane_dock_back_target_changed"),
		});
		recordPaneMoveSnapshot(api, before);
		return true;
	} catch (error) {
		console.error(`[pane dock back:${desktopId}]`, error);
		return false;
	}
}
