// ⌘N compose surface: task first, launch context second. Submission uses the
// same durable intent journal from both the keyboard and the primary action.

import { usePromptAttachments } from "@/components/agents/usePromptAttachments";
import { Alert } from "@/components/ui/alert";
import type { DroppedFilePayload } from "@/lib/files/externalFileDrop";
import { ChevronDown, Folder, KeyRound, X } from "lucide-react";
import { ProviderGlyph, TerminalGlyph } from "@/components/agents/ProviderLogo";
import { QuickDispatchAdvanced } from "./QuickDispatchAdvanced";
import { type LaunchPermissionSelection, launchPermissionLabel } from "@/lib/agents/providerPermissions";
import { NameParamChip } from "./QuickDispatchParameters";
import { DureLoader } from "@/components/ui/dure-loader";
import {
	type ChangeEvent,
	type KeyboardEvent,
	lazy,
	Suspense,
	useRef,
	useEffect,
	useId,
	useState,
} from "react";
import {
	useActiveSpaceId,
	useQuickDispatch,
} from "@/components/agents/quickDispatch/useQuickDispatch";
import {
	DialogNotice} from "@/components/common/CleanupDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { ErrorText } from "@/components/ui/error-text";
import { IconButton } from "@/components/ui/icon-button";
import { Kbd } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	useAvailableProviders,
	useVisibleProviders,
} from "@/lib/agents/agentInstalls";
import { resolveDefaultProvider } from "@/lib/agents/defaultProvider";
import {
	catalogEffortOptions,
	catalogModelOptions,
} from "@/lib/agents/providerModels";
import { resolveQuickDispatchProject, quickDispatchRemoteTarget } from "@/lib/agents/quickDispatch/quickDispatchDefaults";
import {
	beginQuickDispatchIntent,
	completeQuickDispatchIntent,
	newQuickDispatchIntentId,
	type QuickDispatchIntentV1,
	readQuickDispatchIntents,
} from "@/lib/agents/quickDispatch/quickDispatchIntent";
import { sanitizeAgentNameCandidate } from "@/lib/agents/quickDispatch/quickDispatchNaming";
import {
	buildQuickDispatchPrompt,
	MAX_QUICK_DISPATCH_PROMPT_BYTES,
	quickDispatchPromptByteLength,
} from "@/lib/agents/quickDispatch/quickDispatchPrompt";
import { runQuickDispatch } from "@/lib/agents/quickDispatch/quickDispatchRun";
import type { QuickDispatchPrefill } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { t } from "@/lib/i18n";
import { useProviderCatalog } from "@/components/agents/useProviderCatalog";
import { providerCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { saveQuickDispatchAttachments } from "@/lib/ipc";
import { supportsDureProviderCredentialSpawn } from "@/lib/ipc/dureProviderCredentialProfile";
import { track } from "@/lib/ipc/telemetry";
import { insertQuickCommandText } from "@/lib/workspace/pane/quickCommands";
import { saveSessionFiles } from "@/lib/files/sessionFileTransfer";
import { PROVIDERS, type Provider } from "@/types";
import { isProviderEffortSelection, isProviderModelSelection } from "../../../../cli/lib/contracts/provider-launch-selection.mjs";

// Lazy: WorktreeAgentDialog pulls in the full AddAgentBody form (worktree
// planning, provider preflight, account picker…). Most quick-dispatch
// submissions never touch it, so it stays a separate chunk from an overlay
// that is itself already lazy-loaded from App.tsx.
const WorktreeAgentDialog = lazy(() =>
	import("@/components/agents/WorktreeAgentDialog").then((module) => ({
		default: module.WorktreeAgentDialog,
	})),
);

export function QuickDispatchOverlay({
	open,
	prefill,
	onClose,
	onDispatched,
}: {
	open: boolean;
	prefill?: QuickDispatchPrefill;
	onClose: () => void;
	/** Fires once the intent is durably journaled, right before the overlay
	 *  closes — the launcher shows its confirmation pill from this. */
	onDispatched?: () => void;
}) {
	const { projects, agents, focusCtx, defaultProvider, accounts, sshHosts, quickCommands } =
		useQuickDispatch();
	const activeSpaceId = useActiveSpaceId();
	const availableProviders = useAvailableProviders();
	const visibleProviders = useVisibleProviders();

	const [quickDialogOpen, setQuickDialogOpen] = useState(true);
	const [addAgentDialogOpen, setAddAgentDialogOpen] = useState(false);

	const [projectId, setProjectId] = useState<string | null>(
		() => {
			const prefilled = projects.find(
				(project) => project.id === prefill?.projectId,
			);
			return (
				prefilled?.id ??
				resolveQuickDispatchProject({ focusCtx, agents, projects })?.id ??
				null
			);
		},
	);
	// Stored default-agent preference, resolved against what is installed —
	// the same authority the add-agent dialog uses.
	const [providerId, setProviderId] = useState<Provider>(() =>
		resolveDefaultProvider(defaultProvider, projects.some((project) => project.id === projectId && project.kind === "ssh") ? visibleProviders : availableProviders),
	);
	const [model, setModel] = useState<string | null>(null);
	const [effort, setEffort] = useState<string | null>(null);
	const [permission, setPermission] = useState<LaunchPermissionSelection>("inherit");
	const [runSetup, setRunSetup] = useState(true);
	const [useWorktree, setUseWorktree] = useState(false);
	const worktreeToggleId = useId();
	const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
		null,
	);
	const [typedName, setTypedName] = useState<string | null>(
		() => prefill?.typedName ?? null,
	);
	const [text, setText] = useState(() => prefill?.promptText ?? "");
	const composerRef = useRef<HTMLTextAreaElement>(null);
	const composerFocus = useRef<number | "preserve" | null>(null);
	const [inlineError, setInlineError] = useState<string | null>(null);
	const [journalIntents, setJournalIntents] = useState<QuickDispatchIntentV1[]>(
		() => readQuickDispatchIntents(),
	);
	const [retryingIntentId, setRetryingIntentId] = useState<string | null>(null);

	const launchProjects = projects.filter((project) => project.kind === "local" || sshHosts.some((host) => host.id === project.sshHostId));
	const project =
		launchProjects.find((candidate) => candidate.id === projectId) ?? null;
	const worktreeOn = useWorktree && Boolean(project?.isRepo);
	const credentialAccounts = supportsDureProviderCredentialSpawn(providerId)
		? accounts.filter((account) => account.provider === providerId)
		: [];
	// Account removal or a provider change cannot leave a stale selection in
	// the launch intent. The durable runner repeats this validation against its
	// action-time snapshot before it crosses the spawn boundary.
	const accountId = credentialAccounts.some(
		(account) => account.id === selectedAccountId,
	)
		? selectedAccountId
		: null;
	const accountLabel =
		credentialAccounts.find((account) => account.id === accountId)?.name ??
		t("agents.quickDispatch.defaultAccount");

	const catalog = useProviderCatalog(project?.kind === "ssh" ? undefined : providerCatalogSource(
		providerId,
		"local",
		credentialAccounts.find((account) => account.id === accountId),
	));
	const models = catalog.models ?? [];
	const modelOptions = catalogModelOptions(models);
	const effortOptions = catalogEffortOptions(providerId, models, model);
	const modelLabel =
		modelOptions.find((option) => option.value === model)?.label ??
		model ?? t("agents.quickDispatch.autoModel");
	const effortLabel =
		effortOptions.find((option) => option.value === effort)?.label ??
		effort ?? t("agents.quickDispatch.autoEffort");
	const advancedSummary = [
		permission !== "inherit" ? launchPermissionLabel(permission) : null,
		worktreeOn && !runSetup ? t("agents.quickDispatch.setupSkipped") : null,
		model ? modelLabel : null,
		effort ? effortLabel : null,
		typedName,
	].filter(Boolean).join(" · ");
	const catalogStatus = catalog.loading
		? t("common.loading")
		: catalog.error ? t("agents.catalog.loadFailed") : undefined;
	const chooseAccount = (id: string | null) => {
		setSelectedAccountId(id);
		setModel(null);
		setEffort(null);
	};
	const chooseProvider = (next: Provider) => {
		if (next === providerId) return;
		setProviderId(next);
		setPermission("inherit");
		chooseAccount(null);
	};

	if (!visibleProviders.includes(providerId)) {
		chooseProvider(resolveDefaultProvider(defaultProvider, availableProviders));
	}

	const chooseModel = (next: string | null) => {
		setModel(next);
		setEffort((current) =>
			current &&
			catalogEffortOptions(providerId, models, next).some(
				(option) => option.value === current,
			)
				? current
				: null,
		);
	};

	const dismissFailure = (intentId: string) => {
		completeQuickDispatchIntent(intentId);
		setJournalIntents(readQuickDispatchIntents());
	};

	const retryPending = async (intent: QuickDispatchIntentV1) => {
		setRetryingIntentId(intent.intentId);
		try {
			await runQuickDispatch(intent);
		} finally {
			setJournalIntents(readQuickDispatchIntents());
			setRetryingIntentId(null);
		}
	};

	const openFullDialog = () => {
		setQuickDialogOpen(false);
		setAddAgentDialogOpen(true);
	};

	const [attachments, setAttachments] = useState<DroppedFilePayload[]>([]);
	const submissionRef = useRef<object | null>(null);
	useEffect(() => () => { submissionRef.current = null; }, [open, quickDialogOpen, project?.id]);
	const { deferSubmit, remove: removeAttachment, inputProps: attachmentInput } = usePromptAttachments({
		attachments,
		setAttachments,
		scope: open && quickDialogOpen ? project?.id ?? null : null,
		imageName: (ext) => `pasted-${Date.now()}.${ext}`,
		onText: (value) => setText((current) => current + value),
		onError: setInlineError,
		onReadyToSubmit: () => { void handleSubmit(); },
	});

	const handleSubmit = async () => {
		if (!project || !open || !quickDialogOpen || submissionRef.current) return;
		if (deferSubmit()) return;
		if (!text.trim() && attachments.length === 0) return;
		if ((model && !isProviderModelSelection(model)) || (effort && !isProviderEffortSelection(effort))) {
			setInlineError(t("agents.quickDispatch.invalidSelection"));
			return;
		}
		const submission = {};
		submissionRef.current = submission;
		setInlineError(null);

		// Minted upfront (not only when attachments exist) so the same id
		// correlates the attachment directory on disk with the journaled
		// intent — beginQuickDispatchIntent below reuses this exact id
		// instead of minting its own (F4).
		const intentId = newQuickDispatchIntentId();
		let remoteTarget: QuickDispatchIntentV1["remoteTarget"];
		let attachmentPaths: string[] = [];
		try {
			remoteTarget = quickDispatchRemoteTarget(project, sshHosts);
			if (attachments.length > 0) attachmentPaths = project.kind === "ssh"
				? await saveSessionFiles(project.sshHostId, attachments)
				: await saveQuickDispatchAttachments(intentId, attachments);
		} catch (cause) {
			if (submissionRef.current !== submission) return;
			submissionRef.current = null;
			setInlineError(String(cause));
			return;
		}

		if (submissionRef.current !== submission) return;
		const assembledPrompt = buildQuickDispatchPrompt(text, attachmentPaths);
		if (
			quickDispatchPromptByteLength(assembledPrompt) >
			MAX_QUICK_DISPATCH_PROMPT_BYTES
		) {
			submissionRef.current = null;
			setInlineError(t("agents.quickDispatch.promptTooLong"));
			return;
		}

		let intent: QuickDispatchIntentV1;
		try {
			intent = beginQuickDispatchIntent(
				{
					promptText: text,
					attachmentPaths,
					projectId: project.id,
					...(remoteTarget ? { remoteTarget } : {}),
					providerId,
					accountId,
					model,
					effort,
					typedName,
					permissionOverride: permission === "inherit" ? undefined : permission,
					runSetup: worktreeOn && runSetup,
					useWorktree: worktreeOn,
				},
				intentId,
			);
		} catch (cause) {
			// The journal write is an internal storage failure (e.g. quota,
			// commit-verify mismatch) — surface a translated message rather
			// than the raw internal error code.
			console.error("[quickDispatch] failed to journal intent", cause);
			submissionRef.current = null;
			setInlineError(t("agents.quickDispatch.storageFailed"));
			return;
		}

		onDispatched?.();
		onClose();
		track("quick_dispatch_used");
		void runQuickDispatch(intent);
	};

	return (
		<>
			<Dialog
				open={open && quickDialogOpen}
				onOpenChange={(next) => {
					if (next) return;
					setQuickDialogOpen(false);
					onClose();
				}}
			>
				{/* Centred, like every other dialog. The palette pins itself near
				    the top because its result list grows downward and the field
				    must not move while someone types; this is a form with a fixed
				    set of controls, so the top offset only left a gap under it
				    (owner call 2026-09-13). */}
				<DialogContent
					showCloseButton={false}
					className="max-h-[min(680px,80dvh)] w-[min(640px,calc(100vw-32px))] max-w-none gap-0 overflow-x-hidden overflow-y-auto p-0 shadow-2xl sm:max-w-none"
				>
					{!project ? (
						<div className="flex flex-col gap-3 p-4">
							<DialogTitle>{t("agents.quickDispatch.title")}</DialogTitle>
							<IntentJournalRows
								intents={journalIntents}
								retryingIntentId={retryingIntentId}
								onRetry={retryPending}
								onDismiss={dismissFailure}
							/>
							<p className="text-sm text-muted-foreground">
								{t("agents.quickDispatch.projectMissing")}
							</p>
							<Button type="button" onClick={openFullDialog}>
								{t("agents.quickDispatch.openFullDialog")}
							</Button>
						</div>
					) : (
						<div className="flex flex-col">
							<div className="flex flex-col gap-3 px-5 pt-4 pb-4">
								<div className="flex items-center gap-2">
									<DialogTitle className="mr-auto text-sm">{t("agents.quickDispatch.title")}</DialogTitle>
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="sm"
												className="text-muted-foreground"
												aria-label={t("workspace.quickCommands.menu")}
											>
												<TerminalGlyph className="size-3.5" />
												<span className="hidden sm:inline">{t("workspace.quickCommands.menu")}</span>
												<ChevronDown className="size-3" />
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent
											align="start"
											className="w-72 max-w-[calc(100vw-48px)]"
											onEscapeKeyDown={() => { composerFocus.current = "preserve"; }}
											onCloseAutoFocus={(event) => {
												const caret = composerFocus.current;
												composerFocus.current = null;
												if (caret === null) return;
												event.preventDefault();
												const composer = composerRef.current;
												composer?.focus();
												if (typeof caret === "number") composer?.setSelectionRange(caret, caret);
											}}
										>
											<p className="px-2 py-1.5 text-xs text-muted-foreground">
												{t("agents.quickDispatch.quickCommandsHint")}
											</p>
											{quickCommands?.length ? (
												quickCommands.map((command) => (
													<DropdownMenuItem
														key={command.id}
														className="break-words whitespace-normal"
														onSelect={() => {
															const composer = composerRef.current;
															if (!composer) return;
															const next = insertQuickCommandText(
																text,
																command.text,
																composer.selectionStart,
																composer.selectionEnd,
															);
															composerFocus.current = next.caret;
															setText(next.text);
														}}
													>
														{command.label}
													</DropdownMenuItem>
												))
											) : (
												<DropdownMenuItem disabled>
													{t("workspace.quickCommands.empty")}
												</DropdownMenuItem>
											)}
										</DropdownMenuContent>
									</DropdownMenu>
									<DialogClose asChild>
										<IconButton title={t("common.close")} className="size-7 shrink-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><X /></IconButton>
									</DialogClose>
								</div>
								<IntentJournalRows
									intents={journalIntents}
									retryingIntentId={retryingIntentId}
									onRetry={retryPending}
									onDismiss={dismissFailure}
								/>

								<Textarea
									ref={composerRef}
									autoFocus
									value={text}
									placeholder={t("agents.quickDispatch.placeholder")}
									aria-label={t("agents.quickDispatch.title")}
									className="min-h-24 resize-none rounded-none border-0 bg-transparent px-0 py-2 text-[15px] leading-relaxed shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-0 dark:bg-transparent"
									onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
										setText(event.target.value)
									}
									{...attachmentInput}
									onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
										if (event.nativeEvent.isComposing) return;
										if (event.key !== "Enter" || event.shiftKey) return;
										event.preventDefault();
										void handleSubmit();
									}}
								/>

								{attachments.length > 0 && (
									<div className="flex flex-wrap items-center gap-1.5">
										{attachments.map((attachment, index) => (
											<span
												key={`${attachment.fileName}-${index}`}
												className="inline-flex items-center gap-1.5 rounded-md border border-glass-hairline bg-muted/40 py-0.5 pr-1 pl-2 text-meta text-muted-foreground"
											>
												{attachment.fileName}
												<IconButton
													title={t(
														"agents.quickDispatch.removeAttachment",
													)}
													onClick={() => removeAttachment(index)}
												>
													<X aria-hidden="true" />
												</IconButton>
											</span>
										))}
									</div>
								)}

								<div className="flex flex-wrap items-center justify-between gap-2 text-meta text-muted-foreground">
									<p>{t("agents.quickDispatch.attachmentHint")}</p>
									<span className="flex items-center gap-1.5"><Kbd size="sm">⇧⏎</Kbd>{t("agents.quickDispatch.newlineHint")}</span>
								</div>
								<ErrorText>{inlineError}</ErrorText>
							</div>

							<div className="flex flex-col gap-2 border-t border-glass-hairline bg-muted/20 px-4 pt-3 pb-4">
								<div className="flex min-w-0 flex-wrap items-center gap-1.5">
									<SelectField
										aria-label={t("agents.quickDispatch.projectLabel")}
										value={project.id}
										leadingIcon={<Folder />}
										className="w-52"
										onValueChange={(id) => {
											const candidate = launchProjects.find((entry) => entry.id === id);
											if (!candidate) return;
											setProjectId(candidate.id);
											if (candidate.kind === "local")
												chooseProvider(resolveDefaultProvider(providerId, availableProviders));
											setModel(null);
											setEffort(null);
										}}
									>
										{launchProjects.map((candidate) => (
											<SelectOption key={candidate.id} value={candidate.id}>
												{candidate.kind === "ssh"
													? `${sshHosts.find((host) => host.id === candidate.sshHostId)?.name} · ${candidate.name}`
													: candidate.name}
											</SelectOption>
										))}
									</SelectField>
									<SelectField
										aria-label={t("agents.quickDispatch.agentLabel")}
										value={providerId}
										onValueChange={(next) => chooseProvider(next as Provider)}
										leadingIcon={<ProviderGlyph provider={providerId} />}
										className="w-40"
									>
										{(project.kind === "ssh" ? visibleProviders : availableProviders).map(
											(provider) => (
												<SelectOption key={provider} value={provider}>
													{PROVIDERS[provider].label}
												</SelectOption>
											),
										)}
									</SelectField>
									{credentialAccounts.length > 0 && (
										<SelectField
											aria-label={t("agents.account.credential")}
											value={accountId ?? ""}
											onValueChange={(next) => chooseAccount(next || null)}
											leadingIcon={<KeyRound />}
											display={accountLabel}
											className="w-44"
										>
											<SelectOption value="">{t("agents.account.defaultCli")}</SelectOption>
											{credentialAccounts.map((account) => (
												<SelectOption key={account.id} value={account.id}>
													{account.name}
												</SelectOption>
											))}
										</SelectField>
									)}

								</div>
								<div className="flex items-center justify-between gap-3 px-2 py-1">
									<label htmlFor={worktreeToggleId} className="text-xs text-muted-foreground">
										{t("agents.worktree.isolateDedicated")}
									</label>
									<Switch id={worktreeToggleId} checked={worktreeOn} onCheckedChange={setUseWorktree} disabled={!project.isRepo} />
								</div>
								<QuickDispatchAdvanced
									provider={providerId}
									summary={advancedSummary}
									permission={permission} onPermissionChange={setPermission}
									runSetup={worktreeOn && runSetup} onRunSetupChange={setRunSetup}
									useWorktree={worktreeOn}
									action={<Button type="button" className="ml-auto gap-3 px-3" disabled={!text.trim() && attachments.length === 0} onClick={() => { void handleSubmit(); }}>
										{t("agents.quickDispatch.startAgent")}
										<span aria-hidden className="text-primary-foreground/60">⏎</span>
									</Button>}
								>
										{project.kind === "ssh" ? <>
										<NameParamChip label={t("agents.quickDispatch.modelLabel")} value={model ?? ""} placeholder={t("agents.quickDispatch.autoModel")} commit={(value) => setModel(value.trim() || null)} />
										<NameParamChip label={t("agents.quickDispatch.effortLabel")} value={effort ?? ""} placeholder={t("agents.quickDispatch.autoEffort")} commit={(value) => setEffort(value.trim() || null)} />
										</> : <>
										<SelectField
											aria-label={t("agents.quickDispatch.modelLabel")}
											value={model ?? ""}
											display={modelLabel}
											onValueChange={(next) => chooseModel(next || null)}
											onOpenChange={catalog.onOpenChange}
											className="w-48"
										>
											{catalogStatus && (
												<p role="status" className="px-2 py-1 text-xs text-muted-foreground">
													{catalogStatus}
												</p>
											)}
											<SelectOption value="">{t("agents.quickDispatch.autoModel")}</SelectOption>
											{modelOptions.map((option) => (
												<SelectOption key={option.value} value={option.value}>
													{option.label}
												</SelectOption>
											))}
										</SelectField>
										<SelectField
											aria-label={t("agents.quickDispatch.effortLabel")}
											value={effort ?? ""}
											display={effortLabel}
											onValueChange={(next) => setEffort(next || null)}
											onOpenChange={catalog.onOpenChange}
											className="w-40"
										>
											{catalogStatus && (
												<p role="status" className="px-2 py-1 text-xs text-muted-foreground">
													{catalogStatus}
												</p>
											)}
											<SelectOption value="">{t("agents.quickDispatch.autoEffort")}</SelectOption>
											{effortOptions.map((option) => (
												<SelectOption key={option.value} value={option.value}>
													{option.label}
												</SelectOption>
											))}
										</SelectField>

									</>}

									<NameParamChip
										label={t("agents.quickDispatch.nameLabel")}
										value={typedName ?? ""}
										placeholder={t("agents.quickDispatch.nameAuto")}
										commit={(draft) => {
											const trimmed = draft.trim();
											setTypedName(
												trimmed ? sanitizeAgentNameCandidate(trimmed) : null,
											);
										}}
									/>
								</QuickDispatchAdvanced>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>

			{addAgentDialogOpen && (
				<Suspense fallback={null}>
					<WorktreeAgentDialog
						desktopId={activeSpaceId}
						onClose={() => {
							setAddAgentDialogOpen(false);
							onClose();
						}}
					/>
				</Suspense>
			)}
		</>
	);
}

function IntentJournalRows({
	intents,
	retryingIntentId,
	onRetry,
	onDismiss,
}: {
	intents: readonly QuickDispatchIntentV1[];
	retryingIntentId: string | null;
	onRetry: (intent: QuickDispatchIntentV1) => Promise<void>;
	onDismiss: (intentId: string) => void;
}) {
	return intents.map((intent) =>
		intent.state === "pending" ? (
			<PendingIntentRow
				key={intent.intentId}
				intent={intent}
				retrying={retryingIntentId === intent.intentId}
				onRetry={onRetry}
			/>
		) : (
			<FailedIntentRow
				key={intent.intentId}
				intent={intent}
				retrying={retryingIntentId === intent.intentId}
				onRetry={onRetry}
				onDismiss={onDismiss}
			/>
		),
	);
}

function PendingIntentRow({
	intent,
	retrying,
	onRetry,
}: {
	intent: QuickDispatchIntentV1;
	retrying: boolean;
	onRetry: (intent: QuickDispatchIntentV1) => Promise<void>;
}) {
	return (
		<div role="status" className="flex items-center gap-3">
			<DialogNotice className="flex flex-1 items-center gap-2">
				<DureLoader decorative className="shrink-0" />
				{t("agents.quickDispatch.progress.spawning")}
			</DialogNotice>
			<Button
				type="button"
				variant="ghost"
				size="xs"
				disabled={retrying}
				onClick={() => void onRetry(intent)}
			>
				{t("common.retry")}
			</Button>
		</div>
	);
}

/** Failed-dispatch banner row. Dismiss must be the banner's sibling, not its
 *  child — a <button> (interactive content) is not valid content model for
 *  Alert's role="alert". */
function FailedIntentRow({
	intent,
	retrying,
	onRetry,
	onDismiss,
}: {
	intent: QuickDispatchIntentV1;
	retrying: boolean;
	onRetry: (intent: QuickDispatchIntentV1) => Promise<void>;
	onDismiss: (intentId: string) => void;
}) {
	return (
		<div className="flex items-start gap-3">
			<Alert icon={false} className="flex-1">
				{t("agents.quickDispatch.failedBanner", {
					message: intent.failure?.message ?? "",
				})}
			</Alert>
			<Button type="button" variant="ghost" size="xs" disabled={retrying} onClick={() => void onRetry(intent)}>
				{t("common.retry")}
			</Button>
			<button
				type="button"
				className="shrink-0 text-meta text-destructive underline underline-offset-2"
				disabled={retrying}
				onClick={() => onDismiss(intent.intentId)}
			>
				{t("agents.quickDispatch.dismissFailure")}
			</button>
		</div>
	);
}
