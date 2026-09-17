import type { HmuxSessionSummary } from "@/lib/ipc";
import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { TerminalPaneBindingV1 } from "@/lib/terminal/terminalBinding";

export type ManagedLocalRuntimeLiveness = "alive" | "exited" | "unknown";

/** Exact generation-fenced managed Host liveness. This is a projection of the
 * existing census summary, not another probe or cache. */
export function managedLocalRuntimeLiveness(
  binding: TerminalPaneBindingV1 | undefined,
  sessions: Readonly<Record<string, HmuxSessionSummary>>,
): ManagedLocalRuntimeLiveness {
  if (
    binding?.runtime !== "hmux_managed_v1" ||
    binding.source !== "local" ||
    !binding.stopFence
  ) {
    return "unknown";
  }
  const session =
    sessions[hmuxSessionMetadataKey(binding.workspaceId, binding.sessionId)];
  if (
    session?.sessionId !== binding.sessionId ||
    session.workspaceId !== binding.workspaceId ||
    session.sessionClass !== "managed" ||
    session.stopFence === undefined ||
    session.terminalEpoch !== session.stopFence.terminalEpoch ||
    !sameHmuxManagedGeneration(binding.stopFence, session.stopFence)
  ) {
    return "unknown";
  }
  if (
    session.lifecycle === "exited" ||
    session.manifestLifecycle === "exited" ||
    session.health === "exited" ||
    session.hostProcessAlive === false
  ) {
    return "exited";
  }
  return session.lifecycle === "ready" &&
    (session.health === "current_healthy" ||
      session.health === "compatible_old_healthy")
    ? "alive"
    : "unknown";
}
