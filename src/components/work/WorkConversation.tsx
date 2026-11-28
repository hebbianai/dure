import { Expand } from "lucide-react";
import { NativeAgentBackgroundWork } from "@/components/agents/NativeAgentBackgroundWork";
import { NativeAgentChatComposer } from "@/components/agents/NativeAgentChatComposer";
import { AgentChatPendingAnswer } from "@/components/agents/chat/AgentChatPendingAnswer";
import { AgentChatTranscript } from "@/components/agents/chat/AgentChatTranscript";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { AgentGoalBar } from "@/components/agents/chat/AgentGoalBar";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { ChatComposer } from "@/components/agents/chat/ChatComposer";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useChatContentTypography } from "@/components/agents/chat/useChatContentTypography";
import { useNativeAgentResponseState } from "@/components/agents/useAgentDisplayState";
import {
	type NativeAgentChatState,
	useNativeAgentChatState,
} from "@/components/agents/useNativeAgentChatState";
import { useNativeAgentTranscriptPage } from "@/components/agents/useNativeAgentTranscriptPage";
import { PanelStatus } from "@/components/common/PanelStatus";
import { useStructuredAgentPanelState } from "@/components/panels/useAgentPanelState";
import { Button } from "@/components/ui/button";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { backgroundWorkSession } from "@/lib/agents/chat/backgroundWork";
import {
	nativeAgentChatIdle,
	nativeAgentChatOwnerKey,
} from "@/lib/agents/chat/nativeAgentChat";
import {
	type NativeConversationRecordV1,
	nativeConversationRecord,
} from "@/lib/agents/nativeConversationView";
import { t } from "@/lib/i18n";
import { agentSessionWindowTarget } from "@/lib/workspace/window/agentSessionWindowTarget";
import type { Agent } from "@/types";

/** The agent's conversation in a Work column with the composer each agent
 * has elsewhere: a Chat Agent's committed timeline, goal and composer
 * through the window's shared session, and a local terminal's provider
 * transcript (`nativeConversationRecord`): while it runs, with the native
 * composer on the Host's idle prompt path, and once its session has ended,
 * the last conversation it recorded, read only. Otherwise a note that there
 * is none. It never mounts a terminal, so showing it or sending from it
 * never changes a terminal's size, and it never takes focus on its own:
 * what the composer cannot answer goes to the large window. */
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
				<WorkChatConversation agent={agent} profile={target.profile} />
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
	agent,
	profile,
}: {
	agent: Agent;
	profile: AgentStructuredInteractionProfileV1;
}) {
	// The window's shared lease on the session: the pane, its large window
	// and this column read and send through the same controller.
	const session = useAgentChatSession(agent.id, profile);
	const { project } = useStructuredAgentPanelState(agent);
	const { fontSize, lineHeight } = useChatContentTypography();
	const identity = session.draftIdentity;
	// Like a shared conversation, the column runs no pane controls: it has no
	// launch selection, recovery or new conversation, and its team is the
	// managed list above, so there is no team line.
	return (
		<AgentChatTranscript
			session={session}
			typography={{ fontSize, lineHeight }}
			renderPending={(pending) => (
				<AgentChatPendingAnswer session={session} pending={pending} />
			)}
		>
			<AgentGoalBar
				key={`${identity.backendProfileId}:${identity.agentId}:${identity.interactionSessionId}`}
				session={session}
			/>
			<ChatComposer
				session={session}
				disabled={false}
				attachmentsEnabled={project?.kind === "local"}
			/>
		</AgentChatTranscript>
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
	// The column keeps the conversation's runtime-owned state for as long as
	// it shows the agent, under the pane's owner key, so a momentary drop of
	// the runtime projection does not forget a sent prompt.
	const chat = useNativeAgentChatState(
		nativeAgentChatOwnerKey(agent),
		nativeAgentChatIdle({ runtime, state }),
	);
	const record = nativeConversationRecord(agent, runtime, state);
	// Background work is read for the agent's own managed session only, and
	// only while its Host reports it working.
	const backgroundWork = backgroundWorkSession(agent.runtimeBinding);
	return (
		<>
			{record ? (
				<WorkNativeTranscript
					key={`${record.source.conversationId}:${record.terminalEpoch}`}
					agent={agent}
					record={record}
					state={state}
					chat={chat}
					onOpenLargeWindow={onOpenLargeWindow}
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
	agent,
	record,
	state,
	chat,
	onOpenLargeWindow,
}: {
	agent: Agent;
	record: NativeConversationRecordV1;
	state: AgentDisplayState;
	chat: NativeAgentChatState;
	onOpenLargeWindow?: () => void;
}) {
	const { snapshot, setSnapshot, readFailed, setReadFailed, livePending } =
		chat;
	const { runtime } = record;
	const { page, older } = useNativeAgentTranscriptPage({
		...record,
		read: { snapshot, setSnapshot, setReadFailed },
		// Only a running session has a sent prompt still to show.
		pending: runtime ? livePending : undefined,
	});
	const { fontSize, lineHeight } = useChatContentTypography();
	if (page === undefined && !readFailed) {
		return <PanelStatus role="status">{t("common.loading")}</PanelStatus>;
	}
	if (!page) {
		// A provider may have deleted an ended session's history: there is then
		// no record to show, which is not a failure to report.
		return runtime ? (
			<PanelStatus role="alert">
				{t("agents.nativeChat.transcriptUnavailable")}
			</PanelStatus>
		) : (
			<WorkNoConversation onOpenLargeWindow={onOpenLargeWindow} />
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
			{runtime && readFailed && (
				<ChatAlert className="m-2 items-center">
					<span className="min-w-0 flex-1">
						{t("agents.nativeChat.transcriptUnavailable")}
					</span>
				</ChatAlert>
			)}
			{/* The terminal lives in the large window: what the composer cannot
			    answer continues there. An ended session takes no input. */}
			{runtime && (
				<NativeAgentChatComposer
					agent={agent}
					runtime={runtime}
					state={state}
					chat={chat}
					onContinueInTerminal={onOpenLargeWindow}
				/>
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
