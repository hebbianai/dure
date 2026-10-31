import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";

const AGENT_ID = /^agent-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SUCCESSOR_LOOKUP_DEADLINE_MS = 10_000;

/** The Session that the backend currently binds to a local registry Agent,
 * when it differs from the registry's. A restart or account switch replaces
 * the Agent's Session in the backend; the app-written registry follows only
 * when a running app re-projects that transition. Names select the registry
 * record; the backend's binding, not the registry, says where it runs now. */
export async function currentAgentSessionSuccessor({
  agent,
  resolveBackend,
  requestBackend,
  deadlineMs = SUCCESSOR_LOOKUP_DEADLINE_MS,
}) {
  const binding = agent?.runtimeBinding;
  if (
    typeof agent?.id !== "string" ||
    !AGENT_ID.test(agent.id) ||
    binding?.runtime !== "hmux_managed_v1" ||
    binding.source !== "local" ||
    binding.hostId !== "local"
  ) {
    return null;
  }
  const report = await collectAgentRuntimeCommand({
    args: ["get", agent.id],
    resolveBackend,
    deadlineMs,
    ...(requestBackend ? { requestBackend } : {}),
  });
  if (!report.ok || report.result.state !== "stable") return null;
  const authority = report.result.receipt?.authority;
  const current = authority?.authority;
  if (
    authority?.interactionProfile !== "native_cli" ||
    current?.binding?.agentId !== agent.id ||
    typeof current.binding.sessionId !== "string" ||
    typeof current.runtimeWorkspaceId !== "string" ||
    (current.binding.sessionId === binding.sessionId &&
      current.runtimeWorkspaceId === binding.workspaceId)
  ) {
    return null;
  }
  return { sessionId: current.binding.sessionId, workspaceId: current.runtimeWorkspaceId };
}

/** Read a registry Agent's screen. Only when its registered Session can no
 * longer be read does it ask the backend for the Agent's current Session; once
 * found, later reads (for example --follow) stay on that Session. */
export function agentScreenReader({ agent, capture, findSuccessor, onSuccessor }) {
  let successor = null;
  return async (signal) => {
    if (successor) return capture(successor, signal);
    try {
      return await capture(agent, signal);
    } catch (error) {
      if (typeof agent === "string" || error?.kind !== "nonzero") throw error;
      let found = null;
      try {
        found = await findSuccessor(agent);
      } catch {
        // The registry Session's own failure stays the answer.
      }
      if (!found) throw error;
      const screen = await capture(found, signal);
      successor = found;
      onSuccessor?.(found);
      return screen;
    }
  };
}
