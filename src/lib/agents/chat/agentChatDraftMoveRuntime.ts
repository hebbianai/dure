import { recoverCurrentDurableStoreProjection } from "@/lib/persistence/currentDurableProjectionRecovery";
import {
	isDurablePaneOwned,
	isMountedPaneOwned,
} from "@/lib/workspace/pane/paneOwnership";
import { revalidateMountedWorkspaceWindow } from "@/lib/workspace/window/mountedWorkspaceWindow";
import { durableAppStorage, useStore } from "@/store";
import { revalidateAgentChatDraftTarget } from "./agentChatDraftInput";
import type { AgentChatDraftMoveReceipt } from "./agentChatDraftMove";
import {
	type AgentChatDraftMoveRequest,
	draftTransferDigest,
} from "./agentChatDraftMoveRequest";

export async function executeAgentChatDraftMove(
	request: AgentChatDraftMoveRequest,
): Promise<AgentChatDraftMoveReceipt> {
	const { transfer } = request;
	const destination = {
		desktopId: transfer.destination.desktopId,
		panelId: transfer.source.paneId,
	};
	revalidateMountedWorkspaceWindow(transfer.destination);
	if (request.step === "stage") {
		if (
			(await draftTransferDigest(transfer, request.drafts)) !== transfer.digest
		)
			throw new Error("The chat draft snapshot changed in transit.");
		revalidateMountedWorkspaceWindow(transfer.destination);
		revalidateAgentChatDraftTarget(transfer.target);
		useStore
			.getState()
			.applyChatDraftMove({ action: "stage", packet: request });
	} else if (request.step === "commit") {
		// A staged copy is inert. Only the explicit source commit plus the
		// existing durable layout may make it editable in this window.
		if (
			useStore.getState().chatDraftMoveReceipts[transfer.id]?.status !==
			"committed"
		) {
			await durableAppStorage.flush();
			const recovered = await recoverCurrentDurableStoreProjection({
				forceProjection: true,
				requiredProjectionDesktopId: destination.desktopId,
			});
			if (!recovered)
				throw new Error("The moved pane has not been reconciled.");
			revalidateMountedWorkspaceWindow(transfer.destination);
			revalidateAgentChatDraftTarget(transfer.target, destination);
			if (
				!isMountedPaneOwned(destination) ||
				isDurablePaneOwned({
					desktopId: transfer.source.desktopId,
					panelId: transfer.source.paneId,
				})
			)
				throw new Error("The draft destination does not own the moved pane.");
			useStore.getState().applyChatDraftMove({ action: "commit", transfer });
		}
	} else if (request.step === "abort") {
		useStore.getState().applyChatDraftMove({ action: "abort", transfer });
	}
	const receipt = useStore.getState().chatDraftMoveReceipts[transfer.id];
	if (!receipt || receipt.digest !== transfer.digest)
		throw new Error("The chat draft transfer has no matching receipt.");
	return receipt;
}
