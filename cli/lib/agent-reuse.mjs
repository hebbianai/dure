import {
  AppControlClientError,
  publicAppControlIdentity,
  requestAppControl,
} from "./app-control-client.mjs";

const API_VERSION = "dure.agent-reuse/v1";
const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;

function boundedLabel(value, maximum) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
  );
}

function publicAgent(payload, expected) {
  const agent = payload?.agent;
  if (
    !agent ||
    typeof agent !== "object" ||
    !SAFE_TOKEN.test(agent.id ?? "") ||
    !boundedLabel(agent.name, 64) ||
    !SAFE_TOKEN.test(agent.projectId ?? "") ||
    !SAFE_TOKEN.test(agent.provider ?? "") ||
    !SAFE_TOKEN.test(agent.sessionId ?? "") ||
    !SAFE_TOKEN.test(agent.runtime ?? "") ||
    agent.name !== expected.name ||
    (expected.provider !== undefined && agent.provider !== expected.provider)
  ) {
    throw new AppControlClientError(
      "client_response_invalid",
      "The Dure client Agent reuse receipt is invalid.",
    );
  }
  return {
    id: agent.id,
    name: agent.name,
    projectId: agent.projectId,
    provider: agent.provider,
    sessionId: agent.sessionId,
    runtime: agent.runtime,
  };
}

// The app resolves its own project records and reuses only a live Agent.
// Backend project IDs and stopped Agents belong to the runs commands.
const REUSE_REFUSAL_GUIDANCE = {
  project_not_found: "--project takes the app's project name from dure ls (or its app project ID); " +
    "Run and runtime output report backend project IDs, a different namespace. " +
    "To continue a Run or Agent by its Agent ID, preview dure runs resume <agent-id>.",
  agent_reuse_not_found: "spawn --reuse continues only a live Agent in the app. For a closed or stopped " +
    "Agent, preview recovery by Agent ID with dure runs resume <agent-id>; it keeps the conversation.",
};

function withReuseGuidance(error) {
  const guidance = error instanceof AppControlClientError ? REUSE_REFUSAL_GUIDANCE[error.code] : undefined;
  if (!guidance) return error;
  const message = /[.!?]$/.test(error.message) ? error.message : `${error.message}.`;
  return new AppControlClientError(error.code, `${message} ${guidance}`, { cause: error });
}

export async function reuseExistingAgent({
  descriptor,
  project,
  provider,
  name,
  prompt = "",
  idempotencyKey,
  windowLabel,
  fetchImpl = globalThis.fetch,
} = {}) {
  const request = {
    schemaVersion: 1,
    project,
    name,
    prompt,
    idempotencyKey,
    ...(provider !== undefined ? { provider } : {}),
    ...(windowLabel !== undefined ? { windowLabel } : {}),
  };
  const payload = await requestAppControl({
    descriptor,
    path: "/agent/reuse",
    body: request,
    fetchImpl,
  }).catch((error) => {
    throw withReuseGuidance(error);
  });
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    kind: "dure.agent.reuse",
    state: "reused",
    client: publicAppControlIdentity(descriptor),
    agent: publicAgent(payload, request),
  };
}

export function formatAgentReuse(report) {
  return [
    `agent\t${report.agent.name}`,
    `state\t${report.state}`,
    `session\t${report.agent.sessionId}`,
  ].join("\n");
}
