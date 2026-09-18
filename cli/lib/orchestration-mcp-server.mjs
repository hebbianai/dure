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
import { BackendTransportError, backendTransportErrorReport } from "./backend-transport.mjs";
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

const tools = [
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
      "Open one nonblocking Markdown Message or one blocking Text/Select Decision.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "object" },
      },
    },
  },
  {
    name: "orchestration_interaction_get",
    description: "Read one exact service-owned Message or Decision record.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "object" },
      },
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
      "Complete the exact Dispatch generation with a Markdown report. Only explicitly supplied nextWorkCandidates open a successor Decision; no tracker is queried.",
    inputSchema: {
      type: "object",
      required: ["body"],
      properties: {
        body: { type: "object" },
        nextWorkCandidates: nextWorkCandidatesSchema,
      },
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
      const detail = backendTransportErrorReport(error).error;
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
    orchestration_interaction_get: "interaction.get",
    orchestration_decision_answer: "interaction.answer",
    orchestration_dispatch_complete: "dispatch.complete",
  }[name];
  if (!method) throw new Error(`unsupported orchestration tool: ${name}`);
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
