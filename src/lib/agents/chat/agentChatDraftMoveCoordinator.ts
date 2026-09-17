import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type {
	DesktopPaneMoveItem,
	MovePanelsToDesktopReceipt,
} from "@/lib/workspace/desktop/desktopPaneMove";
import { isMountedPaneOwned } from "@/lib/workspace/pane/paneOwnership";
import { requestAgentSessionDraftMove } from "@/lib/workspace/window/agentSessionWindowCommand";
import {
	resolveMountedPaneWindow,
	revalidateMountedPaneWindow,
} from "@/lib/workspace/window/mountedPaneWindow";
import type { MountedWorkspaceWindow } from "@/lib/workspace/window/mountedWindowIdentity";
import {
	resolveMountedWorkspaceWindow,
	resolveReadyWorkspaceWindow,
	waitForMountedWorkspaceWindow,
} from "@/lib/workspace/window/mountedWorkspaceWindow";
import { durableAppStorage, useStore } from "@/store";
import {
	agentForChatPane,
	prepareAgentChatDraftTarget,
	revalidateAgentChatDraftTarget,
} from "./agentChatDraftInput";
import type {
	AgentChatDraftPacket,
	AgentChatDraftTransfer,
} from "./agentChatDraftMove";
import {
	draftTransferDigest,
	parseAgentChatDraftMoveRequest,
} from "./agentChatDraftMoveRequest";

/** Called inside the existing pane move queue. The destination stores an inert
 * copy before the synchronous layout commit; source bytes survive until its
 * exact committed receipt. There is no automatic mutation retry. */
export async function withAgentChatDraftMoves(
	items: readonly DesktopPaneMoveItem[],
	targetDesktopId: string,
	commit: (
		transfers: readonly AgentChatDraftTransfer[],
	) => MovePanelsToDesktopReceipt | Promise<MovePanelsToDesktopReceipt>,
	options: {
		newWindowLabel?: string;
		destination?: MountedWorkspaceWindow;
	} = {},
): Promise<MovePanelsToDesktopReceipt> {
	const targets = items.flatMap((item) => {
		if (item.fromDesktopId === targetDesktopId) return [];
		const agent = agentForChatPane({
			desktopId: item.fromDesktopId,
			panelId: item.panelId,
		});
		return agent ? [{ item, target: prepareAgentChatDraftTarget(agent) }] : [];
	});
	if (!targets.length) return commit([]);
	const destination = options.newWindowLabel
		? await waitForMountedWorkspaceWindow(
				targetDesktopId,
				options.newWindowLabel,
			)
		: options.destination
			? await resolveMountedWorkspaceWindow(
					targetDesktopId,
					options.destination.windowLabel,
				)
			: await resolveReadyWorkspaceWindow(targetDesktopId);
	if (
		options.destination &&
		(destination.dockviewId !== options.destination.dockviewId ||
			destination.windowGeneration !== options.destination.windowGeneration ||
			destination.windowLabel !== options.destination.windowLabel)
	)
		throw new Error("The draft destination changed before transfer.");
	// Workspaces mounted in one WebView already share this same draft store.
	if (destination.windowLabel === getCurrentWebviewWindow().label) {
		if (
			!targets.every(({ item, target }) => {
				const owner = { desktopId: item.fromDesktopId, panelId: item.panelId };
				revalidateAgentChatDraftTarget(target, owner);
				return (
					isMountedPaneOwned(owner) &&
					!useStore.getState().chatDraftMoves[target.identity.agentId]
				);
			})
		)
			throw new Error(
				"The draft must be moved by the window containing its source pane.",
			);
		return commit([]);
	}
	const prepared: AgentChatDraftTransfer[] = [];
	let commitAttempted = false;
	try {
		for (const { item, target } of targets) {
			const source = await resolveMountedPaneWindow(item.panelId);
			if (
				source.windowLabel !== getCurrentWebviewWindow().label ||
				source.desktopId !== item.fromDesktopId
			)
				throw new Error(
					"The draft must be moved by the window containing its source pane.",
				);
			const expected = useStore.getState().chatDrafts[target.identity.agentId];
			const request = parseAgentChatDraftMoveRequest({
				step: "stage",
				transfer: {
					id: crypto.randomUUID(),
					digest: `sha256:${"0".repeat(64)}`,
					target,
					source,
					destination,
				},
				drafts: expected ?? {},
			});
			if (request?.step !== "stage")
				throw new Error("The composed draft cannot be transferred.");
			const packet: AgentChatDraftPacket = {
				transfer: {
					...request.transfer,
					digest: await draftTransferDigest(request.transfer, request.drafts),
				},
				drafts: request.drafts,
			};
			revalidateMountedPaneWindow(source);
			revalidateAgentChatDraftTarget(target, {
				desktopId: source.desktopId,
				panelId: source.paneId,
			});
			useStore
				.getState()
				.applyChatDraftMove({ action: "begin", packet, expected });
			prepared.push(packet.transfer);
			const receipt = await requestAgentSessionDraftMove({
				step: "stage",
				...packet,
			});
			if (receipt.status !== "staged")
				throw new Error("The destination did not stage the draft.");
		}
		for (const transfer of prepared) {
			revalidateMountedPaneWindow(transfer.source);
			revalidateAgentChatDraftTarget(transfer.target, {
				desktopId: transfer.source.desktopId,
				panelId: transfer.source.paneId,
			});
		}
		commitAttempted = true;
		const outcome = commit(prepared);
		const receipt = outcome instanceof Promise ? await outcome : outcome;
		// Even a partial layout outcome can have crossed a destructive boundary.
		// Retain every prepared record until explicit recovery resolves it.
		if (receipt.movedPanelIds.length > 0)
			for (const transfer of prepared) {
				if (receipt.movedPanelIds.includes(transfer.source.paneId))
					useStore
						.getState()
						.applyChatDraftMove({ action: "mark_moved", transfer });
			}
		if (
			prepared.some(
				(transfer) => !receipt.movedPanelIds.includes(transfer.source.paneId),
			)
		)
			throw new Error("The layout did not move every prepared draft pane.");
		await durableAppStorage.flush();
		for (const transfer of prepared) {
			const committed = await requestAgentSessionDraftMove({
				step: "commit",
				transfer,
			});
			if (committed.status !== "committed")
				throw new Error("The draft destination has not confirmed the move.");
			useStore.getState().applyChatDraftMove({
				action: "release",
				transfer,
				receipt: committed,
			});
		}
		return receipt;
	} catch (error) {
		if (!commitAttempted) {
			for (const transfer of prepared) {
				try {
					const aborted = await requestAgentSessionDraftMove({
						step: "abort",
						transfer,
					});
					if (aborted.status !== "aborted") continue;
					revalidateMountedPaneWindow(transfer.source);
					useStore.getState().applyChatDraftMove({
						action: "release",
						transfer,
						receipt: aborted,
					});
				} catch {
					/* An uncertain peer retains both its transfer ID and the source bytes. */
				}
			}
		}
		throw error;
	}
}
