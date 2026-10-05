import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { collectAgentSpawnQuery } from "./agent-spawn-query.mjs";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { collectManagedRehostNamed } from "./managed-rehost-named.mjs";
import { collectManagedRehostPreview, formatManagedRecoveryCommands } from "./managed-rehost-preview.mjs";
import { presentAgentRunRuntime } from "./run-presentation.mjs";
import { collectRunAccountSwitch, formatRunAccountSwitch } from "./run-account-switch.mjs";
import { assertNoConversationProjectOptions } from "./conversation-project-options.mjs";

export const RUNS_HELP = `Usage:
  dure runs list [--cursor CURSOR] [--backend ID] [--json]
  dure runs show <agent-id|operation-id|name> [--backend ID] [--json]
  dure runs open <agent-id|operation-id|name> --space ID [--backend ID] [--json]
  dure runs resume <agent-id|operation-id|name> [--confirm-restart] [--backend ID] [--json]
  dure runs switch-account <agent-id|operation-id|name> --account ACCOUNT_ID|default
                           [--confirm-restart] [--backend ID] [--json]

Lists durable Run records, including headless Runs and earlier app/Host generations.
launchState describes the original launch, not current process liveness. List is
bounded to 64 records; continue with nextCursor until null. Names must be unique.
Show reads the current runtime selection. Open attaches that existing runtime and
never launches a provider. Resume previews exact local recovery; add
--confirm-restart to execute and publish it. A confirmed stopped source waiting
for a deferred target uses backend wake; an existing native source uses native
rehost. Both preserve the conversation without an open app. Remote resume is not
supported here.
Resume retains the original project and working folder. Moving an existing
conversation to another project is not supported; --project, --path and --cwd
are refused before recovery. Use run --project PROJECT for a new conversation.
A retained record alone cannot recover a source whose conversation or native
recovery metadata is unavailable after reboot.
Retain resume's exact status/retry commands after an uncertain response; do not
repeat a name-based resume. Wake retains the operation ID, journal revision and
request key, and publishes through the backend. Run a separate publish command
only when returned for native rehost. Use open after recovery to place the pane.
For live Session observations use dure ls. Use the Session/workspace from show
with dure read <session-id> --workspace ID or dure send <session-id> --workspace ID.

Switch-account previews by default; --confirm-restart executes the same backend
transition as the UI account selector. It preserves the exact conversation and
Chat/Terminal mode for Claude and Codex, on local and SSH backends, without an app.
List registered account IDs/generations with dure recovery get claude or codex
on the same --backend. --account default explicitly selects provider defaults.
An unregistered account must first be prepared on that backend through Dure's
account settings. Busy work is retained, never interrupted or silently resent.
Keep the returned exact runtime switch command for retries after response loss.
Automatic account recovery is separate: see dure recovery --help; it is opt-in.`;

export function parseRunsOptions(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { backend: { type: "string" }, cursor: { type: "string" }, space: { type: "string" }, account: { type: "string" },
      project: { type: "string", short: "p" }, path: { type: "string" }, cwd: { type: "string" },
      "confirm-restart": { type: "boolean" }, json: { type: "boolean" } } });
  assertNoConversationProjectOptions({ ...values,
    projectSpecified: Object.hasOwn(values, "project"), pathSpecified: Object.hasOwn(values, "path") });
  return { ...values, rest: positionals, confirmRestart: values["confirm-restart"],
    backendSpecified: values.backend !== undefined };
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const STATES = new Set(["applying", "ready_to_succeed", "inspect_before_retry", "retry_required",
  "prompt_delivery_uncertain", "succeeded", "failed", "manual_intervention_required"]);
function validPage(value) {
  return value?.schemaVersion === 1 && Array.isArray(value.runs) && value.runs.length <= 64 &&
    (value.nextCursor === null || (typeof value.nextCursor === "string" && TOKEN.test(value.nextCursor))) &&
    value.runs.every((run) => [run.agentId, run.operationId, run.name, run.providerId, run.workspaceId, run.projectId]
      .every((id) => typeof id === "string" && TOKEN.test(id)) && STATES.has(run.launchState) &&
      Number.isSafeInteger(run.createdAtMs) && run.createdAtMs >= 0 &&
      Number.isSafeInteger(run.updatedAtMs) && run.updatedAtMs >= run.createdAtMs) &&
    value.runs.every((run, i) => i === 0 || run.operationId > value.runs[i - 1].operationId) &&
    (value.nextCursor === null || (value.runs.length === 64 && value.nextCursor === value.runs.at(-1).operationId));
}

export async function collectRunsCommand({
  opts, resolveBackend, resolveTarget, descriptor, command,
  requestBackend = performBackendProfileRequest, run, present = presentAgentRunRuntime,
}) {
  const [action, selector] = opts.rest;
  const base = { schemaVersion: 1, apiVersion: "dure.runs/v1", action };
  const failure = (error, details = {}) => ({ ...base, ok: false, ...details, error });
  if (!["list", "show", "open", "resume", "switch-account"].includes(action) ||
      opts.rest.length !== (action === "list" ? 1 : 2) ||
      (action !== "list" && !TOKEN.test(selector ?? "")) ||
      (opts.cursor !== undefined && (action !== "list" || !TOKEN.test(opts.cursor))) ||
      (action === "open" ? !opts.space : opts.space !== undefined) ||
      (opts.confirmRestart && !["resume", "switch-account"].includes(action)) ||
      (action === "switch-account" ? !TOKEN.test(opts.account ?? "") : opts.account !== undefined)) {
    return failure({ code: "runs_request_invalid", message: RUNS_HELP });
  }
  let backend;
  try {
    backend = await resolveBackend();
    if (!backend?.profile || backend.error) return failure(backendRequestFailure(backend?.error, backend?.profile));
    const response = await requestBackend(backend.profile, {
      requestId: randomUUID(), operation: "agent_spawn.list", requiredCapabilities: ["agent_spawn.list"],
      body: { schemaVersion: 1, ...(opts.cursor ? { after: opts.cursor } : {}), ...(selector ? { selector } : {}) },
    }, backend.transportOptions);
    const page = response.result;
    if (!validPage(page) || (selector && page.runs.some((entry) =>
        ![entry.name, entry.agentId, entry.operationId].includes(selector))) || (opts.cursor && page.runs.some((entry) => entry.operationId <= opts.cursor))) {
      return failure({ code: "runs_response_invalid" });
    }
    if (action === "list") return { ...base, ok: true, backend: response.backend, ...page };
    // Exact IDs win over name collisions. A partial page cannot establish uniqueness.
    const exact = page.runs.filter((entry) => entry.agentId === selector || entry.operationId === selector);
    const matches = exact.length ? exact : page.runs;
    if (matches.length !== 1 || page.nextCursor !== null) {
      return failure({ code: page.runs.length ? "run_selector_ambiguous" : "run_not_found",
        message: "Select one exact Agent or operation ID from dure runs list." });
    }
    const selected = matches[0];
    if (action === "resume") {
      const recover = opts.confirmRestart ? collectManagedRehostNamed : collectManagedRehostPreview;
      const recovery = await recover({ opts: { rest: ["rehost", selector], confirmRestart: opts.confirmRestart },
        agentId: selected.agentId, resolveBackend: async () => backend, requestBackend, command, run });
      return { ...base, ok: recovery.ok && !recovery.publicationError, run: selected, recovery,
        ...(!recovery.ok || recovery.publicationError ? { error: recovery.error ?? recovery.publicationError } : {}) };
    }
    const runtime = await collectAgentRuntimeCommand({ args: ["get", selected.agentId],
      resolveBackend: async () => backend, requestBackend });
    if (!runtime.ok) return failure(runtime.error, { run: selected });
    if (action === "switch-account") {
      const accountSwitch = await collectRunAccountSwitch({ run: selected, observation: runtime.result,
        account: opts.account, confirmRestart: opts.confirmRestart, backend, requestBackend });
      return { ...base, ok: accountSwitch.ok, run: selected, accountSwitch,
        ...(!accountSwitch.ok ? { error: accountSwitch.error } : {}) };
    }
    if (action === "show") return { ...base, ok: true, run: selected, runtime: runtime.result };
    const target = await resolveTarget(opts.space);
    const report = await collectAgentSpawnQuery({ action: "status", operationId: selected.operationId,
      backend, requestBackend });
    if (!report.receipt) return failure(report.error ?? { code: "run_receipt_unavailable" }, { run: selected });
    const presentation = await present({ report, currentRuntime: runtime.result, target,
      profile: backend.profile, projectPath: runtime.result.projectionContext?.project?.rootPath,
      descriptor: typeof descriptor === "function" ? descriptor() : descriptor });
    return { ...base, ok: true, run: selected, presentation };
  } catch (error) {
    return failure(error?.code ? { code: error.code, message: error.message } : backendRequestFailure(error, backend?.profile));
  }
}

export function formatRunsCommand(report) {
  if (report.accountSwitch) return formatRunAccountSwitch(report.accountSwitch);
  if (!report.ok) return `${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Run request failed"}` +
    (report.recovery?.continuation ? `\n${formatRecovery(report.recovery)}` : "");
  if (report.action === "list") return [
    "AGENT ID\tNAME\tPROVIDER\tLAUNCH STATE (not liveness)",
    ...report.runs.map((entry) => `${entry.agentId}\t${entry.name}\t${entry.providerId}\t${entry.launchState}`),
    ...(report.nextCursor ? [`Next cursor: ${report.nextCursor}`] : []),
  ].join("\n");
  if (report.action === "resume") return formatRecovery(report.recovery);
  if (report.action === "open") return `${report.run.name}: ${report.presentation.state} ${report.presentation.pane?.spaceId}/${report.presentation.pane?.panelId}`;
  const source = report.runtime.receipt?.authority?.authority;
  return [
    `${report.run.name} (${report.run.agentId}): ${report.runtime.state} runtime selection`,
    "Selection is durable metadata, not current process liveness.",
    ...(source ? [`Session: ${source.binding.sessionId}\nWorkspace: ${source.runtimeWorkspaceId}`] : []),
    `Operation: ${report.run.operationId}`,
    `Open: dure runs open ${report.run.agentId} --space <space-id>`,
    `Recover: dure runs resume ${report.run.agentId}`,
  ].join("\n");
}

function formatRecovery(recovery) {
  return [
    `${recovery.agentId}: ${recovery.state} (${recovery.continuation?.kind === "runtime_wake" ? `backend ${recovery.backendExecution ?? "not_requested"}` : `native ${recovery.nativeExecution}`})`,
    ...(recovery.publication ? [`Binding publication: ${recovery.publication}`] : []),
    ...formatManagedRecoveryCommands(recovery.continuation),
  ].join("\n");
}
