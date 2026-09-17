import type { UnlistenFn } from "@tauri-apps/api/event";
import { addAgent } from "@/lib/agents/agentRegistration";
// Defer startup subscriptions until Tauri injects its IPC bridge.
import { listenWhenReady as listen } from "@/lib/platform/tauriBridge";
import { t } from "@/lib/i18n";
import { terminalEnvironmentParam } from "@/lib/terminal/terminalEnvironmentParam";
import { durableAppStorage, useStore } from "@/store";
import { dispatchCliSettingsRequest } from "@/lib/cli/cliSettingsCommands";
import {
  createTerminalPaneRelativeToSession,
  openHmuxTerminalPanel,
  openAgentPanel,
  type PaneSplitDirection,
} from "@/lib/workspace/dock";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import { closePanelById } from "@/lib/workspace/pane/paneCloseCoordinator";
import { hmux, type ProviderPreflight } from "@/lib/ipc";
import { inspectHmuxSessionExact } from "@/lib/hmux/identity/exactHmuxSessionInspection";
import { runSpawnSagaFromCli } from "@/lib/sessions/launch/spawnSaga";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { hmuxLocalBinding } from "@/lib/terminal/terminalBinding";
import type { Agent, Provider, TerminalEnvironment } from "@/types";
import { ProviderPreflightError } from "@/lib/agents/providerPreflight";
import {
  handleExactHmuxInput,
} from "@/lib/cli/cliHmuxInput";
import { beginManagedRuntimeEnsure } from "@/lib/sessions/launch/managedRuntimeEnsure";
import { sendHmuxInitialAgentPrompt } from "@/lib/sessions/managed/managedAgentInput";
import {
  handleCliAgentReuse,
  reuseAgentByName,
} from "@/lib/cli/cliAgentReuse";
import {
  executeHmuxSessionConversion,
  hmuxSessionConversionSyncPayload,
  inspectHmuxSessionConversion,
  retargetConvertedHmuxPane,
  type HmuxSessionConversionTarget,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import { handleActivity } from "@/lib/agents/hookActivity";
import { handleHookState } from "@/lib/agents/hookReportHandler";
import { handleStandaloneHmuxUpgrade } from "@/lib/hmux/standalone/standaloneHmuxUpgradeCli";
import { handleCliDiagnostics } from "@/lib/cli/cliDiagnostics";
import { handleCliPerformanceReport } from "@/lib/cli/cliPerformanceReport";
import {
  handleRemoteHmuxShellCliRequest,
  type CliRequest,
} from "@/lib/hmux/remote/remoteHmuxShellCliRequest";
import { claimCliRequest, completeCliRequest } from "@/lib/cli/cliRequestBroker";
import { requestRemoteShellHostRegistration } from "@/lib/hmux/remote/remoteHmuxShellDecision";
import {
  handleDesktopActivationCliRequest,
  handleSpaceActivationCliRequest,
} from "@/lib/workspace/desktop/desktopActivationCli";
import { dispatchWorkspaceImportCliRequest } from "@/lib/workspace/workspaceImportCli";
import { dispatchCliDesktopPaneRequest } from "@/lib/cli/cliDesktopPaneLifecycle";
import { dispatchCliPaneActionRequest } from "@/lib/cli/cliPaneActions";
import { handleCliAgentInput } from "@/lib/cli/cliAgentInput";
import { installMountedPaneWindowReporter } from "@/lib/workspace/window/mountedPaneWindow";
import {
  cliSpaceIdentityErrorCode,
  resolveCliSpaceId,
} from "@/lib/cli/cliSpaceIdentity";
import { handleCliHmuxStop } from "@/lib/cli/cliHmuxStop";
import { handleCliHmuxRehost } from "@/lib/cli/cliHmuxRehost";
import { handleCliHmuxAttach } from "@/lib/cli/cliHmuxAttach";
import { handleCliHmuxCreate } from "@/lib/cli/cliHmuxCreate";
import { handleCliProjectRegistration } from "@/lib/cli/cliProjectRegistration";
import { handleCliHostRegistration } from "@/lib/cli/cliHostRegistration";
import { installCliSpaceOwnerReporter, routeCliRequestToSpaceOwner } from "@/lib/cli/cliSpaceOwnerRouting";
import { startCliServerObservers } from "@/lib/cli/cliServerObservers";
import { handleCliManagedRunPresentation } from "@/lib/cli/cliManagedRunPresentation";
import { handleCliStructuredRunPresentation } from "@/lib/cli/cliStructuredRunPresentation";
import { dispatchCliExternalWorkspaceRequest } from "@/lib/cli/cliExternalWorkspace";
import { openExternalWorkspaceForPane } from "@/lib/workspace/externalWorkspace";
import { dispatchCliWorktreePresentation } from "@/lib/cli/cliWorktreePresentation";
import { dispatchCliUnopenedAgentVisibility } from "@/lib/cli/cliUnopenedAgentVisibility";

const cliDesktopPaneDependencies = {
  routeToSpaceOwner: routeCliRequestToSpaceOwner,
  claim: claimCliRequest,
  complete: completeCliRequest,
  closePanel: closePanelById,
  addSpace: (name?: string) => useStore.getState().addSpace({ name }),
  waitForSpace: waitForDesktopDockview,
  removeSpace: (spaceId: string) => useStore.getState().removeSpace(spaceId),
  spaceName: (spaceId: string) =>
    useStore.getState().spaces.find((space) => space.id === spaceId)
      ?.name,
};

const cliExternalWorkspaceDependencies = {
  claim: claimCliRequest,
  complete: completeCliRequest,
  open: openExternalWorkspaceForPane,
};

const cliPaneActionDependencies = {
  complete: completeCliRequest,
  isFallbackWindow: () => getCurrentWebviewWindow().label === "main",
  delay: (milliseconds: number) =>
    new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds)),
};
/** Native local-server requests converge on the same GUI lifecycle paths. */
export async function startCliServer(
  claimPaneRequest: typeof claimCliRequest = claimCliRequest,
): Promise<UnlistenFn> {
  const paneActions = { ...cliPaneActionDependencies, claim: claimPaneRequest };
  let stopObservers: UnlistenFn | undefined;
  let stopSpaceOwnerReporter: UnlistenFn | undefined;
  let stopPaneOwnerReporter: UnlistenFn | undefined;
  let unlistenRequests: UnlistenFn | undefined;
  try {
    stopSpaceOwnerReporter = await installCliSpaceOwnerReporter();
    stopPaneOwnerReporter = await installMountedPaneWindowReporter();
    unlistenRequests = await listen<CliRequest>("cli:request", async (e) => {
      const { reqId, action, params } = e.payload;
      if (await dispatchCliUnopenedAgentVisibility(e.payload, {
        claim: claimCliRequest,
        complete: completeCliRequest,
        isMainWindow: () => getCurrentWebviewWindow().label === "main",
      })) return;
      if (await dispatchCliWorktreePresentation(e.payload, {
        claim: claimCliRequest,
        complete: completeCliRequest,
        isMainWindow: () => getCurrentWebviewWindow().label === "main",
        flush: () => durableAppStorage.flush(),
      })) return;
      if (await dispatchCliSettingsRequest(e.payload, {
        claim: claimCliRequest,
        complete: completeCliRequest,
        getPrefs: () => useStore.getState().uiPrefs,
        setPrefs: (patch) => useStore.getState().setUiPrefs(patch),
      })) return;
      if (
        await dispatchCliExternalWorkspaceRequest(
          e.payload,
          cliExternalWorkspaceDependencies,
        )
      ) {
        return;
      }
      if (
        await dispatchCliDesktopPaneRequest(
          e.payload,
          cliDesktopPaneDependencies,
        )
      ) {
        return;
      }
      if (await dispatchCliPaneActionRequest(e.payload, paneActions)) {
        return;
      }
      if (action === "ssh.host.add") {
        const result = await handleCliHostRegistration(params, reqId);
        if (result) await completeCliRequest(reqId, result, action);
      } else if (action === "project.add") {
        const result = await handleCliProjectRegistration(params, reqId);
        if (result) await completeCliRequest(reqId, result, action);
      } else if (action === "spawn") {
        const result = await handleSpawn(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "spawn");
      } else if (action === "agent.input") {
        const result = await handleCliAgentInput(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "agent.input");
      } else if (action === "agent.reuse") {
        const result = await handleCliAgentReuse(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "agent.reuse");
      } else if (action === "agent.present") {
        const result = await handleCliStructuredRunPresentation(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "agent.present");
      } else if (action === "browser.present") {
        const { handleCliBrowserPresentation } = await import("./cliBrowserPresentation");
        const result = await handleCliBrowserPresentation(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "browser.present");
      } else if (action === "comment") {
        // Checkpoint feature retired 2026-08-27 (user: the line was never
        // read; agent self-narration duplicates the attention authority).
        // Accept-and-drop keeps older installed CLIs harmless; remove the
        // action after 2026-09.
      } else if (action === "activity") handleActivity(params);
      else if (action === "hooks" || action === "hooks.claude")
        handleHookState(params);
      else if (action === "pane.create") {
        const result = await handlePaneCreate(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "pane.create");
      } else if (action === "space.activate")
        await handleSpaceActivationCliRequest(params, reqId);
      else if (action === "desktop.activate")
        await handleDesktopActivationCliRequest(params, reqId);
      else if (action === "hmux.observe") {
        const result = await handleHmuxObserve(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.observe");
      } else if (action === "hmux.attach") {
        const result =
          params.runtime === "hmux_managed_v1"
            ? await handleCliManagedRunPresentation(params, reqId)
            : await handleCliHmuxAttach(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.attach");
      } else if (action === "hmux.upgrade") {
        const result = await handleStandaloneHmuxUpgrade(params, () =>
          claimCliRequest(reqId),
        );
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.upgrade");
      } else if (action === "hmux.rehost") {
        const result = await handleCliHmuxRehost(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.rehost");
      } else if (action === "hmux.convert") {
        const result = await handleHmuxConvert(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.convert");
      } else if (action === "hmux.stop") {
        const result = await handleCliHmuxStop(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.stop");
      } else if (action === "hmux.input") {
        const result = await handleExactHmuxInput(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.input");
      } else if (action === "hmux.create") {
        const result = await handleCliHmuxCreate(params, reqId);
        if (!result) return;
        await completeCliRequest(reqId, result, "hmux.create");
      } else if (action === "hmux.remote-shell") {
        await handleRemoteHmuxShellCliRequest(
          reqId,
          params,
          claimCliRequest,
          completeCliRequest,
          (candidate) => requestRemoteShellHostRegistration(reqId, candidate),
        );
      } else if (action === "spawn.v2") {
        // 서버가 202 {receiptId}를 이미 반환했다 — 진행은 journal이 담당한다.
        // 다중 윈도우/StrictMode 중복 실행은 label 가드 + saga 내부 inFlight로 차단.
        if (getCurrentWebviewWindow().label === "main") {
          await runSpawnSagaFromCli(params);
        }
      } else if (action === "perf.report") {
        const result = await handleCliPerformanceReport(
          reqId,
          params,
          claimCliRequest,
        );
        if (!result) return;
        await completeCliRequest(reqId, result, "perf.report");
      } else if (action === "app.diagnostics") {
        const result = await handleCliDiagnostics(reqId, claimCliRequest);
        if (!result) return;
        await completeCliRequest(reqId, result, "app.diagnostics");
			} else if (await dispatchWorkspaceImportCliRequest(action, params, reqId)) return;
    });
    stopObservers = await startCliServerObservers();
  } catch (error) {
    stopObservers?.();
    stopPaneOwnerReporter?.();
    stopSpaceOwnerReporter?.();
    unlistenRequests?.();
    throw error;
  }
  return () => {
    stopObservers?.();
    stopPaneOwnerReporter?.();
    stopSpaceOwnerReporter?.();
    unlistenRequests?.();
  };
}

async function handleHmuxConvert(
  params: Record<string, unknown>,
  reqId: string,
) {
  let claimed = false;
  const claim = async () => {
    if (claimed) return true;
    claimed = await claimCliRequest(reqId);
    return claimed;
  };
  try {
    const name = String(params.name ?? "").trim();
    const targetPanelId = String(params.targetPanelId ?? "").trim();
    const target = String(
      params.to ?? "",
    ).trim() as HmuxSessionConversionTarget;
    if (
      !name ||
      !targetPanelId ||
      (target !== "managed" && target !== "standalone")
    ) {
      throw new PaneCommandError(
        "invalid_request",
        "name, targetPanelId, and to (managed|standalone) are required",
      );
    }
    const sessions = await hmux.listSessions();
    const source =
      sessions.find((candidate) => candidate.sessionId === name) ??
      (await hmux.resolveNamedSession(name).catch((error) => {
        if (name.startsWith("standalone_") || name.startsWith("convert_")) {
          return undefined;
        }
        throw error;
      }));
    const inspection = await inspectHmuxSessionConversion(
      source?.sessionId ?? name,
      targetPanelId,
      target,
      source?.workspaceId,
      source?.sessionName,
      String(params.agentName ?? "").trim() || undefined,
    );
    if (!(await claim())) return null;
    const conversion = await executeHmuxSessionConversion(
      inspection,
      params.confirmRestart === true,
    );
    if (
      conversion.outcome === "refused" &&
      conversion.requiresConfirmation &&
      conversion.reason === "update_requires_confirmation"
    ) {
      return {
        ok: true,
        preview: true,
        conversion,
        source: {
          desktopId: inspection.desktopId,
          panelId: inspection.panelId,
          sessionId: inspection.sourceBinding.sessionId,
          workspaceId: inspection.sourceBinding.workspaceId,
          runtime: inspection.sourceBinding.runtime,
          cwd: inspection.cwd,
        },
      };
    }
    if (conversion.outcome !== "converted" || !conversion.replacementSession) {
      return {
        ok: false,
        error: {
          code: conversion.reason ?? conversion.outcome,
          message:
            conversion.outcome === "refused" && conversion.requiresConfirmation
              ? `converting ${name} restarts its exact live provider; pass --confirm-restart`
              : `Hmux conversion ${conversion.outcome}: ${
                  conversion.reason ?? "replacement unavailable"
                }`,
        },
        conversion,
      };
    }
    try {
      const pane = await retargetConvertedHmuxPane(inspection, conversion);
      return { ok: true, conversion, pane };
    } catch (error) {
      const payload = hmuxSessionConversionSyncPayload(inspection, conversion);
      return {
        ok: false,
        error: {
          code:
            error instanceof PaneCommandError
              ? error.code
              : "pane_handoff_failed",
          message: `${
            error instanceof Error ? error.message : String(error)
          }; replacement ${payload.binding.sessionId} remains attachable; retry with --name ${inspection.sourceBinding.sessionId} to complete the pane handoff`,
        },
        conversion,
      };
    }
  } catch (error) {
    if (!(await claim())) return null;
    return {
      ok: false,
      error: {
        code:
          error instanceof PaneCommandError
            ? error.code
            : "hmux_conversion_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleHmuxObserve(
  params: Record<string, unknown>,
  reqId: string,
) {
  let claimed = false;
  const claim = async () => {
    if (claimed) return true;
    claimed = await claimCliRequest(reqId);
    return claimed;
  };
  try {
    const requestedSpaceId = resolveCliSpaceId(params);
    const sessionId = String(params.sessionId ?? "").trim();
    const workspaceId = String(params.workspaceId ?? "").trim();
    if (!sessionId || !workspaceId) {
      throw new PaneCommandError(
        "invalid_request",
        "sessionId and workspaceId are required",
      );
    }
    const discovered = await inspectHmuxSessionExact({ sessionId, workspaceId });
    if (!discovered) {
      throw new PaneCommandError(
        "pane_not_found",
        `Hmux session ${sessionId} was not found in workspace ${workspaceId}`,
      );
    }
    if (!(await claim())) return null;
    const desktopId =
      requestedSpaceId ?? useStore.getState().activeSpaceId;
    const opened = openHmuxTerminalPanel(
      desktopId,
      sessionId,
      workspaceId,
      params.cwd ? String(params.cwd) : undefined,
    );
    if (!opened) {
      throw new PaneCommandError(
        "pane_not_found",
        `desktop ${desktopId} is not mounted`,
      );
    }
    return {
      ok: true,
      pane: {
        desktopId,
        panelId: opened,
        sessionId,
        workspaceId,
        mode: "observer",
        binding: hmuxLocalBinding(sessionId, workspaceId),
      },
    };
  } catch (error) {
    if (!(await claim())) return null;
    const code =
      error instanceof PaneCommandError
        ? error.code
        : (cliSpaceIdentityErrorCode(error) ?? "hmux_observe_failed");
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handlePaneCreate(
  params: Record<string, unknown>,
  reqId: string,
) {
  if (params.runtime === "hmux_standalone_v1") {
    return handleCliHmuxAttach(params, reqId);
  }
  let claimed = false;
  const claim = async () => {
    if (claimed) return true;
    claimed = await claimCliRequest(reqId);
    return claimed;
  };
  try {
    const direction = String(params.direction ?? "below");
    if (direction !== "right" && direction !== "below") {
      throw new PaneCommandError(
        "invalid_request",
        "direction must be right or below",
      );
    }
    const receipt = await createTerminalPaneRelativeToSession(
      {
        referenceSessionId: String(params.referenceSessionId ?? ""),
        referencePanelId: params.referencePanelId
          ? String(params.referencePanelId)
          : undefined,
        direction: direction as PaneSplitDirection,
        cwd: params.cwd ? String(params.cwd) : undefined,
      },
      claim,
    );
    return { ok: true, pane: receipt };
  } catch (error) {
    if (error instanceof PaneCommandError && error.code === "request_expired")
      return null;
    if (!(await claim())) return null;
    const code =
      error instanceof PaneCommandError ? error.code : "pane_create_failed";
    return {
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleSpawn(params: Record<string, unknown>, reqId: string) {
  const claimed = await claimCliRequest(reqId);
  if (!claimed) return null;
  try {
    const provider = String(params.provider ?? "claude");
    if (provider !== "claude" && provider !== "codex" && provider !== "kimi") {
      throw new Error(t("cli.server.unsupportedProvider", { provider }));
    }
    const spawned = await spawnAgentInternal({
      project: String(params.project ?? ""),
      provider,
      prompt: params.prompt ? String(params.prompt) : "",
      name: params.name ? String(params.name) : "",
      useWorktree: params.useWorktree !== false,
      reuse: params.reuse === true,
      terminalEnv: terminalEnvironmentParam(params.terminalEnv),
    });
    return {
      ok: true,
      preflight: spawned.preflight ?? null,
      agent: {
        id: spawned.agent.id,
        name: spawned.agent.name,
        projectId: spawned.agent.projectId,
        provider: spawned.agent.provider,
        sessionId: spawned.agent.sessionId,
        worktreePath: spawned.agent.worktreePath,
        reused: spawned.reused,
      },
    };
  } catch (error) {
    const preflight =
      error instanceof ProviderPreflightError ? error.preflight : undefined;
    return {
      ok: false,
      preflight: preflight ?? null,
      error: {
        code: preflight ? "provider_preflight_failed" : "spawn_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Creates or reuses an agent and starts it with the requested initial prompt. */
export async function spawnAgent(opts: {
  project: string;
  provider: Provider;
  prompt?: string;
  name?: string;
  useWorktree?: boolean;
  reuse?: boolean;
  terminalEnv?: TerminalEnvironment;
}): Promise<Agent> {
  return (await spawnAgentInternal(opts)).agent;
}

async function spawnAgentInternal(opts: {
  project: string;
  provider: Provider;
  prompt?: string;
  name?: string;
  useWorktree?: boolean;
  reuse?: boolean;
  terminalEnv?: TerminalEnvironment;
}): Promise<{
  agent: Agent;
  preflight?: ProviderPreflight;
  reused: boolean;
}> {
  const st = useStore.getState();
  const project =
    st.projects.find((p) => p.name === opts.project) ??
    st.projects.find((p) => p.id === opts.project);
  if (!project)
    throw new Error(t("common.projectMissing", { project: opts.project }));

  let name = opts.name || "";
  if (!name) {
    let n = 1;
    const taken = new Set(
      st.agents.filter((a) => a.projectId === project.id).map((a) => a.name),
    );
    while (taken.has(`${opts.provider}-${n}`)) n++;
    name = `${opts.provider}-${n}`;
  }

  // Reuse one exact same-name Agent. If its managed source retired, reconcile
  // the durable Hmux successor into the existing pane before sending input.
  if (opts.reuse) {
    const reused = await reuseAgentByName({
      projectId: project.id,
      projectName: project.name,
      name,
      provider: opts.provider,
      prompt: opts.prompt ?? "",
    });
    if (reused) return { agent: reused, reused: true };
  }

  const agent = await addAgent({
    projectId: project.id,
    name,
    provider: opts.provider,
    useWorktree: opts.useWorktree !== false,
    terminalEnv: opts.terminalEnv,
  });
  let launched = agent;
  let initialPromptAccepted = false;
  // addAgent's single binding authority is hmux_managed_v1; an unbound record
  // (project without a resolvable host) fails visibly at spawn instead, so the
  // retired legacy PTY/SSH prompt delivery has no reachable target here.
  if (agent.runtimeBinding?.runtime === "hmux_managed_v1") {
    const runtime = beginManagedRuntimeEnsure(agent, {
      columns: 120,
      rows: 30,
      initialPrompt: opts.prompt,
    });
    if (!runtime) throw new Error("managed runtime binding was lost before create");
    const receipt = await runtime.receipt;
    launched = receipt.agent;
    initialPromptAccepted = receipt.initialPromptAccepted === true;
  }
  const desktopId = useStore.getState().activeSpaceId;
  await waitForDesktopDockview(desktopId);
  if (!openAgentPanel(desktopId, launched)) {
    throw new PaneCommandError(
      "pane_not_found",
      `desktop ${desktopId} is not mounted`,
    );
  }
  if (opts.prompt && !initialPromptAccepted) {
    await sendHmuxInitialAgentPrompt(launched, opts.prompt);
  }
  return { agent: launched, reused: false };
}
