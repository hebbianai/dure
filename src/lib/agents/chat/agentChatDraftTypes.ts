import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import type { MovePanelsToDesktopReceipt } from "@/lib/workspace/desktop/desktopPaneMove";
import type {
	MountedPaneWindow,
	MountedWorkspaceWindow,
} from "@/lib/workspace/window/mountedWindowIdentity";
import type { Agent, Project } from "@/types";

export interface AgentChatDraftIdentity {
	readonly agentId: string;
	readonly backendProfileId: string;
	readonly interactionSessionId: string;
}

export interface AgentChatDraft {
	readonly text: string;
	readonly attachments: DroppedFilePayload[];
}

export interface PreparedAgentChatDraftTarget {
	readonly identity: AgentChatDraftIdentity;
	readonly sessionId: string;
	readonly projectId: string;
	readonly provider: Agent["provider"];
	readonly worktreePath: string;
	readonly project: Pick<Project, "kind" | "path" | "sshHostId"> | undefined;
}

export interface AgentChatPaneDropPosition {
	readonly referenceGroup?: string;
	readonly referencePanel?: string;
	readonly direction?: "left" | "right" | "above" | "below";
	readonly floating?: { x: number; y: number; width?: number; height?: number };
}
export type AgentChatDrafts = Record<string, AgentChatDraft>;
export interface AgentChatDraftTransfer {
	readonly id: string;
	readonly digest: string;
	readonly target: PreparedAgentChatDraftTarget;
	readonly source: MountedPaneWindow;
	readonly destination: MountedWorkspaceWindow;
}
export interface AgentChatDraftPacket {
	readonly transfer: AgentChatDraftTransfer;
	readonly drafts: AgentChatDrafts;
}
export interface AgentChatDraftMove {
	readonly transfer: AgentChatDraftTransfer;
	readonly role: "source" | "destination" | "departed";
	readonly drafts?: AgentChatDrafts;
	readonly layoutCommitted?: boolean;
	readonly previousDeparture?: AgentChatDraftTransfer;
}
export interface AgentChatDraftMoveReceipt {
	readonly kind: "draft_move";
	readonly id: string;
	readonly digest: string;
	readonly status: "staged" | "moved" | "committed" | "aborted";
	readonly dropReceipt?: MovePanelsToDesktopReceipt;
	readonly dropPosition?: AgentChatPaneDropPosition;
}
export type AgentChatDraftMoveOperation =
	| {
			action: "record_drop";
			transfer: AgentChatDraftTransfer;
			receipt: MovePanelsToDesktopReceipt;
			position: AgentChatPaneDropPosition;
	  }
	| {
			action: "begin";
			packet: AgentChatDraftPacket;
			expected: AgentChatDrafts | undefined;
	  }
	| { action: "stage"; packet: AgentChatDraftPacket }
	| {
			action: "mark_moved" | "commit" | "abort";
			transfer: AgentChatDraftTransfer;
	  }
	| {
			action: "release";
			transfer: AgentChatDraftTransfer;
			receipt: AgentChatDraftMoveReceipt;
	  };

/** Volatile IDE composition state. Sending and provider runtime authority stay
 * with the existing chat controller; a draft never enters its turn queue. */
export interface AgentChatDraftStoreSlice {
	chatDrafts: Record<string, Record<string, AgentChatDraft>>;
	chatDraftEpochs: Record<string, number>;
	chatDraftMoves: Record<string, AgentChatDraftMove>;
	chatDraftMoveReceipts: Record<string, AgentChatDraftMoveReceipt>;
	applyChatDraftMove(operation: AgentChatDraftMoveOperation): void;
	updateChatDraft(
		identity: AgentChatDraftIdentity,
		update: (current: AgentChatDraft) => AgentChatDraft,
	): void;
}

export type AgentChatDraftRecoveryIntent = "finish" | "cancel";
export interface AgentChatDraftRecoveryRequest {
	readonly transfer: AgentChatDraftTransfer;
	readonly intent: AgentChatDraftRecoveryIntent;
}
