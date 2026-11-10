import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { agentDisplayName, matchingAgents } from "./client-registry.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";

const MAX_INSPECTED_CANDIDATES = 8;

const RUN_LAUNCH_STATES = new Set(["applying", "ready_to_succeed", "inspect_before_retry", "retry_required",
  "prompt_delivery_uncertain", "succeeded", "failed", "manual_intervention_required"]);

function validRunPage(value) {
  return value?.schemaVersion === 1 && Array.isArray(value.runs) && value.runs.length <= 64 &&
    (value.nextCursor === null || isDureDomainIdV1(value.nextCursor)) &&
    value.runs.every((run) => [run.agentId, run.operationId, run.name, run.providerId, run.workspaceId, run.projectId]
      .every(isDureDomainIdV1) && RUN_LAUNCH_STATES.has(run.launchState) &&
      Number.isSafeInteger(run.createdAtMs) && run.createdAtMs >= 0 &&
      Number.isSafeInteger(run.updatedAtMs) && run.updatedAtMs >= run.createdAtMs) &&
    value.runs.every((run, i) => i === 0 || run.operationId > value.runs[i - 1].operationId) &&
    (value.nextCursor === null || (value.runs.length === 64 && value.nextCursor === value.runs.at(-1).operationId));
}

/** One bounded page of the backend's durable Run records. A selector narrows
 * it to Runs whose name, Agent ID or operation ID equals the selector. */
export async function listRunRecords({ backend, requestBackend, selector, cursor }) {
  const response = await requestBackend(backend.profile, {
    requestId: randomUUID(), operation: "agent_spawn.list", requiredCapabilities: ["agent_spawn.list"],
    body: { schemaVersion: 1, ...(cursor ? { after: cursor } : {}), ...(selector ? { selector } : {}) },
  }, backend.transportOptions);
  const page = response.result;
  if (!validRunPage(page) || (selector && page.runs.some((entry) =>
      ![entry.name, entry.agentId, entry.operationId].includes(selector))) ||
      (cursor && page.runs.some((entry) => entry.operationId <= cursor))) {
    return { error: { code: "runs_response_invalid" } };
  }
  return { page, backend: response.backend };
}

/** Exact IDs win over name collisions. A partial page cannot establish
 * uniqueness, so each candidate carries its exact `retry(agentId)` command.
 * Returns `{ run: undefined }` when no Run record matches. */
export function selectRunRecord(page, selector, retry) {
  const exact = page.runs.filter((entry) => entry.agentId === selector || entry.operationId === selector);
  const matches = exact.length ? exact : page.runs;
  if (matches.length > 1 || (matches.length === 1 && page.nextCursor !== null)) {
    return { error: { code: "run_selector_ambiguous",
      message: `${page.nextCursor === null ? matches.length : "More than " + matches.length} Runs match ${selector}. Retry with one exact Agent ID:`,
      candidates: matches.map((entry) => ({ agentId: entry.agentId, name: entry.name, projectId: entry.projectId,
        providerId: entry.providerId, operationId: entry.operationId, launchState: entry.launchState,
        retry: retry(entry.agentId) })) } };
  }
  return { run: matches[0] };
}

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

export const NATIVE_SESSION_RESOLVE_CAPABILITY = "agent_runtime.native_session.resolve.v1";
const MAX_SESSION_OWNERS = 8;

function validSessionResolution(value, sessionId) {
  return value?.schemaVersion === 1 && value.sessionId === sessionId && typeof value.complete === "boolean" &&
    Array.isArray(value.agents) && value.agents.length <= MAX_SESSION_OWNERS &&
    value.agents.every((owner) => isDureDomainIdV1(owner?.agentId) && isDureDomainIdV1(owner.workspaceId) &&
      Number.isSafeInteger(owner.bindingGeneration) && owner.bindingGeneration > 0);
}

/** The Agents whose backend binding names this native Session, or null when
 * the backend cannot say. This needs no app Agent list, so it still resolves a
 * live Session after the app lost its state. It maps identity only; the caller
 * re-reads each Agent's runtime. */
async function sessionAgentCandidates({ selector, backend, requestBackend }) {
  if (!backend.profile.expected?.capabilities?.includes(NATIVE_SESSION_RESOLVE_CAPABILITY)) return null;
  let response;
  try {
    response = await requestBackend(backend.profile, {
      requestId: randomUUID(), operation: NATIVE_SESSION_RESOLVE_CAPABILITY,
      requiredCapabilities: [NATIVE_SESSION_RESOLVE_CAPABILITY],
      body: { schemaVersion: 1, sessionId: selector },
    }, backend.transportOptions);
  } catch (error) {
    // A backend started before this read keeps resolving Agent IDs only.
    if (error?.code === "backend_transport_capability_missing") return null;
    throw error;
  }
  if (!validSessionResolution(response.result, selector)) {
    throw Object.assign(new Error("The backend returned an invalid Session lookup."), { code: "runs_response_invalid" });
  }
  return response.result.agents.map((owner) => ({ agentId: owner.agentId, name: null, project: null, providerId: null }));
}

/** Resolve an app-launched, resumed or imported Agent that has no spawn
 * receipt. The backend's runtime projection is the authority for the result. */
export async function resolveAgentWithoutRun({ selector, action, opts, registry, backend, requestBackend }) {
  const backendId = backend.profile.id;
  const projected = clientAgentCandidates(registry, selector);
  let candidates = projected.length ? projected
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
  let bySession = false;
  let sessionLookup = false;
  let direct;
  if (!projected.length) {
    // An exact Agent ID wins. Otherwise the selector may be a Session the app
    // no longer lists, for example after it lost its panes and Agent list.
    direct = await inspect(selector);
    if (direct.error) return { error: direct.error };
    if (direct.observation.state === "unmanaged") {
      const owners = await sessionAgentCandidates({ selector, backend, requestBackend });
      sessionLookup = owners !== null;
      if (owners?.length) {
        candidates = owners;
        bySession = true;
        direct = undefined;
      }
    }
  }
  if (candidates.length > 1) {
    const inspected = await Promise.all(candidates.map(async (candidate, index) => ({
      ...candidate,
      state: index < MAX_INSPECTED_CANDIDATES
        ? runtimeStateLabel((await inspect(candidate.agentId)).observation) : "not_inspected",
      retry: exactRunRetry({ action, agentId: candidate.agentId, opts, backendId }),
    })));
    return { error: { code: "run_selector_ambiguous", candidates: inspected,
      message: `${candidates.length} Agents ${bySession ? "are bound to Session" : "match"} ${selector}. ` +
        "Retry with one exact Agent ID:" } };
  }
  const [candidate] = candidates;
  const { observation, error } = direct ?? await inspect(candidate.agentId);
  if (error) return { error };
  if (observation.state === "unmanaged") {
    return { error: { code: "run_not_found", message: bySession
      ? `Session ${selector} is bound to Agent ${candidate.agentId}, which has no managed runtime on backend ` +
        `${backendId}.`
      : sessionLookup
        ? `No Run record, managed Agent ID or bound Session on backend ${backendId} matches ${selector}. ` +
          "List live Sessions with dure ls --alive, or select the backend that runs it with --backend."
        : projected.length || registry?.state === "available"
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
