import { managedInputFenceJson } from "./managed-input-binding.mjs";
import { collectSessionQuery } from "./session-query.mjs";

// Text and semantic-key input use the same authoritative live Session lookup.
// The client registry is optional presentation, never proof of a headless Run.
export async function resolveLocalManagedInputBinding({ sessionId, workspaceId, hmuxCommand, deadlineMs, channel }) {
  const report = await collectSessionQuery({
    action: "show", hmuxCommand, sessionId, workspaceId,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  const session = report.session;
  const binding = session && {
    runtime: "hmux_managed_v1", source: "local", hostId: "local",
    sessionId: session.sessionId, workspaceId: session.workspaceId,
    stopFence: session.runtime?.generation,
  };
  if (report.kind !== "dure.sessions.show" || session?.sessionId !== sessionId ||
    (workspaceId !== undefined && session.workspaceId !== workspaceId) ||
    !session?.liveness?.exactGeneration || session.liveness.state !== "alive" ||
    session.runtime?.sessionClass !== "managed" || !managedInputFenceJson(binding)) {
    throw Object.assign(new Error(
      `No live managed Session '${sessionId}' was verified${channel ? ` in channel '${channel}'` : ""} (${report.error?.code ?? session?.liveness?.health ?? "unavailable"}). ` +
      "Use dure inspect <session-id> --workspace <workspace-id> --json and dure diagnostics --json in the same channel to check the target. Input was not sent."
    ), { code: "target_unavailable" });
  }
  return binding;
}
