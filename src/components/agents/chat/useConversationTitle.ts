import { useMemo, useSyncExternalStore } from "react";
import {
	conversationTitle,
	conversationPresentationRevision,
	subscribeConversationPresentation,
} from "@/lib/agents/chat/conversationPresentationState";

/** Subscribes presentation surfaces to the newest provider-reported title. */
export function useConversationTitle(
	agentId: string | undefined,
): string | undefined {
	const revision = useSyncExternalStore(
		subscribeConversationPresentation,
		conversationPresentationRevision,
		conversationPresentationRevision,
	);
	return useMemo(() => conversationTitle(agentId), [agentId, revision]);
}
