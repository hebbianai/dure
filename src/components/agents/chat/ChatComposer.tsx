import type { IDockviewPanelProps } from "dockview-react";
import { ArrowUp, CornerUpLeft, ImageIcon, Square, X, Zap } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Titled } from "@/components/ui/tooltip";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { AgentSlackShare } from "@/components/agents/chat/AgentSlackShare";
import { usePromptAttachments } from "@/components/agents/usePromptAttachments";
import { useChatInputLatency } from "@/components/agents/chat/useChatInputLatency";
import { useAgentLaunchControlsPresentation } from "@/components/agents/useAgentToolbarControls";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Textarea } from "@/components/ui/textarea";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import { usePaneInputFocus } from "@/components/workspace/usePaneInputFocus";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { buildPromptWithAttachments } from "@/lib/agents/attachmentPrompt";
import { presentActionError } from "@/lib/agents/chat/actionErrorPresentation";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { useAgentChatDraft } from "@/components/agents/chat/useAgentChatDraft";
import {
	latestTurnFailure,
	TURN_FAILURE_REASON_COPY,
} from "@/lib/agents/chat/turnFailureReason";
import {
	observedProviderCatalog,
	observedSessionInit,
} from "@/lib/agents/chat/observedRuntimeFacts";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import { saveChatAttachments } from "@/lib/ipc";
import { track } from "@/lib/ipc/telemetry";
import { noteUserInput } from "@/lib/scheduling/interactionSignals";
import type { Provider } from "@/types";

function knownProvider(value: string): Provider | null {
	return PROVIDER_IDS.find((candidate) => candidate === value) ?? null;
}

function submissionAuthority(session: AgentChatSessionView): string | null {
	const binding = session.page?.binding;
	const identity = session.draftIdentity;
	return binding &&
		binding.agentId === identity.agentId &&
		binding.interactionSessionId === identity.interactionSessionId
		? JSON.stringify([
				identity.agentId,
				identity.backendProfileId,
				binding.interactionSessionId,
				binding.timelineEpoch,
				binding.bindingRevision,
				binding.runtime.runtimeGeneration,
				binding.runtime.providerEpoch,
			])
		: null;
}

const EMPTY_LAUNCH_SELECTION_VIEW: AgentRuntimeLaunchSelectionView = {
	ownerKey: undefined,
	loaded: false,
	hydrationError: false,
	model: null,
	effort: null,
	permissionMode: "default",
	switching: false,
	error: null,
	switchSelection: async () => ({ outcome: "refused", error: { code: "runtime_unavailable", message: "No runtime is selected.", retryable: false } }),
	retryHydration: () => {},
	dismissError: () => {},
};

/** Banner text for a failed session action: catalogued backend tokens read
 * as words with the raw token kept as quiet diagnostic detail; anything
 * unrecognized renders verbatim. */
function ActionErrorText({ raw }: { raw: string }) {
	const { message, detail } = presentActionError(raw);
	return (
		<span className="min-w-0 flex-1">
			{message}
			{detail && (
				<code className="ml-1.5 text-[0.85em] opacity-70">{detail}</code>
			)}
		</span>
	);
}

/** Credential recoveries the owning pane can perform. Rendered only for a
 * turn whose provider-reported failure reason justifies them; never inferred
 * from a generic failure. `switchAccount` is the pane-scoped switch to a
 * named other account (the same authority as the toolbar switcher), present
 * only when the pane has one; otherwise the banner offers account management. */
export interface ChatTurnFailureRecovery {
	readonly switchAccount?: { readonly targetName: string; readonly run: () => void };
	readonly manageAccounts: () => void;
	readonly signIn?: () => void;
	/** The failure on screen was already answered by an account handoff:
	 * say what moved where, and offer to resend the message that failed. */
	readonly handedOff?: {
		readonly fromName?: string;
		readonly toName: string;
		readonly resend?: () => void;
	};
}

/** The floating glass composer: session-level error banners, a single-line
 * auto-growing textarea, and a control row below it — launch-selection
 * pickers on the left, send/interrupt on the right. Edits the shared IDE draft. */
export function ChatComposer({
	session,
	paneApi,
	disabled,
	launch,
	catalogSource,
	shimmer = false,
	attachmentsEnabled = true,
	recovery,
}: {
	session: AgentChatSessionView;
	paneApi?: IDockviewPanelProps["api"];
	disabled: boolean;
	launch?: AgentRuntimeLaunchSelectionView;
	catalogSource?: ProviderCatalogSource;
	shimmer?: boolean;
	attachmentsEnabled?: boolean;
	recovery?: ChatTurnFailureRecovery;
}) {
	const identity = session.draftIdentity;
	const chatDraft = useAgentChatDraft(identity);
	const {
		draft: composed,
		moving: draftMoving,
		epoch: draftEpoch,
		mayEdit: mayEditDraft,
		setText: setDraft,
		setAttachments,
	} = chatDraft;
	const draft = composed.text;
	const [attachmentError, setAttachmentError] = useState<string | null>(null);
	const [dismissedFailureItemId, setDismissedFailureItemId] = useState<
		string | null
	>(null);
	const rows = session.page?.rows;
	const historyFacts = useMemo(() => {
		const page = rows ? { rows } : undefined;
		return {
			model: observedSessionInit(page).model,
			catalog: observedProviderCatalog(page),
			turnFailure: latestTurnFailure(rows ?? []),
		};
	}, [rows]);
	const turnFailure = session.activeTurn ? undefined : historyFacts.turnFailure;
	const handedOff =
		recovery?.handedOff && turnFailure && turnFailure.itemId !== dismissedFailureItemId
			? { failure: turnFailure, ...recovery.handedOff }
			: undefined;
	const failureRecovery =
		recovery &&
		!recovery.handedOff &&
		turnFailure &&
		turnFailure.recoveries.length > 0 &&
		turnFailure.itemId !== dismissedFailureItemId
			? turnFailure
			: undefined;
	const [submittingAuthority, setSubmittingAuthority] = useState<string | null>(
		null,
	);
	const beginInputLatencySample = useChatInputLatency(draft);
	const binding = session.page?.binding;
	const authority = submissionAuthority(session);
	const sessionRef = useRef<AgentChatSessionView | null>(session);
	const authorityRef = useRef<string | null>(authority);
	const attachmentsEnabledRef = useRef(attachmentsEnabled);
	const blockedRef = useRef(false);
	const submissionRef = useRef<{ authority: string } | null>(null);
	sessionRef.current = session;
	authorityRef.current = authority;
	attachmentsEnabledRef.current = attachmentsEnabled;
	const provider = binding ? knownProvider(binding.providerId) : null;
	const runtimeLaunch = launch ?? EMPTY_LAUNCH_SELECTION_VIEW;
	const launchControlsPresentation =
		useAgentLaunchControlsPresentation(runtimeLaunch);
	// The switch replaces the provider runtime; until the chat session has
	// reconnected to the replacement, the whole composer treats it as one
	// in-flight operation.
	const replacementInFlight = runtimeLaunch.switching;
	const submissionInFlight =
		authority !== null && submittingAuthority === authority;
	blockedRef.current = disabled || replacementInFlight || draftMoving;
	const { deferSubmit, attachments, clear: clearAttachments, remove: removeAttachment, inputProps: attachmentInput } = usePromptAttachments({
		attachments: composed.attachments,
		setAttachments,
		scope: disabled || replacementInFlight || draftMoving || !authority ? null : `${authority}:${draftEpoch}`,
		unavailable: attachmentsEnabled ? undefined : t("agents.chat.attachmentRemoteUnavailable"),
		imageName: (ext, index) => `pasted-${session.page?.finalCursor.sequence ?? 0}-${index + 1}.${ext}`,
		onText: (text) => setDraft((current) => current + text),
		onError: setAttachmentError,
		onAttach: () => setAttachmentError(null),
		onReadyToSubmit: () => { void submit(); },
	});
	useEffect(
		() => () => {
			sessionRef.current = null;
			authorityRef.current = null;
			attachmentsEnabledRef.current = false;
			submissionRef.current = null;
		},
		[],
	);

	const submit = async (event?: FormEvent) => {
		event?.preventDefault();
		if (deferSubmit()) return;
		if (
			disabled ||
			!mayEditDraft() ||
			replacementInFlight ||
			submissionInFlight ||
			session.retryTurnAvailable ||
			(!draft.trim() && attachments.length === 0)
		) {
			return;
		}
		if (!attachmentsEnabled && attachments.length > 0) {
			setAttachmentError(t("agents.chat.attachmentRemoteUnavailable"));
			return;
		}
		if (!authority || submissionRef.current?.authority === authority) return;
		const submission = { authority };
		submissionRef.current = submission;
		setSubmittingAuthority(authority);
		// Attachments persist to disk first — the delivered text references
		// them by absolute path, the same contract quick dispatch uses.
		let input = draft;
		try {
			if (attachments.length > 0) {
				if (!binding) return;
				const paths = await saveChatAttachments(
					binding.interactionSessionId,
					attachments,
				);
				if (!attachmentsEnabledRef.current) {
					if (authorityRef.current === authority) {
						setAttachmentError(t("agents.chat.attachmentRemoteUnavailable"));
					}
					return;
				}
				input = buildPromptWithAttachments(draft, paths);
			}
			const activeSession = sessionRef.current;
			if (
				authorityRef.current !== authority ||
				!chatDraft.isCurrent() ||
				blockedRef.current ||
				!mayEditDraft() ||
				!activeSession ||
				activeSession.phase !== "ready" ||
				activeSession.retryTurnAvailable
			) {
				return;
			}
			setAttachmentError(null);
			// While a turn runs, steer at the next provider boundary. Providers
			// without a steering channel fall back to the controller-owned queue.
			if (activeSession.sending || activeSession.activeTurn) {
				setDraft("");
				clearAttachments();
				try {
					await activeSession.steerOrQueue(input);
					if (binding) track("message_sent", { provider: binding.providerId });
				} catch (cause) {
					if (authorityRef.current === authority) {
						setAttachmentError(
							cause instanceof Error ? cause.message : String(cause),
						);
						setDraft((current) => (current ? current : input));
					}
				}
				return;
			}
			setDraft("");
			clearAttachments();
			try {
				await activeSession.send(input);
				if (binding) track("message_sent", { provider: binding.providerId });
			} catch {
				// The controller retains the exact retry intent; restoring the draft
				// could invite a second, differently identified send.
			}
		} catch (cause) {
			if (authorityRef.current === authority) {
				setAttachmentError(
					cause instanceof Error ? cause.message : String(cause),
				);
			}
		} finally {
			if (submissionRef.current === submission) {
				submissionRef.current = null;
				setSubmittingAuthority((current) =>
					current === authority ? null : current,
				);
			}
		}
	};

	const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault();
			void submit();
		}
	};

	const inputRef = useRef<HTMLTextAreaElement>(null);
	const inputDisabled =
		disabled ||
		draftMoving ||
		replacementInFlight ||
		submissionInFlight ||
		session.phase !== "ready" ||
		session.sending;
	usePaneInputFocus({ paneApi, inputRef, inputReady: !inputDisabled });

	return (
		<form
			className="px-2 pt-0.5 pb-2 @2xl/chat:px-3 @2xl/chat:pb-3"
			onSubmit={submit}
		>
			<div className="mx-auto max-w-3xl">
				{session.error && !session.reconnecting && (
					<Alert className="mb-2 items-center">
						<span className="min-w-0 flex-1">{session.error}</span>
						<Button
							type="button"
							size="xs"
							variant="outline"
							onClick={session.retryConnection}
						>
							{t("common.retry")}
						</Button>
					</Alert>
				)}
				{attachmentError && (
					<Alert className="mb-2 items-center">
						<span className="min-w-0 flex-1">{attachmentError}</span>
					</Alert>
				)}
				{handedOff && (
					<Alert className="mb-2 flex-wrap items-center" icon={false}>
						<span className="min-w-0 flex-1">
							{handedOff.fromName
								? t("agents.chat.recovery.handedOff", {
										from: handedOff.fromName,
										to: handedOff.toName,
									})
								: t("agents.chat.recovery.handedOffTo", { to: handedOff.toName })}
						</span>
						<div className="ml-auto flex flex-wrap justify-end gap-1">
							{handedOff.resend && (
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={handedOff.resend}
								>
									{t("agents.chat.recovery.resend")}
								</Button>
							)}
							<IconButton
								title={t("common.close")}
								className="-m-1 shrink-0"
								onClick={() => setDismissedFailureItemId(handedOff.failure.itemId)}
							>
								<X aria-hidden="true" />
							</IconButton>
						</div>
					</Alert>
				)}
				{failureRecovery && recovery && (
					<Alert className="mb-2 flex-wrap items-center">
						<span className="min-w-0 flex-1">
							{t(TURN_FAILURE_REASON_COPY[failureRecovery.reason])}
						</span>
						<div className="ml-auto flex flex-wrap justify-end gap-1">
							{failureRecovery.recoveries.includes("sign_in") &&
								recovery.signIn && (
									<Button
										type="button"
										size="xs"
										variant="outline"
										onClick={recovery.signIn}
									>
										{t("agents.chat.recovery.signIn")}
									</Button>
								)}
							{recovery.switchAccount ? (
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={recovery.switchAccount.run}
								>
									{t("agents.chat.recovery.switchTo", {
										name: recovery.switchAccount.targetName,
									})}
								</Button>
							) : (
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={recovery.manageAccounts}
								>
									{t("agents.chat.recovery.manageAccounts")}
								</Button>
							)}
							<IconButton
								title={t("common.close")}
								className="-m-1 shrink-0 text-destructive hover:text-destructive"
								onClick={() => setDismissedFailureItemId(failureRecovery.itemId)}
							>
								<X aria-hidden="true" />
							</IconButton>
						</div>
					</Alert>
				)}
				{session.actionError && (
					<Alert className="mb-2 flex-wrap items-center">
						<ActionErrorText raw={session.actionError} />
						{!session.retryTurnAvailable && (
							<IconButton
								title={t("common.close")}
								className="-m-1 ml-auto shrink-0 text-destructive hover:text-destructive"
								onClick={() => session.dismissActionError()}
							>
								<X aria-hidden="true" />
							</IconButton>
						)}
						{session.retryTurnAvailable && (
							<div className="ml-auto flex w-full flex-wrap justify-end gap-1 @lg/chat:w-auto">
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={() => void session.retryTurn().catch(() => {})}
								>
									{t("agents.chat.retrySend")}
								</Button>
								<Button
									type="button"
									size="xs"
									variant="outline"
									onClick={() => {
										if (!mayEditDraft()) return;
										const restored = session.editRetryableTurn();
										if (restored !== undefined) {
											setDraft((current) =>
												current ? `${restored}\n${current}` : restored,
											);
										}
									}}
								>
									{t("agents.chat.editUncertainSend")}
								</Button>
							</div>
						)}
					</Alert>
				)}
				{/* glass/chrome is the input-on-glass material (the same fill
				    SEARCH_FIELD_SURFACE uses), not the app floor. bg-background
				    made this bar darker than the pane it floats on, which reads
				    as sunken — depth here is brightness, not shadow (SOUL §3.2)
				    — and the gap widened once the pane surface stopped sharing
				    the app floor's value. */}
				<div className="flex flex-col gap-0.5 rounded-xl border border-glass-hairline bg-glass-chrome px-2 py-1.5 shadow-card backdrop-blur-xl transition-shadow duration-150 focus-within:shadow-menu @2xl/chat:rounded-2xl @2xl/chat:px-2.5">
					{session.queuedMessages.length > 0 && (
						<div className="flex flex-col gap-1 border-b border-glass-hairline px-1 pt-0.5 pb-1.5">
							{session.queuedMessages.map((text, index) => (
								<div
									key={`${index}:${text.slice(0, 24)}`}
									className="group/queued flex items-baseline gap-1.5 text-[0.92em]"
								>
									<span
										data-selectable
										className="min-w-0 flex-1 truncate text-muted-foreground"
									>
										{text}
									</span>
									<IconButton
										title={t("agents.chat.queuedEdit")}
										className="size-5 opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
										onClick={() => {
											if (!mayEditDraft()) return;
											const removed = session.dequeueMessage(index);
											if (removed !== undefined) {
												setDraft((current) =>
													current ? `${current}\n${removed}` : removed,
												);
											}
										}}
									>
										<CornerUpLeft aria-hidden="true" />
									</IconButton>
									<IconButton
										title={t("agents.chat.queuedRemove")}
										className="size-5 opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
										onClick={() => session.dequeueMessage(index)}
									>
										<X aria-hidden="true" />
									</IconButton>
								</div>
							))}
							{/* The action is an icon control (owner call 2026-08-31 —
							    a sentence-long button dominated the row); its fast
							    tooltip carries the full "interrupt and send now"
							    label, and the hint keeps truncating first. */}
							<span className="flex items-center justify-between gap-2 text-[0.77em] text-muted-foreground/80">
								<Titled title={t("agents.chat.queuedHint")}>
									<span
										className="min-w-0 flex-1 truncate"
									>
										{t("agents.chat.queuedHint")}
									</span>
								</Titled>
								{"activeTurn" in session && session.activeTurn && (
									<ToolbarControl
										label={t("agents.chat.queuedInterruptSend")}
										icon={
											<Zap aria-hidden="true" className="size-3.5 shrink-0" />
										}
										className="shrink-0"
										disabled={session.interrupting}
										onClick={() => void session.interrupt().catch(() => {})}
									/>
								)}
							</span>
						</div>
					)}
					{attachments.length > 0 && (
						<div className="flex flex-wrap items-center gap-1 px-1 pt-0.5">
							{attachments.map((file, index) => (
								<span
									key={`${index}:${file.fileName}`}
									className="flex min-w-0 items-center gap-1 rounded-md bg-glass-tint-selected px-1.5 py-0.5 text-[0.85em] text-muted-foreground"
								>
									<ImageIcon aria-hidden="true" className="size-3 shrink-0" />
									<span className="max-w-32 truncate">{file.fileName}</span>
									<IconButton
										title={t("agents.chat.attachmentRemove")}
										className="size-4"
										onClick={() => removeAttachment(index)}
									>
										<X aria-hidden="true" />
									</IconButton>
								</span>
							))}
						</div>
					)}
					{/* The grid mirror owns intrinsic height without a geometry read;
					    the sentinel preserves an empty trailing line. */}
					<div className="grid min-w-0">
						<div
							aria-hidden="true"
							className="invisible col-start-1 row-start-1 max-h-40 min-h-7 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words px-1 py-1 text-[length:inherit]"
						>
							{`${draft}\u200b`}
						</div>
						<Textarea
							ref={inputRef}
							rows={1}
							value={draft}
							onChange={(event) => {
								beginInputLatencySample();
								noteUserInput();
								setDraft(event.target.value);
							}}
							onKeyDown={onComposerKeyDown}
							{...attachmentInput}
							placeholder={t("agents.chat.composerPlaceholder")}
							aria-label={t("agents.chat.composerLabel")}
							className="col-start-1 row-start-1 h-full max-h-40 min-h-7 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1 text-[length:inherit] shadow-none focus-visible:ring-0 dark:bg-transparent dark:disabled:bg-transparent"
							disabled={inputDisabled}
						/>
					</div>
					{/* Wrap instead of truncating: in a narrow pane three pills
					    squeezed onto one line all cut mid-word ("Reasoning
					    effo…"), which read as broken UI (user report
					    2026-08-31). */}
					<div className="flex min-w-0 flex-wrap items-center gap-0.5">
						{provider && !replacementInFlight && (
							<AgentLaunchSelectionControls
								provider={provider}
								launch={runtimeLaunch}
								presentation={launchControlsPresentation}
								observedModel={historyFacts.model}
								catalog={historyFacts.catalog}
								catalogSource={catalogSource}
								busy={
									disabled || draftMoving ||
									replacementInFlight ||
									submissionInFlight ||
									session.sending ||
									Boolean(session.activeTurn)
								}
							/>
						)}
						{replacementInFlight && launch && (
							<span
								className={`${shimmer ? "chat-shimmer " : ""}min-w-0 truncate pl-1 text-[0.85em]`}
							>
								{t("agents.chat.switching")}
							</span>
						)}
						<AgentSlackShare
							key={`${session.draftIdentity.backendProfileId}:${session.draftIdentity.agentId}:${session.draftIdentity.interactionSessionId}`}
							identity={session.draftIdentity}
							disabled={disabled || draftMoving || replacementInFlight || session.phase !== "ready"}
						/>
						<div className="ml-auto shrink-0 pl-2">
							{session.activeTurn ? (
								<Button
									type="button"
									size="icon-sm"
									variant="outline"
									className="rounded-full"
									title={t("agents.chat.interrupt")}
									disabled={disabled || session.interrupting}
									onClick={() => void session.interrupt().catch(() => {})}
								>
									<Square aria-hidden="true" className="fill-current" />
								</Button>
							) : (
								<Button
									type="submit"
									size="icon-sm"
									className="rounded-full"
									title={t("agents.chat.send")}
									disabled={
										disabled || draftMoving ||
										replacementInFlight ||
										submissionInFlight ||
										(!draft.trim() && attachments.length === 0) ||
										session.sending ||
										session.retryTurnAvailable ||
										session.phase !== "ready"
									}
								>
									<ArrowUp aria-hidden="true" />
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		</form>
	);
}
