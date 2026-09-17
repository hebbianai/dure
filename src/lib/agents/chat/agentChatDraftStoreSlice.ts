import { reduceAgentChatDraftMove } from "./agentChatDraftMove";
import type {
	AgentChatDraft,
	AgentChatDraftIdentity,
	AgentChatDraftStoreSlice,
} from "./agentChatDraftTypes";

export type {
	AgentChatDraft,
	AgentChatDraftIdentity,
	AgentChatDraftStoreSlice,
} from "./agentChatDraftTypes";

export const EMPTY_CHAT_DRAFT: AgentChatDraft = { text: "", attachments: [] };

export function agentChatDraftKey(identity: AgentChatDraftIdentity): string {
	return JSON.stringify([
		identity.backendProfileId,
		identity.interactionSessionId,
	]);
}

/** Whether a composer that rendered at `epoch` may still edit or send this
 * Agent's draft: no move between windows holds it, and no move has finished
 * since — every finished move bumps the epoch, so a render from before it
 * must not write into the draft that moved. */
export function agentChatDraftEditable(
	state: Pick<AgentChatDraftStoreSlice, "chatDraftMoves" | "chatDraftEpochs">,
	agentId: string,
	epoch: number,
): boolean {
	return (
		!state.chatDraftMoves[agentId] &&
		(state.chatDraftEpochs[agentId] ?? 0) === epoch
	);
}

export function createAgentChatDraftStoreSlice(
	set: (
		update: (
			state: AgentChatDraftStoreSlice,
		) => Partial<AgentChatDraftStoreSlice>,
	) => void,
): AgentChatDraftStoreSlice {
	return {
		chatDrafts: {},
		chatDraftEpochs: {},
		chatDraftMoves: {},
		chatDraftMoveReceipts: {},
		applyChatDraftMove: (operation) =>
			set((state) => {
				const update = reduceAgentChatDraftMove(state, operation);
				if (!Object.keys(update).length) return update;
				const transfer =
					"packet" in operation
						? operation.packet.transfer
						: operation.transfer;
				const agentId = transfer.target.identity.agentId;
				return {
					...update,
					chatDraftEpochs: {
						...state.chatDraftEpochs,
						[agentId]: (state.chatDraftEpochs[agentId] ?? 0) + 1,
					},
				};
			}),
		updateChatDraft: (identity, update) =>
			set((state) => {
				if (state.chatDraftMoves[identity.agentId])
					throw new Error("The chat draft is moving between windows.");
				const key = agentChatDraftKey(identity);
				const drafts = state.chatDrafts[identity.agentId] ?? {};
				const current = drafts[key] ?? EMPTY_CHAT_DRAFT;
				const next = update(current);
				if (next === current) return {};
				const remaining = { ...drafts };
				if (!next.text && !next.attachments.length) delete remaining[key];
				else remaining[key] = next;
				const chatDrafts = { ...state.chatDrafts };
				if (Object.keys(remaining).length)
					chatDrafts[identity.agentId] = remaining;
				else delete chatDrafts[identity.agentId];
				return { chatDrafts };
			}),
	};
}
