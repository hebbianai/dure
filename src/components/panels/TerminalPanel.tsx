import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import type { IDockviewPanelProps } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import { RetiredLegacyPane } from "@/components/terminal/RetiredLegacyPane";
import type { HmuxSessionExitReceipt } from "@/lib/terminal/structuredTerminalRecord";
import { TerminalView } from "@/components/terminal/TerminalView";
import { PaneRehostBoundary } from "@/components/workspace/PaneRehostBoundary";
import {
  useWorkspaceDurableLayoutCommit,
  useWorkspaceRuntimeDesktopId,
} from "@/components/workspace/WorkspaceRuntimeContext";
import { openSplitLauncherOn, paneSplitTargetForPanel } from "@/lib/workspace/pane/paneSplit";
import {
  type RemoteHmuxManagedStartedMarkerV1,
  remoteHmuxBridgeMarkerMatchesSource,
} from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import { resolveRemoteHmuxStandaloneController } from "@/lib/hmux/remote/remoteHmuxControllerResolution";
import {
  isRemoteHmuxPaneTransitionV1,
  type RemoteHmuxPaneTransitionV1,
} from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import {
  planRemoteHmuxExitTransition,
  planRemoteHmuxManagedTransition,
  sameRemoteHmuxBinding,
} from "@/lib/hmux/remote/remoteHmuxRuntimeTransition";
import { t } from "@/lib/i18n";
import {
  type HmuxProviderConversationIdentity,
  type HmuxWorkingDirectory,
  hmux,
  homeDir,
} from "@/lib/ipc";
import { projectAttachedStandaloneHmuxWorkingDirectory } from "@/lib/hmux/standalone/standaloneHmuxWorkingDirectory";
import { projectManagedPaneConversationIdentity } from "@/lib/terminal/managedPaneConversationIdentity";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { terminalRuntimePresentationOwnerKey } from "@/lib/terminal/terminalRuntimePresentationOwner";
import { providerRunCmd, providerSupportsExplicitResume } from "@/lib/agents/providers";
import { currentTerminalDefaultColors } from "@/lib/theme/themePreference";
import { hmuxManagedPromotionAvailability } from "@/lib/hmux/conversion/hmuxManagedPromotionEligibility";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { sameHmuxConversionBinding } from "@/lib/hmux/conversion/hmuxSessionConversionIdentity";
import {
  commitPreparedHmuxSessionConversion,
  prepareHmuxSessionConversion,
} from "@/lib/hmux/conversion/hmuxSessionConversionWorkflow";
import {
  hmuxPaneConversationId,
  isHmuxPaneBinding,
  isRemoteHmuxStandalonePaneBinding,
  type HmuxPaneBindingV1,
  remoteHmuxManagedBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import {
  getTerminalExecutionLocation,
  hasTerminalExecutionLocationObservation,
  useTerminalExecutionLocation,
  useTerminalExecutionLocationObservation,
} from "@/lib/terminal/terminalExecutionLocationStore";
import { dockPanelParameters } from "@/lib/workspace/dock/dockPanelParameters";
import { commitExplicitDockviewMutation } from "@/lib/workspace/dock/explicitDockviewCommit";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { paneViewCloseMenu } from "@/lib/workspace/pane/paneKillMenu";
import {
  paneTitleFromObservedTitle,
  terminalPaneTitle,
} from "@/lib/workspace/pane/paneTitle";
import { applyAutomaticPaneTitle } from "@/lib/workspace/pane/paneTitleOverrideStore";
import { useStore } from "@/store";
import { sessionRuntimeDisplayState } from "@/lib/sessions/runtime/sessionRuntimeDisplayState";

export interface TerminalPanelParams {
  sessionId: string;
  cwd?: string;
  binding?: TerminalPaneBindingV1;
  remoteHmuxTransition?: RemoteHmuxPaneTransitionV1;
  /** Command panes only: close this pane when the command exits 0 instead of
   *  leaving a tombstone. Failures always keep the log visible. */
  closeOnSuccess?: boolean;
}

/** Local shell panel. Every live pane is an Hmux binding; the legacy PTY
 * command-launch lifecycle was retired 2026-08-16 alongside its runtime. */
export function TerminalPanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const { sessionId, cwd, binding } = props.params;
  const isHmux = isHmuxPaneBinding(binding);
  const desktopId = useWorkspaceRuntimeDesktopId();
  const commitWorkspaceLayout = useWorkspaceDurableLayoutCommit();
  const liveCwd = useStore((state) => state.sessionCwd[sessionId]);
  const terminalTitle = useStore((state) => state.sessionTitle[sessionId]);
  const detectedProvider = useStore(
    (state) => state.sessionAgentPin[sessionId] ?? state.sessionAgent[sessionId],
  );
  const agentRuntimeState = useStore(
    (state) => state.sessionAgentRuntimeState[sessionId],
  );
  const projects = useStore((state) => state.projects);
  // The pane's own Host, from its binding: a remote standalone shell is
  // titled by the SSH host it runs on, a local one by "local". This is the
  // pane's location, distinct from a nested `ssh` hop observed inside it.
  const paneHostId = binding?.source === "ssh" ? binding.hostId : undefined;
  const paneHostName = useStore((state) =>
    paneHostId
      ? state.sshHosts.find((host) => host.id === paneHostId)?.name
      : undefined,
  );
  const paneHostLabel =
    paneHostName ?? (paneHostId ? t("common.remote") : "local");
  const executionLocation = useTerminalExecutionLocation(sessionId);
  const executionLocationObserved =
    useTerminalExecutionLocationObservation(sessionId);
  const effectiveCwd = liveCwd || cwd;
  const paramsRef = useRef(props.params);
  paramsRef.current = props.params;
  const remoteTransitionInFlight = useRef(false);
  const promotionAttempt = useRef<string | undefined>(undefined);
  useEffect(() => {
    applyAutomaticPaneTitle(
      props.api,
      executionLocation.kind === "ssh"
        ? terminalPaneTitle(executionLocation.target)
        : paneTitleFromObservedTitle(
            terminalTitle,
            terminalPaneTitle(paneHostLabel, effectiveCwd),
            hmuxPaneConversationId(binding),
          ),
    );
  }, [
    binding,
    effectiveCwd,
    executionLocation,
    paneHostLabel,
    props.api,
    terminalTitle,
  ]);

  useEffect(() => {
    const availability = hmuxManagedPromotionAvailability(
      {
        kind: "term",
        runtime: binding?.runtime,
        workspaceId: binding?.workspaceId,
        hostId: binding?.source === "ssh" ? binding.hostId : undefined,
        provider: detectedProvider,
        displayState: sessionRuntimeDisplayState(agentRuntimeState),
        cwd: effectiveCwd,
        executionLocationKnown:
          executionLocationObserved && executionLocation.kind === "local",
      },
      projects,
    );
    if (
      availability !== "eligible" ||
      !isHmuxProviderSessionSourceBinding(binding, "terminal") ||
      !detectedProvider
    ) {
      return;
    }

    const request = {
      sourceSessionId: binding.sessionId,
      sourceWorkspaceId: binding.workspaceId,
      panelId: props.api.id,
      target: "managed" as const,
    };
    const attempt = [
      binding.workspaceId,
      binding.sessionId,
      detectedProvider,
      agentRuntimeState?.terminalEpoch ?? "",
      agentRuntimeState?.revision ?? "",
      effectiveCwd,
    ].join("\0");
    if (promotionAttempt.current === attempt) return;
    promotionAttempt.current = attempt;

    void (async () => {
      try {
        const prepared = await prepareHmuxSessionConversion(request);
        const currentPanel = props.containerApi.getPanel(props.api.id);
        if (currentPanel?.api !== props.api) return;
        const currentParams = dockPanelParameters(currentPanel);
        const state = useStore.getState();
        const currentBinding = currentParams.binding;
        if (!isHmuxProviderSessionSourceBinding(currentBinding, "terminal")) return;
        const currentProvider =
          state.sessionAgentPin[binding.sessionId] ??
          state.sessionAgent[binding.sessionId];
        const currentRuntime = state.sessionAgentRuntimeState[binding.sessionId];
        const currentLocation = getTerminalExecutionLocation(binding.sessionId);
        const stillEligible = hmuxManagedPromotionAvailability(
          {
            kind: "term",
            runtime: currentBinding.runtime,
            workspaceId: currentBinding.workspaceId,
            provider: currentProvider,
            displayState: sessionRuntimeDisplayState(currentRuntime),
            cwd:
              state.sessionCwd[binding.sessionId] ||
              (typeof currentParams.cwd === "string" ? currentParams.cwd : undefined),
            executionLocationKnown:
              hasTerminalExecutionLocationObservation(binding.sessionId) &&
              currentLocation.kind === "local",
          },
          state.projects,
        );
        if (
          stillEligible !== "eligible" ||
          currentProvider !== detectedProvider ||
          !sameHmuxConversionBinding(currentBinding, binding)
        ) {
          return;
        }
        await commitPreparedHmuxSessionConversion(prepared);
      } catch (error) {
        console.warn("Automatic agent pane promotion failed", error);
      }
    })();
  }, [
    agentRuntimeState,
    binding,
    detectedProvider,
    effectiveCwd,
    executionLocation,
    executionLocationObserved,
    projects,
    props.api,
    props.containerApi,
  ]);

  const handleRemoteManagedStarted = useCallback(
    async (marker: RemoteHmuxManagedStartedMarkerV1) => {
      if (remoteTransitionInFlight.current) return;
      const current = paramsRef.current;
      const currentBinding = current.binding;
      const transition = current.remoteHmuxTransition;
      if (
        !isRemoteHmuxStandalonePaneBinding(currentBinding) ||
        !isRemoteHmuxPaneTransitionV1(transition) ||
        transition.phase === "preparing" ||
        !sameRemoteHmuxBinding(currentBinding, transition.targetBinding) ||
        !remoteHmuxBridgeMarkerMatchesSource(marker, currentBinding)
      ) {
        return;
      }
      remoteTransitionInFlight.current = true;
      try {
        const managedBinding = remoteHmuxManagedBinding(
          marker.target.sessionId,
          marker.target.workspaceId,
          currentBinding.hostId,
          currentBinding.commandBridgeNonce,
          marker.target.sessionId,
          {
            runnerPrincipal: marker.target.runnerPrincipal,
            runnerInstance: marker.target.runnerInstance,
            channelEpoch: marker.target.channelEpoch,
            hostInstanceId: marker.target.hostInstanceId,
            terminalEpoch: marker.target.terminalEpoch,
          },
        );
        const resolution = await resolveRemoteHmuxStandaloneController(
          useStore.getState().sshHosts,
          managedBinding,
        );
        const plannedBinding = planRemoteHmuxManagedTransition(
          currentBinding,
          transition,
          marker,
          resolution.session,
        );
        if (
          !plannedBinding ||
          plannedBinding.sessionId !== managedBinding.sessionId ||
          plannedBinding.workspaceId !== managedBinding.workspaceId
        ) {
          throw new Error("remote_hmux_command_bridge_catalog_mismatch");
        }
        const latest = paramsRef.current;
        if (
          !isRemoteHmuxStandalonePaneBinding(latest.binding) ||
          !sameRemoteHmuxBinding(latest.binding, currentBinding) ||
          !isRemoteHmuxPaneTransitionV1(latest.remoteHmuxTransition) ||
          latest.remoteHmuxTransition.phase === "preparing" ||
          !sameRemoteHmuxBinding(
            latest.remoteHmuxTransition.targetBinding,
            transition.targetBinding,
          )
        ) {
          throw new Error("remote_hmux_pane_changed_before_managed_handoff");
        }
        const next = {
          ...latest,
          sessionId: managedBinding.sessionId,
          binding: managedBinding,
        };
        paramsRef.current = next;
        props.api.updateParameters(next);
        commitWorkspaceLayout?.();
      } catch (error) {
        await messageDialog(
          t("common.hmuxSwitch.failed", { error: String(error) }),
          { kind: "error" },
        );
      } finally {
        remoteTransitionInFlight.current = false;
      }
    },
    [commitWorkspaceLayout, props.api],
  );

  const handleRemoteHmuxExit = useCallback(() => {
    const current = paramsRef.current;
    const planned = planRemoteHmuxExitTransition(
      current.binding,
      current.remoteHmuxTransition,
    );
    if (!planned) return;
    if (planned.transition) {
      const next = {
        ...current,
        sessionId: planned.binding.sessionId,
        binding: planned.binding,
        remoteHmuxTransition: planned.transition,
      };
      paramsRef.current = next;
      props.api.updateParameters(next);
      commitWorkspaceLayout?.();
      return;
    }
    const { remoteHmuxTransition: _transition, ...withoutTransition } = current;
    const next = {
      ...withoutTransition,
      sessionId: planned.binding.sessionId,
      binding: planned.binding,
    };
    paramsRef.current = next;
    props.api.updateParameters(next);
    commitWorkspaceLayout?.();
  }, [commitWorkspaceLayout, props.api]);

  const handleHmuxSessionExit = useCallback(
    (receipt: HmuxSessionExitReceipt) => {
      // One-shot command panes close themselves on a clean exit — a finished
      // login/setup has nothing left to show. Any failure stays inspectable.
      if (Boolean(paramsRef.current.closeOnSuccess) && receipt.exitCode === 0) {
        props.api.close();
        return;
      }
      const current = paramsRef.current.binding;
      if (
        current?.runtime === "hmux_standalone_v1" &&
        current.source === "local"
      ) {
        return;
      }
      handleRemoteHmuxExit();
    },
    [handleRemoteHmuxExit, props.api],
  );

  const handleProviderConversationIdentity = useCallback(
    (
      identity: HmuxProviderConversationIdentity,
      attachedBinding: HmuxPaneBindingV1,
    ) => {
      const current = paramsRef.current;
      const nextBinding = projectManagedPaneConversationIdentity(
        current.binding,
        attachedBinding,
        identity,
      );
      if (nextBinding === current.binding) return;
      const next = { ...current, binding: nextBinding };
      paramsRef.current = next;
      props.api.updateParameters(next);
      commitWorkspaceLayout?.();
    },
    [commitWorkspaceLayout, props.api],
  );

  const handleWorkingDirectory = useCallback(
    (
      workingDirectory: HmuxWorkingDirectory,
      attachedBinding: HmuxPaneBindingV1,
    ) => {
      if (!desktopId) return;
      const currentPanel = props.containerApi.getPanel(props.api.id);
      if (!currentPanel || currentPanel.api !== props.api) return;
      if (
        !projectAttachedStandaloneHmuxWorkingDirectory(
          dockPanelParameters(currentPanel),
          attachedBinding,
          workingDirectory.path,
        )
      ) {
        return;
      }
      try {
        const committed = commitExplicitDockviewMutation({
          desktopId,
          api: props.containerApi,
          mutate: () => {
            const livePanel = props.containerApi.getPanel(props.api.id);
            if (!livePanel || livePanel.api !== props.api) {
              throw new PaneCommandError(
                "pane_changed",
                `terminal pane ${props.api.id} changed before cwd projection`,
              );
            }
            const next = projectAttachedStandaloneHmuxWorkingDirectory(
              dockPanelParameters(livePanel),
              attachedBinding,
              workingDirectory.path,
            );
            if (!next) return undefined;
            livePanel.api.updateParameters(next);
            return next;
          },
          targetChangedError: () =>
            new PaneCommandError(
              "pane_changed",
              `terminal pane ${props.api.id} changed before cwd projection`,
            ),
        });
        if (committed) {
          paramsRef.current = committed as unknown as TerminalPanelParams;
        }
      } catch (error) {
        console.warn("Failed to persist terminal working directory", error);
      }
    },
    [desktopId, props.api, props.containerApi],
  );

  if (!isHmux) {
    // The legacy PTY runtime is retired (2026-08-16): a non-hmux binding can
    // only come from a persisted pre-migration pane. Render the dead-end
    // notice and keep every legacy spawn/exit affordance unreachable.
    return <RetiredLegacyPane onClose={() => props.api.close()} />;
  }

  return (
    <PaneRehostBoundary paneId={props.api.id}>
      <TerminalView
        sessionId={sessionId}
        kind="pty"
        binding={binding}
        attachRecovery={
          binding?.runtime === "hmux_standalone_v1" &&
          binding.source === "local"
            ? {
                ownerKey: JSON.stringify([terminalRuntimePresentationOwnerKey(binding), effectiveCwd]),
                automatic: true,
                intent: hmuxPaneConversationId(binding)
                  ? "resume"
                  : "start_fresh",
                context: `pane=${props.api.id} session=${sessionId} cwd=${effectiveCwd}`,
                // A dead plain shell recovers as a fresh session in the same
                // cwd. A terminal that was RUNNING a detected provider whose
                // exact conversation identity was observed resumes that exact
                // conversation through the reviewed adapter — never a
                // continue-latest guess, never an invented flag.
                resume: async () => {
                  const provider =
                    useStore.getState().sessionAgent[sessionId] ?? null;
                  const conversationId =
                    hmuxPaneConversationId(binding) ?? undefined;
                  const commandLine =
                    provider &&
                    conversationId &&
                    providerSupportsExplicitResume(provider)
                      ? providerRunCmd(provider, { convId: conversationId })
                      : undefined;
                  const created = await hmux.createStandalone({
                    operationId: `restore-${sessionId}`,
                    cwd: effectiveCwd || (await homeDir()),
                    columns: 120,
                    rows: 30,
                    ...(commandLine ? { commandLine } : {}),
                    terminalDefaultColors: currentTerminalDefaultColors(),
                  });
                  useStore.getState().setHmuxSessionMetadata(created);
                  const latest = paramsRef.current;
                  const next = {
                    ...latest,
                    sessionId: created.sessionId,
                    binding: hmuxStandaloneBinding(
                      created.sessionId,
                      created.workspaceId,
                    ),
                  };
                  paramsRef.current = next;
                  props.api.updateParameters(next);
                  commitWorkspaceLayout?.();
                },
              }
            : undefined
        }
        runtimeWorkingDirectory={cwd}
        paneApi={props.api}
        onRemoteManagedStarted={(marker) =>
          void handleRemoteManagedStarted(marker)
        }
        onProviderConversationIdentity={handleProviderConversationIdentity}
        onWorkingDirectory={handleWorkingDirectory}
        onHmuxSessionExit={handleHmuxSessionExit}
        onSplit={(direction) =>
          openSplitLauncherOn(
            props.containerApi,
            paneSplitTargetForPanel(props.api, props.params),
            { referencePanel: props.api.id, direction },
          )
        }
        {...paneViewCloseMenu({
          panelId: props.api.id,
          desktopId: desktopId ?? undefined,
          title: props.api.title,
          params: props.params,
          close: () => closePanelById(props.api.id, desktopId ?? undefined),
        })}
      />
    </PaneRehostBoundary>
  );
}
