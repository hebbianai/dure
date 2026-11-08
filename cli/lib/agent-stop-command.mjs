import { randomUUID } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import {
  canonicalAgentStopApplyRevisionV1,
  parseCanonicalAgentStopResultV1,
  projectCanonicalAgentStopV1,
} from "./contracts/agent-dispatch-stop.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { formatRunCandidates, listRunRecords, selectRunRecord } from "./run-agent-selection.mjs";

export const AGENT_STOP_HELP = `Usage:
  dure stop <agent-name-or-id> [--target-panel-id ID] --yes [--json]
  dure hmux stop --name <agent-name-or-id> [--target-panel-id ID] --yes [--json]

Stop one Agent and remove its registration and panes. Workspaces, worktrees and
conversation history are preserved. Use project/name for ambiguous names.
Requires the Dure app selected by DURE_APP_CHANNEL; the app routes each Agent to
its owning backend. --backend is not supported by this client-scoped command.
A Run the app has not opened, such as a schedule occurrence, is stopped through
its Run record on DURE_BACKEND_PROFILE or the local backend; select it by its
Agent ID, operation ID or Run name.
Omit --yes only in an interactive terminal to confirm there.
Uses dispatch.stop for backend-owned Agents; no /exit or terminal key injection.
After an uncertain response, retry the same Agent ID to reconcile the recorded
stop before cleanup. A successful receipt confirms cleanup; a failure does not.
JSON uses dure.agent-stop/v1. Exit 0 means cleaned; exit 1 means failed.`;

export function parseAgentStopCommand(args) {
  if (args.length === 0 || args.length === 1 && ["--help", "-h", "help"].includes(args[0])) {
    return { help: true };
  }
  const options = { rest: ["stop"] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      options.rest.push(...args.slice(index + 1));
      break;
    }
    if (["--yes", "--json"].includes(arg)) {
      const key = arg.slice(2);
      if (options[key]) throw new Error(AGENT_STOP_HELP);
      options[key] = true;
    } else if (["--name", "--target-panel-id"].includes(arg)) {
      const key = arg === "--name" ? "name" : "targetPanelId";
      const value = args[++index];
      if (options[key] !== undefined || !value?.trim() || value.startsWith("--")) throw new Error(AGENT_STOP_HELP);
      options[key] = value;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unsupported stop option: ${arg}\n${AGENT_STOP_HELP}`);
    } else options.rest.push(arg);
  }
  if (options.rest.length !== (options.name ? 1 : 2) || !(options.name ?? options.rest[1])?.trim()) {
    throw new Error(AGENT_STOP_HELP);
  }
  return options;
}

/** The app presents no Agent for this selector. A Run launched without the app,
 * such as a schedule occurrence, is owned by its backend Run record until
 * `dure runs open` presents it, so the stop continues there. */
export function stopsRunRecord(receipt, options) {
  return receipt?.ok === false && receipt.error?.code === "pane_not_found" &&
    !options.targetPanelId && isDureDomainIdV1(options.name ?? options.rest[1]);
}

class RunRecordStopError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function invalidStopReceipt() {
  return new RunRecordStopError("agent_dispatch_stop_response_invalid",
    "The backend returned an unexpected stop receipt. Inspect the Run with dure runs show before retrying.");
}

/** A preserve-workspace stop this command may confirm or resume. */
function appliesPreservingWorkspace(receipt) {
  const { kind } = projectCanonicalAgentStopV1(receipt);
  return receipt?.workspaceDisposition === "preserve" && (kind === "pending_confirmation" || kind === "resume_apply");
}

/** Stops one unpresented Run through its backend's dispatch.stop journal,
 * keeping its workspace: the status → preview → apply sequence the app runs for
 * an Agent it presents, without a presentation to clean up. Returns
 * `appReceipt` unchanged when the backend has no Run record for the selector. */
export async function collectRunRecordStop({
  selector, appReceipt, resolveBackend, requestBackend = performBackendProfileRequest,
}) {
  let backend;
  let agent;
  let receipt;
  try {
    backend = await resolveBackend();
    if (!backend?.profile || backend.error) {
      return { ok: false, error: backendRequestFailure(backend?.error, backend?.profile) };
    }
    const listed = await listRunRecords({ backend, requestBackend, selector });
    if (listed.error) return { ok: false, error: listed.error };
    const selection = selectRunRecord(listed.page, selector, (agentId) => ["stop", agentId, "--yes"]);
    if (selection.error) return { ok: false, error: selection.error };
    const run = selection.run;
    if (!run) return appReceipt;
    agent = { id: run.agentId, name: run.name };
    const request = async (operation, body) => {
      const response = await requestBackend(backend.profile, {
        requestId: randomUUID(), operation, requiredCapabilities: [operation], body,
      }, backend.transportOptions);
      const parsed = parseCanonicalAgentStopResultV1(response.result, run.operationId);
      if (parsed === undefined || (parsed && parsed.agentId !== run.agentId)) throw invalidStopReceipt();
      return parsed;
    };

    receipt = await request("dispatch.stop.status", { schemaVersion: 1, spawnOperationId: run.operationId });
    const observed = projectCanonicalAgentStopV1(receipt).kind;
    if (observed === "resume_apply" && receipt.workspaceDisposition !== "preserve") {
      throw new RunRecordStopError("agent_dispatch_stop_failed",
        "An existing stop removes the workspace; resume it through its original cleanup flow");
    }
    if (observed !== "forget_presentation" && !appliesPreservingWorkspace(receipt)) {
      receipt = await request("dispatch.stop.preview", {
        schemaVersion: 1, spawnOperationId: run.operationId, workspaceDisposition: "preserve",
      });
      if (receipt?.workspaceDisposition !== "preserve") throw invalidStopReceipt();
    }
    if (appliesPreservingWorkspace(receipt)) {
      const planned = receipt;
      receipt = await request("dispatch.stop.apply", {
        schemaVersion: 1, operationId: planned.operationId, planToken: planned.planToken,
        expectedJournalRevision: canonicalAgentStopApplyRevisionV1(planned),
      });
      if (!receipt || receipt.operationId !== planned.operationId || receipt.planToken !== planned.planToken ||
          receipt.workspaceDisposition !== planned.workspaceDisposition) {
        throw invalidStopReceipt();
      }
    }
    if (projectCanonicalAgentStopV1(receipt).kind !== "forget_presentation") {
      return { ok: false, dispatchStop: receipt, agent, error: { code: `agent_dispatch_stop_${receipt.status}`,
        message: "The backend retained the Run's runtime. Inspect it with dure runs show before retrying." } };
    }
    return { ok: true, dispatchStop: receipt, agent };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof RunRecordStopError
        ? { code: error.code, message: error.message }
        : backendRequestFailure(error, backend?.profile),
      ...(receipt ? { dispatchStop: receipt } : {}),
      ...(agent ? { agent } : {}),
    };
  }
}

export function agentStopReport(receipt, httpOk) {
  const valid = receipt && typeof receipt === "object" && typeof receipt.ok === "boolean" &&
    (!receipt.ok || receipt.dispatchStop || receipt.stop || receipt.cleanup);
  return {
    ...(valid ? receipt : { error: { code: "agent_stop_response_invalid", message: "The app did not return a stop receipt. Inspect the Agent before retrying." } }),
    apiVersion: "dure.agent-stop/v1", ok: Boolean(httpOk && valid && receipt.ok),
  };
}

export function formatAgentStopReport(report, name) {
  if (!report.ok) {
    return [`${report.error?.code ?? "agent_stop_failed"}: ${report.error?.message ?? "Agent cleanup failed"}`,
      ...formatRunCandidates(report.error?.candidates)].join("\n");
  }
  const label = report.agent?.name ?? name;
  if (report.dispatchStop) return `${label} stopped and removed (${report.dispatchStop.status})${report.dispatchStop.workspaceDisposition === "preserve" ? "; workspace preserved" : ""}`;
  if (report.cleanup) return `${label} exited registration cleaned (${report.cleanup.sourceState || report.cleanup.reason}, ${report.cleanup.sessionId}, ${report.cleanup.workspaceId})`;
  return `${label} provider stopped (${report.stop.outcome}, ${report.stop.sessionId}, ${report.stop.workspaceId})`;
}
