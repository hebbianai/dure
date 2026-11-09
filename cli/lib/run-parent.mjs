import { matchingAgents } from "./client-registry.mjs";
import {
  AGENT_SPAWN_PARENT_LINK_CAPABILITY,
  validSpawnParent,
} from "./agent-spawn-query.mjs";

export class RunParentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RunParentError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RunParentError(code, message);
}

/** The exact Hmux Session this process runs in, when its environment names
 * one. Agents started in a Dure terminal pane inherit these variables. */
export function callerSessionParent(environment = process.env) {
  const parent = {
    sessionId: environment.HMUX_SESSION_ID,
    workspaceId: environment.HMUX_WORKSPACE_ID,
  };
  return validSpawnParent(parent) ? parent : null;
}

export function backendSupportsParentLink(backend) {
  return backend?.profile?.expected?.capabilities?.includes(
    AGENT_SPAWN_PARENT_LINK_CAPABILITY,
  ) === true;
}

function localBackend(backend) {
  return backend?.profile?.transport?.kind === "local";
}

/** Resolve an Agent name, project/name, Agent ID or Session ID through the
 * app's Agent list to the exact Session it runs in on this backend. */
export function registryParent(selector, registry, backend) {
  if (registry?.state !== "available") {
    fail(
      "run_parent_not_found",
      `The app's Agent list is unavailable to resolve ${selector}. Use --parent SESSION_ID --parent-workspace ID.`,
    );
  }
  const byId = registry.agents.filter((agent) => agent.id === selector);
  const matches = byId.length ? byId : matchingAgents(registry, selector);
  if (matches.length !== 1) {
    fail(
      matches.length === 0 ? "run_parent_not_found" : "run_parent_ambiguous",
      matches.length === 0
        ? `No Agent matches ${selector}. List Agents with dure ls, or use --parent SESSION_ID --parent-workspace ID.`
        : `${matches.length} Agents match ${selector}. Use an Agent ID, or --parent SESSION_ID --parent-workspace ID.`,
    );
  }
  const binding = matches[0].runtimeBinding;
  const parent = { sessionId: binding?.sessionId, workspaceId: binding?.workspaceId };
  if (!validSpawnParent(parent)) {
    fail("run_parent_not_found", `${selector} has no terminal Session to link to.`);
  }
  const source = backend?.profile?.transport?.kind === "ssh" ? "ssh" : "local";
  if (binding.source !== source ||
      binding.hostId !== (source === "ssh" ? backend.profile.id : "local")) {
    fail(
      "run_parent_backend_mismatch",
      `${selector} runs on another backend. A parent must run on the same backend as its child.`,
    );
  }
  return parent;
}

/**
 * Decide which agent a new Run records as its parent.
 * - --no-parent records none.
 * - --parent names one explicitly, and fails when it can't be recorded.
 * - Otherwise the calling agent's own Session is recorded when this process
 *   runs inside one on the local backend and the backend supports links.
 * Returns { parent, source }, where parent is undefined when none is sent.
 */
export function resolveRunParent({
  selector,
  workspaceId,
  noParent = false,
  environment = process.env,
  registry,
  backend,
}) {
  // An unreachable backend fails the Run itself with its own error.
  if (noParent || backend?.error) return { parent: undefined, source: "none" };
  if (selector !== undefined) {
    const parent = workspaceId !== undefined
      ? { sessionId: selector, workspaceId }
      : registryParent(selector, registry, backend);
    if (!validSpawnParent(parent)) {
      fail("run_parent_invalid", "The parent Session or workspace ID is invalid.");
    }
    if (!backendSupportsParentLink(backend)) {
      fail(
        "run_parent_unsupported",
        "The selected backend can't record a parent link. Update Dure on that host, or drop --parent.",
      );
    }
    return { parent, source: "explicit" };
  }
  const caller = callerSessionParent(environment);
  // An Hmux Session in this environment belongs to this machine's Host, so it
  // is a parent only for Runs on the local backend.
  if (!caller || !localBackend(backend)) return { parent: undefined, source: "none" };
  if (!backendSupportsParentLink(backend)) {
    return { parent: undefined, source: "unsupported" };
  }
  return { parent: caller, source: "caller_session" };
}

export function sameParent(left, right) {
  return left?.sessionId === right?.sessionId && left?.workspaceId === right?.workspaceId;
}

const MAX_CHILD_LISTING_PAGES = 64;

/** Every Run record whose recorded parent is exactly this Session. The Run
 * list is paged by operation ID; a parent reads all of it once. */
export async function listChildRuns({ parent, backend, listRuns, deadlineMs }) {
  const children = [];
  let cursor;
  for (let page = 0; page < MAX_CHILD_LISTING_PAGES; page += 1) {
    const listed = await listRuns({ backend, cursor, deadlineMs });
    if (listed.error) return { error: listed.error };
    children.push(...listed.page.runs.filter((run) => sameParent(run.parent, parent)));
    cursor = listed.page.nextCursor;
    if (cursor === null) return { children };
  }
  return {
    error: {
      code: "wait_children_listing_incomplete",
      message: `Stopped after ${MAX_CHILD_LISTING_PAGES} pages of Run records.`,
    },
  };
}

const LAUNCH_FAILED = new Set(["failed", "manual_intervention_required"]);
const LAUNCH_INCOMPLETE = new Set(["retry_required", "inspect_before_retry", "prompt_delivery_uncertain"]);
// The settled states a parent is woken for. "working" and "launching" are not.
export const SETTLED_CHILD_STATES = new Set([
  "turn_completed",
  "exited",
  "attention_required",
  "launch_failed",
  "launch_incomplete",
]);
export const ACTION_REQUIRED_CHILD_STATES = new Set([
  "attention_required",
  "launch_failed",
  "launch_incomplete",
]);

/**
 * Classify one child from its Run record and the Host's observation of its
 * Session. A child is settled when it has finished at least one turn and is
 * idle, its provider exited, it waits for input or approval, or its launch
 * failed or stopped short. Silence and terminal output are never evidence.
 */
export function classifyChild(run, sessionReport) {
  if (LAUNCH_FAILED.has(run.launchState)) return { state: "launch_failed" };
  // A launch that stopped short waits for someone to inspect or retry it.
  if (LAUNCH_INCOMPLETE.has(run.launchState)) return { state: "launch_incomplete" };
  if (run.launchState !== "succeeded") return { state: "launching" };
  if (typeof run.sessionId !== "string") {
    return { state: "unobservable", reason: "chat_runtime" };
  }
  if (!sessionReport || sessionReport.error) {
    return { state: "working", reason: "observation_unavailable" };
  }
  const { liveness, runtime } = sessionReport.session;
  if (liveness.state === "exited") return { state: "exited" };
  const current = runtime.agentRuntimeState;
  if (!liveness.exactGeneration) return { state: "working", reason: "host_generation_unobserved" };
  if (!current) return { state: "unobservable", reason: "response_observation_missing" };
  const turnCompletedCount = current.turnCompletedCount;
  if (current.lifecycle === "exited") return { state: "exited", turnCompletedCount };
  if (current.attention !== "none") {
    return { state: "attention_required", attention: current.attention, turnCompletedCount };
  }
  if (current.activity === "waiting" && current.backgroundWork !== true &&
      BigInt(turnCompletedCount) > 0n) {
    return { state: "turn_completed", turnCompletedCount };
  }
  return { state: "working", turnCompletedCount };
}
