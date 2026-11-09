import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { runBoundedCommand } from "./bounded-command.mjs";
import { agentDisplayName } from "./client-registry.mjs";
import { agentRuntimeWakeTarget } from "./contracts/agent-runtime.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { PROVIDERS } from "./contracts/provider-catalog.mjs";
import { collectManagedRehostCommand } from "./managed-rehost-command.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";
import { collectManagedRehostPublication } from "./managed-rehost-publication.mjs";
import { providerResumeSupport } from "./provider-capabilities.mjs";
import { listRunRecords } from "./run-agent-selection.mjs";
import { supportsHmuxCapability } from "./runtime-diagnostics.mjs";

export const RESUME_HELP = `Usage:
  dure resume --all [--dry-run] [--include-exited] [--backend ID] [--json]

Restores every agent whose Host is gone, for example after a reboot, into its own
conversation, worktree and account. No open app is required. To recover one agent
use dure runs resume <agent>.

Only a Host the operating system proves is gone is replaced. An agent that is
running, or a Host that is not answering but may still be alive, is left alone.
Run it again at any time: restored agents then report as already running, and an
attempt interrupted earlier continues the same operation.

Agents that cannot be restored are listed with a reason, never dropped:
hibernating or deliberately closed agents, Chat agents (open them to continue),
a missing conversation ID, a provider without exact resume, a missing worktree. --include-exited also restores agents whose provider had already
exited on its own. --dry-run reports the plan and changes nothing.

Local backends only. Exits 2 when any restore fails; skipped agents do not fail it.`;

const HOST_ABSENT_CAPABILITY = "managed_rehost_host_absent_start_v1";
const RESTORE_CONCURRENCY = 4;
const INSPECT_CONCURRENCY = 8;
const MAX_RUN_PAGES = 64;
const NATIVE_QUERY_TIMEOUT_MS = 5_000;
/** Bulk historical outcomes: counted in text output, listed in full by --json. */
const QUIET_SKIP_REASONS = new Set(["not_managed", "closed"]);

const SKIP_MESSAGES = {
  not_managed: "The selected backend has no managed runtime for this Agent.",
  closed: "This Agent was stopped deliberately, so it is not restored.",
  hibernated: "This Agent is hibernating and wakes when it next receives work.",
  transition_in_progress: "A runtime transition is in progress for this Agent.",
  chat_runtime: "Chat agents are not restored by this command. Open the agent to continue it.",
  runtime_not_restorable: "This Agent's runtime has no local Hmux source to restore.",
  no_conversation_id: "No provider conversation ID was saved. Open its pane to choose a conversation.",
  provider_without_resume: "This provider cannot resume a conversation.",
  provider_without_exact_resume: "This provider can only resume its latest conversation, not this exact one.",
  worktree_missing: "The working folder no longer exists. Open its pane and choose Recreate worktree and resume.",
  provider_exited: "Its provider exited on its own before the Host ended. Add --include-exited to restore it.",
  host_still_running: "The Host is not answering but may still be alive, so it was left alone.",
  host_incompatible: "The Host is running a protocol this CLI cannot talk to. Restart it from its pane.",
  host_state_unknown: "The Host's state could not be observed, so it was left alone.",
  runtime_generation_changed: "The session was replaced after this Agent's runtime was recorded.",
  no_recovery_recipe: "This session predates saved recovery details. Use the actions in its pane.",
  conversation_mismatch: "The session's conversation differs from the one the backend recorded.",
  source_changed: "Another recovery of this session already started. Inspect it before retrying.",
};

const NATIVE_SKIP_REASONS = {
  managed_rehost_socket_owner_absence_required: "host_still_running",
  hmux_managed_rehost_recipe_missing: "no_recovery_recipe",
  hmux_managed_rehost_conversation_required: "no_conversation_id",
  hmux_managed_rehost_identity_mismatch: "conversation_mismatch",
  hmux_managed_rehost_source_changed: "source_changed",
};

export function parseResumeOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    all: { type: "boolean" }, "dry-run": { type: "boolean" }, "include-exited": { type: "boolean" },
    backend: { type: "string" }, json: { type: "boolean" },
  } });
  return { ...values, rest: positionals, dryRun: values["dry-run"], includeExited: values["include-exited"],
    backendSpecified: values.backend !== undefined };
}

async function mapPool(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Every agent either source knows about: Run records cover headless launches
 * and the app's registry covers agents it launched, resumed or imported. */
async function listKnownAgents({ backend, requestBackend, registry }) {
  const agents = new Map();
  let cursor;
  let runsComplete = false;
  for (let page = 0; page < MAX_RUN_PAGES && !runsComplete; page++) {
    const listed = await listRunRecords({ backend, requestBackend, cursor });
    if (listed.error) return { error: listed.error };
    for (const run of listed.page.runs) agents.set(run.agentId, { agentId: run.agentId, name: run.name });
    cursor = listed.page.nextCursor;
    runsComplete = cursor === null;
  }
  for (const agent of registry.agents) {
    if (!isDureDomainIdV1(agent.id)) continue;
    agents.set(agent.id, { ...agents.get(agent.id), agentId: agent.id,
      name: agentDisplayName(agent) ?? agents.get(agent.id)?.name ?? null,
      worktree: typeof agent.worktree === "string" ? agent.worktree : undefined });
  }
  return { agents: [...agents.values()],
    complete: runsComplete && ["available", "absent"].includes(registry.state) };
}

const skip = (reason, message = SKIP_MESSAGES[reason]) => ({ outcome: "skipped", reason, message });

/** Classify the backend's durable selection. Selection never proves liveness. */
export function classifyRuntime(observation, resumeSupport = (id) => {
  const spec = PROVIDERS[id];
  return spec ? providerResumeSupport(spec) : undefined;
}) {
  if (agentRuntimeWakeTarget(observation)) return skip("hibernated");
  if (observation.state === "unmanaged") return skip("not_managed");
  if (observation.state === "closed") return skip(observation.stage === "stopped" ? "closed" : "transition_in_progress");
  if (observation.state !== "stable") return skip("transition_in_progress");
  const selected = observation.receipt.authority;
  if (selected?.interactionProfile === "structured_protocol") return skip("chat_runtime");
  const source = selected?.authority;
  const binding = source?.binding;
  if (selected?.interactionProfile !== "native_cli" || binding?.runtimeKindId !== "runtime.hmux" ||
      ![binding.sessionId, source.runtimeWorkspaceId].every((id) => typeof id === "string" && id.length > 0)) {
    return skip("runtime_not_restorable");
  }
  const providerId = observation.receipt.providerId;
  const support = resumeSupport(providerId);
  if (support === "none") return skip("provider_without_resume");
  if (support === "latest_only") return skip("provider_without_exact_resume");
  return { outcome: "candidate", providerId, source, sessionId: binding.sessionId, workspaceId: source.runtimeWorkspaceId,
    conversationId: binding.providerConversationId ?? observation.receipt.providerConversationRef ?? null };
}

/** Classify Hmux's current observation of the exact selected session. */
export function classifySession(session, target, { includeExited }) {
  if (session.host_instance_id !== target.source.hostInstanceId ||
      session.terminal_epoch !== target.source.terminalEpoch) {
    return session.health === "healthy" ? { outcome: "running" } : skip("runtime_generation_changed");
  }
  const conversationId = target.conversationId ?? session.providerConversationIdentity?.conversation_id ?? null;
  const restore = (extra) => conversationId
    ? { outcome: "restore", conversationId, ...extra }
    : skip("no_conversation_id");
  switch (session.health) {
    case "healthy": return { outcome: "running" };
    case "stale_transport": return restore({ requireHostAbsent: true });
    // An exited tombstone is the Host's own proof, and its generation cannot
    // satisfy the live-Host socket check.
    case "exited": return includeExited ? restore({ requireHostAbsent: false }) : skip("provider_exited");
    case "incompatible_protocol": return skip("host_incompatible");
    default: return skip("host_state_unknown");
  }
}

function restoreOperationId({ source, workspaceId, sessionId }) {
  const digest = createHash("sha256")
    .update(["dure-resume-all-v1", workspaceId, sessionId, source.hostInstanceId, source.terminalEpoch].join("\0"))
    .digest("hex");
  return `resume-all-${digest.slice(0, 48)}`;
}

async function readSession({ command, run, sessionId, workspaceId }) {
  const response = await run([command, "--json", "session", "show", sessionId, "--workspace", workspaceId],
    { timeoutMs: NATIVE_QUERY_TIMEOUT_MS, maxCaptureBytes: 1024 * 1024 });
  if (response.kind !== "success") return undefined;
  try {
    const parsed = JSON.parse(response.stdout);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function planAgent(agent, { backend, requestBackend, command, run, includeExited, worktreeExists }) {
  const identity = { agentId: agent.agentId, name: agent.name ?? null };
  const inspected = await collectAgentRuntimeCommand({ args: ["get", agent.agentId],
    resolveBackend: async () => backend, requestBackend });
  if (!inspected.ok) {
    return { ...identity, outcome: "failed", reason: inspected.error?.remoteCode ?? inspected.error?.code ?? "runtime_inspect_failed",
      message: inspected.error?.message ?? "The backend could not report this Agent's runtime." };
  }
  const providerId = inspected.result.receipt?.providerId ?? inspected.result.projectionContext?.agent?.providerId ?? null;
  const described = { ...identity, providerId };
  const runtime = classifyRuntime(inspected.result);
  if (runtime.outcome !== "candidate") return { ...described, ...runtime };
  const session = await readSession({ command, run, sessionId: runtime.sessionId, workspaceId: runtime.workspaceId });
  if (!session) return { ...described, ...skip("host_state_unknown") };
  const decision = classifySession(session, runtime, { includeExited });
  if (decision.outcome !== "restore") return { ...described, ...decision };
  if (agent.worktree && isAbsolute(agent.worktree) && !worktreeExists(agent.worktree)) {
    return { ...described, ...skip("worktree_missing") };
  }
  return { ...described, ...decision, source: runtime.source, sessionId: runtime.sessionId, workspaceId: runtime.workspaceId };
}

async function restoreAgent(target, { backend, requestBackend, command, run, settle }) {
  const operationId = restoreOperationId(target);
  const described = { agentId: target.agentId, name: target.name, providerId: target.providerId,
    conversationId: target.conversationId, previousSessionId: target.sessionId, workspaceId: target.workspaceId, operationId };
  const status = ["hmux", "rehost", "status", target.sessionId, "--workspace", target.workspaceId, "--operation-id", operationId, "--json"];
  const execution = await collectManagedRehostCommand({ action: "start", sessionId: target.sessionId, workspaceId: target.workspaceId,
    operationId, confirmRestart: true, expectedConversationId: target.conversationId,
    requireHostAbsent: target.requireHostAbsent, command, run, ...(settle ? { settle } : {}) });
  if (!execution.ok) {
    const native = execution.error.native;
    const worktree = native?.code === "hmux_managed_rehost_recipe_invalid" && /\bcwd\b/.test(native.message ?? "");
    const reason = worktree ? "worktree_missing" : NATIVE_SKIP_REASONS[native?.code];
    if (reason) return { ...described, ...skip(reason), retry: runsResumeRetry(target.agentId, backend) };
    return { ...described, outcome: "failed", reason: native?.code ?? execution.error.code,
      message: native?.message ?? execution.error.message, retry: status };
  }
  if (execution.state === "running") {
    return { ...described, outcome: "failed", reason: "restore_still_running",
      message: "Hmux is still applying this restore. Run dure resume --all again once its status completes.", retry: status };
  }
  const publication = await collectManagedRehostPublication({
    opts: { rest: ["rehost", "publish", target.agentId], operationId, fromSession: target.sessionId, workspace: target.workspaceId },
    resolveBackend: async () => backend, requestBackend,
  });
  if (!publication.ok) {
    return { ...described, outcome: "failed", reason: publication.error?.remoteCode ?? publication.error?.code ?? "restore_publication_failed",
      message: "The agent restarted but its binding was not published. Run dure resume --all again to finish.", retry: status };
  }
  return { ...described, outcome: "restored", sessionId: execution.receipt.replacementReceipt.sessionId, replayed: execution.receipt.replayed };
}

const runsResumeRetry = (agentId, backend) => ["runs", "resume", agentId, "--backend", backend.profile.id];
const RETRYABLE_SKIPS = new Set(["hibernated", "closed", "provider_exited", "host_state_unknown", "host_still_running"]);

function reportEntry(plan, backend) {
  const { outcome: _outcome, source: _source, requireHostAbsent: _fence, ...entry } = plan;
  if (plan.outcome === "skipped" && !entry.retry && RETRYABLE_SKIPS.has(plan.reason)) {
    entry.retry = runsResumeRetry(plan.agentId, backend);
  }
  return entry;
}

export async function collectResumeAll({
  opts, resolveBackend, loadRegistry = () => ({ state: "absent", agents: [] }), command,
  requestBackend = performBackendProfileRequest, run = runBoundedCommand, settle, worktreeExists = existsSync,
}) {
  const base = { schemaVersion: 1, apiVersion: "dure.resume/v1", action: "resume_all", dryRun: Boolean(opts.dryRun) };
  const failure = (error) => ({ ...base, ok: false, error });
  if (!opts.all || opts.rest.length !== 0) return failure({ code: "resume_request_invalid", message: RESUME_HELP });
  let backend;
  try {
    backend = await resolveBackend();
    if (!backend?.profile || backend.error) return failure(backendRequestFailure(backend?.error, backend?.profile));
    if (backend.profile.transport.kind !== "local") {
      return failure({ code: "resume_all_local_only", message: "dure resume --all restores agents on this machine. Run it on the remote host itself." });
    }
    const manifest = await run([command, "capabilities", "--json"], { timeoutMs: NATIVE_QUERY_TIMEOUT_MS });
    let capabilities;
    try { capabilities = manifest.kind === "success" ? JSON.parse(manifest.stdout) : undefined; } catch { /* Refused below. */ }
    if (!supportsHmuxCapability(capabilities, HOST_ABSENT_CAPABILITY)) {
      return failure({ code: "resume_all_runtime_update_required",
        message: "This Hmux runtime cannot prove a Host is gone before replacing it. Update Dure and retry; no agent was changed." });
    }
    const registry = loadRegistry();
    const known = await listKnownAgents({ backend, requestBackend, registry });
    if (known.error) return failure(known.error);
    const context = { backend, requestBackend, command, run, settle, worktreeExists, includeExited: Boolean(opts.includeExited) };
    const plans = await mapPool(known.agents, INSPECT_CONCURRENCY, (agent) => planAgent(agent, context));
    const targets = plans.filter((plan) => plan.outcome === "restore");
    const outcomes = opts.dryRun ? [] : await mapPool(targets, RESTORE_CONCURRENCY, (target) => restoreAgent(target, context));
    const settled = [...plans.filter((plan) => plan.outcome !== "restore"), ...outcomes];
    const pick = (outcome) => settled.filter((plan) => plan.outcome === outcome).map((plan) => reportEntry(plan, backend));
    const report = { restored: pick("restored"), alreadyRunning: pick("running"), skipped: pick("skipped"), failed: pick("failed") };
    const restorable = opts.dryRun ? { restorable: targets.map((plan) => reportEntry(plan, backend)) } : {};
    return { ...base, ok: report.failed.length === 0, backend: { id: backend.profile.id },
      inventory: { complete: known.complete, agents: known.agents.length, clientRegistry: registry.state }, ...restorable, ...report };
  } catch (error) {
    return failure(error?.code ? { code: error.code, message: error.message } : backendRequestFailure(error, backend?.profile));
  }
}

function formatEntries(title, entries, describe) {
  return entries.length ? [`${title}:`, ...entries.flatMap(describe)] : [];
}

const label = (entry) => `${entry.name ?? entry.agentId} (${entry.agentId})`;

export function formatResumeAll(report) {
  if (!report.ok && report.error) return `${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Restore failed"}`;
  const quiet = report.skipped.filter((entry) => QUIET_SKIP_REASONS.has(entry.reason));
  const listed = report.skipped.filter((entry) => !QUIET_SKIP_REASONS.has(entry.reason));
  const withReason = (entry) => [`  ${label(entry)}: ${entry.reason}. ${entry.message}`,
    ...(entry.retry ? [`    Retry: ${rehostCommandLine(entry.retry)}`] : [])];
  const planned = report.dryRun ? report.restorable.length : report.restored.length;
  return [
    `${report.dryRun ? "Would restore" : "Restored"} ${planned}, already running ${report.alreadyRunning.length}, ` +
      `skipped ${report.skipped.length}, failed ${report.failed.length}.`,
    ...formatEntries("Would restore", report.restorable ?? [], (entry) => [`  ${label(entry)}: conversation ${entry.conversationId}`]),
    ...formatEntries("Restored", report.restored, (entry) => [`  ${label(entry)}: conversation ${entry.conversationId}`]),
    ...formatEntries("Failed", report.failed, withReason),
    ...formatEntries("Skipped", listed, withReason),
    ...(quiet.length ? [`${quiet.length} stopped or unmanaged agents were not restored; --json lists them.`] : []),
    ...(report.inventory.complete ? [] : ["The agent list was incomplete, so some agents may not have been considered."]),
  ].join("\n");
}
