import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { matchingAgents } from "./client-registry.mjs";
import { collectAgentSpawnQuery } from "./agent-spawn-query.mjs";
import { collectSessionQuery } from "./session-query.mjs";
import { boundedString, decimal, sameGeneration } from "./session-runtime-projection.mjs";
import { readDelegatedWorkflow } from "./workflow-completion.mjs";

export const WAIT_HELP = `dure wait — Observe one completion condition without controlling its target

  dure wait <agent-or-session> [--workspace ID] [--after-turn N --terminal-epoch ID]
  dure wait --operation-id ID
  dure wait --task ID --dispatch ID --generation N

Options: --backend ID, --timeout SECONDS (default 600), --deadline-ms N (default 2500), --json

Response: waits for the next Host-reported completed-turn count after the initial
snapshot. For a fast response or resuming a wait, use --after-turn and --terminal-epoch
from an earlier 'dure inspect <session> --workspace ID --json' or wait result.
Names resolve once; an explicit session ID plus --workspace needs no app registry.
Rehosting changes the target generation and cannot complete the old wait.
Response end does not prove a particular prompt was accepted or a task succeeded.

Operation: reads the same dure run/spawn request; success means execution setup and
prompt delivery completed, not provider response or task completion. Never retries execution.
Task: reads the exact delegated task/dispatch generation completed by 'dure workflow done'.

JSON is one dure.wait/v1 result with the target, observation and outcome.
Exit: 0 condition met; 1 reported failure/action required; 2 unknown/invalid;
124 observation deadline (target outcome unknown); 130 observer interrupted.
Timeout and interruption do not stop the Agent. Repeat the exact target to resume.
`;

function invalid(message) {
  throw Object.assign(new Error(message), { code: "wait_arguments_invalid" });
}

export function parseWaitArguments(args) {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      "operation-id": { type: "string" }, task: { type: "string" }, dispatch: { type: "string" },
      generation: { type: "string" }, workspace: { type: "string" }, backend: { type: "string" },
      "after-turn": { type: "string" }, "terminal-epoch": { type: "string" },
      timeout: { type: "string", default: "600" }, "deadline-ms": { type: "string", default: "2500" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return { help: true };
  const subject = values["operation-id"] !== undefined ? "run" : values.task !== undefined ? "task" : "response";
  const selectedFields = {
    run: ["operation-id"], task: ["task", "dispatch", "generation"],
    response: ["workspace", "after-turn", "terminal-epoch"],
  };
  const allowed = new Set([...selectedFields[subject], "backend", "timeout", "deadline-ms", "json"]);
  if (Object.keys(values).some((key) => !allowed.has(key)) ||
      positionals.length !== (subject === "response" ? 1 : 0)) invalid("Choose exactly one wait target. See dure wait --help.");
  if (subject !== "response" && selectedFields[subject].some((key) => !boundedString(values[key]))) invalid("The exact wait target is incomplete.");
  if (subject === "response" && (!boundedString(positionals[0]) ||
      ((values["after-turn"] === undefined) !== (values["terminal-epoch"] === undefined)) ||
      (values["after-turn"] !== undefined && (!decimal(values["after-turn"]) || !boundedString(values["terminal-epoch"]))) ||
      (values.workspace !== undefined && !boundedString(values.workspace)))) invalid("Use an exact target; --after-turn and --terminal-epoch must be supplied together.");
  const timeoutMs = Number(values.timeout) * 1000;
  const deadlineMs = Number(values["deadline-ms"]);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86400000 ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 10000) invalid("Use a timeout up to 86400 seconds and a request deadline of 1–10000 ms.");
  if (subject === "task" && (!/^[1-9][0-9]*$/u.test(values.generation) || !Number.isSafeInteger(Number(values.generation)))) invalid("Task generation must be a positive integer.");
  return {
    subject, query: positionals[0], workspaceId: values.workspace,
    operationId: values["operation-id"], taskId: values.task, dispatchId: values.dispatch,
    generation: values.generation === undefined ? undefined : Number(values.generation),
    afterTurn: values["after-turn"], terminalEpoch: values["terminal-epoch"],
    backend: values.backend, backendSpecified: values.backend !== undefined,
    timeoutMs, deadlineMs, json: values.json === true,
  };
}

function responseTarget(options, registry, backend) {
  if (options.workspaceId) return { sessionId: options.query, workspaceId: options.workspaceId };
  if (registry?.state !== "available") invalid("The name projection is unavailable or incomplete; use an exact session ID with --workspace.");
  const matches = matchingAgents(registry, options.query);
  if (matches.length !== 1) invalid("Select one Agent name, project/name, or exact session ID with --workspace.");
  const binding = matches[0].runtimeBinding;
  if (!binding || !boundedString(binding.sessionId) || !boundedString(binding.workspaceId)) {
    throw Object.assign(new Error("No native Session binding is available for this Agent."), { code: "wait_runtime_unavailable" });
  }
  const source = backend?.profile?.transport.kind === "ssh" ? "ssh" : "local";
  if (binding.source !== source || binding.hostId !== (source === "ssh" ? backend.profile.id : "local")) {
    invalid("Select the binding's exact backend with --backend, or use an explicit session ID and --workspace.");
  }
  return { sessionId: binding.sessionId, workspaceId: binding.workspaceId };
}

/** Consume existing query contracts; no screen parsing, runtime writer or retry action. */
export async function collectWait(options, {
  registry, backend, hmuxCommand,
  querySession = collectSessionQuery, queryRun = collectAgentSpawnQuery, queryTask = readDelegatedWorkflow,
  signal, now = () => performance.now(), pause = (ms) => sleep(ms, undefined, { signal }),
} = {}) {
  const startedAt = now();
  const { subject } = options;
  let target = subject === "run" ? { operationId: options.operationId }
    : subject === "task" ? { taskId: options.taskId, dispatchId: options.dispatchId, generation: options.generation }
    : { sessionId: options.query, workspaceId: options.workspaceId };
  let observation = null;
  let latestRevision = -1n;
  let lastError;
  const result = (state, exitCode, code, message) => ({
    apiVersion: "dure.wait/v1", subject, state, target, observation,
    ...(backend?.profile ? { backendId: backend.profile.id } : {}),
    durationMs: Math.max(0, Math.round(now() - startedAt)), exitCode,
    ...(code ? { error: { code, message, ...(lastError ? { cause: lastError } : {}) } } : {}),
  });
  try {
    if (backend?.error) throw backend.error;
    if (subject === "response") {
      target = { ...responseTarget(options, registry, backend),
        ...(options.afterTurn === undefined ? {} : { afterTurn: options.afterTurn, terminalEpoch: options.terminalEpoch }),
      };
    }
    while (!signal?.aborted) {
      const remaining = options.timeoutMs - (now() - startedAt);
      if (remaining <= 0) return result("unknown", 124, "wait_timeout", "Observation deadline reached. Query the same target; its outcome is not inferred and no execution was retried.");
      const deadlineMs = Math.max(1, Math.min(options.deadlineMs, Math.ceil(remaining)));
      let report;
      try {
        report = subject === "run"
          ? await queryRun({ action: "status", ...target, backend, deadlineMs })
          : subject === "task"
            ? await queryTask({ ...target, backend, deadlineMs })
            : await querySession({ action: "show", sessionId: target.sessionId, workspaceId: target.workspaceId, hmuxCommand, backend, deadlineMs });
      } catch (error) {
        report = { error: { code: error.code ?? "wait_observation_failed", message: error.message } };
      }
      if (signal?.aborted) break;
      lastError = report.error;
      if (lastError) {
        if (["hmux_session_query_timeout", "backend_transport_timeout"].includes(lastError.code)) {
          await pause(Math.min(500, Math.max(1, options.timeoutMs - (now() - startedAt))));
          continue;
        }
        return result("unknown", 2, lastError.code, "Completion observation is unavailable. Query the same target; no execution or prompt was retried.");
      }
      if (subject === "run") {
        if (!report.receipt) return result("unknown", 2, "wait_operation_not_found", "No receipt was found for this exact execution request.");
        const receipt = report.receipt;
        if (BigInt(receipt.lastSequence) >= latestRevision) {
          latestRevision = BigInt(receipt.lastSequence);
          observation = receipt;
          if (receipt.state === "succeeded") return result("completed", 0);
          if (["failed", "manual_intervention_required"].includes(receipt.state)) return result("failed", 1, receipt.terminalCode, "The execution request reported failure or requires intervention.");
          if (["retry_required", "inspect_before_retry", "prompt_delivery_uncertain"].includes(receipt.state)) return result("unknown", 2, "wait_operation_action_required", "Inspect the existing request's recovery receipt. Waiting never retries execution or prompt delivery.");
        }
      } else if (subject === "task") {
        observation = report.receipt;
        if (observation.status === "completed") return result("completed", 0);
        if (observation.status === "start_failed") return result("failed", 1, "wait_task_start_failed", "The delegated task could not start.");
      } else {
        const { runtime, liveness } = report.session;
        if (!liveness.exactGeneration || !runtime.agentRuntimeState) return result("unknown", 2, "wait_response_unavailable", "The Host has no exact response observation. Process liveness or silence cannot prove response completion.");
        if ((target.generation && !sameGeneration(target.generation, runtime.generation)) ||
            (target.terminalEpoch && target.terminalEpoch !== runtime.generation.terminalEpoch)) return result("unknown", 2, "wait_generation_changed", "The Session generation changed. The old response is not completed by a replacement.");
        target.generation ??= runtime.generation;
        target.terminalEpoch ??= runtime.generation.terminalEpoch;
        const current = runtime.agentRuntimeState;
        target.afterTurn ??= current.turnCompletedCount;
        if (BigInt(current.revision) >= latestRevision) {
          latestRevision = BigInt(current.revision);
          observation = current;
          if (BigInt(current.turnCompletedCount) > BigInt(target.afterTurn)) return result("completed", 0);
          if (current.lifecycle === "exited") return result("unknown", 2, "wait_response_exited", "The provider exited without an observed response completion; its response outcome is unknown.");
          if (current.attention !== "none") return result("unknown", 2, "wait_response_attention_required", "The provider requests attention; inspect its input, approval or error before continuing.");
        }
      }
      await pause(Math.min(500, Math.max(1, options.timeoutMs - (now() - startedAt))));
    }
    return result("unknown", 130, "wait_interrupted", "Only this observer was interrupted; its target was not stopped.");
  } catch (error) {
    return signal?.aborted
      ? result("unknown", 130, "wait_interrupted", "Only this observer was interrupted; its target was not stopped.")
      : result("unknown", 2, error.code ?? "wait_observation_failed", error.message);
  }
}

export async function runWaitCommand(args, { resolveContext, hmuxCommand, signal, output = (text) => process.stdout.write(text) }) {
  let options;
  let report;
  try {
    options = parseWaitArguments(args);
    if (options.help) { output(WAIT_HELP); return 0; }
    report = await collectWait(options, { ...await resolveContext(options), hmuxCommand, signal });
  } catch (error) {
    report = { apiVersion: "dure.wait/v1", state: "unknown", error: { code: "wait_arguments_invalid", message: error.message }, exitCode: 2 };
  }
  output(options?.json || args.includes("--json") ? `${JSON.stringify(report)}\n`
    : `${report.subject ?? "wait"}: ${report.state}${report.error ? ` — ${report.error.code}: ${report.error.message}` : " (selected condition only; other completion states are not implied)"}\n`);
  return report.exitCode;
}
