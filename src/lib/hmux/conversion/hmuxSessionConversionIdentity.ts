import { fnv1a32Hex } from "@/lib/platform/hash";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { isHmuxProviderSessionSourceBinding } from "@/lib/hmux/identity/hmuxProviderSessionSource";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import type { SerializedPanelRef } from "@/lib/workspace/layout/layoutLifecycle";
import {
  hmuxStandaloneBinding,
  type HmuxManagedPaneBindingV1,
  type HmuxStandalonePaneBindingV1,
} from "@/lib/terminal/terminalBinding";

export type HmuxSessionConversionTarget = "managed" | "standalone";
export type ConvertibleHmuxBinding =
  | HmuxManagedPaneBindingV1
  | HmuxStandalonePaneBindingV1;

export function hmuxSessionConversionId(
  panelId: string,
  sourceBinding: ConvertibleHmuxBinding,
  target: HmuxSessionConversionTarget,
): string {
  const seed = [
    panelId,
    sourceBinding.sessionId,
    sourceBinding.workspaceId,
    target,
  ].join("\0");
  return `convert_${fnv1a32Hex(seed)}${fnv1a32Hex(`hmux-convert\0${seed}`)}`;
}

export function sameHmuxConversionBinding(
  left: ConvertibleHmuxBinding | undefined,
  right: ConvertibleHmuxBinding,
): boolean {
  if (
    left?.runtime === right.runtime &&
    left.source === right.source &&
    left.hostId === right.hostId &&
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId
  ) {
    if (
      left.runtime === "hmux_managed_v1" &&
      right.runtime === "hmux_managed_v1"
    ) {
      return (
        left.createIdempotencyKey === right.createIdempotencyKey &&
        left.credentialId === right.credentialId &&
        left.credentialGeneration === right.credentialGeneration &&
        sameHmuxManagedGeneration(left.stopFence, right.stopFence)
      );
    }
    return true;
  }
  return false;
}

function isManagedConversionTargetBinding(
  candidate: ConvertibleHmuxBinding,
  source: ConvertibleHmuxBinding,
  panelId: string,
): boolean {
  if (
    candidate.runtime !== "hmux_managed_v1" ||
    candidate.workspaceId !== source.workspaceId
  ) {
    return false;
  }
  const conversionId = hmuxSessionConversionId(panelId, source, "managed");
  const key = candidate.createIdempotencyKey;
  if (key === conversionId) return true;
  if (!key?.startsWith(`${conversionId}_`)) return false;
  return /^[1-9][0-9]*$/u.test(key.slice(conversionId.length + 1));
}

export function selectHmuxConversionSourceBinding(
  bindings: readonly (ConvertibleHmuxBinding | undefined)[],
  target: HmuxSessionConversionTarget,
  expectedSessionId: string,
  expectedWorkspaceId?: string,
  sourcePane?: Pick<SerializedPanelRef, "id" | "component">,
): ConvertibleHmuxBinding {
  const present = bindings.filter(
    (binding): binding is ConvertibleHmuxBinding => binding !== undefined,
  );
  const sources = present
    .filter(
      (binding): binding is ConvertibleHmuxBinding =>
        binding.sessionId === expectedSessionId &&
        (expectedWorkspaceId === undefined ||
          binding.workspaceId === expectedWorkspaceId) &&
        (target === "managed"
          ? isHmuxProviderSessionSourceBinding(binding, sourcePane?.component)
          : binding.runtime === "hmux_managed_v1"),
    )
    .filter(
      (binding, index, all) =>
        all.findIndex((candidate) =>
          sameHmuxConversionBinding(candidate, binding),
        ) === index,
    );
  if (sources.length !== 1) {
    throw new PaneCommandError(
      sources.length === 0 ? "invalid_request" : "pane_changed",
      sources.length === 0
        ? `pane consumers are already ${target} or no longer retain the source binding`
        : "pane consumers disagree about the Hmux conversion source",
    );
  }
  const source = sources[0];
  const conflictingSource = present.some((candidate) => {
    if (sameHmuxConversionBinding(candidate, source)) return false;
    const candidateCanBeSource =
      target === "managed"
        ? isHmuxProviderSessionSourceBinding(candidate, sourcePane?.component)
        : candidate.runtime === "hmux_managed_v1";
    if (!candidateCanBeSource) return false;
    // A managed-shell conversion has a managed replacement as well. Only the
    // replacement fenced by this conversion is a target consumer rather than
    // a disagreeing second source.
    return !(
      target === "managed" &&
      source.runtime === "hmux_managed_v1" &&
      isManagedConversionTargetBinding(candidate, source, sourcePane?.id ?? "")
    );
  });
  if (conflictingSource) {
    throw new PaneCommandError(
      "pane_changed",
      "pane consumers disagree about the Hmux conversion source",
    );
  }
  return source;
}

export function recoverConvertedStandaloneSourceBinding(
  bindings: readonly (ConvertibleHmuxBinding | undefined)[],
  expectedSessionId: string,
  expectedWorkspaceId?: string,
): HmuxStandalonePaneBindingV1 | undefined {
  const present = bindings.filter(
    (binding): binding is ConvertibleHmuxBinding => binding !== undefined,
  );
  if (
    present.length === 0 ||
    present.some((binding) => binding.runtime !== "hmux_managed_v1")
  ) {
    return undefined;
  }
  const first = present[0];
  if (
    present.some((binding) => !sameHmuxConversionBinding(binding, first)) ||
    first.sessionId === expectedSessionId
  ) {
    return undefined;
  }
  return hmuxStandaloneBinding(
    expectedSessionId,
    expectedWorkspaceId ?? first.workspaceId,
  );
}
