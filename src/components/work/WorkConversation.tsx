import { Expand } from "lucide-react";
import { useState } from "react";
import { NativeAgentBackgroundWork } from "@/components/agents/NativeAgentBackgroundWork";
import { AgentChatTranscript } from "@/components/agents/chat/AgentChatTranscript";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useChatContentTypography } from "@/components/agents/chat/useChatContentTypography";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import { useNativeAgentTranscriptPage } from "@/components/agents/useNativeAgentTranscriptPage";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { backgroundWorkSession } from "@/lib/agents/chat/backgroundWork";
import type { NativeAgentChatSnapshot } from "@/lib/agents/chat/nativeAgentChat";
import { nativeConversationViewAvailability } from "@/lib/agents/nativeConversationView";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import { agentSessionWindowTarget } from "@/lib/workspace/window/agentSessionWindowTarget";
import type { Agent } from "@/types";
import {
	type NativeAgentTranscriptSource,
	nativeAgentTranscriptSource,
} from "../../../cli/lib/agent-transcript.mjs";

/** The agent's conversation in a Work column, read-only: a Chat Agent's
 * committed timeline, a local terminal's provider transcript when the
 * pane's Conversation view could show it, and otherwise a note
 * that there is none. It never mounts a terminal, so showing it never
 * changes a terminal's size; typing happens in the large window. */
export function WorkConversation({
	agent,
	onOpenLargeWindow,
}: {
	agent: Agent;
	/** Absent when the agent has no large window. */
	onOpenLargeWindow?: () => void;
}) {
	const target = agentSessionWindowTarget(agent);
	return (
		<section
			aria-label={t("work.conversation.label")}
			data-slot="work-conversation"
			className="relative flex min-h-0 flex-1 flex-col"
		>
			{target?.kind === "chat" ? (
				<WorkChatConversation
					agentId={agent.id}
					profile={target.profile}
					onOpenLargeWindow={onOpenLargeWindow}
				/>
			) : (
				<WorkNativeConversation
					agent={agent}
					onOpenLargeWindow={onOpenLargeWindow}
				/>
			)}
		</section>
	);
}

function WorkChatConversation({
	agentId,
	profile,
	onOpenLargeWindow,
}: {
	agentId: string;
	profile: AgentStructuredInteractionProfileV1;
	onOpenLargeWindow?: () => void;
}) {
	// The window's shared lease on the session: the pane, its large window
	// and this column read the same controller.
	const session = useAgentChatSession(agentId, profile);
	const { fontSize, lineHeight } = useChatContentTypography();
	return (
		<AgentChatTranscript
			session={session}
			typography={{ fontSize, lineHeight }}
			renderPending={() => (
				<WorkPendingNotice onOpenLargeWindow={onOpenLargeWindow} />
			)}
		/>
	);
}

/** What a pending request shows here: that it waits for a person, and where
 * to answer it. The answer is given where the agent can be typed into. */
function WorkPendingNotice({
	onOpenLargeWindow,
}: {
	onOpenLargeWindow?: () => void;
}) {
	return (
		<ChatAlert className="items-center">
			<span className="min-w-0 flex-1">{t("work.conversation.pending")}</span>
			{onOpenLargeWindow && (
				<Button type="button" variant="ghost" size="xs" onClick={onOpenLargeWindow}>
					<Expand />
					{t("work.detail.openLargeWindow")}
				</Button>
			)}
		</ChatAlert>
	);
}

function WorkNativeConversation({
	agent,
	onOpenLargeWindow,
}: {
	agent: Agent;
	onOpenLargeWindow?: () => void;
}) {
	// The Host's runtime and display state, as the pane's own Conversation
	// view reads them.
	const { runtime, state } = useNativeAgentResponseState(agent);
	const source = nativeAgentTranscriptSource(agent, agent.runtimeBinding);
	// The same authority as the pane's View menu decides whether there is a
	// conversation to show.
	const shown =
		nativeConversationViewAvailability(agent, runtime).available &&
		source.kind === "local" &&
		runtime
			? { source, runtime }
			: undefined;
	// Background work is read for the agent's own managed session only, and
	// only while its Host reports it working.
	const backgroundWork = backgroundWorkSession(agent.runtimeBinding);
	return (
		<>
			{shown ? (
				<WorkNativeTranscript
					key={`${shown.source.conversationId}:${shown.runtime.terminalEpoch}`}
					source={shown.source}
					runtime={shown.runtime}
					working={state === "working"}
				/>
			) : (
				<WorkNoConversation onOpenLargeWindow={onOpenLargeWindow} />
			)}
			{backgroundWork && (
				<NativeAgentBackgroundWork
					workspaceId={backgroundWork.workspaceId}
					sessionId={backgroundWork.sessionId}
					active={
						runtime?.lifecycle === "running" && runtime.activity === "working"
					}
				/>
			)}
		</>
	);
}

function WorkNativeTranscript({
	source,
	runtime,
	working,
}: {
	source: NativeAgentTranscriptSource;
	runtime: HmuxAgentRuntimeState;
	working: boolean;
}) {
	// This column keeps its own read for as long as it is shown; the pane's
	// read stays the pane's.
	const [snapshot, setSnapshot] = useState<NativeAgentChatSnapshot>();
	const [readFailed, setReadFailed] = useState(false);
	const { page, older } = useNativeAgentTranscriptPage({
		source,
		terminalEpoch: runtime.terminalEpoch,
		turnCompletedCount: runtime.turnCompletedCount,
		working,
		read: { snapshot, setSnapshot, setReadFailed },
	});
	const { fontSize, lineHeight } = useChatContentTypography();
	if (page === undefined && !readFailed) {
		return <PanelStatus role="status">{t("common.loading")}</PanelStatus>;
	}
	if (!page) {
		return (
			<PanelStatus role="alert">
				{t("agents.nativeChat.transcriptUnavailable")}
			</PanelStatus>
		);
	}
	return (
		<div
			className="@container/chat flex min-h-0 flex-1 flex-col"
			style={{ fontSize, lineHeight }}
		>
			<TranscriptContents
				page={page}
				loadingOlder={older.loading}
				olderHistoryError={
					older.failed ? t("agents.chat.historyBoundary") : undefined
				}
				onLoadOlder={older.loadOlder}
			/>
			{readFailed && (
				<ChatAlert className="m-2 items-center">
					<span className="min-w-0 flex-1">
						{t("agents.nativeChat.transcriptUnavailable")}
					</span>
				</ChatAlert>
			)}
		</div>
	);
}

/** An agent whose provider keeps no conversation record Dure can read, or
 * one whose record is not readable now. Its live view is still a click
 * away. */
function WorkNoConversation({
	onOpenLargeWindow,
}: {
	onOpenLargeWindow?: () => void;
}) {
	return (
		<div className="m-auto flex max-w-72 flex-col items-center gap-2 p-4 text-center">
			<p className="text-xs text-muted-foreground">{t("work.conversation.none")}</p>
			{onOpenLargeWindow && (
				<Button type="button" variant="ghost" size="xs" onClick={onOpenLargeWindow}>
					<Expand />
					{t("work.detail.openLargeWindow")}
				</Button>
			)}
		</div>
	);
}
