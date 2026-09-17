import type { RemoteHmuxCatalogSessionV1 } from "@/lib/hmux/remote/remoteHmuxBroker";
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
  type RemoteHmuxManagedPaneBindingV1,
  type RemoteHmuxStandalonePaneBindingV1,
  remoteHmuxManagedBinding,
  type TerminalPaneBindingV1,
} from "@/lib/terminal/terminalBinding";

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

export function planRemoteHmuxManagedTransition(
  binding: TerminalPaneBindingV1 | undefined,
  transition: unknown,
  marker: RemoteHmuxManagedStartedMarkerV1,
  catalogSession: RemoteHmuxCatalogSessionV1,
): RemoteHmuxManagedPaneBindingV1 | undefined {
  if (
    !isRemoteHmuxStandalonePaneBinding(binding) ||
    !isRemoteHmuxPaneTransitionV1(transition) ||
    transition.phase === "preparing" ||
    !sameRemoteHmuxBinding(binding, transition.targetBinding) ||
    !remoteHmuxBridgeMarkerMatchesSource(marker, binding) ||
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
      transition: RemoteHmuxPaneTransitionV1;
    }
  | {
      binding: RemoteHmuxPaneTransitionV1["sourceBinding"];
      transition: undefined;
    };

export function planRemoteHmuxExitTransition(
  binding: TerminalPaneBindingV1 | undefined,
  transition: unknown,
): RemoteHmuxExitTransition | undefined {
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
