import { createInterface } from "node:readline";
import { callJevMcpTool, jevMcpTool } from "./jev-mcp-tool.mjs";
import { appControlMcpTools, callAppControlMcpTool } from "./app-control-mcp-tools.mjs";
import {
  checkpointCursor,
  createOrchestrationRequest,
  defaultOrchestrationEndpoint,
  exactAcknowledgementCheckpoint,
  loadCursor,
  requestOrchestration,
} from "./orchestration-client.mjs";
import { BackendTransportError } from "./backend-transport.mjs";
import { orchestrationFailureDetail } from "./orchestration-failure.mjs";
import { completionRequestSchema } from "./contracts/orchestration-completion.mjs";
import { interactionOpenRequestSchema } from "./contracts/orchestration-interaction.mjs";
import {
  currentOrchestrationCheckpointPath,
  parseOrchestrationIntegrationReceipt,
  resolveCurrentDispatchContext,
} from "./orchestration-lifecycle.mjs";
import {
  nextWorkCandidatesSchema,
  parseNextWorkCandidates,
  publishNextWorkDecision,
} from "./orchestration-next-work.mjs";

import { dispatchDeadlineSetSchema, dispatchDeadlineGetSchema } from "./contracts/dispatch-deadline.mjs";

const identitySchema = { type: "string", minLength: 1 };
const sessionFields = ["sessionId", "workspaceId", "providerId", "runnerPrincipal", "runnerInstance", "channelEpoch", "hostInstanceId", "terminalEpoch"];
const interactionReadSchema = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "authority", "interactionId", "participant", "readCapability"],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    authority: { type: "object", required: ["workspaceId"], properties: { workspaceId: identitySchema, tenantRef: identitySchema }, additionalProperties: false },
    interactionId: identitySchema, participant: identitySchema,
    readCapability: { ...identitySchema, description: "As the worker, copy context deliveryCapability with the endpointFence; as the author, the Dispatch interactionCapability." },
    endpointFence: {
      type: "object", additionalProperties: false,
      description: "Copy the worker endpointFence from dispatch context when reading as that worker; omit when reading as author. sessionIdentity changes after every restart or account switch: omit it to use this Session's current identity. A copied identity that is no longer current is replaced with this Session's current one and reported in the result.",
      required: ["endpointRef", "generation", "deliveryCapability", "acknowledgementCapability"],
      properties: { endpointRef: identitySchema, sessionIdentity: identitySchema,
        generation: { type: "integer", minimum: 1 }, deliveryCapability: identitySchema, acknowledgementCapability: identitySchema },
    },
  },
};
const tools = [
  ...[
    ["set", dispatchDeadlineSetSchema, "Set or clear one exact Dispatch deadline. Resolve context first and copy its target, interactionCapability and revision. Reuse the same body/key after an uncertain response. Overdue attention is a durable coordinator Message, never completion or interruption."],
    ["get", dispatchDeadlineGetSchema, "Read an exact Dispatch deadline, current revision/state and any committed overdue event cursor. This does not acknowledge the coordinator inbox."],
  ].map(([operation, schema, description]) => ({
    name: `orchestration_dispatch_deadline_${operation}`, description,
    inputSchema: { type: "object", required: ["body"], additionalProperties: false, properties: { body: schema } },
  })),
  {
    name: "orchestration_context_get_current",
    description:
      "Resolve the exact current managed Session and return its capability-bearing Dispatch context.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_interaction_open",
    description:
      "Open one nonblocking Markdown Message or one blocking Text/Select Decision for an explicit dispatch audience. Resolve orchestration_context_get_current first and copy the context fields as described in body; draft fields belong in body.interaction.common. Copying your coordinator grant targets your own coordinator, not another session. For a message to a discovered managed session use orchestration_message_open_exact_session.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: interactionOpenRequestSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_message_open_exact_session",
    description: "Send one durable Message to an explicitly discovered managed Session generation. Resolve the destination with sessions discovery and dispatch.context.get.exact-session first; copy its session and endpointFence.endpointRef. Never substitute the sender's context. The receipt's deliveries[].endpoint.sessionIdentity identifies the destination; acceptance is not a read or completion. Retry only an identical payload and idempotency key after an uncertain response.",
    inputSchema: {
      type: "object", required: ["body"], additionalProperties: false,
      properties: { body: {
        type: "object", additionalProperties: false,
        required: ["schemaVersion", "session", "expectedEndpointRef", "idempotencyKey", "interactionId", "title", "descriptionMarkdown", "openedAtMs"],
        properties: {
          schemaVersion: { type: "integer", const: 1 },
          session: { type: "object", required: sessionFields, additionalProperties: false,
            properties: Object.fromEntries(sessionFields.map((field) => [field, identitySchema])) },
          expectedEndpointRef: identitySchema, idempotencyKey: identitySchema, interactionId: identitySchema,
          title: identitySchema, descriptionMarkdown: identitySchema, openedAtMs: { type: "integer" },
        },
      } },
    },
  },
  {
    name: "orchestration_interaction_get",
    description: "Read one exact service-owned Message or Decision record.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: interactionReadSchema,
      },
    },
  },
  {
    name: "orchestration_interaction_progress",
    description: "Inspect one Message or Decision's committed delivery, wake, observation, acknowledgement and dispatch completion without consuming its inbox. Uses the same body as orchestration_interaction_get; observation is not task completion.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: { body: interactionReadSchema },
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_events_read",
    description:
      "Read this managed Session's durable Events after its persisted acknowledgement cursor.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 128,
          description: "Maximum Events to return; defaults to 128.",
        },
        acknowledgement: {
          type: "object",
          required: ["through", "idempotencyKey"],
          properties: {
            through: { type: "integer", minimum: 1 },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "orchestration_decision_answer",
    description: "Answer one exact Decision revision with Text or Select.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "object" },
      },
    },
  },
  {
    name: "orchestration_dispatch_complete",
    description:
      "Complete the exact Dispatch generation with a Markdown report. Resolve orchestration_context_get_current first and copy the context fields as described in body. Only explicitly supplied nextWorkCandidates open a successor Decision; no tracker is queried.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: completionRequestSchema,
        nextWorkCandidates: nextWorkCandidatesSchema,
      },
      additionalProperties: false,
    },
  },
  {
    name: "agent_goal_get",
    description:
      "Read the explicit goal for a Dure agent, including its latest revision, objective and active/paused/complete/failed state. Use the agent ID from its Dure conversation context or run receipt.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: {
          type: "object",
          required: ["schemaVersion", "agentId"],
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            agentId: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "agent_goal_put",
    description:
      "Start or update an explicitly requested Dure goal. The common backend continues successful segments in the same conversation; no tracker or mandatory next-work Decision is introduced. Preserve the upper objective and latest revision from agent_goal_get (0 only for a new goal). Keep active while useful work remains, pause for actual waiting, and mark complete only after verifying the full outcome. A stale revision is a changed direction to reconcile, not a mutation to resend blindly. Pausing stops future continuation without interrupting already admitted work.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: {
          type: "object",
          required: [
            "schemaVersion",
            "agentId",
            "expectedRevision",
            "idempotencyKey",
            "objective",
            "status",
          ],
          properties: {
            schemaVersion: { type: "integer", const: 1 },
            agentId: { type: "string", minLength: 1 },
            expectedRevision: { type: "integer", minimum: 0 },
            idempotencyKey: { type: "string", minLength: 1, maxLength: 160 },
            objective: { type: "string", minLength: 1 },
            status: {
              type: "string",
              enum: ["active", "paused", "complete", "failed"],
            },
            detail: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
];

function toolResult(receipt, supplement) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          supplement === undefined ? receipt : { completion: receipt, ...supplement },
        ),
      },
    ],
    structuredContent: receipt,
  };
}

async function withBackendRejectionDetails(action) {
  try {
    return await action();
  } catch (error) {
    if (
      error instanceof BackendTransportError &&
      error.code === "backend_transport_remote_error" &&
      typeof error.details?.code === "string"
    ) {
      const detail = orchestrationFailureDetail(error);
      const reason = detail.reasonCode ? `: ${detail.reasonCode}` : "";
      const disposition =
        detail.disposition
          ? ` (${detail.disposition})`
          : "";
      throw new Error(`${detail.remoteCode}${reason}${disposition}: ${detail.message}`, {
        cause: error,
      });
    }
    throw error;
  }
}

function currentContextOptions(environment, dependencies) {
  return {
    integrationReceipt: dependencies.integrationReceipt,
    ...(dependencies.receiptPath ? { receiptPath: dependencies.receiptPath } : {}),
    request: dependencies.request ?? requestOrchestration,
    now: dependencies.now ?? Date.now,
    authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION,
  };
}

async function currentDispatchContext(environment, dependencies) {
  const context = await resolveCurrentDispatchContext(
    environment,
    currentContextOptions(environment, dependencies),
  );
  if (!context) throw new Error("current managed Session identity is unavailable");
  return context;
}

const FENCED_INTERACTION_READS = new Set(["interaction.get", "interaction.progress"]);
// Only a read that a stale fence can make fail is retried with the current one.
const STALE_FENCE_CODES = new Set(["orchestration_record_not_found", "orchestration_capability_denied"]);

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The endpoint fence of this process's own current Dispatch context, when the
 * copied fence names that same endpoint, generation, participant and
 * capabilities. Only the session identity, which every restart or account
 * switch replaces, may differ. The backend validated this context against the
 * process's own Session, so a stale process cannot borrow another's identity. */
async function currentWorkerFence(body, environment, dependencies) {
  const fence = body.endpointFence;
  const context = await currentDispatchContext(environment, dependencies);
  const current = context.endpointFence;
  if (
    !plainRecord(current) ||
    typeof current.sessionIdentity !== "string" ||
    context.participant !== body.participant ||
    context.target?.authority?.workspaceId !== body.authority?.workspaceId ||
    ["endpointRef", "generation", "deliveryCapability", "acknowledgementCapability"]
      .some((field) => current[field] !== fence[field])
  ) {
    return null;
  }
  return current;
}

async function readInteraction({ method, body, environment, dependencies, endpoint }) {
  const send = (requestBody) =>
    (dependencies.request ?? requestOrchestration)(
      endpoint,
      createOrchestrationRequest({ method, body: requestBody }),
      { authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION, environment },
    );
  const fence = plainRecord(body) ? body.endpointFence : undefined;
  if (!plainRecord(fence)) return { receipt: await send(body) };
  if (fence.sessionIdentity === undefined) {
    const current = await currentWorkerFence(body, environment, dependencies);
    if (!current) {
      throw new Error(
        "endpointFence.sessionIdentity may be omitted only for this managed Session's current endpoint; copy the endpointRef, generation, participant and capabilities from orchestration_context_get_current",
      );
    }
    return { receipt: await send({ ...body, endpointFence: current }) };
  }
  try {
    return { receipt: await send(body) };
  } catch (error) {
    if (
      !(error instanceof BackendTransportError) ||
      !STALE_FENCE_CODES.has(error.details?.code)
    ) {
      throw error;
    }
    let current;
    try {
      current = await currentWorkerFence(body, environment, dependencies);
    } catch (contextError) {
      // A retired generation explains the failed read better than "not found".
      throw contextError instanceof BackendTransportError &&
        contextError.details?.code === "orchestration_generation_conflict"
        ? contextError
        : error;
    }
    if (!current || current.sessionIdentity === fence.sessionIdentity) throw error;
    const receipt = await send({ ...body, endpointFence: current });
    return {
      receipt,
      notice:
        `endpointFence.sessionIdentity ${fence.sessionIdentity} is no longer current for ` +
        `endpoint ${fence.endpointRef}; this read used this Session's current identity ` +
        `${current.sessionIdentity}. The identity changes after every restart or account ` +
        "switch, so omit endpointFence.sessionIdentity instead of copying it into prompts or notes.",
    };
  }
}

function withNotice(result, notice) {
  return notice === undefined
    ? result
    : { ...result, content: [...result.content, { type: "text", text: notice }] };
}

function eventReadIntent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("orchestration Event read intent is invalid");
  }
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "limit" && key !== "acknowledgement")) {
    throw new Error("orchestration Event read intent is invalid");
  }
  const limit = input.limit ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new Error("orchestration Event read intent is invalid");
  }
  const acknowledgement = input.acknowledgement;
  if (acknowledgement === undefined) return { limit };
  if (
    !acknowledgement ||
    typeof acknowledgement !== "object" ||
    Array.isArray(acknowledgement) ||
    Object.keys(acknowledgement).some(
      (key) => key !== "through" && key !== "idempotencyKey",
    ) ||
    !Number.isSafeInteger(acknowledgement.through) ||
    acknowledgement.through < 1 ||
    typeof acknowledgement.idempotencyKey !== "string" ||
    acknowledgement.idempotencyKey.length < 1 ||
    acknowledgement.idempotencyKey.length > 256
  ) {
    throw new Error("orchestration Event read intent is invalid");
  }
  return { limit, acknowledgement };
}

async function readCurrentEvents({
  input,
  environment,
  dependencies,
  endpoint,
}) {
  const intent = eventReadIntent(input);
  const context = await currentDispatchContext(environment, dependencies);
  const checkpointPath = currentOrchestrationCheckpointPath(
    environment,
    context.endpointFence?.endpointRef,
  );
  const acknowledgedCursor = loadCursor(checkpointPath);
  const after = Math.max(
    acknowledgedCursor,
    intent.acknowledgement?.through ?? 0,
  );
  const body = {
    schemaVersion: 1,
    authority: context.target?.authority,
    target: context.target,
    participant: context.participant,
    deliveryCapability: context.deliveryCapability,
    endpointFence: context.endpointFence,
    after,
    limit: intent.limit,
    ...(intent.acknowledgement
      ? {
          acknowledgement: {
            through: intent.acknowledgement.through,
            idempotencyKey: intent.acknowledgement.idempotencyKey,
            acknowledgementCapability: context.acknowledgementCapability,
          },
        }
      : {}),
  };
  const response = await (dependencies.request ?? requestOrchestration)(
    endpoint,
    createOrchestrationRequest({ method: "events.read", body }),
    {
      authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION,
      environment,
    },
  );
  if (intent.acknowledgement) {
    const checkpoint = exactAcknowledgementCheckpoint(
      response.receipt,
      intent.acknowledgement.through,
    );
    if (checkpoint.through >= acknowledgedCursor) {
      checkpointCursor(
        checkpointPath,
        checkpoint.through,
        checkpoint.deliveryReceiptId,
      );
    }
  }
  return response;
}

export async function handleMcpRequest(
  message,
  environment = process.env,
  dependencies = {},
) {
  if (message?.jsonrpc !== "2.0") throw new Error("invalid JSON-RPC version");
  if (message.method === "notifications/initialized") return null;
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "dure-orchestration", version: "1" },
    };
  }
  if (message.method === "tools/list") return { tools: [...tools, ...appControlMcpTools, jevMcpTool] };
  if (message.method !== "tools/call") throw new Error(`unsupported MCP method: ${message.method}`);
  const endpoint = defaultOrchestrationEndpoint(environment);
  const name = message.params?.name;
  const input = message.params?.arguments ?? {};
  if (name === "jev_evaluate") return callJevMcpTool(input, environment, dependencies);
  const appResult = await callAppControlMcpTool(name, input, environment, dependencies);
  if (appResult !== undefined) return appResult;
  if (name === "orchestration_context_get_current") {
    const context = await withBackendRejectionDetails(() =>
      currentDispatchContext(environment, dependencies),
    );
    const receipt = { schemaVersion: 1, context };
    return toolResult(receipt);
  }
  if (name === "orchestration_events_read") {
    const receipt = await withBackendRejectionDetails(() =>
      readCurrentEvents({
        input,
        environment,
        dependencies,
        endpoint,
      }),
    );
    return toolResult(receipt);
  }
  const method = {
    agent_goal_get: "agent_goal.get",
    agent_goal_put: "agent_goal.put",
    orchestration_interaction_open: "interaction.open",
    orchestration_message_open_exact_session: "interaction.message.open.exact-session",
    orchestration_interaction_get: "interaction.get",
    orchestration_interaction_progress: "interaction.progress",
    orchestration_decision_answer: "interaction.answer",
    orchestration_dispatch_complete: "dispatch.complete",
    orchestration_dispatch_deadline_set: "dispatch.deadline.set",
    orchestration_dispatch_deadline_get: "dispatch.deadline.get",
  }[name];
  if (!method) throw new Error(`unsupported orchestration tool: ${name}`);
  if (FENCED_INTERACTION_READS.has(method)) {
    const { receipt, notice } = await withBackendRejectionDetails(() =>
      readInteraction({ method, body: input.body, environment, dependencies, endpoint }),
    );
    return withNotice(toolResult(receipt), notice);
  }
  const candidates =
    method === "dispatch.complete"
      ? parseNextWorkCandidates(input.nextWorkCandidates)
      : undefined;
  const request = createOrchestrationRequest({ method, body: input.body });
  const receipt = await withBackendRejectionDetails(() =>
    (dependencies.request ?? requestOrchestration)(endpoint, request, {
      authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION,
      environment,
    }),
  );
  if (candidates !== undefined) {
    let nextWork;
    try {
      nextWork = await publishNextWorkDecision({
        completionBody: input.body,
        candidates,
        endpoint,
        environment,
        integrationReceipt: dependencies.integrationReceipt,
        receiptPath: dependencies.receiptPath,
        request: dependencies.request ?? requestOrchestration,
        now: dependencies.now ?? Date.now,
      });
    } catch (error) {
      nextWork = {
        state: "unavailable",
        code: "next_work_publication_failed",
        message:
          "The completion report committed, but the next-work Decision could not be opened. Retry the same completion request after transport recovers.",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    return toolResult(receipt, { nextWork });
  }
  return toolResult(receipt);
}

export async function orchestrationWorkerCatalogue() {
  // Use the selected bundle's handler, without contacting its backend. The
  // native idle relay retains this metadata while its worker is dormant.
  return {
    schemaVersion: 1,
    kind: "dure.mcp.stateless-worker-catalogue",
    initialize: await handleMcpRequest({ jsonrpc: "2.0", method: "initialize" }),
    tools: await handleMcpRequest({ jsonrpc: "2.0", method: "tools/list" }),
  };
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && arguments_[0] === "--catalogue") {
    const catalogue = await orchestrationWorkerCatalogue();
    process.stdout.write(`${JSON.stringify(catalogue)}\n`);
    return;
  }
  let integrationReceipt;
  try {
    if (arguments_.length === 2 && arguments_[0] === "--receipt-json") {
      integrationReceipt = parseOrchestrationIntegrationReceipt(JSON.parse(arguments_[1]));
    } else if (arguments_.length !== 0) {
      throw new Error("invalid worker arguments");
    }
  } catch {
    process.stderr.write("usage: orchestration-mcp-server.mjs [--catalogue | --receipt-json <JSON>]\n");
    process.exitCode = 2;
    return;
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let message;
    try {
      message = JSON.parse(line);
      const result = await handleMcpRequest(message, process.env, { integrationReceipt });
      if (message.id === undefined) continue;
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    } catch (error) {
      if (message?.id === undefined) continue;
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message?.id ?? null,
          error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
        })}\n`,
      );
    }
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
