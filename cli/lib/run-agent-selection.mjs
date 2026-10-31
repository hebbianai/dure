import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { agentDisplayName, matchingAgents } from "./client-registry.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";

const MAX_INSPECTED_CANDIDATES = 8;

/** A runtime label for choosing between candidates, not proof of liveness. */
function runtimeStateLabel(observation) {
  if (!observation?.state) return "unavailable";
  return ["closed", "transitioning"].includes(observation.state) && typeof observation.stage === "string"
    ? `${observation.state}:${observation.stage}` : observation.state;
}

/** Retry the same action with one exact Agent ID. Execution flags are left
 * out so the retry previews first and returns its own exact Apply command. */
export function exactRunRetry({ action, agentId, opts, backendId }) {
  return ["runs", action, agentId,
    ...(action === "switch-account" ? ["--account", opts.account] : []),
    ...(action === "open" ? ["--space", opts.space] : []),
    ...(action === "move" ? ["--project", opts.project] : []),
    "--backend", backendId];
}

export function formatRunCandidates(candidates = []) {
  return candidates.flatMap((candidate) => [
    `  ${candidate.agentId}\t${candidate.name ?? "-"}\t${candidate.project ?? candidate.projectId ?? "-"}\t` +
      `${candidate.state ?? candidate.launchState ?? "-"}`,
    `    ${rehostCommandLine(candidate.retry)}`,
  ]);
}

/** The client projection maps a name or Session to an Agent ID; it never
 * proves that the selected backend owns a runtime for that Agent. */
function clientAgentCandidates(registry, selector) {
  if (registry?.state !== "available") return [];
  const byId = registry.agents.filter((agent) => agent.id === selector);
  const matches = byId.length ? byId : matchingAgents(registry, selector);
  const seen = new Set();
  return matches.filter((agent) => isDureDomainIdV1(agent.id) && !seen.has(agent.id) && seen.add(agent.id))
    .map((agent) => ({ agentId: agent.id, name: agentDisplayName(agent) ?? null,
      project: typeof agent.project === "string" ? agent.project : null,
      providerId: typeof agent.provider === "string" ? agent.provider : null }));
}

/** Resolve an app-launched, resumed or imported Agent that has no spawn
 * receipt. The backend's runtime projection is the authority for the result. */
export async function resolveAgentWithoutRun({ selector, action, opts, registry, backend, requestBackend }) {
  const backendId = backend.profile.id;
  const projected = clientAgentCandidates(registry, selector);
  const candidates = projected.length ? projected
    : isDureDomainIdV1(selector) ? [{ agentId: selector, name: null, project: null, providerId: null }] : [];
  if (candidates.length === 0) {
    return { error: { code: "run_not_found", message: registry?.state === "available"
      ? `No Run record or Agent matches ${selector}. List Agents with dure ls and select an exact Agent ID.`
      : `No Run record matches ${selector}, and the app's name projection is unavailable to resolve it. ` +
        "Select an exact Agent ID." } };
  }
  const inspect = async (agentId) => {
    const report = await collectAgentRuntimeCommand({ args: ["get", agentId],
      resolveBackend: async () => backend, requestBackend });
    return report.ok ? { observation: report.result } : { error: report.error };
  };
  if (candidates.length > 1) {
    const inspected = await Promise.all(candidates.map(async (candidate, index) => ({
      ...candidate,
      state: index < MAX_INSPECTED_CANDIDATES
        ? runtimeStateLabel((await inspect(candidate.agentId)).observation) : "not_inspected",
      retry: exactRunRetry({ action, agentId: candidate.agentId, opts, backendId }),
    })));
    return { error: { code: "run_selector_ambiguous", candidates: inspected,
      message: `${candidates.length} Agents match ${selector}. Retry with one exact Agent ID:` } };
  }
  const [candidate] = candidates;
  const { observation, error } = await inspect(candidate.agentId);
  if (error) return { error };
  if (observation.state === "unmanaged") {
    return { error: { code: "run_not_found", message: projected.length || registry?.state === "available"
      ? `No Run record matches ${selector}, and Agent ${candidate.agentId} has no managed runtime on backend ` +
        `${backendId}. Select the backend that runs it with --backend.`
      : `No Run record or managed Agent ID on backend ${backendId} matches ${selector}, and the app's name ` +
        "projection is unavailable to resolve a name or Session. Select an exact Agent ID." } };
  }
  const context = observation.projectionContext;
  return {
    observation,
    agent: {
      agentId: candidate.agentId, name: candidate.name,
      providerId: context?.agent?.providerId ?? observation.receipt?.providerId ?? candidate.providerId,
      workspaceId: context?.agent?.workspaceId ?? null, projectId: context?.project?.projectId ?? null,
    },
  };
}
