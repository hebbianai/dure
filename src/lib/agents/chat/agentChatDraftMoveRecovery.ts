import type { AgentChatDraftRecoveryRequest } from "./agentChatDraftTypes";

export type {
	AgentChatDraftRecoveryIntent,
	AgentChatDraftRecoveryRequest,
} from "./agentChatDraftTypes";

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { enqueuePaneMove } from "@/lib/workspace/pane/paneMoveQueue";
import {
	requestAgentSessionDraftMove,
	requestAgentSessionDraftRecovery,
} from "@/lib/workspace/window/agentSessionWindowCommand";
import { revalidateMountedPaneWindow } from "@/lib/workspace/window/mountedPaneWindow";
import { revalidateMountedWorkspaceWindow } from "@/lib/workspace/window/mountedWorkspaceWindow";
import { durableAppStorage, useStore } from "@/store";
import {
	type AgentChatDraftMoveReceipt,
	sameDraftTransfer,
} from "./agentChatDraftMove";

/** Explicit recovery uses the retained transfer identity and never repeats a
 * layout mutation. The source queue also serializes against the original move. */
export function recoverAgentChatDraftMove(
	request: AgentChatDraftRecoveryRequest,
): Promise<AgentChatDraftMoveReceipt> {
	if (getCurrentWebviewWindow().label !== request.transfer.source.windowLabel)
		return requestAgentSessionDraftRecovery(request);
	return enqueuePaneMove(async () => {
		const { transfer } = request;
		revalidateMountedWorkspaceWindow(transfer.source);
		const move =
			useStore.getState().chatDraftMoves[transfer.target.identity.agentId];
		if (
			!move ||
			!sameDraftTransfer(move.transfer, transfer) ||
			(move.role !== "source" && move.role !== "departed")
		)
			throw new Error("The source draft transfer changed.");
		let receipt: AgentChatDraftMoveReceipt;
		if (request.intent === "cancel" && move.role === "source") {
			revalidateMountedPaneWindow(transfer.source);
			receipt = await requestAgentSessionDraftMove({ step: "abort", transfer });
		} else {
			receipt = await requestAgentSessionDraftMove({
				step: "status",
				transfer,
			});
			if (
				receipt.status === "moved" ||
				(receipt.status === "staged" && move.layoutCommitted)
			) {
				await durableAppStorage.flush();
				receipt = await requestAgentSessionDraftMove({
					step: "commit",
					transfer,
				});
			}
		}
		if (receipt.status === "aborted")
			revalidateMountedPaneWindow(transfer.source);
		if (
			move.role === "source" &&
			(receipt.status === "committed" || receipt.status === "aborted")
		)
			useStore
				.getState()
				.applyChatDraftMove({ action: "release", transfer, receipt });
		return receipt;
	});
}
