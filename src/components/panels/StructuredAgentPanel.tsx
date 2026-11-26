import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect } from "react";
import type { AgentConversationHistoryActionLease } from "@/components/agents/AgentConversationHistoryControl";
import { useAgentChatSession } from "@/components/agents/chat/useAgentChatSession";
import { useApprovedPlanPermissionSelection } from "@/components/agents/chat/useApprovedPlanPermissionSelection";
import { useChatPaneActions } from "@/components/agents/chat/useChatPaneActions";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import { useUsageLimitHandoff } from "@/components/agents/chat/useUsageLimitHandoff";
import { useAgentPaneAttentionAck } from "@/components/agents/useAgentPaneAttentionAck";
import {
	useRuntimeOwnedRequest,
	useRuntimeOwnedValue,
} from "@/components/agents/useRuntimeOwnedValue";
import { presentForkInAgentPanelDesktop } from "@/components/panels/AgentPanelToolbarFrame";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import {
	useStructuredAgentPanelState,
} from "@/components/panels/useAgentPanelState";
import { useRemoteAgentCredentialActions } from "@/components/panels/useRemoteAgentCredentialActions";
import {
	AgentLargeViewSourceProxy,
	useAgentLargeViewSource,
} from "@/components/workspace/AgentLargeViewSourceProxy";
import { useAgentSessionPanePublication } from "@/components/workspace/useAgentSessionPaneChannel";
import { StructuredAgentView } from "@/components/panels/StructuredAgentView";
import {
	type StructuredAgentPaneSurface,
	StructuredAgentPaneRefusal,
} from "@/lib/agents/chat/structuredAgentPaneSurface";
import { agentRuntimeTransitionRefusal } from "@/lib/ipc/dureAgentRuntime";
import { publishAgentSessionChatPane } from "@/lib/workspace/window/agentSessionWindowChatPane";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import { AgentPluginClaimStatus } from "@/components/plugins/AgentPluginClaimStatus";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import {
	conversationHistoryCredentialProfile,
	managedLiveConversationHistoryAvailable,
} from "@/lib/agents/agentConversationHistory";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { agentProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { localAgentProjectMovePort } from "@/lib/agents/agentProjectMovePort";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import {
	agentRuntimePaneActionOwnerKey,
	runAgentRuntimePaneAction,
} from "@/lib/agents/agentRuntimePaneAction";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import type { StructuredAgentRuntimeProjectionGenerationV1 } from "@/lib/agents/agentRuntimeProjectionRecovery";
import type { AgentStructuredInteractionProfileV1 } from "@/lib/agents/chat/agentInteractionProfile";
import { latestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
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
import {
	launchManagedConversationTargetInSibling,
	managedConversationLaunchFailureMessage,
} from "@/lib/sessions/managed/managedConversationLaunch";
import { openCommandTerminalOn } from "@/lib/workspace/dock/openCommandTerminal";
import { resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import type { Agent } from "@/types";

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
	const session = useAgentChatSession(agent.id, profile, onRuntimeInvalidated);
	// The pane owns the launch selection, so it follows an approved plan here
	// even while the Agent's large window presents the conversation.
	useApprovedPlanPermissionSelection(session, launchSelection);
	const activeTurn = "activeTurn" in session ? session.activeTurn : undefined;
	const answeringRequestId =
		"answeringRequestId" in session ? session.answeringRequestId : undefined;
	const conversationTitle = useConversationTitle(agent.id);
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
	const [accountFailure, setAccountFailure] =
		useRuntimeOwnedValue<string>(runtimeOwnerKey);
	const [remoteRecoveryAccount, setRemoteRecoveryAccount] =
		useRuntimeOwnedValue<(typeof accounts)[number]>(runtimeOwnerKey);
	const [ownedAccountBusy, setAccountBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const [ownedProfileBusy, setProfileBusy] =
		useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
	const [ownedProjectMoveBusy, setProjectMoveBusy] =
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
	const projectMoveBusy = ownedProjectMoveBusy ?? false;
	const chatInputLocked = accountBusy || profileBusy || projectMoveBusy;
	const paneId = panelProps.api.id;
	const paneDesktopId = useWorkspaceRuntimeDesktopId();
	const largeView = useAgentLargeViewSource(
		{
			agentId: agent.id,
			sourceWindowLabel: getCurrentWebviewWindow().label,
		},
		paneId,
	);
	useAgentPaneAttentionAck(agent.id, panelProps.api);
	// `/clear` in the composer is the history menu's "new conversation": the
	// same sibling-pane launch, under the same pane-owned action lease.
	const newConversationAvailable = managedLiveConversationHistoryAvailable({
		activity: chatActivity,
		binding: undefined,
		interactionProfile: agent.interactionProfile,
		projectKind: project?.kind,
		provider: agent.provider,
	});
	const launchNewConversation = async () => {
		const ran = await historyActionLease
			.run(async () => {
				await launchManagedConversationTargetInSibling({
					sourceAgentId: agent.id,
					desktopId: paneDesktopId ?? getActiveSpaceId(),
					referencePanelId: paneId,
					target: { kind: "fresh" },
				});
			})
			.catch((error: unknown) => {
				throw new Error(managedConversationLaunchFailureMessage(error));
			});
		if (!ran) throw new StructuredAgentPaneRefusal();
	};
	const turnFailure =
		activeTurn || !("page" in session)
			? undefined
			: latestTurnFailure(session.page?.latestFailure);

	useEffect(() => {
		applyAutomaticPaneTitle(
			panelProps.api,
			resolveAgentPaneTitle({
				agent,
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
	const runtimeSwitchLocked =
		chatInputLocked || remoteAccountBusy || runtimeProfileSwitchBusy;
	useNamedPaneAction(
		paneId,
		"switch_runtime:terminal",
		supportsStructuredChat(agent.provider) &&
			!runtimeSwitchLocked,
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
        const recoveryAttempt = turnFailure
            ? usageLimitHandoffState.begin(agent.id, turnFailure.createdAtMs)
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
	// The toolbar switcher's own disabled predicate; the pane actions and the
	// automatic handoff honour exactly the same lock.
	const accountMovesLocked =
		chatInputLocked || remoteAccountBusy || structuredActionBusy;
	const { view: handoffView, requestHandoff } = useUsageLimitHandoff({
		agentId: agent.id,
		provider: agent.provider,
		recovery: "page" in session ? session.page?.recovery : undefined,
		accountMovesLocked,
		currentCredentialId: currentAccount?.id,
		pool: accountPool,
		failure: turnFailure,
		performAccountSwitch,
	});
	const handoffDecision =
		handoffView.kind === "decided" ||
		handoffView.kind === "failed" ||
		handoffView.kind === "continues"
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
			locked: chatInputLocked,
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

	const accountById = (accountId: string) => {
		const account = accountPool.find((candidate) => candidate.id === accountId);
		if (!account) throw new Error("credential_reference_unavailable");
		return account;
	};
	const newConversationOffered = newConversationAvailable && !accountMovesLocked;
	const signInOffered = project?.kind !== "ssh";
	// The pane's own state and actions as one surface: rendered here, and
	// mirrored by the Agent's large window, whose commands run on exactly
	// these handlers under the same locks the controls show.
	const paneSurface: StructuredAgentPaneSurface = {
		presentation: {
			schemaVersion: 1,
			inputLocked: chatInputLocked,
			accountMovesLocked,
			accountBusy: accountBusy || remoteAccountBusy,
			accountFailure: boundedPaneText(presentedAccountFailure),
			recoveryAccountId: remoteRecoveryAccount?.id ?? null,
			runtimeSwitchLocked,
			runtimeSwitchBusy: runtimeProfileSwitchBusy,
			newConversation: newConversationOffered,
			conversationFailure: boundedPaneText(conversationFailure),
			recovery: supportsAccounts(agent.provider)
				? {
						switchAccountTarget:
							handoffDecision?.kind === "handoff"
								? handoffDecision.targetName
								: null,
						signIn: signInOffered,
						handedOff:
							handoffView.kind === "handled" && handoffView.outcome
								? {
										...(handoffView.outcome.fromName !== undefined
											? { fromName: handoffView.outcome.fromName }
											: {}),
										toName: handoffView.outcome.toName,
										resend: resendLastMessage !== undefined,
									}
								: null,
						continuesAtMs:
							handoffView.kind === "continues" ? handoffView.atMs : null,
					}
				: null,
		},
		run: async (command) => {
			switch (command.kind) {
				case "switch_account":
					if (accountMovesLocked) throw new StructuredAgentPaneRefusal();
					await performAccountSwitch(command.accountId);
					return;
				case "remote_login":
					await openRemoteLogin(accountById(command.accountId));
					return;
				case "copy_to_host":
					await copyAccountToHost(accountById(command.accountId));
					return;
				case "switch_to_terminal": {
					if (runtimeSwitchLocked) throw new StructuredAgentPaneRefusal();
					setProfileBusy(true);
					try {
						await switchToNativeTerminal(
							agent.id,
							command.sourceStopPolicy,
							command.expectedSourceRevision,
						);
					} catch (error) {
						// A refusal crosses to the requesting surface intact, so
						// it can offer to replace an active source.
						const refusal = agentRuntimeTransitionRefusal(error);
						if (refusal) return { kind: "runtime_transition_refused", refusal };
						throw error;
					} finally {
						setProfileBusy(false);
					}
					return;
				}
				case "new_conversation":
					if (!newConversationOffered) throw new StructuredAgentPaneRefusal();
					await launchNewConversation();
					return;
				case "dismiss_conversation_failure":
					setConversationFailure(undefined);
					return;
				case "recovery_switch_account":
					if (handoffDecision?.kind !== "handoff")
						throw new StructuredAgentPaneRefusal();
					await requestHandoff();
					return;
				case "resend_last_message":
					if (!resendLastMessage) throw new StructuredAgentPaneRefusal();
					await resendLastMessage.run();
					return;
				case "sign_in":
					if (!supportsAccounts(agent.provider) || !signInOffered)
						throw new StructuredAgentPaneRefusal();
					openCommandTerminalOn(panelProps.containerApi, {
						title: t("agents.chat.recovery.signIn"),
						command: providerLoginCmd(agent.provider, currentAccount),
						closeOnSuccess: true,
					});
					return;
			}
		},
	};
	useAgentSessionPanePublication(
		paneId,
		paneSurface,
		publishAgentSessionChatPane,
	);
	return (
		<StructuredAgentView
			agent={agent}
			session={session}
			onReady={markReady}
			body={largeView ? <AgentLargeViewSourceProxy {...largeView} /> : undefined}
			runtime={{
				surface: "pane",
				pane: paneSurface,
				presentFork: (forkedAgent) =>
					presentForkInAgentPanelDesktop(
						{ desktopId: paneDesktopId, panelId: paneId },
						forkedAgent,
					),
				projectMove: localAgentProjectMovePort(agent.id),
				// The pane's own project move locks it through its presentation.
				transitioning: false,
				setTransitioning: setProjectMoveBusy,
				paneStatus: <AgentPluginClaimStatus agent={agent} paneId={paneId} />,
				composer: {
					paneApi: panelProps.api,
					launchSelection,
					catalogSource: agentProviderCatalogSource(agent, project, accounts),
				},
				history: {
					actionLease: historyActionLease,
					activeConversationId: agent.conversationId ?? null,
					activity: chatActivity,
					conversations,
					mutationAllowed: true,
					mutationDisabledTitle: "",
					onError: (error) => setConversationFailure(String(error)),
					onLoad: () => void loadConversations(),
					onSwitchExisting: async () => {
						throw new Error("structured_conversation_history_requires_sibling");
					},
					paneDesktopId,
					panelId: paneId,
					projectKind: project?.kind,
					resuming: accountMovesLocked,
				},
			}}
		/>
	);
}

/** Pane text bounded to what the presentation carries. */
function boundedPaneText(text: string | undefined): string | null {
	return text === undefined ? null : text.slice(0, 4_096);
}
