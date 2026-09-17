import { settleDurableAppState } from "@/lib/persistence/durableAppStateSettlement";
import type {
	DesktopPaneMoveItem,
	MovePanelsToDesktopReceipt,
} from "@/lib/workspace/desktop/desktopPaneMove";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { commitDesktopPaneDrop } from "@/lib/workspace/pane/paneDropCommit";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import type { PanelPosition } from "@/lib/workspace/pane/panePlacement";
import {
	requestAgentSessionPaneDrop,
	requestAgentSessionPaneMove,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import {
	resolveMountedPaneWindow,
	revalidateMountedPaneWindow,
} from "@/lib/workspace/window/mountedPaneWindow";
import {
	observeMountedWorkspaceWindow,
	revalidateMountedWorkspaceWindow,
} from "@/lib/workspace/window/mountedWorkspaceWindow";
import { durableAppStorage, useStore } from "@/store";
import type { Agent } from "@/types";
import {
	prepareAgentChatDraftTarget,
	revalidateAgentChatDraftTarget,
} from "./agentChatDraftInput";
import { sameDraftTransfer } from "./agentChatDraftMove";
import { withAgentChatDraftMoves } from "./agentChatDraftMoveCoordinator";
import {
	type AgentChatPaneDropRequest,
	type AgentChatPaneMoveRequest,
	type AgentChatPaneMoveResult,
	parseChatPaneDropPosition,
} from "./agentChatPaneDropRequest";

export async function moveChatPaneFromDestination(
	agent: Agent,
	item: DesktopPaneMoveItem,
	desktopId: string,
	position: PanelPosition,
): Promise<MovePanelsToDesktopReceipt> {
	const target = prepareAgentChatDraftTarget(agent);
	const destination = observeMountedWorkspaceWindow(desktopId).mount;
	const placement = parseChatPaneDropPosition(position);
	if (!destination || !placement)
		throw new Error("The chat pane drop destination is unavailable.");
	const source = await resolveMountedPaneWindow(item.panelId);
	if (source.desktopId !== item.fromDesktopId)
		throw new Error("The dragged chat pane moved before the drop.");
	revalidateMountedWorkspaceWindow(destination);
	revalidateAgentChatDraftTarget(target);
	return (
		await requestAgentSessionPaneMove({
			target,
			source,
			destination,
			position: placement,
		})
	).receipt;
}

/** Source serializes draft ownership, while the target retains native placement. */
export function executeSourceChatPaneMove(
	request: AgentChatPaneMoveRequest,
): Promise<AgentChatPaneMoveResult> {
	return enqueuePaneMove(async () => {
		revalidateMountedPaneWindow(request.source);
		revalidateAgentChatDraftTarget(request.target, {
			desktopId: request.source.desktopId,
			panelId: request.source.paneId,
		});
		let id: string | undefined;
		const receipt = await withAgentChatDraftMoves(
			[
				{
					panelId: request.source.paneId,
					fromDesktopId: request.source.desktopId,
				},
			],
			request.destination.desktopId,
			async (transfers) => {
				const transfer = transfers[0];
				if (transfers.length !== 1 || !transfer)
					throw new Error("The chat pane has no prepared draft transfer.");
				id = transfer.id;
				revalidateMountedPaneWindow(request.source);
				const sourceApi = getDockview(request.source.desktopId);
				if (!sourceApi)
					throw new Error("The chat source workspace disappeared.");
				useStore
					.getState()
					.saveLayout(request.source.desktopId, sourceApi.toJSON());
				await durableAppStorage.flush();
				revalidateMountedPaneWindow(request.source);
				revalidateAgentChatDraftTarget(request.target, {
					desktopId: request.source.desktopId,
					panelId: request.source.paneId,
				});
				return (
					await requestAgentSessionPaneDrop({
						transfer,
						position: request.position,
					})
				).receipt;
			},
			{ destination: request.destination },
		);
		if (!id) throw new Error("The chat pane move has no transfer receipt.");
		return { kind: "pane_moved", id, receipt };
	});
}

/** This window is already awaiting the source inside its move queue. Execute
 * only the exact staged transfer, recording its layout result before yielding. */
export async function executeDestinationChatPaneDrop(
	request: AgentChatPaneDropRequest,
): Promise<AgentChatPaneMoveResult> {
	const { transfer } = request;
	revalidateMountedWorkspaceWindow(transfer.destination);
	const previous = useStore.getState().chatDraftMoveReceipts[transfer.id];
	if (previous?.dropReceipt) {
		if (
			previous.digest !== transfer.digest ||
			JSON.stringify(previous.dropPosition) !== JSON.stringify(request.position)
		)
			throw new Error("The recorded chat drop request changed.");
		return {
			kind: "pane_moved",
			id: transfer.id,
			receipt: previous.dropReceipt,
		};
	}
	const currentApi = getDockview(transfer.destination.desktopId);
	if (!currentApi) throw new Error("The chat drop workspace disappeared.");
	useStore
		.getState()
		.saveLayout(transfer.destination.desktopId, currentApi.toJSON());
	await durableAppStorage.flush();
	await settleDurableAppState();
	revalidateMountedWorkspaceWindow(transfer.destination);
	const recorded = useStore.getState().chatDraftMoveReceipts[transfer.id];
	if (recorded?.digest !== undefined && recorded.digest !== transfer.digest)
		throw new Error("The chat drop transfer changed.");
	if (recorded?.dropReceipt) {
		if (
			JSON.stringify(recorded.dropPosition) !== JSON.stringify(request.position)
		)
			throw new Error("The recorded chat drop request changed.");
		return {
			kind: "pane_moved",
			id: transfer.id,
			receipt: recorded.dropReceipt,
		};
	}
	const move =
		useStore.getState().chatDraftMoves[transfer.target.identity.agentId];
	if (
		move?.role !== "destination" ||
		!sameDraftTransfer(move.transfer, transfer) ||
		recorded?.status !== "staged"
	)
		throw new Error("The chat drop has no staged draft.");
	revalidateAgentChatDraftTarget(transfer.target, {
		desktopId: transfer.source.desktopId,
		panelId: transfer.source.paneId,
	});
	const api = getDockview(transfer.destination.desktopId);
	if (api?.getPanel(transfer.source.paneId))
		revalidateAgentChatDraftTarget(transfer.target, {
			desktopId: transfer.destination.desktopId,
			panelId: transfer.source.paneId,
		});
	const groupId = request.position.referenceGroup;
	const group = groupId ? api?.getGroup(groupId) : undefined;
	if (groupId && !group) throw new Error("The chat drop group changed.");
	if (
		request.position.referencePanel &&
		!api?.getPanel(request.position.referencePanel)
	)
		throw new Error("The chat drop reference pane changed.");
	const receipt = commitDesktopPaneDrop(
		{
			panelId: transfer.source.paneId,
			fromDesktopId: transfer.source.desktopId,
		},
		transfer.destination.desktopId,
		{ ...request.position, ...(group ? { referenceGroup: group } : {}) },
	);
	if (receipt.error || !receipt.movedPanelIds.includes(transfer.source.paneId))
		throw new Error(receipt.error?.code ?? "The chat pane drop was refused.");
	useStore.getState().applyChatDraftMove({
		action: "record_drop",
		transfer,
		receipt,
		position: request.position,
	});
	await durableAppStorage.flush();
	return { kind: "pane_moved", id: transfer.id, receipt };
}
