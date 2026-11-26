import type { IDockviewPanelProps } from "dockview-react";
import { CornerUpLeft, ImageIcon, Square, X, Zap } from "lucide-react";
import { ChatAlert } from "@/components/agents/chat/ChatAlert";
import {
	ChatComposerSendButton,
	ChatComposerShell,
} from "@/components/agents/chat/ChatComposerShell";
import { Titled } from "@/components/ui/tooltip";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { AgentSlackShare } from "@/components/agents/chat/AgentSlackShare";
import {
	ChatSlashCommandPalette,
	chatSlashCommandOptionId,
} from "@/components/agents/chat/ChatSlashCommandPalette";
import { usePromptAttachments } from "@/components/agents/usePromptAttachments";
import { useChatInputLatency } from "@/components/agents/chat/useChatInputLatency";
import { useAgentLaunchControlsPresentation } from "@/components/agents/useAgentToolbarControls";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ToolbarControl } from "@/components/ui/toolbar-control";
import { usePaneInputFocus } from "@/components/workspace/usePaneInputFocus";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import type { ProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { buildPromptWithAttachments } from "@/lib/agents/attachmentPrompt";
import { presentActionError } from "@/lib/agents/chat/actionErrorPresentation";
import type { AgentChatSessionView } from "@/lib/agents/chat/agentChatSessionView";
import { useAgentChatDraft } from "@/components/agents/chat/useAgentChatDraft";
import {
	continuationTimeLabel,
	latestTurnFailure,
	TURN_FAILURE_REASON_COPY,
} from "@/lib/agents/chat/turnFailureReason";
import {
	observedProviderCatalog,
	observedProviderCommands,
	observedSessionInit,
} from "@/lib/agents/chat/observedRuntimeFacts";
import {
	type ChatSlashCommand,
	chatSlashCommands,
	type DureChatCommandId,
	matchSlashCommands,
	resolveSlashCommand,
	slashCommandQuery,
} from "@/lib/agents/chat/slashCommands";
import { PROVIDER_IDS } from "@/lib/agents/providers";
import { currentLang, t } from "@/lib/i18n";
import { saveChatAttachments } from "@/lib/ipc";
import { track } from "@/lib/ipc/telemetry";
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
	readonly chooseAccount?: () => void;
	readonly signIn?: () => void;
	/** The failure on screen was already answered by an account handoff:
	 * say what moved where, and offer to resend the message that failed. */
	readonly handedOff?: {
		readonly fromName?: string;
		readonly toName: string;
		readonly resend?: () => void | Promise<void>;
	};
	/** The backend continues the failed turn on the same account at this
	 * Unix millisecond, after the limit resets. */
	readonly continuesAtMs?: number;
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
	onNewConversation,
}: {
	session: AgentChatSessionView;
	paneApi?: IDockviewPanelProps["api"];
	disabled: boolean;
	launch?: AgentRuntimeLaunchSelectionView;
	catalogSource?: ProviderCatalogSource;
	shimmer?: boolean;
	attachmentsEnabled?: boolean;
	recovery?: ChatTurnFailureRecovery;
	/** The pane's existing "new conversation" control; `/clear` runs it. */
	onNewConversation?: () => void;
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
			commands: observedProviderCommands(page),
		};
	}, [rows]);
	const turnFailure = session.activeTurn
		? undefined
		: latestTurnFailure(session.page?.latestFailure);
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
	const [modelPickerRequest, setModelPickerRequest] = useState(0);
	const [commandNotice, setCommandNotice] = useState<string | null>(null);
	const [paletteDismissedFor, setPaletteDismissedFor] = useState<string | null>(
		null,
	);
	const [activeCommandIndex, setActiveCommandIndex] = useState(0);
	const paletteId = useId();
	// The switch replaces the provider runtime; until the chat session has
	// reconnected to the replacement, the whole composer treats it as one
	// in-flight operation.
	const replacementInFlight = runtimeLaunch.switching;
	const submissionInFlight =
		authority !== null && submittingAuthority === authority;
	const pendingQueueEdits = session.pendingQueueEdits ?? [];
	const queueRows = [
		...pendingQueueEdits,
		...session.queuedMessages.filter(
			(queued) =>
				!pendingQueueEdits.some(
					(edit) => edit.clientMessageId === queued.clientMessageId,
				),
		),
	];
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

	// `/model` opens the composer's model pill, so it exists only while that
	// pill is on screen; `/clear` only where the pane offers a new conversation.
	const modelCommandAvailable =
		provider !== null &&
		!replacementInFlight &&
		!launchControlsPresentation.hidden.has("launch-model");
	const newConversationAvailable = onNewConversation !== undefined;
	const slashCommands = useMemo(
		() =>
			chatSlashCommands(historyFacts.commands, {
				clear: newConversationAvailable,
				model: modelCommandAvailable,
			}),
		[historyFacts.commands, newConversationAvailable, modelCommandAvailable],
	);

	const runDureCommand = (id: DureChatCommandId) => {
		if (!mayEditDraft()) return;
		setDraft("");
		setCommandNotice(null);
		if (id === "model") setModelPickerRequest((request) => request + 1);
		else onNewConversation?.();
	};

	const submit = async (override?: string) => {
		if (override === undefined && deferSubmit()) return;
		const text = override ?? draft;
		if (
			disabled ||
			!mayEditDraft() ||
			replacementInFlight ||
			submissionInFlight ||
			session.retryTurnAvailable ||
			(!text.trim() && attachments.length === 0)
		) {
			return;
		}
		// A slash command runs only when this session can run it: Dure's own
		// map to pane controls, the provider's travel as its own input, and an
		// unknown one stays in the draft with a reason instead of being sent.
		const resolution = resolveSlashCommand(text, slashCommands);
		if (resolution.kind === "unknown") {
			setCommandNotice(
				t("agents.chat.commandUnknown", { name: resolution.name }),
			);
			return;
		}
		if (resolution.kind === "command") {
			// The model picker is locked while a turn runs, and a provider
			// command must not be steered into one as plain text.
			const { command } = resolution;
			const waitsForTurn = command.kind === "provider" || command.id === "model";
			if (waitsForTurn && (session.sending || session.activeTurn)) {
				setCommandNotice(t("agents.chat.commandBusy", { name: command.name }));
				return;
			}
			if (command.kind === "dure") {
				runDureCommand(command.id);
				return;
			}
		}
		setCommandNotice(null);
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
		let input = resolution.kind === "command" ? text.trim() : text;
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
				input = buildPromptWithAttachments(input, paths);
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
			// without a steering channel fall back to the conversation service queue.
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

	const inputRef = useRef<HTMLTextAreaElement>(null);
	const inputDisabled =
		disabled ||
		draftMoving ||
		replacementInFlight ||
		submissionInFlight ||
		session.phase !== "ready" ||
		session.sending;
	usePaneInputFocus({ paneApi, inputRef, inputReady: !inputDisabled });

	const commandQuery = inputDisabled ? null : slashCommandQuery(draft);
	const paletteCommands =
		commandQuery === null ? [] : matchSlashCommands(slashCommands, commandQuery);
	const paletteOpen =
		paletteCommands.length > 0 && paletteDismissedFor !== draft;
	const activeCommand = paletteOpen
		? Math.min(activeCommandIndex, paletteCommands.length - 1)
		: -1;
	const chooseCommand = (command: ChatSlashCommand, complete: boolean) => {
		if (!mayEditDraft()) return;
		// A command that takes arguments completes into the draft first unless
		// its name is already typed out; one that takes none runs at once, as
		// a terminal palette does.
		if (complete || (command.argumentHint && commandQuery !== command.name)) {
			setDraft(`/${command.name} `);
			return;
		}
		void submit(`/${command.name}`);
	};

	return (
		<ChatComposerShell
			onSubmit={() => void submit()}
			notices={
				<>
					{session.error && !session.reconnecting && (
						<ChatAlert className="mb-2 items-center">
							<span className="min-w-0 flex-1">{session.error}</span>
							<Button
								type="button"
								size="xs"
								variant="outline"
								onClick={session.retryConnection}
							>
								{t("common.retry")}
							</Button>
						</ChatAlert>
					)}
					{attachmentError && (
						<ChatAlert className="mb-2 items-center">
							<span className="min-w-0 flex-1">{attachmentError}</span>
						</ChatAlert>
					)}
					{commandNotice && (
						<ChatAlert tone="warn" className="mb-2 items-center">
							<span className="min-w-0 flex-1">{commandNotice}</span>
							<IconButton
								title={t("common.close")}
								showTooltip={false}
								className="-m-1 shrink-0"
								onClick={() => setCommandNotice(null)}
							>
								<X aria-hidden="true" />
							</IconButton>
						</ChatAlert>
					)}
					{handedOff && (
						<ChatAlert className="mb-2 flex-wrap items-center" icon={false}>
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
										onClick={() => {
											// The session owns the visible error and any uncertain
											// request; this button never creates a retry itself.
											void Promise.resolve(handedOff.resend?.()).catch(() => {});
										}}
									>
										{t("agents.chat.recovery.resend")}
									</Button>
								)}
								<IconButton
									title={t("common.close")}
									showTooltip={false}
									className="-m-1 shrink-0"
									onClick={() => setDismissedFailureItemId(handedOff.failure.itemId)}
								>
									<X aria-hidden="true" />
								</IconButton>
							</div>
						</ChatAlert>
					)}
					{failureRecovery && recovery && (
						<ChatAlert className="mb-2 flex-wrap items-center">
							<span className="min-w-0 flex-1">
								{t(TURN_FAILURE_REASON_COPY[failureRecovery.reason])}
								{recovery.continuesAtMs !== undefined &&
									` ${t("agents.chat.recovery.continuesAt", {
										time: continuationTimeLabel(recovery.continuesAtMs, currentLang()),
									})}`}
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
										onClick={recovery.chooseAccount ?? recovery.manageAccounts}
									>
										{t(recovery.chooseAccount ? "agents.chat.recovery.chooseAccount" : "agents.chat.recovery.manageAccounts")}
									</Button>
								)}
								<IconButton
									title={t("common.close")}
									showTooltip={false}
									className="-m-1 shrink-0 text-destructive hover:text-destructive"
									onClick={() => setDismissedFailureItemId(failureRecovery.itemId)}
								>
									<X aria-hidden="true" />
								</IconButton>
							</div>
						</ChatAlert>
					)}
					{session.actionError && (
						<ChatAlert className="mb-2 flex-wrap items-center">
							<ActionErrorText raw={session.actionError} />
							{!session.retryTurnAvailable && (
								<IconButton
									title={t("common.close")}
									showTooltip={false}
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
											void session
												.editRetryableTurn((restored) => {
													setDraft((current) =>
														current ? `${restored}\n${current}` : restored,
													);
												})
												.catch(() => {});
										}}
									>
										{t("agents.chat.editUncertainSend")}
									</Button>
								</div>
							)}
						</ChatAlert>
					)}
				</>
			}
			header={
				<>
					{queueRows.length > 0 && (
						<div className="flex flex-col gap-1 border-b border-glass-hairline px-1 pt-0.5 pb-1.5">
							{queueRows.map((input) => (
								<div
									key={input.clientMessageId}
									className="group/queued flex items-baseline gap-1.5 text-[0.92em]"
								>
									<span
										data-selectable
										className="min-w-0 flex-1 truncate text-muted-foreground"
									>
										{input.preview}
									</span>
									{pendingQueueEdits.includes(input) && (
										<span className="shrink-0 text-muted-foreground">
											{t("agents.chat.queuedEditPending")}
										</span>
									)}
									<IconButton
										title={t("agents.chat.queuedEdit")}
										className="size-5 opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
										onClick={() => {
											if (!mayEditDraft()) return;
											void session
												.dequeueMessage(input.clientMessageId, (removed) => {
													if (!mayEditDraft()) return false;
													setDraft((current) =>
														current ? `${current}\n${removed}` : removed,
													);
													return true;
												})
												.catch(() => {});
										}}
									>
										<CornerUpLeft aria-hidden="true" />
									</IconButton>
									<IconButton
										title={t("agents.chat.queuedRemove")}
										className="size-5 opacity-0 group-hover/queued:opacity-100 focus-visible:opacity-100"
										onClick={() =>
											void session
												.dequeueMessage(input.clientMessageId)
												.catch(() => {})
										}
									>
										<X aria-hidden="true" />
									</IconButton>
								</div>
							))}
							{session.queuedMoreAfter != null && (
								<Button
									type="button"
									size="xs"
									variant="ghost"
									disabled={session.loadingQueued}
									onClick={() => void session.loadMoreQueued().catch(() => {})}
								>
									{t("agents.chat.queuedMore")}
								</Button>
							)}
							{/* The action is an icon control (owner call 2026-08-31 —
							    a sentence-long button dominated the row); its fast
							    tooltip carries the full "interrupt and send now"
							    label, and the hint keeps truncating first. */}
							{session.queuedMessages.length > 0 && (
								<span className="flex items-center justify-between gap-2 text-[0.77em] text-muted-foreground/80">
									<Titled title={t("agents.chat.queuedHint")}>
										<span className="min-w-0 flex-1 truncate">
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
							)}
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
				</>
			}
			popover={
				paletteOpen && (
					<ChatSlashCommandPalette
						id={paletteId}
						commands={paletteCommands}
						activeIndex={activeCommand}
						onActiveIndexChange={setActiveCommandIndex}
						onChoose={(command) => chooseCommand(command, false)}
					/>
				)
			}
			input={{
				ref: inputRef,
				value: draft,
				onValueChange: (value) => {
					beginInputLatencySample();
					setDraft(value);
					setActiveCommandIndex(0);
					if (commandNotice) setCommandNotice(null);
				},
				onKeyDown: (event) => {
					if (!paletteOpen || event.nativeEvent.isComposing) return;
					const command = paletteCommands[activeCommand];
					const count = paletteCommands.length;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						const step = event.key === "ArrowDown" ? 1 : -1;
						setActiveCommandIndex((activeCommand + step + count) % count);
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						setPaletteDismissedFor(draft);
					} else if (
						command &&
						!event.shiftKey &&
						(event.key === "Tab" || event.key === "Enter")
					) {
						event.preventDefault();
						chooseCommand(command, event.key === "Tab");
					}
				},
				...(paletteOpen
					? {
							"aria-controls": paletteId,
							"aria-activedescendant": chatSlashCommandOptionId(
								paletteId,
								activeCommand,
							),
						}
					: {}),
				...attachmentInput,
				disabled: inputDisabled,
			}}
			controls={
				<>
					{provider && !replacementInFlight && (
						<AgentLaunchSelectionControls
							provider={provider}
							launch={runtimeLaunch}
							presentation={launchControlsPresentation}
							modelPickerRequest={modelPickerRequest}
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
				</>
			}
			action={
				session.activeTurn ? (
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
					<ChatComposerSendButton
						disabled={
							disabled ||
							draftMoving ||
							replacementInFlight ||
							submissionInFlight ||
							(!draft.trim() && attachments.length === 0) ||
							session.sending ||
							session.retryTurnAvailable ||
							session.phase !== "ready"
						}
					/>
				)
			}
		/>
	);
}
