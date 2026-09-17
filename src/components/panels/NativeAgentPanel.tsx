import { NativeAgentResponseView } from "@/components/agents/NativeAgentResponseView";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  managedCredentialSwitchFailureMessage,
  managedCredentialSwitchIdentityBlock,
} from "@/lib/agents/freshCredentialSwitch";
import { t } from "@/lib/i18n";
import type { Agent } from "@/types";
import { AgentRuntimeProfileSwitch } from "@/components/agents/AgentRuntimeProfileSwitch";
import { AgentLaunchSelectionControls } from "@/components/agents/AgentLaunchSelectionControls";
import { agentProviderCatalogSource } from "@/lib/agents/providerModelCatalogSource";
import { AgentCredentialSwitcher } from "@/components/agents/AgentCredentialSwitcher";
import {
  useAgentLaunchControlsPresentation,
  useAgentToolbarControls,
  useAgentToolbarGroupPresentation,
} from "@/components/agents/useAgentToolbarControls";
import { RetiredLegacyPane } from "@/components/terminal/RetiredLegacyPane";
import { TerminalView } from "@/components/terminal/TerminalView";
import { useWorkspaceRuntimeDesktopId } from "@/components/workspace/WorkspaceRuntimeContext";
import type { AgentConversationTarget } from "@/components/agents/AgentConversationControls";
import {
  AgentConversationHistoryControl,
  type AgentConversationHistoryActionLease,
} from "@/components/agents/AgentConversationHistoryControl";
import { AgentExitedSessionSurface } from "@/components/agents/AgentExitedSessionSurface";
import { useManagedAgentTerminalFallback } from "@/components/agents/useManagedAgentTerminalFallback";
import {
  useRuntimeOwnedRequest,
  useRuntimeOwnedValue,
} from "@/components/agents/useRuntimeOwnedValue";
import {
  hostToOpts,
  listConversations,
  sshListConversations,
  type Conversation,
} from "@/lib/ipc";
import { workspacePerformance } from "@/lib/workspace/performance/workspacePerformance";
import { supportsAccounts, supportsStructuredChat } from "@/lib/agents/providers";
import { isRemoteCredentialUnavailable } from "@/lib/agents/remoteAccountOverlay";
import { AccountsDialog } from "@/components/agents/AccountsDialog";
import {
  applyDeferredCredentialSwitchNow,
  cancelDeferredCredentialSwitch,
} from "@/lib/sessions/credentials/deferredCredentialSwitchRuntime";
import { recoverExitedManagedConversationPane } from "@/lib/sessions/managed/managedConversationLaunch";
import { convergeManagedAgentRehost } from "@/lib/sessions/managed/managedAgentRehostConvergence";
import { resumeExactManagedAgentPane } from "@/lib/sessions/managed/managedExactConversationResume";
import { managedAgentWorktreeRecovery } from "@/lib/sessions/managed/managedAgentWorktreeRecovery";
import { useAgentPaneAttentionAck } from "@/components/agents/useAgentPaneAttentionAck";
import { openSplitLauncherOn, paneSplitTargetForPanel } from "@/lib/workspace/pane/paneSplit";
import { paneViewCloseMenu } from "@/lib/workspace/pane/paneKillMenu";
import { resolveAgentPaneTitle } from "@/lib/workspace/pane/paneTitle";
import { useConversationTitle } from "@/components/agents/chat/useConversationTitle";
import {
  hmuxPaneConversationId,
  isHmuxPaneBinding,
} from "@/lib/terminal/terminalBinding";
import type { TerminalAttachRecovery } from "@/lib/terminal/terminalAttachRecovery";
import { evaluateAgentProviderMutation } from "@/lib/agents/agentProviderMutationPolicy";
import { conversationHistoryCredentialProfile } from "@/lib/agents/agentConversationHistory";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import { agentRuntimePresentationOwnerKey } from "@/lib/agents/agentRuntimePresentationOwner";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import {
  runCredentialSwitchWithFeedback,
  type CredentialProfileRecovery,
} from "@/lib/agents/credentialSwitchRecovery";
import { AgentPanelWindowActions } from "@/components/panels/AgentPanelWindowActions";
import type { AgentPanelDockProps } from "@/components/panels/agentPanelContract";
import { useNativeAgentPanelState } from "@/components/panels/useAgentPanelState";
import { useRemoteAgentCredentialActions } from "@/components/panels/useRemoteAgentCredentialActions";
import { useNamedPaneAction } from "@/components/workspace/useNamedPaneAction";
import {
  AgentPanelToolbarFrame,
  presentForkInAgentPanelDesktop,
} from "@/components/panels/AgentPanelToolbarFrame";
import { AgentPluginClaimStatus } from "@/components/plugins/AgentPluginClaimStatus";
import { DelegateTaskControl } from "@/components/agents/DelegateTaskControl";
import type { DureAgentRuntimeSourceStopPolicyV1 } from "@/lib/ipc/dureAgentRuntime";
import type { AgentRuntimeLaunchSelectionView } from "@/lib/agents/agentRuntimeLaunchSelection";
import { agentRuntimePaneActionOwnerKey, runAgentRuntimePaneAction } from "@/lib/agents/agentRuntimePaneAction";
import type { AgentCredentialTransitionResult } from "@/lib/agents/agentCredentialTransition";

const WINDOW_ACTION_CONTROL_IDS = [
  "diff-window",
  "source-control-window",
] as const;

export function NativeAgentPanel({
  agent,
  backendManaged,
  historyActionLease,
  panelProps: props,
  launchSelection,
  switchCredential,
  switchToStructuredChat,
}: {
  agent: Agent;
  backendManaged: boolean;
  historyActionLease: AgentConversationHistoryActionLease;
  panelProps: AgentPanelDockProps;
  launchSelection: AgentRuntimeLaunchSelectionView;
  switchCredential: (
    agentId: string,
    targetCredentialId: string | null,
  ) => Promise<AgentCredentialTransitionResult>;
  switchToStructuredChat: (
    agentId: string,
    targetCredentialId: string | null,
    sourceStopPolicy?: DureAgentRuntimeSourceStopPolicyV1,
    expectedSourceRevision?: number,
  ) => Promise<void>;
}) {
  const agentId = agent.id;
  const runtimeOwnerKey = agentRuntimePresentationOwnerKey(agent);
  const {
    agentCwd,
    terminalTitle,
    activity,
    agentRuntimeState,
    setAgentActivity,
    accounts,
    sshHosts,
    project,
    restartReq,
    getActiveSpaceId,
    getAgentById,
    getProjectSshHost,
  } = useNativeAgentPanelState(agent);
  const binding = agent.runtimeBinding;
  const isHmux = isHmuxPaneBinding(binding);
  const conversationTitle = useConversationTitle(agent.id);
  // pane-open 계측: mount → 첫 터미널 paint (프론트 표면 비용, provider별 분해).
  // 지배 비용(provider-ready)은 ensureManagedAgentRuntime이 별도 기록한다 (bd 6gy).
  const paneId = props.api.id;
  const paneProvider = agent?.provider;
  const paneDesktopId = useWorkspaceRuntimeDesktopId();
  useEffect(() => {
    // 삭제된/미해석 에이전트는 계측하지 않는다 — 'agent:unknown' 고아 샘플 방지.
    if (!paneProvider) return;
    // 숨은 탭·백그라운드 데스크탑에서 mount된 pane은 첫 paint가 사용자가 열어볼
    // 때까지 지연되므로(visible 게이트) 대기 시간이 openMs로 오염된다 — 스킵.
    if (!props.api.isVisible) return;
    if (paneDesktopId && getActiveSpaceId() !== paneDesktopId) return;
    workspacePerformance.beginPaneOpen(paneId, `agent:${paneProvider}`);
    // ready에 못 닿는 종료(스폰 실패·조기 닫힘·provider 전환)는 샘플을 버린다.
    return () => workspacePerformance.cancelPaneOpen(paneId);
  }, [paneId, paneProvider, paneDesktopId, props.api, getActiveSpaceId]);
  const [ownedAccountsOpen, setAccountsOpen] =
    useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
  const accountsOpen = ownedAccountsOpen ?? false;
  const [accountRecovery, setAccountRecovery] =
    useRuntimeOwnedValue<CredentialProfileRecovery>(runtimeOwnerKey);
  const [accountFailure, setAccountFailure] =
    useRuntimeOwnedValue<string>(runtimeOwnerKey);
  const [remoteRecoveryAccount, setRemoteRecoveryAccount] =
    useRuntimeOwnedValue<(typeof accounts)[number]>(runtimeOwnerKey);
  useAgentPaneAttentionAck(agentId, props.api);
  const [ownedResuming, setResuming] =
    useRuntimeOwnedValue<boolean>(runtimeOwnerKey);
  const resuming = ownedResuming ?? false;
  const runtimeTransitioning = resuming || launchSelection.switching;
  useNamedPaneAction(
    props.api.id,
    "switch_runtime:chat",
    backendManaged &&
      supportsStructuredChat(agent.provider) &&
      !runtimeTransitioning &&
      !agent.pendingCredentialSwitch,
    () =>
      runAgentRuntimePaneAction((sourceStopPolicy, expectedSourceRevision) =>
        switchToStructuredChat(
          agent.id,
          agentCredentialReferenceId(agent) ?? null,
          sourceStopPolicy,
          expectedSourceRevision,
        ),
      ),
    agentRuntimePaneActionOwnerKey(agent),
  );
  const toolbarControls = useAgentToolbarControls();
  const launchControlsPresentation =
    useAgentLaunchControlsPresentation(launchSelection);
  const windowActionsPresentation = useAgentToolbarGroupPresentation(
    WINDOW_ACTION_CONTROL_IDS,
  );
  const [staleManagedRecoveryVisible, setStaleManagedRecoveryVisible] =
    useState(false);
  const [structuredAttachRecoveryVisible, setStructuredAttachRecoveryVisible] =
    useState(false);
  const [conversationFailure, setConversationFailure] =
    useRuntimeOwnedValue<string>(runtimeOwnerKey);
  const reportConversationError = (error: unknown) => {
    setConversationFailure(String(error));
  };
  const terminalFallback = useManagedAgentTerminalFallback({
    agentId: agent?.id,
    activity,
    binding,
    containerApi: props.containerApi,
    panelApi: props.api,
    cwd: agent?.worktreePath,
    terminalEnv: agent?.terminalEnv,
    desktopId: paneDesktopId ?? undefined,
    recoveryAvailable: staleManagedRecoveryVisible,
    disabled: runtimeTransitioning,
    onTransitioningChange: setResuming,
    onError: reportConversationError,
  });
  const [ownedConvs, setConvs] =
    useRuntimeOwnedValue<Conversation[] | null>(runtimeOwnerKey);
  const beginConversationLoad = useRuntimeOwnedRequest(runtimeOwnerKey);
  const beginExitedConversationTransition =
    useRuntimeOwnedRequest(runtimeOwnerKey);
  const convs = ownedConvs ?? null;
  const [ownedActiveConvId, setActiveConvId] =
    useRuntimeOwnedValue<string | null>(runtimeOwnerKey);
  const activeConvId = ownedActiveConvId ?? null;
  const remoteAgentHost =
    binding?.source === "ssh"
      ? sshHosts.find((host) => host.id === project?.sshHostId)
      : undefined;
  const {
    busy: accountBusy,
    openRemoteLogin,
    copyAccountToHost,
  } = useRemoteAgentCredentialActions({
    agent,
    host: remoteAgentHost,
    containerApi: props.containerApi,
  });

  // Keep Dockview on the same explicit-name → observed-title → directory
  // authority as PaneChrome and Spaces; metadata remains in their diagnostics.
  useEffect(() => {
    if (agent) {
      applyAutomaticPaneTitle(
        props.api,
        resolveAgentPaneTitle({
          name: agent.name,
          displayName: agent.displayName,
          runtimeTitle: conversationTitle ?? terminalTitle,
          opaqueConversationId:
            hmuxPaneConversationId(binding) ?? agent.conversationId,
          directoryCandidates: [agentCwd, agent.worktreePath],
        }),
      );
    }
  }, [agent, agentCwd, binding, conversationTitle, props.api, terminalTitle]);

  if (!isHmux) {
    // The legacy PTY/SSH agent runtime is retired (2026-08-16): persisted
    // agents promote onto the managed runtime at rehydration, so a non-hmux
    // binding here is an orphaned record. Render the dead-end notice and keep
    // every legacy spawn affordance unreachable.
    return <RetiredLegacyPane onClose={() => props.api.close()} />;
  }
  const isSshSession = binding.source === "ssh";
  const terminalKind = isSshSession ? "ssh" : "pty";
  const structuredRuntimeActionsAvailable =
    backendManaged && supportsStructuredChat(agent.provider);
  const conversationMutation = evaluateAgentProviderMutation(
    binding,
    "conversation",
  );
  const credentialMutation = evaluateAgentProviderMutation(binding, "credential");
  const standaloneMutationMessage = t("common.standaloneProviderSwapBlocked");
  // Exited conversation actions replace this exact pane. Header history on a
  // live source remains the separate, non-destructive sibling action. Exact
  // Resume deliberately has no UI ownership lease: Hmux owns replacement
  // idempotency, so a stale frontend projection cannot reject the attempt.
  const runExitedConversationTransition = async (
    resolveTarget: () => Promise<AgentConversationTarget | undefined>,
  ) => {
    setConversationFailure(undefined);
    setResuming(true);
    try {
      const target = await resolveTarget();
      if (!target) return;
      if (target.kind === "fresh") {
        const isCurrent = beginExitedConversationTransition();
        const lease = {
          checkpoint: () => {
            if (!isCurrent()) {
              throw new Error("client_agent_runtime_transition_conflict");
            }
          },
        };
        if (
          !conversationMutation.allowed ||
          binding?.runtime !== "hmux_managed_v1"
        ) {
          throw new Error(standaloneMutationMessage);
        }
        if (activity !== "exited") {
          throw new Error("managed_exited_conversation_recovery_required");
        }
        const conversationId = await recoverExitedManagedConversationPane({
          agentId: agent.id,
          panelId: props.api.id,
          target,
        }, lease);
        setActiveConvId(conversationId);
        setAgentActivity(agent.id, "connecting");
        return;
      }
      await recoverExitedManagedConversationPane({
        agentId: agent.id,
        panelId: props.api.id,
        target,
      });
    } finally {
      setResuming(false);
    }
  };
  const switchConversation = (target: AgentConversationTarget) =>
    runExitedConversationTransition(async () => target);

  // 대화 목록 조회 (드롭다운/폴백 공용)
  const fetchConversations = async (): Promise<Conversation[]> => {
    const credentialProfile = conversationHistoryCredentialProfile({
      agent,
      accounts,
      remote: isSshSession,
    });
    if (!isSshSession) {
      return await listConversations(
        agent.worktreePath,
        agent.provider,
        credentialProfile,
      );
    }
    const host = getProjectSshHost(agent.projectId);
    return host
      ? await sshListConversations({
          connectOpts: hostToOpts(host),
          cwd: agent.worktreePath,
          provider: agent.provider,
          credentialProfile,
        })
      : [];
  };

  const recoveryConversationId = (
    hmuxPaneConversationId(binding) ?? agent.conversationId
  )?.trim();
  // Attach failure and clean exit share this one action authority. The action
  // starts a new Host directly; presentation state never admits or rejects it.
  const attachRecovery: TerminalAttachRecovery = {
    ownerKey: JSON.stringify([runtimeOwnerKey, recoveryConversationId]),
    transitioning: runtimeTransitioning,
    intent: recoveryConversationId ? "resume" : "start_fresh",
    worktree: managedAgentWorktreeRecovery(agent, project),
    resume: async () => {
      setConversationFailure(undefined);
      setResuming(true);
      try {
        if (recoveryConversationId) {
          return await resumeExactManagedAgentPane(
            agent.id,
            props.api.id,
            recoveryConversationId,
          );
        }
        const converged = await convergeManagedAgentRehost(
          agent.id,
          props.api.id,
        ).catch(() => null);
        if (converged) return converged;
        const conversationId = await recoverExitedManagedConversationPane({
          agentId: agent.id,
          panelId: props.api.id,
          target: { kind: "fresh" },
        });
        setActiveConvId(conversationId);
        setAgentActivity(agent.id, "connecting");
        return conversationId;
      } catch (cause) {
        if (remoteAgentHost && currentAccount && isRemoteCredentialUnavailable(cause)) {
          await openRemoteLogin(currentAccount);
        }
        // Opening login is not a successful create; the same action remains
        // available once the user authenticates in the selected remote profile.
        throw cause;
      } finally {
        setResuming(false);
      }
    },
    context: [
      `agent=${agent.id}`,
      `pane=${props.api.id}`,
      `session=${agent.sessionId}`,
      recoveryConversationId ? `conversation=${recoveryConversationId}` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };

  // 대화 목록 로드 (드롭다운 열 때)
  const loadConversations = async () => {
    const isCurrent = beginConversationLoad();
    setConversationFailure(undefined);
    setConvs(null);
    try {
      const conversations = await fetchConversations();
      if (!isCurrent()) return;
      setConvs(conversations);
    } catch (error) {
      if (!isCurrent()) return;
      setConvs([]);
      reportConversationError(error);
    }
  };

  // --- 계정 스위처 ---
  const accountPool = supportsAccounts(agent.provider)
    ? accounts.filter((a) => a.provider === agent.provider)
    : [];
  const followsGlobal = false;
  const effectiveAccountId = agentCredentialReferenceId(agent) ?? null;
  const currentAccount = effectiveAccountId
    ? accountPool.find((a) => a.id === effectiveAccountId)
    : undefined;
  const pendingCredentialSwitch =
    binding?.runtime === "hmux_managed_v1" &&
    (!agent.pendingCredentialSwitch?.targetLaunchSelection ||
      agent.pendingCredentialSwitch.targetCredentialId !==
        agent.pendingCredentialSwitch.sourceCredentialId)
      ? agent.pendingCredentialSwitch
      : undefined;
  const managedCredentialIdentityBlock =
    binding?.runtime === "hmux_managed_v1" &&
    !structuredRuntimeActionsAvailable
      ? managedCredentialSwitchIdentityBlock(agent, agentRuntimeState)
      : undefined;
  const agentHost = remoteAgentHost;

  /** Credential 변경은 확인된 conversation id를 명시적으로 유지한다.
   * managed Host만 실행 중인 provider 프로세스를 교체할 수 있다 —
   * legacy PTY/SSH migration 경로는 2026-08-16 은퇴했다. */
  const switchAccount = async (accountId: string | null) => {
    if (
      !credentialMutation.allowed ||
      binding?.runtime !== "hmux_managed_v1"
    ) {
      throw new Error(standaloneMutationMessage);
    }
    setResuming(true);
    try {
      const targetAccount = accountId
        ? accountPool.find((account) => account.id === accountId)
        : undefined;
      if (accountId && !targetAccount) {
        throw new Error("credential_reference_unavailable");
      }
      const result = await switchCredential(agent.id, accountId);
      setActiveConvId(result.conversationId);
    } finally {
      setResuming(false);
    }
  };

  const openAccountRecovery = (recovery: CredentialProfileRecovery) => {
    setAccountFailure(undefined);
    setAccountRecovery(recovery);
    setAccountsOpen(true);
  };

  // 왜 막혔는지까지 보여준다. "실패했습니다"만으로는 기다리면 되는 상태(첫
  // 메시지 전)와 사용자가 정리해야 하는 상태(대화 여러 개)를 구분할 수 없다.
  const reportAccountSwitchFailure = (error: unknown) => {
    if (structuredRuntimeActionsAvailable) {
      setAccountFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    const currentAgent = getAgentById(agent.id);
    setAccountFailure(managedCredentialSwitchFailureMessage(currentAgent, error));
  };

  const runAccountSwitch = (accountId: string | null) => {
    setAccountFailure(undefined);
    setRemoteRecoveryAccount(undefined);
    const targetAccount = accountId
      ? accountPool.find((account) => account.id === accountId)
      : undefined;
    void runCredentialSwitchWithFeedback({
      execute: () => switchAccount(accountId),
      account: targetAccount,
      onRecovery: (recovery) => {
        setRemoteRecoveryAccount(targetAccount);
        openAccountRecovery(recovery);
      },
      onFailure: (error) => {
        setRemoteRecoveryAccount(targetAccount);
        return reportAccountSwitchFailure(error);
      },
    }).then((outcome) => {
      if (outcome === "completed") setRemoteRecoveryAccount(undefined);
    });
  };

  const applyPendingAccountSwitch = () => {
    setAccountFailure(undefined);
    const targetAccount = pendingCredentialSwitch?.targetCredentialId
      ? accountPool.find(
          (account) =>
            account.id === pendingCredentialSwitch.targetCredentialId,
        )
      : undefined;
    setResuming(true);
    void runCredentialSwitchWithFeedback({
      execute: () => applyDeferredCredentialSwitchNow(agent.id),
      account: targetAccount,
      onRecovery: openAccountRecovery,
      onFailure: reportAccountSwitchFailure,
    }).finally(() => setResuming(false));
  };

  return (
    <div className="flex h-full flex-col">
      <AgentPanelToolbarFrame
        agent={agent}
        hmux={isHmux}
        presentFork={(forkedAgent) =>
          presentForkInAgentPanelDesktop(
            { desktopId: paneDesktopId, panelId: paneId },
            forkedAgent,
          )
        }
      >
        <AgentPluginClaimStatus
          agent={agent}
          paneId={paneId}
          onNavigate={() => props.api.setActive()}
        />
        {paneDesktopId && (
          <DelegateTaskControl
            agent={agent}
            desktopId={paneDesktopId}
            hiddenTrigger
            panelId={paneId}
          />
        )}
        {/* 계정 스위처 — 이 pane에서만 바뀌고, 대화는 이어서 재시작된다 */}
        {supportsAccounts(agent.provider) &&
          toolbarControls.visible("account", {
            mustShow: !!pendingCredentialSwitch || !!accountFailure,
          }) &&
          toolbarControls.slot(
            "account",
            <AgentCredentialSwitcher
            agentId={agent.id}
            provider={agent.provider}
            accounts={accountPool}
            currentAccount={currentAccount}
            recoveryAccount={remoteRecoveryAccount}
            followsGlobal={followsGlobal}
            pending={pendingCredentialSwitch}
            failure={accountFailure}
            hostName={agentHost?.name}
            accountBusy={accountBusy}
            disabled={
              runtimeTransitioning ||
              accountBusy ||
              !credentialMutation.allowed ||
              !!managedCredentialIdentityBlock
            }
            disabledTitle={
              managedCredentialIdentityBlock
                ? managedCredentialIdentityBlock.reason ??
                  t("common.accountSwitchAfterFirstMessage")
                : credentialMutation.allowed
                ? t("common.paneAccount")
                : standaloneMutationMessage
            }
            onSwitch={runAccountSwitch}
            onApplyNow={applyPendingAccountSwitch}
            onCancel={() => cancelDeferredCredentialSwitch(agent.id)}
            onRemoteLogin={(account) => void openRemoteLogin(account)}
            onCopyToHost={(account) => void copyAccountToHost(account)}
            onManageAccounts={() => {
              setAccountRecovery(undefined);
              setAccountsOpen(true);
            }}
          />,
          )}
        {backendManaged && (
          <AgentLaunchSelectionControls
            provider={agent.provider}
            launch={launchSelection}
            catalogSource={agentProviderCatalogSource(agent, project, accounts)}
            busy={runtimeTransitioning || !!agent.pendingCredentialSwitch}
            presentation={launchControlsPresentation}
          />
        )}
        {structuredRuntimeActionsAvailable &&
          toolbarControls.visible("view-switch") &&
          toolbarControls.slot(
            "view-switch",
            <AgentRuntimeProfileSwitch
              key={`runtime-profile:${runtimeOwnerKey}`}
            disabled={runtimeTransitioning || !!agent.pendingCredentialSwitch}
            disabledTitle={
              agent.pendingCredentialSwitch
                ? t("agents.runtime.finishCredentialSwitchFirst")
                : runtimeTransitioning
                  ? t("common.loading")
                  : undefined
            }
            onSwitch={(sourceStopPolicy, expectedSourceRevision) =>
              switchToStructuredChat(
                agent.id,
                effectiveAccountId,
                sourceStopPolicy,
                expectedSourceRevision,
              )
            }
            onSwitchingChange={setResuming}
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
          activeConversationId={agent.conversationId ?? activeConvId}
          activity={activity}
          agent={agent}
          binding={binding}
          conversations={convs}
          mutationAllowed={conversationMutation.allowed}
          mutationDisabledTitle={standaloneMutationMessage}
          onError={reportConversationError}
          onLoad={() => void loadConversations()}
          onSwitchExisting={switchConversation}
          paneDesktopId={paneDesktopId}
          panelId={props.api.id}
          projectKind={project?.kind}
          resuming={runtimeTransitioning}
        />,
          )}
      </AgentPanelToolbarFrame>

      <div
        className="relative min-h-0 flex-1"
        onKeyDownCapture={terminalFallback.onTerminalKeyDown}
      >
        <NativeAgentResponseView agent={agent} disabled={runtimeTransitioning || structuredAttachRecoveryVisible || staleManagedRecoveryVisible}>
          <TerminalView
            sessionId={agent.sessionId}
            providerHint={agent.provider}
            attachRecovery={attachRecovery}
            largeView={{
              agentId: agent.id,
              sourceWindowLabel: getCurrentWebviewWindow().label,
            }}
            kind={terminalKind}
            binding={binding}
            inputDisabled={runtimeTransitioning || activity === "exited"}
            onFirstPaint={() => workspacePerformance.markPaneReady(paneId)}
            runtimeWorkingDirectory={agent.worktreePath}
            epoch={restartReq}
            paneApi={props.api}
            onHmuxSessionExit={terminalFallback.onHmuxSessionExit}
            onAttachRecoveryPresentationChange={setStructuredAttachRecoveryVisible}
            onSplit={(direction) =>
              openSplitLauncherOn(
                props.containerApi,
                paneSplitTargetForPanel(props.api, props.params),
                { referencePanel: props.api.id, direction },
              )
            }
            {...paneViewCloseMenu({
              panelId: props.api.id,
              desktopId: paneDesktopId ?? undefined,
              title: props.api.title,
              params: props.params,
              close: () => props.api.close(),
            })}
          />
        </NativeAgentResponseView>
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
        <AgentExitedSessionSurface
          agentId={agent.id}
          panelId={props.api.id}
          binding={binding}
          activity={activity}
          authoritativeExit={terminalFallback.authoritativeExit}
          attachRecovery={attachRecovery}
          onOpenShell={terminalFallback.onOpenShell}
          resuming={runtimeTransitioning}
          structuredAttachRecoveryVisible={structuredAttachRecoveryVisible}
          onTransitioningChange={setResuming}
          onRecoveryAvailabilityChange={(_available, deadInput) =>
            setStaleManagedRecoveryVisible(deadInput)
          }
        />
      </div>
      {accountsOpen && (
        <AccountsDialog
          recovery={accountRecovery}
          onClose={() => {
            setAccountsOpen(false);
            setAccountRecovery(undefined);
          }}
        />
      )}
    </div>
  );
}
