// ChatDraftMoveNotice's store wiring (cluster wiring hook): the draft moves
// this workspace still has to show recovery for, each with the name to show
// and whether keeping the draft at its source is still an option.
import {
	type AgentChatDraftMove,
	agentChatDraftMoveCancellable,
	pendingAgentChatDraftMoves,
} from "@/lib/agents/chat/agentChatDraftMove";
import { t } from "@/lib/i18n";
import { useStore } from "@/store";

export interface ChatDraftMoveNoticeItem {
	readonly move: AgentChatDraftMove;
	readonly name: string;
	readonly canCancel: boolean;
}

export function useChatDraftMoveNotices(
	desktopId: string,
): ChatDraftMoveNoticeItem[] {
	const moves = useStore((state) => state.chatDraftMoves);
	const receipts = useStore((state) => state.chatDraftMoveReceipts);
	const agents = useStore((state) => state.agents);
	return pendingAgentChatDraftMoves(moves, desktopId).map((move) => ({
		move,
		name:
			agents.find((agent) => agent.id === move.transfer.target.identity.agentId)
				?.name ?? t("agents.runtime.chatTarget"),
		canCancel: agentChatDraftMoveCancellable(move, receipts[move.transfer.id]),
	}));
}
