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
