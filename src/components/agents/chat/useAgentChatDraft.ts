// The chat composer's draft wiring (cluster wiring hook): the shared IDE
// draft for one identity, whether a move between windows holds it, and the
// fence every edit and send passes — no move in flight, and the epoch this
// render saw still current. The composer keeps rendering and submission.
import type { Dispatch, SetStateAction } from "react";
import {
	type AgentChatDraft,
	type AgentChatDraftIdentity,
	agentChatDraftEditable,
	agentChatDraftKey,
	EMPTY_CHAT_DRAFT,
} from "@/lib/agents/chat/agentChatDraftStoreSlice";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { useStore } from "@/store";

export function useAgentChatDraft(identity: AgentChatDraftIdentity) {
	const draftKey = agentChatDraftKey(identity);
	const readDraft = () =>
		useStore.getState().chatDrafts[identity.agentId]?.[draftKey] ??
		EMPTY_CHAT_DRAFT;
	const draft = useStore(
		(state) =>
			state.chatDrafts[identity.agentId]?.[draftKey] ?? EMPTY_CHAT_DRAFT,
	);
	const moving = useStore((state) =>
		Boolean(state.chatDraftMoves[identity.agentId]),
	);
	const epoch = useStore(
		(state) => state.chatDraftEpochs[identity.agentId] ?? 0,
	);
	const mayEdit = () =>
		agentChatDraftEditable(useStore.getState(), identity.agentId, epoch);
	/** Whether the store still holds the draft this render composed from. */
	const isCurrent = () => readDraft() === draft;
	const update = (patch: (current: AgentChatDraft) => AgentChatDraft) => {
		if (!mayEdit()) return;
		useStore.getState().updateChatDraft(identity, patch);
	};
	const setText: Dispatch<SetStateAction<string>> = (next) =>
		update((current) => ({
			...current,
			text: typeof next === "function" ? next(current.text) : next,
		}));
	const setAttachments: Dispatch<SetStateAction<DroppedFilePayload[]>> = (
		next,
	) =>
		update((current) => ({
			...current,
			attachments:
				typeof next === "function" ? next(current.attachments) : next,
		}));
	return { draft, moving, epoch, mayEdit, isCurrent, setText, setAttachments };
}
