import {
  createOrchestrationRequest,
  requestOrchestration,
} from "./orchestration-client.mjs";

const BACKEND_ENDPOINT_PREFIX = "backend-profile:";

export class OrchestrationCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "OrchestrationCommandError";
  }
}

function parseBody(source) {
  let body;
  try {
    body = JSON.parse(source);
  } catch {
    throw new OrchestrationCommandError(
      "orchestration_body_invalid",
      "orchestration body must be one JSON object",
    );
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new OrchestrationCommandError(
      "orchestration_body_invalid",
      "orchestration body must be one JSON object",
    );
  }
  return body;
}

function resolveEndpoint({ backend, backendSpecified, environment }) {
  if (environment.DURE_ORCHESTRATION_HOME) {
    return `${BACKEND_ENDPOINT_PREFIX}${backendSpecified ? backend : "local"}`;
  }
  const hostedEndpoint = environment.DURE_ORCHESTRATION_ENDPOINT?.trim();
  if (hostedEndpoint && backendSpecified) {
    throw new OrchestrationCommandError(
      "orchestration_endpoint_ambiguous",
      "use either --backend or DURE_ORCHESTRATION_ENDPOINT, not both",
    );
  }
  if (hostedEndpoint) {
    let parsed;
    try {
      parsed = new URL(hostedEndpoint);
    } catch {
      throw new OrchestrationCommandError(
        "orchestration_endpoint_invalid",
        "DURE_ORCHESTRATION_ENDPOINT must be an HTTPS URL",
      );
    }
    if (parsed.protocol !== "https:") {
      throw new OrchestrationCommandError(
        "orchestration_endpoint_invalid",
        "DURE_ORCHESTRATION_ENDPOINT must be an HTTPS URL",
      );
    }
    return parsed.href;
  }
  return `${BACKEND_ENDPOINT_PREFIX}${backendSpecified ? backend : environment.DURE_BACKEND_PROFILE?.trim() ?? ""}`;
}

async function prepareEndpoint(endpoint, prepareBackendProfile) {
  if (
    !endpoint.startsWith(BACKEND_ENDPOINT_PREFIX) ||
    typeof prepareBackendProfile !== "function"
  ) {
    return endpoint;
  }
  const requestedId = endpoint.slice(BACKEND_ENDPOINT_PREFIX.length) || undefined;
  const selection = await prepareBackendProfile(requestedId);
  const selectedId = selection?.profile?.id;
  if (typeof selectedId !== "string" || selectedId.length === 0) {
    throw new OrchestrationCommandError(
      "orchestration_backend_selection_invalid",
      "the selected orchestration backend profile is invalid",
    );
  }
  return `${BACKEND_ENDPOINT_PREFIX}${selectedId}`;
}

export function parseOrchestrationInvoke(arguments_) {
  if (
    !Array.isArray(arguments_) ||
    arguments_.length !== 2 ||
    typeof arguments_[0] !== "string" ||
    arguments_[0].length === 0 ||
    typeof arguments_[1] !== "string"
  ) {
    throw new OrchestrationCommandError(
      "orchestration_usage_invalid",
      "usage: dure orchestration invoke <method> '<body-json>' [--backend ID] [--json]",
    );
  }
  return createOrchestrationRequest({
    method: arguments_[0],
    body: parseBody(arguments_[1]),
  });
}

export async function runOrchestrationInvokeFromCli({
  arguments_,
  backend,
  backendSpecified = false,
  environment = process.env,
  json = false,
  output = (source) => process.stdout.write(source),
  prepareBackendProfile,
  request = requestOrchestration,
} = {}) {
  const orchestrationRequest = parseOrchestrationInvoke(arguments_);
  const endpoint = await prepareEndpoint(
    resolveEndpoint({ backend, backendSpecified, environment }),
    prepareBackendProfile,
  );
  const receipt = await request(endpoint, orchestrationRequest, {
    authorization: environment.DURE_ORCHESTRATION_AUTHORIZATION?.trim(),
    environment,
  });
  output(`${JSON.stringify(receipt, null, json ? 0 : 2)}\n`);
  return receipt;
}
