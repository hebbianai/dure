import { managedInputFenceJson } from "./managed-input-binding.mjs";
import { collectSessionQuery } from "./session-query.mjs";

// A lookup Hmux could not answer, or one whose Host did not answer the probe
// in time, says nothing about whether the Session is alive: a busy Host or a
// loaded machine can miss the deadline while the agent keeps working. Nothing
// has been written yet, so the read-only lookup is repeated a bounded number
// of times. Input itself is never retried.
const LOOKUP_RETRY_DELAYS_MS = [250, 750];
const INCONCLUSIVE_LOOKUP_ERRORS = new Set(["hmux_session_query_failed", "hmux_session_query_timeout"]);

function inconclusiveLookup(report) {
  return report.error
    ? INCONCLUSIVE_LOOKUP_ERRORS.has(report.error.code)
    : report.session?.liveness?.health === "unprobed";
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Hmux exits the same way for an unknown Session ID as for a read it could
// not finish, so the message names both causes instead of guessing.
function inconclusiveLookupError(report, { sessionId, workspaceId, channel, attempts }) {
  const target = `managed Session '${sessionId}'${channel ? ` in channel '${channel}'` : ""}`;
  const cause = report.error
    ? `Could not look up ${target} (${report.error.code}) after ${attempts} attempts. Check the Session ID.` +
      (workspaceId === undefined ? " Pass --workspace <workspace-id> to skip the search across workspaces." : "") +
      " A busy Host or a loaded machine can also fail the lookup"
    : `The Host of ${target} did not answer its probe (unprobed) after ${attempts} attempts. A busy Host or a loaded machine can miss the probe deadline`;
  return Object.assign(new Error(
    `${cause} while the Session keeps working, so this does not show that the Session exited. ` +
    "Input was not sent; retry the same command. Use dure inspect <session-id> --workspace <workspace-id> --json and dure diagnostics --json in the same channel to check the target."
  ), { code: "target_unavailable" });
}

// Text and semantic-key input use the same authoritative live Session lookup.
// The client registry is optional presentation, never proof of a headless Run.
export async function resolveLocalManagedInputBinding({ sessionId, workspaceId, hmuxCommand, deadlineMs, channel }) {
  const lookup = () => collectSessionQuery({
    action: "show", hmuxCommand, sessionId, workspaceId,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });
  let report = await lookup();
  let attempts = 1;
  for (const retryDelayMs of LOOKUP_RETRY_DELAYS_MS) {
    if (!inconclusiveLookup(report)) break;
    await delay(retryDelayMs);
    report = await lookup();
    attempts += 1;
  }
  if (inconclusiveLookup(report)) {
    throw inconclusiveLookupError(report, { sessionId, workspaceId, channel, attempts });
  }
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
