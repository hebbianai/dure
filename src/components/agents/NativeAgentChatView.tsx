import { AgentTeamLine } from "@/components/agents/AgentTeamLine";
import { NativeAgentBackgroundWork } from "@/components/agents/NativeAgentBackgroundWork";
import { NativeAgentChatComposer } from "@/components/agents/NativeAgentChatComposer";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import type { NativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { useNativeAgentTranscriptPage } from "@/components/agents/useNativeAgentTranscriptPage";
import { PanelStatus } from "@/components/common/PanelStatus";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { backgroundWorkSession } from "@/lib/agents/chat/backgroundWork";
import { t } from "@/lib/i18n";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { Agent } from "@/types";
import type { NativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

/** The conversation view of a native terminal Agent: the provider transcript,
 * with the tool calls between its messages as collapsed bursts, rendered with
 * the shared chat rows, plus the shared native composer. The terminal stays
 * mounted underneath and owns everything else the transcript cannot show
 * (other prompts, slash commands, trust prompts). The pane owns the runtime
 * state (`chat`) and the draft lives in the shared chat draft store, so
 * neither is lost when this view unmounts. */
export function NativeAgentChatView({
	agent,
	source,
	runtime,
	state,
	chat,
	onContinueInTerminal,
}: {
	agent: Agent;
	source: NativeAgentTranscriptSource;
	runtime: HmuxAgentRuntimeState;
	state: AgentDisplayState;
	chat: NativeAgentChatState;
	onContinueInTerminal(): void;
}) {
	// The desktop reads background work for its own managed sessions; for a
	// provider without readable records it answers an empty list.
	const backgroundWorkTarget = backgroundWorkSession(agent.runtimeBinding);
	const { snapshot, setSnapshot, readFailed, setReadFailed, livePending } =
		chat;
	// The pane keeps the last read, so showing the view again at the same
	// cursor reuses it.
	const { page, older } = useNativeAgentTranscriptPage({
		source,
		terminalEpoch: runtime.terminalEpoch,
		turnCompletedCount: runtime.turnCompletedCount,
		working: state === "working",
		read: { snapshot, setSnapshot, setReadFailed },
		pending: livePending,
	});

	return (
		<section
			aria-label={t("agents.nativeChat.conversation")}
			className="@container/chat absolute inset-0 flex min-h-0 flex-col bg-surface-terminal text-sm leading-relaxed"
		>
			{page === undefined && !readFailed ? (
				<PanelStatus role="status">{t("common.loading")}</PanelStatus>
			) : page ? (
				<TranscriptContents
					page={page}
					loadingOlder={older.loading}
					olderHistoryError={
						older.failed ? t("agents.chat.historyBoundary") : undefined
					}
					onLoadOlder={older.loadOlder}
				/>
			) : (
				<PanelStatus role="alert">
					{t("agents.nativeChat.transcriptUnavailable")}
				</PanelStatus>
			)}
			{backgroundWorkTarget ? (
				<NativeAgentBackgroundWork
					workspaceId={backgroundWorkTarget.workspaceId}
					sessionId={backgroundWorkTarget.sessionId}
					active={
						runtime.lifecycle === "running" && runtime.activity === "working"
					}
				/>
			) : null}
			<AgentTeamLine agentId={agent.id} />
			<NativeAgentChatComposer
				agent={agent}
				runtime={runtime}
				state={state}
				chat={chat}
				notices={
					page &&
					readFailed && (
						<ChatAlert className="mb-2 items-center">
							<span className="min-w-0 flex-1">
								{t("agents.nativeChat.transcriptUnavailable")}
							</span>
						</ChatAlert>
					)
				}
				onContinueInTerminal={onContinueInTerminal}
			/>
		</section>
	);
}
