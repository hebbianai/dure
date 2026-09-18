import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { AccountsDialog } from "@/components/agents/AccountsDialog";
import {
	type AgentConversationHistoryActionLease,
	AgentConversationHistoryControl,
} from "@/components/agents/AgentConversationHistoryControl";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import { AgentRuntimeProfileSwitch } from "@/components/agents/AgentRuntimeProfileSwitch";
import { StructuredAgentChatSurface } from "@/components/agents/chat/StructuredAgentChatSurface";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useChatPaneActions } from "@/components/agents/chat/useChatPaneActions";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { useUsageLimitHandoff } from "@/components/agents/chat/useUsageLimitHandoff";
import { useAgentPaneAttentionAck } from "@/components/agents/useAgentPaneAttentionAck";
import {
	useAgentToolbarControls,
	useAgentToolbarGroupPresentation,
} from "@/components/agents/useAgentToolbarControls";
import {
	useRuntimeOwnedRequest,
	useRuntimeOwnedValue,
} from "@/components/agents/useRuntimeOwnedValue";
import {
	AgentPanelToolbarFrame,
	presentForkInAgentPanelDesktop,
} from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import {
	useAutoSwitchAccounts,
	useStructuredAgentPanelState,
} from "@/components/panels/useAgentPanelState";
import { useRemoteAgentCredentialActions } from "@/components/panels/useRemoteAgentCredentialActions";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import { AgentPluginClaimStatus } from "@/components/plugins/AgentPluginClaimStatus";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import { conversationHistoryCredentialProfile } from "@/lib/agents/agentConversationHistory";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { agentProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import {
	agentRuntimePaneActionOwnerKey,
	runAgentRuntimePaneAction,
} from "@/lib/agents/agentRuntimePaneAction";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { StructuredAgentRuntimeProjectionGenerationV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { latestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
import { resumeUsageLimitTurn } from "@/lib/agents/chat/resumeUsageLimitTurn";
import { usageLimitHandoffState } from "@/lib/agents/usageLimitHandoffState";
import {
	providerLoginCmd,
	supportsAccounts,
	supportsStructuredChat,
} from "@/lib/agents/providers";
import { t } from "@/lib/i18n";
import {
	type Conversation,
	hostToOpts,
	listConversations,
	sshListConversations,
} from "@/lib/ipc";
import type { DureAgentRuntimeSourceStopPolicyV1 } from "@/lib/ipc/dureAgentRuntime";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import type { Agent } from "@/types";

const STRUCTURED_WINDOW_ACTION_CONTROL_IDS = [
	"diff-window",
	"source-control-window",
] as const;

export function StructuredAgentPanel({
	agent,
	historyActionLease,
	profile,
	panelProps,
	launchSelection,
	onRuntimeInvalidated,
	switchCredential,
	switchToNativeTerminal,
}: {
	agent: Agent;
	historyActionLease: AgentConversationHistoryActionLease;
	profile: AgentStructuredInteractionProfileV1;
	panelProps: AgentPanelDockProps;
	launchSelection: AgentRuntimeLaunchSelectionView;
	onRuntimeInvalidated(
		generation: StructuredAgentRuntimeProjectionGenerationV1,
	): boolean | Promise<boolean>;
	switchCredential: (
		agentId: string,
		targetCredentialId: string | null,
	) => Promise<AgentCredentialTransitionResult>;
	switchToNativeTerminal: (
		agentId: string,
		sourceStopPolicy?: DureAgentRuntimeSourceStopPolicyV1,
		expectedSourceRevision?: number,
	) => Promise<void>;
}) {
	const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
	const {
		agentCwd,
		project,
		accounts,
		sshHosts,
		setAgentActivity,
		getActiveSpaceId,
	} = useStructuredAgentPanelState(agent);
	const autoSwitchAccounts = useAutoSwitchAccounts();
	const session = useAgentChatSession(agent.id, profile, onRuntimeInvalidated);
	const activeTurn = "activeTurn" in session ? session.activeTurn : undefined;
	const answeringRequestId =
		"answeringRequestId" in session ? session.answeringRequestId : undefined;
	const conversationTitle = useConversationTitle(agent.id);
	const toolbarControls = useAgentToolbarControls();
	const windowActionsPresentation = useAgentToolbarGroupPresentation(
		STRUCTURED_WINDOW_ACTION_CONTROL_IDS,
	);
	// Structured chat sessions have no hmux terminal, so the semantic-state
	// watch never feeds them; this pane is the one activity producer for its
	// agent, mirroring the turn lifecycle the chat controller already owns.
	const chatActivity =
		activeTurn || session.sending
			? ("working" as const)
			: session.phase === "connecting" || session.phase === "detached"
				? ("connecting" as const)
				: ("waiting" as const);
	useEffect(() => {
		setAgentActivity(agent.id, chatActivity);
	}, [agent.id, chatActivity, setAgentActivity]);
	const [accountsOpen, setAccountsOpen] = useState(false);
	const [accountFailure, setAccountFailure] =
		useRuntimeOwnedValue<string>(runtimeOwnerKey);
	const [remoteRecoveryAccount, setRemoteRecoveryAccount] =
		useRuntimeOwnedValue<(typeof accounts)[number]>(runtimeOwnerKey);
	const [ownedAccountBusy, setAccountBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const [ownedProfileBusy, setProfileBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const [conversationFailure, setConversationFailure] =
		useRuntimeOwnedValue<string>(runtimeOwnerKey);
	const [ownedConversations, setConversations] = useRuntimeOwnedValue<
		Conversation[] | null
	>(runtimeOwnerKey);
	const beginConversationLoad = useRuntimeOwnedRequest(runtimeOwnerKey);
	const conversations = ownedConversations ?? null;
	const accountBusy = ownedAccountBusy ?? false;
	const profileBusy = ownedProfileBusy ?? false;
	const paneId = panelProps.api.id;
	const paneDesktopId = useWorkspaceRuntimeDesktopId();
	useAgentPaneAttentionAck(agent.id, panelProps.api);
	const turnFailure =
		activeTurn || !("page" in session)
			? undefined
			: latestTurnFailure(session.page?.latestFailure);

	useEffect(() => {
		applyAutomaticPaneTitle(
			panelProps.api,
			resolveAgentPaneTitle({
				name: agent.name,
				displayName: agent.displayName,
				runtimeTitle: conversationTitle,
				opaqueConversationId: agent.conversationId,
				directoryCandidates: [agentCwd, agent.worktreePath],
			}),
		);
	}, [agent, agentCwd, conversationTitle, panelProps.api]);

	useEffect(() => {
		if (!panelProps.api.isVisible) return;
		if (paneDesktopId && getActiveSpaceId() !== paneDesktopId) return;
		workspacePerformance.beginPaneOpen(paneId, `agent:${agent.provider}`);
		return () => workspacePerformance.cancelPaneOpen(paneId);
	}, [agent.provider, getActiveSpaceId, paneDesktopId, paneId, panelProps.api]);

	const markReady = useCallback(
		() => workspacePerformance.markPaneReady(paneId),
		[paneId],
	);
	const accountPool = supportsAccounts(agent.provider)
		? accounts.filter((account) => account.provider === agent.provider)
		: [];
	const credentialReferenceId = agentCredentialReferenceId(agent);
	const currentAccount = credentialReferenceId
		? accountPool.find((account) => account.id === credentialReferenceId)
		: undefined;
	const remoteHost =
		project?.kind === "ssh"
			? sshHosts.find((host) => host.id === project.sshHostId)
			: undefined;
	const loadConversations = async () => {
		const isCurrent = beginConversationLoad();
		setConversationFailure(undefined);
		setConversations(null);
		try {
			const credentialProfile = conversationHistoryCredentialProfile({
				agent,
				accounts: accountPool,
				remote: project?.kind === "ssh",
			});
			const conversations =
				project?.kind === "ssh"
					? remoteHost
						? await sshListConversations({
								connectOpts: hostToOpts(remoteHost),
								cwd: agent.worktreePath,
								provider: agent.provider,
								credentialProfile,
							})
						: []
					: await listConversations(
							agent.worktreePath,
							agent.provider,
							credentialProfile,
						);
			if (!isCurrent()) return;
			setConversations(conversations);
		} catch (error) {
			if (!isCurrent()) return;
			setConversations([]);
			setConversationFailure(
				error instanceof Error ? error.message : String(error),
			);
		}
	};
	const {
		busy: remoteAccountBusy,
		openRemoteLogin,
		copyAccountToHost,
	} = useRemoteAgentCredentialActions({
		agent,
		host: remoteHost,
		containerApi: panelProps.containerApi,
	});
	const chatMutationBusy =
		answeringRequestId !== undefined || session.sending || session.interrupting;
	const structuredActionBusy =
		Boolean(activeTurn) || chatMutationBusy || launchSelection.switching;
	// The backend owns whether a live source can be preserved or must be
	// discarded; an active turn must never remove the user's terminal escape.
	const runtimeProfileSwitchBusy =
		chatMutationBusy || launchSelection.switching;
	useNamedPaneAction(
		paneId,
		"switch_runtime:terminal",
		supportsStructuredChat(agent.provider) &&
			!(accountBusy || remoteAccountBusy || runtimeProfileSwitchBusy),
		() =>
			runAgentRuntimePaneAction((sourceStopPolicy, expectedSourceRevision) =>
				switchToNativeTerminal(
					agent.id,
					sourceStopPolicy,
					expectedSourceRevision,
				),
			),
		agentRuntimePaneActionOwnerKey(agent),
	);
	// The one pane-scoped account switch: the toolbar switcher, the recovery
	// banner, the usage-limit handoff, and the pane actions all run this.
	const performAccountSwitch = (
		accountId: string | null,
	): Promise<AgentCredentialTransitionResult> => {
		const targetAccount = accountId
			? accountPool.find((account) => account.id === accountId)
			: undefined;
		if (accountId && !targetAccount) {
			return Promise.reject(new Error("credential_reference_unavailable"));
		}
		setAccountFailure(undefined);
		setRemoteRecoveryAccount(undefined);
		setAccountBusy(true);
		const episode = turnFailure
			? usageLimitHandoffState.read(agent.id, turnFailure.createdAtMs)
			: undefined;
		const recoveryAttempt = episode?.result.kind === "failed"
			? usageLimitHandoffState.begin(agent.id, episode.attempt.failureAtMs, "requested")
			: undefined;
		return switchCredential(agent.id, accountId)
			.then((result) => {
				// Manual toolbar/CLI recovery consumes the same failed attempt.
				// Only an actual completed transition can clear its shared error.
				if (result.kind === "completed" && recoveryAttempt) {
					usageLimitHandoffState.settle(recoveryAttempt, {
						kind: "completed",
						outcome: {
							fromName: currentAccount?.name,
							toName: targetAccount?.name ?? t("agents.account.defaultCli"),
						},
					});
				}
				return result;
			})
			.catch((error: unknown) => {
				if (recoveryAttempt) {
					usageLimitHandoffState.settle(recoveryAttempt, {
						kind: "failed",
						error: error instanceof Error ? error.message : String(error),
					});
				}
				setRemoteRecoveryAccount(targetAccount);
				setAccountFailure(
					error instanceof Error ? error.message : String(error),
				);
				throw error;
			})
			.finally(() => setAccountBusy(false));
	};
	const runAccountSwitch = (accountId: string | null) => {
		void performAccountSwitch(accountId).catch(() => {});
	};
	// The toolbar switcher's own disabled predicate; the pane actions and the
	// automatic handoff honour exactly the same lock.
	const accountMovesLocked =
		accountBusy || remoteAccountBusy || profileBusy || structuredActionBusy;
	const { view: handoffView, requestHandoff } = useUsageLimitHandoff({
		agentId: agent.id,
		provider: agent.provider,
		automatic: autoSwitchAccounts && project?.kind !== "ssh",
		accountMovesLocked,
		currentCredentialId: currentAccount?.id,
		pool: accountPool,
		failure: turnFailure,
		performAccountSwitch,
		resumeAfterHandoff: resumeUsageLimitTurn,
	});
	const handoffDecision =
		handoffView.kind === "decided" || handoffView.kind === "failed"
			? handoffView.decision
			: undefined;
	const presentedAccountFailure =
		accountFailure ??
		(handoffView.kind === "failed" ? handoffView.error : undefined);
	// A handled episode no longer offers another account handoff. Resending
	// its retained input is a separate, explicit action shared by GUI and CLI.
	const openTurnFailure =
		handoffView.kind === "handled" ? undefined : turnFailure;
	const retainedInput = turnFailure?.userInput;
	const resendLastMessage =
		handoffView.kind === "handled" &&
		handoffView.outcome &&
		handoffView.outcome.resume !== "accepted" &&
		handoffView.outcome.resume !== "uncertain" &&
		turnFailure &&
		retainedInput !== undefined &&
		session.phase === "ready" &&
		!session.reconnecting &&
		!accountMovesLocked &&
		!session.retryTurnAvailable
			? {
					failureId: turnFailure.itemId,
					run: () => session.send(retainedInput),
				}
			: undefined;
	useChatPaneActions(
		{
			paneId,
			agentId: agent.id,
			conversationId: agent.conversationId ?? undefined,
			interactionSessionId: profile.interactionSessionId,
		},
		{
			phase: session.phase,
			reconnecting: session.reconnecting,
			activeTurn,
			interrupting: session.interrupting,
			// Same lock the chat surface passes as `disabled`.
			locked: accountBusy || profileBusy,
			accountMovesLocked,
			error:
				handoffView.kind === "failed"
					? handoffView.error
					: "error" in session
						? session.error
						: undefined,
			lastTurnFailure: openTurnFailure?.reason,
			handoffRefusal:
				handoffDecision?.kind === "refused" ? handoffDecision.code : undefined,
			interrupt: session.interrupt,
			resendLastMessage,
			handoff: handoffDecision?.kind === "handoff" ? requestHandoff : undefined,
			switchAccount: {
				...Object.fromEntries(
					accountPool
						.filter((account) => account.id !== currentAccount?.id)
						.map((account) => [
							account.id,
							async () => {
								await performAccountSwitch(account.id);
							},
						]),
				),
				// The provider's default login is a target too, but has no id.
				...(currentAccount
					? {
							default: async () => {
								await performAccountSwitch(null);
							},
						}
					: {}),
			},
		},
		runtimeOwnerKey,
	);

	return (
		<div className="flex h-full flex-col">
			<AgentPanelToolbarFrame
				agent={agent}
				hmux
				presentFork={(forkedAgent) =>
					presentForkInAgentPanelDesktop(
						{ desktopId: paneDesktopId, panelId: paneId },
						forkedAgent,
					)
				}
			>
				<AgentPluginClaimStatus agent={agent} paneId={paneId} />
				{supportsStructuredChat(agent.provider) &&
					supportsAccounts(agent.provider) &&
					toolbarControls.visible("account", {
						mustShow: !!presentedAccountFailure,
					}) &&
					toolbarControls.slot(
						"account",
						<AgentCredentialSwitcher
							agentId={agent.id}
							provider={agent.provider}
							accounts={accountPool}
							currentAccount={currentAccount}
							recoveryAccount={remoteRecoveryAccount}
							followsGlobal={false}
							failure={presentedAccountFailure}
							hostName={remoteHost?.name}
							accountBusy={accountBusy || remoteAccountBusy}
							allowCurrentAccountReselect={session.phase !== "ready"}
							disabled={
								accountBusy ||
								remoteAccountBusy ||
								profileBusy ||
								structuredActionBusy
							}
							disabledTitle={t("common.paneAccount")}
							onSwitch={runAccountSwitch}
							onApplyNow={() => {}}
							onCancel={() => {}}
							onRemoteLogin={(account) => void openRemoteLogin(account)}
							onCopyToHost={(account) => void copyAccountToHost(account)}
							onManageAccounts={() => setAccountsOpen(true)}
						/>,
					)}
				{supportsStructuredChat(agent.provider) &&
					toolbarControls.visible("view-switch") &&
					toolbarControls.slot(
						"view-switch",
						<AgentRuntimeProfileSwitch
							key={`runtime-profile:${runtimeOwnerKey}`}
							target="terminal"
							disabled={
								accountBusy || remoteAccountBusy || runtimeProfileSwitchBusy
							}
							disabledTitle={
								runtimeProfileSwitchBusy ? t("common.loading") : undefined
							}
							onSwitch={(sourceStopPolicy, expectedSourceRevision) =>
								switchToNativeTerminal(
									agent.id,
									sourceStopPolicy,
									expectedSourceRevision,
								)
							}
							onSwitchingChange={setProfileBusy}
						/>,
					)}
				<AgentPanelWindowActions
					agent={agent}
					project={project}
					showDiff={project?.kind !== "ssh"}
					presentation={windowActionsPresentation}
				/>
				{toolbarControls.visible("conversation-history") &&
					toolbarControls.slot(
						"conversation-history",
						<AgentConversationHistoryControl
							key={`conversation-history:${runtimeOwnerKey}`}
							actionLease={historyActionLease}
							activeConversationId={agent.conversationId ?? null}
							activity={chatActivity}
							agent={agent}
							binding={undefined}
							conversations={conversations}
							mutationAllowed
							mutationDisabledTitle=""
							onError={(error) => setConversationFailure(String(error))}
							onLoad={() => void loadConversations()}
							onSwitchExisting={async () => {
								throw new Error(
									"structured_conversation_history_requires_sibling",
								);
							}}
							paneDesktopId={paneDesktopId}
							panelId={paneId}
							projectKind={project?.kind}
							resuming={
								accountBusy || remoteAccountBusy || structuredActionBusy
							}
						/>,
					)}
			</AgentPanelToolbarFrame>
			<div className="relative min-h-0 flex-1">
				<StructuredAgentChatSurface
					session={session}
					paneApi={panelProps.api}
					disabled={accountBusy || profileBusy}
					attachmentsEnabled={project?.kind === "local"}
					launchSelection={launchSelection}
					catalogSource={agentProviderCatalogSource(agent, project, accounts)}
					onReady={markReady}
					recovery={
						supportsAccounts(agent.provider)
							? {
									// The pane's own switch to the account the handoff policy
									// chose from fresh observed usage — never the global
									// active account, never a guess.
									...(handoffDecision?.kind === "handoff"
										? {
												switchAccount: {
													targetName: handoffDecision.targetName,
													run: () => void requestHandoff().catch(() => {}),
												},
											}
										: {}),
									manageAccounts: () => setAccountsOpen(true),
									// The episode was already answered by a handoff: say so,
									// and offer the failed message back with one click.
									...(handoffView.kind === "handled" && handoffView.outcome
										? {
												handedOff: {
													...handoffView.outcome,
													...(resendLastMessage
														? { resend: resendLastMessage.run }
														: {}),
												},
											}
										: {}),
									// Remote panes sign in on the host through the
									// account switcher instead of a local terminal.
									...(project?.kind === "ssh"
										? {}
										: {
												signIn: () =>
													openCommandTerminalOn(panelProps.containerApi, {
														title: t("agents.chat.recovery.signIn"),
														command: providerLoginCmd(
															agent.provider,
															currentAccount,
														),
														closeOnSuccess: true,
													}),
											}),
								}
							: undefined
					}
				/>
				{conversationFailure && (
					<Alert
						surface="dock"
						className="absolute inset-x-2 top-2 z-20"
						dismiss={{
							label: t("common.close"),
							onClick: () => setConversationFailure(undefined),
						}}
					>
						<span className="min-w-0 flex-1">{conversationFailure}</span>
					</Alert>
				)}
			</div>
			{accountsOpen && (
				<AccountsDialog onClose={() => setAccountsOpen(false)} />
			)}
		</div>
	);
}
