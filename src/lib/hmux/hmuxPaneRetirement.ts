import { resolveRemoteHmuxStandaloneController } from "@/lib/hmux/remote/remoteHmuxControllerResolution";
import {
  type HmuxPaneDepartureReceipt,
  hmux,
  remoteHmuxDepartGracefully,
} from "@/lib/ipc";
import {
  isRemoteHmuxStandalonePaneBinding,
  type RemoteHmuxStandalonePaneBindingV1,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";
import type { SshHostConfig } from "@/types";

export interface HmuxPaneRetirementPlan {
  ownerId: string;
  sessionId: string;
  workspaceId: string;
}

export interface RemoteHmuxPaneRetirementPlan {
  ownerId: string;
  binding: RemoteHmuxStandalonePaneBindingV1;
}

/** Must stay identical to TerminalView's native attachment ownership key. */
export function hmuxPaneOwnerId(
  windowLabel: string,
  desktopId: string,
  panelId: string,
): string {
  return `window:${windowLabel}:desktop:${desktopId}:pane:${panelId}`;
}

/** A local view close can exercise lifetime policy only through its local Host adapter. */
export function planExplicitHmuxPaneDeparture(input: {
  windowLabel: string;
  desktopId: string;
  panelId: string;
  binding?: TerminalPaneBindingV1;
}): HmuxPaneRetirementPlan | null {
  if (
    input.binding?.runtime !== "hmux_standalone_v1" ||
    input.binding.source !== "local"
  ) {
    return null;
  }
  return {
    ownerId: hmuxPaneOwnerId(input.windowLabel, input.desktopId, input.panelId),
    sessionId: input.binding.sessionId,
    workspaceId: input.binding.workspaceId,
  };
}

export function planExplicitRemoteHmuxPaneDeparture(input: {
  windowLabel: string;
  desktopId: string;
  panelId: string;
  binding?: TerminalPaneBindingV1;
}): RemoteHmuxPaneRetirementPlan | null {
  if (!isRemoteHmuxStandalonePaneBinding(input.binding)) return null;
  return {
    ownerId: hmuxPaneOwnerId(input.windowLabel, input.desktopId, input.panelId),
    binding: input.binding,
  };
}

/**
 * Best-effort product adapter for one explicit pane close.
 *
 * Closing the pane must remain available with an older or unhealthy Host. The
 * backend therefore returns a typed preserve result when possible, and this
 * adapter converts transport failure into the same conservative outcome. It
 * never falls back to provider termination.
 */
export async function departHmuxPaneExplicitly(
  plan: HmuxPaneRetirementPlan | null,
): Promise<HmuxPaneDepartureReceipt | null> {
  if (!plan) return null;
  try {
    const receipt = await hmux.departPaneGracefully(
      plan.ownerId,
      plan.sessionId,
      plan.workspaceId,
    );
    if (
      receipt.state === "session_preserved" &&
      receipt.reason === "not_attached"
    ) {
      return await hmux.abandonUnpresentedCreation(
        plan.sessionId,
        plan.workspaceId,
      );
    }
    return receipt;
  } catch {
    return {
      state: "session_preserved",
      reason: "transport_unavailable",
    };
  }
}

export async function departRemoteHmuxPaneExplicitly(
  plan: RemoteHmuxPaneRetirementPlan | null,
  hosts: readonly SshHostConfig[],
): Promise<HmuxPaneDepartureReceipt | null> {
  if (!plan) return null;
  try {
    const { target, session } = await resolveRemoteHmuxStandaloneController(
      hosts,
      plan.binding,
    );
    return await remoteHmuxDepartGracefully(
      target,
      session,
      plan.ownerId,
    );
  } catch {
    return {
      state: "session_preserved",
      reason: "transport_unavailable",
    };
  }
}
