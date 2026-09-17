import {
  inspectStandaloneHmuxPaneSet,
  prepareStandaloneHmuxPaneSet,
  retargetStandaloneHmuxPaneSet,
  type HmuxStandalonePaneInspection,
  type RetargetHmuxStandalonePaneReceipt,
  type StandaloneHmuxPaneSetInspection,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSet";
import {
  hmux,
  type HmuxRecoveryExecutionReceipt,
  type HmuxRecoveryPlanReceipt,
} from "@/lib/ipc";
import { isWritableHealthyStandaloneReplacement } from "@/lib/hmux/standalone/hmuxRecoveryReplacement";
import { useStore } from "@/store";

export interface StandaloneHmuxRecoveryInspection {
  source: HmuxStandalonePaneInspection;
  paneSet: StandaloneHmuxPaneSetInspection;
  plan: HmuxRecoveryPlanReceipt;
}

export interface StandaloneHmuxRecoveryResult {
  receipt: HmuxRecoveryExecutionReceipt;
  pane: RetargetHmuxStandalonePaneReceipt;
  panes: readonly RetargetHmuxStandalonePaneReceipt[];
}

/** Inspect an exact pane without mutating it. The backend owns the resurrection
 * recipe and destructive-boundary validation. */
export async function inspectStandaloneHmuxRecovery(
  panelId: string,
): Promise<StandaloneHmuxRecoveryInspection | null> {
  const paneSet = await inspectStandaloneHmuxPaneSet(panelId);
  const { source } = paneSet;

  const plan = await hmux.planRecovery({
    sessionId: source.sessionId,
    workspaceId: source.workspaceId,
    adapterSupportsExplicitResume: false,
    confirmed: false,
  });
  const confirmationPreview =
    !plan.allowed &&
    plan.action === "none" &&
    plan.reason === "update_requires_confirmation" &&
    plan.requiresConfirmation;
  if (
    plan.sessionId !== source.sessionId ||
    (!confirmationPreview &&
      (!plan.allowed ||
        plan.action !== "restore_plain_shell_with_current_build"))
  ) {
    return null;
  }
  return {
    source,
    paneSet,
    plan: confirmationPreview
      ? {
          ...plan,
          action: "restore_plain_shell_with_current_build",
        }
      : plan,
  };
}

function sourceNeedsTermination(
  inspection: StandaloneHmuxPaneSetInspection,
): boolean {
  const summary = inspection.sourceSummary;
  if (
    summary?.sessionId !== inspection.source.sessionId ||
    summary.workspaceId !== inspection.source.workspaceId
  ) {
    return true;
  }
  const rebootStale =
    summary.manifestLifecycle === "ready" &&
    summary.lifecycle === "unavailable" &&
    summary.health === "stale_transport";
  const exited =
    summary.manifestLifecycle === "exited" &&
    summary.lifecycle === "exited" &&
    summary.health === "exited";
  return !rebootStale && !exited;
}

/** Re-fence the pane set, stop a live exact binding, and let the backend replay
 * its canonical recipe into one fresh Host. A reboot-stale or exited source is
 * instead proved absent by the recovery transaction's process-generation
 * boundary, so recovery never dials a socket already known to be dead. */
export async function executeStandaloneHmuxRecovery(
  inspection: StandaloneHmuxRecoveryInspection,
): Promise<StandaloneHmuxRecoveryResult> {
  const paneSet = await prepareStandaloneHmuxPaneSet(inspection.paneSet);
  const { source } = paneSet;
  if (
    source.sessionId !== inspection.source.sessionId ||
    source.workspaceId !== inspection.source.workspaceId
  ) {
    throw new Error(
      `terminal pane ${inspection.source.panelId} changed before standalone Hmux recovery`,
    );
  }

  if (sourceNeedsTermination(paneSet)) {
    await hmux.terminateStandalone(source.sessionId, source.workspaceId);
  }
  const operationId = `standalone_rehost_${source.sessionId}`;
  const receipt = await hmux.executeRecovery({
    recoveryId: operationId,
    kind: "plain_shell",
    sessionId: source.sessionId,
    workspaceId: source.workspaceId,
    adapterSupportsExplicitResume: false,
    confirmed: true,
  });
  const replacement = receipt.replacementSession;
  if (
    receipt.sourceSessionId !== source.sessionId ||
    receipt.action !== "restore_plain_shell_with_current_build" ||
    receipt.outcome !== "restored" ||
    !replacement ||
    replacement.workspaceId !== source.workspaceId ||
    !isWritableHealthyStandaloneReplacement(replacement)
  ) {
    throw new Error(
      receipt.reason ?? "standalone Hmux recovery returned an invalid receipt",
    );
  }

  const retargeted = await retargetStandaloneHmuxPaneSet(paneSet, {
    kind: "recovery",
    operationId,
    replacement,
  });
  useStore.getState().setHmuxSessionMetadata(replacement);
  return {
    receipt,
    pane: retargeted.primary,
    panes: retargeted.panes,
  };
}
