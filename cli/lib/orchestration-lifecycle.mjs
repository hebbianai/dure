import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendTransportError } from "./backend-transport.mjs";
import {
  createOrchestrationRequest,
  defaultOrchestrationEndpoint,
  loadCursor,
  managedSessionEnrollmentIdempotencyKey,
  orchestrationIntegrationInstallRootRef,
  requestOrchestration,
} from "./orchestration-client.mjs";

const EVENTS = new Set(["identity", "checkpoint", "session_start", "wakeup"]);
const CURRENT_SESSION_TARGET_REFERENCE = "orchestration.current-session";
const SESSION_ENVIRONMENT = Object.freeze([
  ["sessionId", "HMUX_SESSION_ID"],
  ["workspaceId", "HMUX_WORKSPACE_ID"],
  ["runnerPrincipal", "HMUX_RUNNER_PRINCIPAL"],
  ["runnerInstance", "HMUX_RUNNER_INSTANCE"],
  ["channelEpoch", "HMUX_CHANNEL_EPOCH"],
  ["hostInstanceId", "HMUX_HOST_INSTANCE_ID"],
  ["terminalEpoch", "HMUX_TERMINAL_EPOCH"],
]);

export function lifecycleContext(environment = process.env, event = "session_start") {
  if (!EVENTS.has(event)) throw new Error(`unsupported orchestration lifecycle event: ${event}`);
  const required = {
    participant: environment.DURE_ORCHESTRATION_PARTICIPANT,
    endpointRef: environment.DURE_ORCHESTRATION_ENDPOINT_REF,
    sessionIdentity: environment.DURE_ORCHESTRATION_SESSION_IDENTITY,
    generation: environment.DURE_ORCHESTRATION_GENERATION,
    checkpointPath: environment.DURE_ORCHESTRATION_CHECKPOINT,
  };
  if (Object.values(required).some((value) => typeof value !== "string" || value.length === 0)) {
    return null;
  }
  if (!/^\d+$/u.test(required.generation) || Number(required.generation) < 1) {
    throw new Error("orchestration generation is invalid");
  }
  const checkpointPath = path.resolve(required.checkpointPath);
  const cursor = loadCursor(checkpointPath);
  return {
    event,
    participant: required.participant,
    endpointRef: required.endpointRef,
    sessionIdentity: required.sessionIdentity,
    generation: Number(required.generation),
    lastAcknowledgedCursor: cursor,
    checkpointPresent: fs.existsSync(checkpointPath),
  };
}

export function lifecycleHookPayload(environment = process.env, event = "session_start") {
  const context = lifecycleContext(environment, event);
  if (!context) return {};
  return renderLifecycleHookPayload(context);
}

function renderLifecycleHookPayload(context) {
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext:
        `Dure durable orchestration inbox is available through the installed MCP server. ` +
        `Participant ${context.participant}; endpoint ${context.endpointRef}; ` +
        `session ${context.sessionIdentity}; generation ${context.generation}; ` +
        `resume after acknowledged Event cursor ${context.lastAcknowledgedCursor}. ` +
        `Do not inject orchestration payloads into terminal input.`,
    },
  };
}

export function parseOrchestrationIntegrationReceipt(receipt) {
  if (
    receipt?.schemaVersion !== 1 ||
    typeof receipt.provider !== "string" ||
    typeof receipt.version !== "string" ||
    typeof receipt.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.digest) ||
    typeof receipt.channel !== "string" ||
    !Array.isArray(receipt.capabilities)
  ) {
    throw new Error("orchestration integration receipt is invalid");
  }
  return receipt;
}

function exactSession(environment, providerId) {
  const session = { providerId };
  for (const [field, variable] of SESSION_ENVIRONMENT) {
    const value = environment[variable];
    if (typeof value !== "string" || value.length === 0) return null;
    session[field] = value;
  }
  return session;
}

function defaultCheckpointPath(environment, endpointRef) {
  const root = environment.DURE_HOME || path.join(os.homedir(), ".dure");
  return path.join(root, "orchestration", "cursors", `${endpointRef}.json`);
}

export function currentOrchestrationCheckpointPath(environment, endpointRef) {
  const configured = environment.DURE_ORCHESTRATION_CHECKPOINT;
  return typeof configured === "string" && configured.length > 0
    ? path.resolve(configured)
    : defaultCheckpointPath(environment, endpointRef);
}

function canCreateCurrentSessionRun(error) {
  return (
    error instanceof BackendTransportError &&
    error.code === "backend_transport_remote_error" &&
    error.details?.disposition === "unassigned"
  );
}

function currentSessionEnrollment(environment, receiptPath, integrationReceipt) {
  const receipt = parseOrchestrationIntegrationReceipt(
    integrationReceipt === undefined
      ? JSON.parse(fs.readFileSync(receiptPath, "utf8"))
      : integrationReceipt,
  );
  const session = exactSession(environment, receipt.provider);
  if (!session) return null;
  const installRootRef = orchestrationIntegrationInstallRootRef(
    receipt.provider,
    receipt.digest,
  );
  if (!installRootRef) throw new Error("orchestration integration receipt is invalid");
  return {
    endpoint: defaultOrchestrationEndpoint(environment),
    integrationReceipt: {
      installRootRef,
      version: receipt.version,
      digest: receipt.digest,
      channel: receipt.channel,
      capabilities: receipt.capabilities,
    },
    session,
  };
}

async function enrollCurrentSession(
  enrollment,
  predecessor,
  { request, now, authorization, environment },
  integrationReceipt = enrollment.integrationReceipt,
) {
  const response = await request(
    enrollment.endpoint,
    createOrchestrationRequest({
      method: "run.create",
      body: {
        schemaVersion: 1,
        workflowKindRef: "workflow.existing-session-reporting",
        task: {
          summary: "Report the current managed session",
          instructions:
            "Publish durable Markdown Messages and Decisions through the orchestration service.",
        },
        session: enrollment.session,
        integrationReceipt,
        runtimeRef: "runtime.hmux",
        targetReference: CURRENT_SESSION_TARGET_REFERENCE,
        idempotencyKey: managedSessionEnrollmentIdempotencyKey(
          enrollment.session,
          integrationReceipt,
          predecessor,
        ),
        createdAtMs: now(),
      },
    }),
    { authorization, environment },
  );
  return response.receipt?.context;
}

async function readCurrentSessionContext(
  enrollment,
  { request, authorization, environment },
) {
  const response = await request(
    enrollment.endpoint,
    createOrchestrationRequest({
      method: "dispatch.context.get",
      body: {
        schemaVersion: 1,
        session: enrollment.session,
      },
    }),
    { authorization, environment },
  );
  return response.receipt;
}

export async function resolveCurrentDispatchContext(
  environment = process.env,
  {
    integrationReceipt,
    receiptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "install-receipt.json",
    ),
    request = requestOrchestration,
    now = Date.now,
    authorization = environment.DURE_ORCHESTRATION_AUTHORIZATION,
  } = {},
) {
  const enrollment = currentSessionEnrollment(environment, receiptPath, integrationReceipt);
  if (!enrollment) return null;
  const observedAtMs = now();
  const enroll = (predecessor, integrationReceipt) =>
    enrollCurrentSession(
      enrollment,
      predecessor,
      {
        request,
        now: () => observedAtMs,
        authorization,
        environment,
      },
      integrationReceipt,
    );
  let context;
  try {
    context = await readCurrentSessionContext(enrollment, {
      request,
      authorization,
      environment,
    });
  } catch (error) {
    if (!canCreateCurrentSessionRun(error)) throw error;
    context = await enroll();
  }
  if (context?.successorRequired === true) {
    context = await enroll(context.target, context.integrationReceipt);
  }
  return context;
}

export async function resolveSuccessorDispatchContext(
  environment = process.env,
  predecessor,
  {
    integrationReceipt,
    receiptPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "install-receipt.json",
    ),
    request = requestOrchestration,
    now = Date.now,
    authorization = environment.DURE_ORCHESTRATION_AUTHORIZATION,
  } = {},
) {
  const enrollment = currentSessionEnrollment(environment, receiptPath, integrationReceipt);
  if (!enrollment) return null;
  const current = await readCurrentSessionContext(enrollment, {
    request,
    authorization,
    environment,
  });
  return enrollCurrentSession(
    enrollment,
    predecessor,
    { request, now, authorization, environment },
    current.integrationReceipt,
  );
}

export async function resolveLifecycleHookPayload(
  environment = process.env,
  event = "session_start",
  options = {},
) {
  const configured = lifecycleContext(environment, event);
  if (configured) return renderLifecycleHookPayload(configured);
  if (!EVENTS.has(event)) throw new Error(`unsupported orchestration lifecycle event: ${event}`);
  const context = await resolveCurrentDispatchContext(environment, options);
  if (!context) return {};
  const checkpointPath = currentOrchestrationCheckpointPath(
    environment,
    context?.endpointFence?.endpointRef,
  );
  const resolved = {
    event,
    participant: context?.participant,
    endpointRef: context?.endpointFence?.endpointRef,
    sessionIdentity: context?.endpointFence?.sessionIdentity,
    generation: context?.endpointFence?.generation,
    lastAcknowledgedCursor: loadCursor(checkpointPath),
    checkpointPresent: fs.existsSync(checkpointPath),
  };
  if (
    typeof resolved.participant !== "string" ||
    typeof resolved.endpointRef !== "string" ||
    typeof resolved.sessionIdentity !== "string" ||
    !Number.isSafeInteger(resolved.generation) ||
    resolved.generation < 1
  ) {
    throw new Error("orchestration Dispatch context receipt is invalid");
  }
  const payload = renderLifecycleHookPayload(resolved);
  payload.hookSpecificOutput.additionalContext +=
    ` Capability context: ${JSON.stringify(context)}. ` +
    `Cursor checkpoint: ${checkpointPath}.`;
  return payload;
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  if (index === -1) return undefined;
  return argumentsList[index + 1];
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const event = argumentValue(process.argv.slice(2), "--event") ?? "session_start";
  process.stdout.write(
    `${JSON.stringify(await resolveLifecycleHookPayload(process.env, event))}\n`,
  );
}
