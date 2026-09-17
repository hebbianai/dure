import { tryUpgradeManagedHmuxShell } from "@/lib/hmux/managed/managedHmuxShellUpgrade";
import { hmux } from "@/lib/ipc";
import { hmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import {
  inspectStandaloneHmuxPaneSet,
  prepareStandaloneHmuxPaneSet,
  retargetStandaloneHmuxPaneSet,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSet";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";

export async function handleStandaloneHmuxUpgrade(
  params: Record<string, unknown>,
  claimRequest: () => Promise<boolean>,
) {
  let claimed = false;
  const claim = async () => {
    if (claimed) return true;
    claimed = await claimRequest();
    return claimed;
  };
  try {
    const managedShell = await tryUpgradeManagedHmuxShell(params, claim);
    if (managedShell !== undefined) return managedShell;
    const name = String(params.name ?? "").trim();
    const targetPanelId = String(params.targetPanelId ?? "").trim();
    if (!name || !targetPanelId) {
      throw new PaneCommandError(
        "invalid_request",
        "name and targetPanelId are required",
      );
    }
    const inspected = await inspectStandaloneHmuxPaneSet(targetPanelId);
    if (!(await claim())) return null;
    const paneSet = await prepareStandaloneHmuxPaneSet(inspected);
    const operationId = `upgrade_${paneSet.source.sessionId}`;
    const upgrade = await hmux.upgradeStandalone({
      upgradeId: operationId,
      sessionId: paneSet.source.sessionId,
      workspaceId: paneSet.source.workspaceId,
      sessionName: name,
      confirmed: params.confirmRestart === true,
    });
    if (
      upgrade.sourceSessionId !== paneSet.source.sessionId ||
      upgrade.sourceWorkspaceId !== paneSet.source.workspaceId
    ) {
      throw new Error("Hmux upgrade returned a mismatched source receipt");
    }
    if (
      upgrade.outcome === "refused" ||
      upgrade.outcome === "replacement_failed" ||
      !upgrade.replacementSession
    ) {
      return {
        ok: false,
        error: {
          code: upgrade.reason ?? upgrade.outcome,
          message:
            upgrade.outcome === "refused" && upgrade.requiresConfirmation
              ? `upgrading ${name} restarts its live provider; pass --confirm-restart`
              : `Hmux upgrade ${upgrade.outcome}: ${upgrade.reason ?? "replacement unavailable"}`,
        },
        upgrade,
      };
    }

    if (
      upgrade.outcome === "already_current" &&
      upgrade.replacementSession.sessionId === paneSet.source.sessionId &&
      upgrade.replacementSession.workspaceId === paneSet.source.workspaceId
    ) {
      const binding = hmuxStandaloneBinding(
        paneSet.source.sessionId,
        paneSet.source.workspaceId,
      );
      const panes = paneSet.consumers.map((consumer) => ({
        desktopId: consumer.desktopId,
        panelId: consumer.panelId,
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        binding,
        ...(consumer.cwd ? { cwd: consumer.cwd } : {}),
      }));
      const primary = panes.find(
        (pane) =>
          pane.desktopId === paneSet.source.desktopId &&
          pane.panelId === paneSet.source.panelId,
      );
      if (!primary) {
        throw new PaneCommandError(
          "pane_changed",
          "primary standalone Hmux pane disappeared after upgrade inspection",
        );
      }
      return {
        ok: true,
        upgrade,
        pane: {
          ...primary,
          runtime: "hmux_standalone_v1",
          source: "local",
          hostId: "local",
          mode: "controller",
        },
        panes,
        pendingPanelIds: [],
      };
    }

    try {
      const retargeted = await retargetStandaloneHmuxPaneSet(paneSet, {
        kind: "upgrade",
        operationId,
        replacement: upgrade.replacementSession,
      });
      return {
        ok: true,
        upgrade,
        pane: {
          ...retargeted.primary,
          runtime: "hmux_standalone_v1",
          source: "local",
          hostId: "local",
          mode: "controller",
        },
        panes: retargeted.panes,
        pendingPanelIds: retargeted.pendingPanelIds,
      };
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof PaneCommandError
              ? error.code
              : "pane_handoff_failed",
          message: `${error instanceof Error ? error.message : String(error)}; replacement ${name} remains attachable and the same request converges from its durable receipt`,
        },
        upgrade,
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
            : "hmux_upgrade_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
