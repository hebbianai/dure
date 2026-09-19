import type { RemoteHmuxCatalogSessionV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import {
  type RemoteHmuxManagedStartedMarkerV1,
  remoteHmuxBridgeMarkerMatchesCatalog,
  remoteHmuxBridgeMarkerMatchesSource,
} from "@/lib/hmux/remote/remoteHmuxCommandBridge";
import {
  isRemoteHmuxPaneTransitionV1,
  type RemoteHmuxPaneTransitionV1,
} from "@/lib/hmux/remote/remoteHmuxPaneTransition";
import {
  isRemoteHmuxStandalonePaneBinding,
  isTerminalPaneBindingV1,
  type RemoteHmuxManagedPaneBindingV1,
  type RemoteHmuxStandalonePaneBindingV1,
  remoteHmuxManagedBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

/** The pane's return address while a command bridge owns its presentation.
 * Independent of whether the SSH shell was opened directly or from a local shell. */
export interface RemoteHmuxManagedReturnV1 {
  schemaVersion: 1;
  sourceBinding: RemoteHmuxStandalonePaneBindingV1;
  targetBinding: RemoteHmuxManagedPaneBindingV1;
}

export function sameRemoteHmuxBinding(
  left:
    | RemoteHmuxStandalonePaneBindingV1
    | RemoteHmuxManagedPaneBindingV1
    | undefined,
  right: RemoteHmuxStandalonePaneBindingV1 | RemoteHmuxManagedPaneBindingV1,
): boolean {
  return (
    left?.runtime === right.runtime &&
    left.source === "ssh" &&
    left.hostId === right.hostId &&
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.commandBridgeNonce === right.commandBridgeNonce
  );
}

export function remoteHmuxCommandBridgeSourceMatches(
  binding: TerminalPaneBindingV1 | undefined,
  transition: unknown,
  marker: RemoteHmuxManagedStartedMarkerV1,
): binding is RemoteHmuxStandalonePaneBindingV1 {
  return (
    isRemoteHmuxStandalonePaneBinding(binding) &&
    remoteHmuxBridgeMarkerMatchesSource(marker, binding) &&
    (transition === undefined ||
      (isRemoteHmuxPaneTransitionV1(transition) &&
        transition.phase !== "preparing" &&
        sameRemoteHmuxBinding(binding, transition.targetBinding)))
  );
}

export function planRemoteHmuxManagedTransition(
  binding: TerminalPaneBindingV1 | undefined,
  transition: unknown,
  marker: RemoteHmuxManagedStartedMarkerV1,
  catalogSession: RemoteHmuxCatalogSessionV1,
): RemoteHmuxManagedPaneBindingV1 | undefined {
  if (
    !remoteHmuxCommandBridgeSourceMatches(binding, transition, marker) ||
    !remoteHmuxBridgeMarkerMatchesCatalog(marker, catalogSession)
  ) {
    return undefined;
  }
  return remoteHmuxManagedBinding(
    marker.target.sessionId,
    marker.target.workspaceId,
    binding.hostId,
    binding.commandBridgeNonce,
    marker.target.sessionId,
    {
      runnerPrincipal: catalogSession.runnerPrincipal,
      runnerInstance: catalogSession.runnerInstance,
      channelEpoch: catalogSession.channelEpoch,
      hostInstanceId: catalogSession.hostInstanceId,
      terminalEpoch: catalogSession.terminalEpoch,
    },
  );
}

export type RemoteHmuxExitTransition =
  | {
      binding: RemoteHmuxStandalonePaneBindingV1;
      transition: RemoteHmuxPaneTransitionV1 | undefined;
    }
  | {
      binding: RemoteHmuxPaneTransitionV1["sourceBinding"];
      transition: undefined;
    };

export function planRemoteHmuxExitTransition(
  binding: TerminalPaneBindingV1 | undefined,
  transition: unknown,
  managedReturn?: unknown,
): RemoteHmuxExitTransition | undefined {
  if (managedReturn !== undefined) {
    if (!managedReturn || typeof managedReturn !== "object") return undefined;
    const { schemaVersion, sourceBinding, targetBinding } =
      managedReturn as Record<string, unknown>;
    if (
      schemaVersion !== 1 ||
      !isTerminalPaneBindingV1(sourceBinding) ||
      !isRemoteHmuxStandalonePaneBinding(sourceBinding) ||
      !isTerminalPaneBindingV1(targetBinding) ||
      targetBinding.runtime !== "hmux_managed_v1" ||
      targetBinding.source !== "ssh" ||
      binding?.runtime !== "hmux_managed_v1" ||
      binding.source !== "ssh" ||
      sourceBinding.hostId !== targetBinding.hostId ||
      sourceBinding.commandBridgeNonce !== targetBinding.commandBridgeNonce ||
      !sameRemoteHmuxBinding(binding, targetBinding) ||
      !targetBinding.stopFence ||
      !sameHmuxManagedGeneration(binding.stopFence, targetBinding.stopFence) ||
      (transition !== undefined &&
        (!isRemoteHmuxPaneTransitionV1(transition) ||
          transition.phase === "preparing" ||
          !sameRemoteHmuxBinding(sourceBinding, transition.targetBinding)))
    ) {
      return undefined;
    }
    return {
      binding: sourceBinding,
      transition: transition as RemoteHmuxPaneTransitionV1 | undefined,
    };
  }
  // Layouts saved before managed return addresses were recorded retain the
  // existing local -> SSH -> provider restoration path.
  if (
    !isRemoteHmuxPaneTransitionV1(transition) ||
    transition.phase === "preparing"
  ) {
    return undefined;
  }
  if (
    binding?.runtime === "hmux_managed_v1" &&
    binding.source === "ssh" &&
    binding.hostId === transition.targetBinding.hostId &&
    binding.commandBridgeNonce === transition.targetBinding.commandBridgeNonce
  ) {
    return {
      binding: transition.targetBinding,
      transition,
    };
  }
  if (
    isRemoteHmuxStandalonePaneBinding(binding) &&
    sameRemoteHmuxBinding(binding, transition.targetBinding)
  ) {
    return {
      binding: transition.sourceBinding,
      transition: undefined,
    };
  }
  return undefined;
}
