import { Play, SquareTerminal } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useManagedAgentRecoveryBarState } from "@/components/sessions/useManagedAgentRecoveryBarState";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField, SelectOption } from "@/components/ui/select-field";
import { usePaneActionPending } from "@/components/workspace/useNamedPaneAction";
import { conversationHistoryCredentialProfile } from "@/lib/agents/agentConversationHistory";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { t } from "@/lib/i18n";
import { type Conversation, listConversations } from "@/lib/ipc";
import { startFreshManagedAgentPane } from "@/lib/sessions/managed/managedAgentFreshStart";
import {
	managedAgentRecoveryEntry,
	managedAgentRecoveryHasDeadInput,
} from "@/lib/sessions/managed/managedAgentRecoveryEntry";
import { recoverExitedManagedConversationPane } from "@/lib/sessions/managed/managedConversationLaunch";
import { useManagedCredentialSwitchTransition } from "@/lib/sessions/managed/managedCredentialSwitchTransition";
import {
	type HmuxManagedPaneBindingV1,
	hmuxPaneConversationId,
} from "@/lib/terminal/terminalBinding";

interface RecoveryFailure {
	message: string;
}

function recoveryFailure(error: unknown): RecoveryFailure {
	return { message: error instanceof Error ? error.message : String(error) };
}

export function ManagedAgentRecoveryBar({
	agentId,
	panelId,
	binding,
	inspectConfirmedExit = true,
	inspectUnknownExit = true,
	disabled = false,
	onOpenShell,
	onTransitioningChange,
	onAvailabilityChange,
	forceConversationSelection = false,
	fallback = null,
}: {
	agentId: string;
	panelId: string;
	binding?: HmuxManagedPaneBindingV1;
	inspectConfirmedExit?: boolean;
	inspectUnknownExit?: boolean;
	disabled?: boolean;
	onOpenShell?: () => Promise<void>;
	onTransitioningChange?(transitioning: boolean): void;
	onAvailabilityChange: (available: boolean, deadInput: boolean) => void;
	forceConversationSelection?: boolean;
	fallback?: ReactNode;
}) {
	const { agent, metadata, paneHealth, activity, accounts, conversationPeers } =
		useManagedAgentRecoveryBarState({ agentId, panelId, binding });
	const credentialSwitchTransition = useManagedCredentialSwitchTransition(
		agentId,
		agent?.pendingCredentialSwitch,
	);
	const [busy, setBusy] = useState(false);
	const [candidates, setCandidates] = useState<Conversation[] | null>(null);
	const [selectedConversationId, setSelectedConversationId] = useState("");
	const [failure, setFailure] = useState<RecoveryFailure | null>(null);
	const [reviewedConversation, setReviewedConversation] = useState<string>();
	const ownerKey =
		agent && binding
			? agentRuntimePresentationOwnerKey({ ...agent, runtimeBinding: binding })
			: undefined;
	const savedConversationId =
		(hmuxPaneConversationId(binding) ?? agent?.conversationId)?.trim() || "";
	const reviewKey = ownerKey
		? JSON.stringify([ownerKey, savedConversationId])
		: undefined;
	const reviewingPeers =
		!credentialSwitchTransition &&
		conversationPeers.length > 0 &&
		reviewKey !== undefined &&
		reviewedConversation === reviewKey;
	const selectingConversation = forceConversationSelection || reviewingPeers;
	const entry = managedAgentRecoveryEntry({
		hasAgent: Boolean(agent),
		hasBinding: Boolean(binding),
		activity,
		metadata,
		paneHealth,
		credentialSwitchTransition,
		inspectConfirmedExit,
		inspectUnknownExit,
	});
	const rehosting = usePaneActionPending(panelId, "rehost");
	const showRecoveryActions = entry.visible || selectingConversation;
	const visible =
		!rehosting &&
		(showRecoveryActions ||
			(!credentialSwitchTransition && conversationPeers.length > 0));
	const actionDisabled = disabled || busy;
	const storedConversationId = selectingConversation ? "" : savedConversationId;
	const deadInput = entry.visible && managedAgentRecoveryHasDeadInput(metadata);
	const worktreePath = agent?.worktreePath;
	const provider = agent?.provider;
	let historyProfile: ReturnType<typeof conversationHistoryCredentialProfile>;
	let historyError: string | undefined;
	if (agent && visible && !storedConversationId) {
		try {
			historyProfile = conversationHistoryCredentialProfile({
				agent,
				accounts,
				remote: false,
			});
		} catch (error) {
			historyError = recoveryFailure(error).message;
		}
	}
	const historyReferenceId = historyProfile?.referenceId;
	const historyDirectory = historyProfile?.directory;

	// Availability is presentation output, not a new recovery request. Parent
	// renders must not clear a selected conversation or a failed action.
	useEffect(() => {
		onAvailabilityChange(visible, deadInput);
	}, [onAvailabilityChange, visible, deadInput]);

	useEffect(() => {
		let disposed = false;
		setCandidates(null);
		setSelectedConversationId("");
		setFailure(null);
		setBusy(false);
		if (!ownerKey || !worktreePath || !provider || !visible) {
			return;
		}
		if (storedConversationId) {
			return;
		}
		if (historyError) {
			setFailure({ message: historyError });
			return;
		}
		setBusy(true);
		const loadRecovery = Promise.resolve().then(() =>
			listConversations(
				worktreePath,
				provider,
				historyReferenceId && historyDirectory
					? { referenceId: historyReferenceId, directory: historyDirectory }
					: undefined,
			),
		);
		void loadRecovery
			.then((candidate) => {
				if (disposed) return;
				setCandidates(candidate);
			})
			.catch((error: unknown) => {
				if (disposed) return;
				setFailure(recoveryFailure(error));
			})
			.finally(() => {
				if (disposed) return;
				setBusy(false);
			});
		return () => {
			disposed = true;
		};
	}, [
		ownerKey,
		worktreePath,
		provider,
		panelId,
		visible,
		selectingConversation,
		storedConversationId,
		historyReferenceId,
		historyDirectory,
		historyError,
	]);

	const runRecovery = async (operation: () => Promise<void>) => {
		if (actionDisabled) return;
		setBusy(true);
		onTransitioningChange?.(true);
		setFailure(null);
		try {
			await operation();
		} catch (error) {
			setFailure(recoveryFailure(error));
		} finally {
			onTransitioningChange?.(false);
			setBusy(false);
		}
	};

	const recoverConversation = async (conversationId: string) => {
		if (!agent || !conversationId) return;
		await runRecovery(async () => {
			await recoverExitedManagedConversationPane({
				agentId: agent.id,
				panelId,
				target: { kind: "id", id: conversationId },
			});
		});
	};

	const startFreshConversation = async () => {
		await runRecovery(async () => {
			await startFreshManagedAgentPane(agentId, panelId);
			setCandidates(null);
			onAvailabilityChange(false, false);
		});
	};

	if (rehosting) return null;
	if (!agent || !binding || !visible) return fallback;
	const conversationId =
		selectedConversationId ||
		storedConversationId ||
		t("sessions.exactResume.selectionRequired");
	const hasExactConversationOption =
		storedConversationId !== "" || (candidates?.length ?? 0) > 0;

	return (
		// A fixed element on the opaque pane, not an overlay above it — the
		// pane's own face plus a hairline, no blur.
		<div className="@container/managed-recovery absolute inset-x-0 bottom-0 z-20 max-h-[50%] overflow-y-auto border-t border-glass-hairline bg-glass-pane px-3 py-2">
			<div className="flex flex-col gap-2">
				{!credentialSwitchTransition && conversationPeers.length > 0 && (
					<Alert
						tone="warn"
						action={
							!reviewingPeers ? (
								<Button
									size="xs"
									variant="outline"
									disabled={actionDisabled}
									onClick={() => setReviewedConversation(reviewKey)}
								>
									{t("sessions.duplicates.review")}
								</Button>
							) : undefined
						}
					>
						{t("sessions.duplicates.notice", {
							names: conversationPeers
								.map((peer) => peer.displayName?.trim() || peer.name)
								.join(", "),
						})}
					</Alert>
				)}
				{reviewingPeers && (
					<p className="text-xs text-muted-foreground">
						{t("sessions.duplicates.repairEffect")}
					</p>
				)}
				{showRecoveryActions && (
					<>
						<div className="min-w-0 flex-1 space-y-1 text-xs">
							<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground">
								<strong className="text-sidebar-foreground">
									{t("common.provider")}: {agent.provider}
								</strong>
								<span className="max-w-72 truncate">
									{t("sessions.exactResume.workingDirectory")}:{" "}
									{agent.worktreePath}
								</span>
								<span className="max-w-64 truncate">
									{t("common.conversationId")}: {conversationId}
								</span>
							</div>
							{candidates !== null && candidates.length > 0 && (
								<div className="flex min-w-0 items-center gap-2 @max-[360px]/managed-recovery:flex-col @max-[360px]/managed-recovery:items-stretch">
									{/* Allow long conversation labels to shrink within the row. */}
									<div className="min-w-0 flex-1">
									<SelectField
										aria-label={t("sessions.exactResume.conversationPickerLabel")}
										disabled={actionDisabled}
										value={selectedConversationId}
										onValueChange={(nextValue) => setSelectedConversationId(nextValue)}
									>
										<SelectOption value="">
											{t("sessions.exactResume.selectConversation")}
										</SelectOption>
										{candidates.map((candidate) => (
											<SelectOption key={candidate.id} value={candidate.id}>
												{candidate.title || candidate.id} · {candidate.id}
											</SelectOption>
										))}
									</SelectField>
									</div>
									<Button
										size="sm"
										className="@max-[360px]/managed-recovery:self-end"
										disabled={actionDisabled || !selectedConversationId}
										onClick={() =>
											void recoverConversation(selectedConversationId)
										}
									>
										<Play className="size-3.5" />{" "}
										{t("sessions.recovery.resumeExactConversation")}
									</Button>
								</div>
							)}
							{candidates?.length === 0 && (
								<div className="flex items-center gap-2">
									<p className="text-muted-foreground">
										{t("sessions.exactResume.noRecoverableConversations")}
									</p>
								</div>
							)}
							{failure && (
								<div className="text-destructive">
									<p>
										{t("sessions.exactResume.failureReason")}: {failure.message}
									</p>
								</div>
							)}
						</div>
						{/* Exact resume keeps primary weight when it is available; otherwise
				    fresh start becomes the primary escape route. */}
						<div className="flex flex-wrap items-center justify-end gap-2">
							{onOpenShell && (
								<Button
									size="sm"
									variant="ghost"
									disabled={actionDisabled}
									onClick={() => {
										if (actionDisabled) return;
										void onOpenShell().catch((error) => {
											setFailure(recoveryFailure(error));
										});
									}}
								>
									<SquareTerminal className="size-3.5" />{" "}
									{t("common.openShell")}
								</Button>
							)}
							<Button
								size="sm"
								variant={hasExactConversationOption ? "secondary" : "default"}
								disabled={actionDisabled}
								onClick={() => void startFreshConversation()}
							>
								<Play className="size-3.5" /> {t("common.newConversation")}
							</Button>
							{storedConversationId && (
								<Button
									size="sm"
									disabled={actionDisabled}
									onClick={() => void recoverConversation(storedConversationId)}
								>
									<Play className="size-3.5" />{" "}
									{t("sessions.recovery.resumeExactConversation")}
								</Button>
							)}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
