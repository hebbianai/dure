import { t } from "@/lib/i18n";
import {
  executeHmuxSessionConversion,
  inspectHmuxSessionConversion,
  retargetConvertedHmuxPane,
  type HmuxSessionConversionInspection,
  type HmuxSessionConversionPaneReceipt,
  type HmuxSessionConversionTarget,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import type { HmuxSessionConversionReceipt } from "@/lib/ipc";

export interface HmuxSessionConversionWorkflowRequest {
  readonly sourceSessionId: string;
  readonly panelId: string;
  readonly target: HmuxSessionConversionTarget;
  readonly sourceWorkspaceId?: string;
  readonly sourceSessionName?: string;
  readonly requestedAgentName?: string;
}

export interface HmuxSessionConversionConfirmation {
  readonly title: string;
  readonly message: string;
}

export interface PreparedHmuxSessionConversion {
  readonly request: HmuxSessionConversionWorkflowRequest;
  readonly inspection: HmuxSessionConversionInspection;
}

export interface HmuxSessionConversionWorkflowDeps {
  inspect: (
    request: HmuxSessionConversionWorkflowRequest,
  ) => Promise<HmuxSessionConversionInspection>;
  execute: (
    inspection: HmuxSessionConversionInspection,
    confirmed: boolean,
  ) => Promise<HmuxSessionConversionReceipt>;
  confirm: (
    confirmation: HmuxSessionConversionConfirmation,
  ) => Promise<boolean>;
  retarget: (
    inspection: HmuxSessionConversionInspection,
    receipt: HmuxSessionConversionReceipt,
  ) => Promise<HmuxSessionConversionPaneReceipt>;
}

const defaultDeps = {
  inspect: (request: HmuxSessionConversionWorkflowRequest) =>
    inspectHmuxSessionConversion(
      request.sourceSessionId,
      request.panelId,
      request.target,
      request.sourceWorkspaceId,
      request.sourceSessionName,
      request.requestedAgentName,
    ),
  execute: executeHmuxSessionConversion,
  retarget: retargetConvertedHmuxPane,
};

type PrepareOverrides = Partial<
  Pick<HmuxSessionConversionWorkflowDeps, "inspect" | "execute">
>;

type CommitOverrides = Partial<
  Pick<HmuxSessionConversionWorkflowDeps, "execute" | "retarget">
>;

/** Read-only identity/process/cwd inspection plus the Host confirmation fence. */
export async function prepareHmuxSessionConversion(
  request: HmuxSessionConversionWorkflowRequest,
  overrides: PrepareOverrides = {},
): Promise<PreparedHmuxSessionConversion> {
  const inspect = overrides.inspect ?? defaultDeps.inspect;
  const execute = overrides.execute ?? defaultDeps.execute;
  const inspection = await inspect(request);
  const preview = await execute(inspection, false);
  if (
    preview.outcome !== "refused" ||
    preview.reason !== "update_requires_confirmation" ||
    !preview.conversationId
  ) {
    throw new Error(
      preview.reason ?? t("hmux.conversion.preflightFailed"),
    );
  }
  return { request, inspection };
}

/** Execute one already-previewed conversion and CAS-retarget its exact pane. */
export async function commitPreparedHmuxSessionConversion(
  prepared: PreparedHmuxSessionConversion,
  overrides: CommitOverrides = {},
): Promise<HmuxSessionConversionPaneReceipt> {
  const execute = overrides.execute ?? defaultDeps.execute;
  const retarget = overrides.retarget ?? defaultDeps.retarget;
  const receipt = await execute(prepared.inspection, true);
  if (receipt.outcome !== "converted" || !receipt.replacementSession) {
    throw new Error(
      receipt.reason ?? t("hmux.conversion.replacementStartFailed"),
    );
  }
  return retarget(prepared.inspection, receipt);
}

/**
 * Shared read-only preview -> explicit confirm -> journaled conversion -> pane
 * CAS workflow. Callers only supply the platform confirmation surface.
 */
export async function runHmuxSessionConversionWorkflow(
  request: HmuxSessionConversionWorkflowRequest,
  confirm: HmuxSessionConversionWorkflowDeps["confirm"],
  overrides: Partial<
    Omit<HmuxSessionConversionWorkflowDeps, "confirm">
  > = {},
): Promise<HmuxSessionConversionPaneReceipt | undefined> {
  const deps: HmuxSessionConversionWorkflowDeps = {
    ...defaultDeps,
    ...overrides,
    confirm,
  };
  const prepared = await prepareHmuxSessionConversion(request, deps);
  const targetLabel =
    request.target === "managed" ? t("hmux.conversion.target.managed") : t("hmux.conversion.target.standalone");
  const accepted = await deps.confirm({
    title: t("common.hmuxSwitch.title"),
    message: t("hmux.conversion.confirm.message", {
      target: targetLabel,
    }),
  });
  if (!accepted) return undefined;

  return commitPreparedHmuxSessionConversion(prepared, deps);
}
