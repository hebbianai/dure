import { type ReactNode, useId } from "react";
import { AgentPendingRequestCard } from "@/components/agents/chat/AgentPendingRequestCard";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import {
	ChatComposerSendButton,
	ChatComposerShell,
} from "@/components/agents/chat/ChatComposerShell";
import { useAgentChatDraft } from "@/components/agents/chat/useAgentChatDraft";
import type { NativeAgentChatState } from "@/components/agents/useNativeAgentChatState";
import { Button } from "@/components/ui/button";
import type { AgentDisplayState } from "@/lib/agents/agentStateModel";
import { approvalShown, pendingApproval } from "@/lib/agents/approvalRequest";
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
	nativeAgentInputFailure,
	nativeAgentPromptBackendProfileId,
	nativeTranscriptUserEntries,
	presentNativeAgentInputError,
} from "@/lib/agents/chat/nativeAgentChat";
import { t } from "@/lib/i18n";
import {
	answerNativeAgentApproval,
	sendNativeAgentPrompt,
} from "@/lib/ipc/dureAgentNativeInput";
import type { HmuxAgentRuntimeState } from "@/lib/ipc/hmuxContracts";
import type { Agent } from "@/types";

/** The shared composer of a native terminal Agent's conversation, on the
 * Host's idle prompt path: a prompt is written only at an idle prompt of the
 * runtime's terminal generation, and an approval whose provider said what it
 * asks shows as the shared pending-request card, answered through the Host's
 * attention response. Everything else waits with its reason and the way to
 * the terminal. The caller owns the runtime-owned state (`chat`), so a sent
 * prompt outlives this composer; the draft lives in the shared chat draft
 * store. */
export function NativeAgentChatComposer({
	agent,
	runtime,
	state,
	chat,
	notices,
	onContinueInTerminal,
}: {
	agent: Agent;
	runtime: HmuxAgentRuntimeState;
	state: AgentDisplayState;
	chat: NativeAgentChatState;
	/** What the conversation above has to say, shown before the composer's
	 * own notices. */
	notices?: ReactNode;
	/** Shows the terminal itself, for what the conversation cannot answer;
	 * absent where no terminal can be shown from here. */
	onContinueInTerminal?: () => void;
}) {
	const reasonId = useId();
	const terminalEpoch = runtime.terminalEpoch;
	const count = runtime.turnCompletedCount;
	const {
		snapshot,
		livePending,
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
		<ChatComposerShell
			onSubmit={() => void submit()}
			notices={
				<>
					{showsApproval && (
						<div className="mb-2">
							<AgentPendingRequestCard
								pending={nativeAgentApprovalCardRequest(approval, {
									agentId: agent.id,
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
											{onContinueInTerminal && (
												<Button
													type="button"
													variant="ghost"
													size="xs"
													onClick={onContinueInTerminal}
												>
													{t("agents.nativeChat.approval.openTerminal")}
												</Button>
											)}
										</ChatAlert>
									)
								}
							/>
						</div>
					)}
					{notices}
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
					{onContinueInTerminal && (
						<Button
							type="button"
							variant="ghost"
							size="xs"
							onClick={onContinueInTerminal}
						>
							{t("agents.finalResponse.continueInTerminal")}
						</Button>
					)}
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
	);
}
