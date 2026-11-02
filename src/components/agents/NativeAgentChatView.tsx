import { ArrowUp } from "lucide-react";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useState,
} from "react";
import { TranscriptContents } from "@/components/agents/chat/AgentChatTimelineRows";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import { useRuntimeOwnedValue } from "@/components/agents/useRuntimeOwnedValue";
import { PanelStatus } from "@/components/common/PanelStatus";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import {
	type NativeAgentChatPendingPrompt,
	type NativeAgentChatSnapshot,
	nativeAgentChatComposerReason,
	nativeAgentChatComposerState,
	nativeAgentChatPage,
	nativeAgentChatPendingSettled,
	nativeAgentChatRefreshCursor,
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

/** The conversation view of a native terminal Agent: the provider transcript
 * rendered with the shared chat rows, plus a composer on the Host's idle
 * prompt path. The terminal stays mounted underneath and owns everything the
 * transcript cannot show (approvals, slash commands, trust prompts). */
export function NativeAgentChatView({
	agent,
	source,
	runtime,
	state,
	draft,
	onDraftChange,
	onContinueInTerminal,
}: {
	agent: Agent;
	source: NativeAgentTranscriptSource;
	runtime: HmuxAgentRuntimeState;
	state: AgentDisplayState;
	draft: string;
	onDraftChange(draft: string): void;
	onContinueInTerminal(): void;
}) {
	const { agentId, provider, conversationId } = source;
	const reasonId = useId();
	const terminalEpoch = runtime.terminalEpoch;
	const count = runtime.turnCompletedCount;
	const working = state === "working";
	const ownerKey = JSON.stringify([
		agentRuntimePresentationOwnerKey(agent),
		conversationId,
		terminalEpoch,
	]);
	const [snapshot, setSnapshot] =
		useRuntimeOwnedValue<NativeAgentChatSnapshot>(ownerKey);
	const [readFailed, setReadFailed] = useRuntimeOwnedValue<boolean>(ownerKey);
	const [pending, setPending] =
		useRuntimeOwnedValue<NativeAgentChatPendingPrompt>(ownerKey);
	const [sendError, setSendError] = useRuntimeOwnedValue<string>(ownerKey);
	const [sendingOwner, setSendingOwner] = useState<string>();
	const sending = sendingOwner === ownerKey;
	const cursor = nativeAgentChatRefreshCursor({
		conversationId,
		terminalEpoch,
		turnCompletedCount: count,
		working,
	});

	// The cursor is the refresh contract: it changes exactly when the inputs
	// read below (conversation, terminal generation, Host count) change. A new
	// presentation owner also re-reads, since its setters drop older writes.
	useEffect(() => {
		let current = true;
		void readProviderConversationTranscript(provider, conversationId).then(
			(transcript) => {
				if (!current) return;
				setSnapshot({ transcript, turnCompletedCount: count });
				setReadFailed(false);
			},
			() => {
				if (current) setReadFailed(true);
			},
		);
		return () => {
			current = false;
		};
	}, [ownerKey, cursor]);

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
		pending: livePending !== undefined,
	});
	const reason = nativeAgentChatComposerReason(composer);
	const error = sendError ? presentNativeAgentInputError(sendError) : undefined;

	const submit = async (event?: FormEvent) => {
		event?.preventDefault();
		const text = draft;
		if (composer.kind !== "ready" || !text.trim()) return;
		setSendError(undefined);
		setSendingOwner(ownerKey);
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
			onDraftChange("");
		} catch (cause) {
			const code =
				cause && typeof cause === "object" && "code" in cause
					? String(cause.code)
					: "agent_runtime_native_input_failed";
			setSendError(code);
		} finally {
			setSendingOwner((current) =>
				current === ownerKey ? undefined : current,
			);
		}
	};
	const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			void submit();
		}
	};

	return (
		<section
			aria-label={t("agents.nativeChat.conversation")}
			className="@container/chat absolute inset-0 flex min-h-0 flex-col bg-surface-terminal pt-9 text-sm leading-relaxed"
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
			<form
				className="px-2 pt-0.5 pb-2 @2xl/chat:px-3 @2xl/chat:pb-3"
				onSubmit={(event) => void submit(event)}
			>
				<div className="mx-auto flex max-w-3xl flex-col gap-1.5">
					{page && readFailed && (
						<ChatAlert className="items-center">
							<span className="min-w-0 flex-1">
								{t("agents.nativeChat.transcriptUnavailable")}
							</span>
						</ChatAlert>
					)}
					{error && (
						<ChatAlert className="items-center" role="alert">
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
					<div className="flex flex-col gap-0.5 rounded-xl border border-glass-hairline bg-glass-chrome px-2 py-1.5 shadow-card backdrop-blur-xl transition-shadow duration-150 focus-within:shadow-menu @2xl/chat:rounded-2xl @2xl/chat:px-2.5">
						<Textarea
							rows={1}
							value={draft}
							onChange={(event) => onDraftChange(event.target.value)}
							onKeyDown={onKeyDown}
							placeholder={t("agents.chat.composerPlaceholder")}
							aria-label={t("agents.chat.composerLabel")}
							aria-describedby={reason ? reasonId : undefined}
							className="max-h-40 min-h-7 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-[length:inherit] shadow-none focus-visible:ring-0 dark:bg-transparent dark:disabled:bg-transparent"
							disabled={composer.kind !== "ready"}
						/>
						<div className="flex min-w-0 flex-wrap items-center gap-1">
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
									className={`min-w-0 flex-1 truncate text-[0.85em] text-muted-foreground ${
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
							<div className="ml-auto shrink-0 pl-2">
								<Button
									type="submit"
									size="icon-sm"
									className="rounded-full"
									title={t("agents.chat.send")}
									aria-label={t("agents.chat.send")}
									disabled={composer.kind !== "ready" || !draft.trim()}
								>
									<ArrowUp aria-hidden="true" />
								</Button>
							</div>
						</div>
					</div>
				</div>
			</form>
		</section>
	);
}
