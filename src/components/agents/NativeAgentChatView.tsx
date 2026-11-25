import { useEffect, useId, useMemo } from "react";
import { NativeAgentBackgroundWork } from "@/components/agents/NativeAgentBackgroundWork";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import {
	ChatComposerSendButton,
	ChatComposerShell,
} from "@/components/agents/chat/ChatComposerShell";
import { useAgentChatDraft } from "@/components/agents/chat/useAgentChatDraft";
import { useOlderProviderHistory } from "@/components/agents/chat/useOlderProviderHistory";
import type { NativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { approvalShown, pendingApproval } from "@/lib/agents/approvalRequest";
import { backgroundWorkSession } from "@/lib/agents/chat/backgroundWork";
import {
	nativeAgentApprovalCardRequest,
	nativeAgentApprovalChoice,
	nativeAgentApprovalDecisions,
	presentNativeAgentApprovalError,
} from "@/lib/agents/chat/nativeAgentApproval";
import {
	nativeAgentChatComposerReason,
	nativeAgentChatComposerState,
	nativeAgentChatDraftIdentity,
	nativeAgentChatPage,
	nativeAgentChatPendingSettled,
	nativeAgentChatRefreshCursor,
	nativeAgentInputFailure,
	nativeAgentPromptBackendProfileId,
	nativeTranscriptUserEntries,
	presentNativeAgentInputError,
} from "@/lib/agents/chat/nativeAgentChat";
import { t } from "@/lib/i18n";
import { readProviderConversationTranscript } from "@/lib/ipc/conversations";
import {
	answerNativeAgentApproval,
	sendNativeAgentPrompt,
} from "@/lib/ipc/dureAgentNativeInput";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { Agent } from "@/types";
import type { NativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

/** The conversation view of a native terminal Agent: the provider transcript,
 * with the tool calls between its messages as collapsed bursts, rendered with
 * the shared chat rows, plus the shared composer on the Host's idle prompt
 * path. An approval whose provider said what it asks shows as the shared
 * pending-request card and is answered through the Host's attention
 * response. The terminal stays mounted underneath and owns everything else
 * the transcript cannot show (other prompts, slash commands, trust prompts).
 * The pane owns the runtime state (`chat`) and the draft lives in the shared
 * chat draft store, so neither is lost when this view unmounts. */
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
	const { agentId, provider, conversationId } = source;
	// The desktop reads background work for its own managed sessions; for a
	// provider without readable records it answers an empty list.
	const backgroundWorkTarget = backgroundWorkSession(agent.runtimeBinding);
	const reasonId = useId();
	const terminalEpoch = runtime.terminalEpoch;
	const count = runtime.turnCompletedCount;
	const working = state === "working";
	const {
		snapshot,
		setSnapshot,
		readFailed,
		setReadFailed,
		pending,
		setPending,
		sendError,
		setSendError,
		sending,
		setSending,
		approvalAnswer,
		setApprovalAnswer,
	} = chat;
	const chatDraft = useAgentChatDraft(nativeAgentChatDraftIdentity(agent));
	const draft = chatDraft.draft.text;
	const cursor = nativeAgentChatRefreshCursor({
		conversationId,
		terminalEpoch,
		turnCompletedCount: count,
		working,
	});

	// The cursor is the refresh contract: it changes exactly when the inputs
	// read below (conversation, terminal generation, Host count) change. A new
	// owner of the pane's state also re-reads, since its setters are new. The
	// pane keeps the last read, so showing the view again at the same cursor
	// reuses it.
	const readCursor = snapshot?.cursor;
	useEffect(() => {
		if (readCursor === cursor) return;
		let current = true;
		void readProviderConversationTranscript(provider, conversationId, {
			includeTools: true,
		}).then(
			(transcript) => {
				if (!current) return;
				setSnapshot({ transcript, turnCompletedCount: count, cursor });
				setReadFailed(false);
			},
			() => {
				if (current) setReadFailed(true);
			},
		);
		return () => {
			current = false;
		};
	}, [cursor, setSnapshot, setReadFailed]);

	// Older history loads on request above the newest read, from where that
	// read starts; a newer read that starts elsewhere starts the pages again.
	const older = useOlderProviderHistory(
		{ provider, conversationId },
		snapshot?.transcript.olderCursor,
		(before) =>
			readProviderConversationTranscript(provider, conversationId, {
				includeTools: true,
				before,
			}),
	);
	const olderPages = older.pages?.pages;
	const livePending =
		pending && !nativeAgentChatPendingSettled(pending, snapshot)
			? pending
			: undefined;
	const page = useMemo(() => {
		if (!snapshot) return undefined;
		try {
			return nativeAgentChatPage({
				source: { kind: "local", agentId, provider, conversationId },
				transcript: snapshot.transcript,
				older: olderPages,
				canLoadOlder: true,
				terminalEpoch,
				working,
				pending: livePending,
			});
		} catch {
			return null;
		}
	}, [
		agentId,
		provider,
		conversationId,
		snapshot,
		olderPages,
		terminalEpoch,
		working,
		livePending,
	]);

	const approval = pendingApproval(runtime);
	const showsApproval = approvalShown(approval, approvalAnswer);
	const approvalAnswerHere =
		approval && approvalAnswer?.attentionId === approval.attentionId
			? approvalAnswer
			: undefined;
	const approvalError =
		approvalAnswerHere?.state === "failed" && approvalAnswerHere.failure
			? presentNativeAgentApprovalError(approvalAnswerHere.failure)
			: undefined;
	const composer = nativeAgentChatComposerState({
		runtime,
		state,
		sending,
		pending: livePending !== undefined && !livePending.released,
		approvalShown: showsApproval,
	});
	const reason = nativeAgentChatComposerReason(composer);
	const error = sendError ? presentNativeAgentInputError(sendError) : undefined;

	// Drafting is always open; only submission waits for an idle prompt. The
	// draft is read-only for the short in-flight send so the text that clears
	// on success is exactly the text that was written.
	const submit = async () => {
		const text = draft;
		if (
			composer.kind !== "ready" ||
			chatDraft.moving ||
			!chatDraft.mayEdit() ||
			!text.trim()
		) {
			return;
		}
		setSendError(undefined);
		setSending(true);
		try {
			await sendNativeAgentPrompt(
				{
					agentId: agent.id,
					backendProfileId: nativeAgentPromptBackendProfileId(agent),
					expectedTerminalEpoch: terminalEpoch,
				},
				text,
			);
			setPending({
				text,
				sentAtMs: Date.now(),
				userEntriesAtSend: snapshot
					? nativeTranscriptUserEntries(snapshot.transcript)
					: null,
				turnCompletedCountAtSend: count,
			});
			chatDraft.setText((current) => (current === text ? "" : current));
		} catch (cause) {
			setSendError(nativeAgentInputFailure(cause));
		} finally {
			setSending(undefined);
		}
	};

	// One answer per approval: the Host refuses a second one anyway, and the
	// card stays answerable after a failure only to say why and offer the
	// terminal.
	const answer = async (value: unknown) => {
		if (!approval || approvalAnswerHere?.state === "sending") return;
		const choice = nativeAgentApprovalChoice(approval.request, value);
		if (!choice) return;
		const { attentionId } = approval;
		setApprovalAnswer({ attentionId, state: "sending" });
		try {
			await answerNativeAgentApproval(
				{
					agentId: agent.id,
					backendProfileId: nativeAgentPromptBackendProfileId(agent),
					expectedTerminalEpoch: terminalEpoch,
				},
				attentionId,
				choice,
			);
			setApprovalAnswer({ attentionId, state: "sent" });
		} catch (cause) {
			setApprovalAnswer({
				attentionId,
				state: "failed",
				failure: nativeAgentInputFailure(cause),
			});
		}
	};

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
			<ChatComposerShell
				onSubmit={() => void submit()}
				notices={
					<>
						{showsApproval && (
							<div className="mb-2">
								<AgentPendingRequestCard
									pending={nativeAgentApprovalCardRequest(approval, {
										agentId,
										terminalEpoch,
									})}
									permissionDecisions={nativeAgentApprovalDecisions(
										approval.request,
									)}
									busy={approvalAnswerHere?.state === "sending"}
									onAnswer={(value) => void answer(value)}
									notice={
										approvalError && (
											<ChatAlert className="items-center" role="alert">
												<span data-selectable className="min-w-0 flex-1">
													{approvalError.message}
													<span className="ml-1 font-mono text-[0.85em] opacity-70">
														{approvalError.detail}
													</span>
												</span>
												<Button
													type="button"
													variant="ghost"
													size="xs"
													onClick={onContinueInTerminal}
												>
													{t("agents.nativeChat.approval.openTerminal")}
												</Button>
											</ChatAlert>
										)
									}
								/>
							</div>
						)}
						{page && readFailed && (
							<ChatAlert className="mb-2 items-center">
								<span className="min-w-0 flex-1">
									{t("agents.nativeChat.transcriptUnavailable")}
								</span>
							</ChatAlert>
						)}
						{error && (
							<ChatAlert className="mb-2 items-center" role="alert">
								<span data-selectable className="min-w-0 flex-1">
									{error.message}
									{error.detail && (
										<span className="ml-1 font-mono text-[0.85em] opacity-70">
											{error.detail}
										</span>
									)}
								</span>
							</ChatAlert>
						)}
					</>
				}
				input={{
					value: draft,
					onValueChange: (value) => chatDraft.setText(value),
					readOnly: sending || chatDraft.moving,
					"aria-describedby": reason ? reasonId : undefined,
				}}
				controls={
					<>
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={onContinueInTerminal}
						>
							{t("agents.finalResponse.continueInTerminal")}
						</Button>
						{reason && (
							<span
								id={reasonId}
								role="status"
								className={`min-w-0 flex-1 truncate pl-1 text-[0.85em] text-muted-foreground ${
									composer.kind === "disabled" &&
									(
										composer.reason === "working" ||
											composer.reason === "sending"
									)
										? "chat-shimmer"
										: ""
								}`}
							>
								{reason}
							</span>
						)}
					</>
				}
				action={
					<ChatComposerSendButton
						disabled={
							composer.kind !== "ready" || chatDraft.moving || !draft.trim()
						}
					/>
				}
			/>
		</section>
	);
}
