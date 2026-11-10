import { useEffect, useId, useMemo } from "react";
import { NativeAgentBackgroundWork } from "@/components/agents/NativeAgentBackgroundWork";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import {
	ChatComposerSendButton,
	ChatComposerShell,
} from "@/components/agents/chat/ChatComposerShell";
import { useAgentChatDraft } from "@/components/agents/chat/useAgentChatDraft";
import type { NativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { backgroundWorkSession } from "@/lib/agents/chat/backgroundWork";
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
import { sendNativeAgentPrompt } from "@/lib/ipc/dureAgentNativeInput";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { Agent } from "@/types";
import type { NativeAgentTranscriptSource } from "../../../cli/lib/agent-transcript.mjs";

const noOlderHistory = async () => {};

/** The conversation view of a native terminal Agent: the provider transcript,
 * with the tool calls between its messages as collapsed bursts, rendered with
 * the shared chat rows, plus the shared composer on the Host's idle prompt
 * path. The terminal stays mounted underneath and owns
 * everything the transcript cannot show (approvals, slash commands, trust
 * prompts). The pane owns the runtime state (`chat`) and the draft lives in
 * the shared chat draft store, so neither is lost when this view unmounts. */
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
		terminalEpoch,
		working,
		livePending,
	]);

	const composer = nativeAgentChatComposerState({
		runtime,
		state,
		sending,
		pending: livePending !== undefined && !livePending.released,
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
					loadingOlder={false}
					onLoadOlder={noOlderHistory}
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
