import type { AgentChatActiveTurnV1 } from "@/lib/agents/chat/agentChatProjection";
import type { AgentChatDraftIdentity } from "@/lib/agents/chat/agentChatDraftStoreSlice";
import type {
	AgentGoalUpdateV1,
	AgentTimelinePageV1,
} from "@/lib/agents/chat/agentConversationContract";

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
	/** Messages typed while a turn was running; they auto-send (joined into
	 * one turn) once the active turn finishes. */
	queuedMessages: readonly string[];
}

interface AgentChatSessionActions {
	putGoal(update: AgentGoalUpdateV1): Promise<boolean>;
	retryConnection(): void;
	loadOlder(): Promise<void>;
	send(input: string): Promise<void>;
	queueMessage(input: string): void;
	steerOrQueue(input: string): Promise<"steered" | "queued">;
	dequeueMessage(index: number): string | undefined;
	retryTurn(): Promise<void>;
	editRetryableTurn(): string | undefined;
	answerPending(requestId: string, answer: unknown): Promise<void>;
	interrupt(): Promise<void>;
	dismissActionError(): void;
}

/** Stable presentation contract consumed by chat surfaces and composers. */
export type AgentChatSessionView = AgentChatSessionSnapshot &
	AgentChatSessionActions & { readonly draftIdentity: AgentChatDraftIdentity };
