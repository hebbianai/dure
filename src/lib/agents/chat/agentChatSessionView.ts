import type { AgentChatDraftIdentity } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import type { AgentChatActiveTurnV1 } from "@/lib/agents/chat/agentChatProjection";
import type {
	AgentGoalUpdateV1,
	AgentQueuedInputV1,
	AgentTimelinePageV1,
} from "@/lib/agents/chat/agentConversationContract";
import type { ProviderConversationActivity } from "@/lib/ipc/conversations";

type AgentChatSessionPhase = "detached" | "connecting" | "ready" | "error";

export interface AgentChatSessionSnapshot {
	phase: AgentChatSessionPhase;
	page?: AgentTimelinePageV1;
	activeTurn?: AgentChatActiveTurnV1;
	error?: string;
	actionError?: string;
	reconnecting: boolean;
	sending: boolean;
	savingGoal: boolean;
	goalError?: string;
	retryTurnAvailable: boolean;
	answeringRequestId?: string;
	interrupting: boolean;
	loadingOlder: boolean;
	olderHistoryError?: string;
	/** Accepted input awaiting execution in the conversation service. */
	queuedMessages: readonly AgentQueuedInputV1[];
	/** Local edits whose original input has not yet reached its draft. */
	pendingQueueEdits?: readonly Pick<
		AgentQueuedInputV1,
		"clientMessageId" | "preview"
	>[];
	queuedMoreAfter?: number | null;
	loadingQueued?: boolean;
}

interface AgentChatSessionActions {
	putGoal(update: AgentGoalUpdateV1): Promise<boolean>;
	retryConnection(): void;
	loadOlder(): Promise<void>;
	/** The provider history page that ends `before` a transcript cursor and
	 * starts no earlier than `after`: older than the seeded timeline, or in a
	 * gap between its rows; null when this session cannot read it. */
	readProviderHistory(
		before: number,
		after?: number,
	): Promise<ProviderConversationActivity | null>;
	send(input: string): Promise<void>;
	queueMessage(input: string): Promise<void>;
	steerOrQueue(input: string): Promise<"steered" | "queued">;
	dequeueMessage(
		clientMessageId: string,
		restore?: (input: string) => boolean,
	): Promise<string>;
	loadMoreQueued(): Promise<void>;
	retryTurn(): Promise<void>;
	editRetryableTurn(restore: (input: string) => void): Promise<void>;
	answerPending(requestId: string, answer: unknown): Promise<void>;
	interrupt(): Promise<void>;
	dismissActionError(): void;
}

/** Stable presentation contract consumed by chat surfaces and composers. */
export type AgentChatSessionView = AgentChatSessionSnapshot &
	AgentChatSessionActions & { readonly draftIdentity: AgentChatDraftIdentity };
