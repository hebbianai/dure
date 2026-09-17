import type { UnlistenFn } from "@tauri-apps/api/event";
import { listenWhenReady as listen } from "@/lib/platform/tauriBridge";
import {
  MANAGED_AGENT_CHAIN_STOPPED_EVENT,
  MANAGED_AGENT_STOPPED_EVENT,
} from "@/lib/sessions/managed/managedAgentStop";
import { createManagedAgentStopObservers } from "@/lib/sessions/managed/managedAgentStopObserver";
import { startExitedManagedAgentCleanupCliBridge } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCli";
import {
  applyHmuxSessionConversionSync,
  HMUX_SESSION_CONVERTED_EVENT,
} from "@/lib/hmux/conversion/hmuxSessionConversion";
import {
  applyStandaloneHmuxRetargetSync,
  HMUX_STANDALONE_RETARGETED_EVENT,
} from "@/lib/hmux/standalone/standaloneHmuxPaneSet";

export async function startCliServerObservers(): Promise<UnlistenFn> {
  const managedStopObservers = createManagedAgentStopObservers();
  let unlistenManagedChainStopSync: UnlistenFn | undefined;
  let unlistenManagedStopSync: UnlistenFn | undefined;
  let unlistenExitedManagedCleanup: UnlistenFn | undefined;
  let unlistenSessionConversionSync: UnlistenFn | undefined;
  let unlistenStandaloneRetargetSync: UnlistenFn | undefined;

  const stop = () => {
    unlistenStandaloneRetargetSync?.();
    unlistenSessionConversionSync?.();
    unlistenManagedChainStopSync?.();
    unlistenManagedStopSync?.();
    unlistenExitedManagedCleanup?.();
  };

  try {
    unlistenManagedStopSync = await listen(
      MANAGED_AGENT_STOPPED_EVENT,
      (event) => {
        void managedStopObservers.exact(event.payload);
      },
    );
    unlistenManagedChainStopSync = await listen(
      MANAGED_AGENT_CHAIN_STOPPED_EVENT,
      (event) => {
        void managedStopObservers.chain(event.payload);
      },
    );
    unlistenExitedManagedCleanup =
      await startExitedManagedAgentCleanupCliBridge();
    unlistenSessionConversionSync = await listen(
      HMUX_SESSION_CONVERTED_EVENT,
      (event) => {
        applyHmuxSessionConversionSync(event.payload);
      },
    );
    unlistenStandaloneRetargetSync = await listen(
      HMUX_STANDALONE_RETARGETED_EVENT,
      (event) => {
        void applyStandaloneHmuxRetargetSync(event.payload);
      },
    );
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
