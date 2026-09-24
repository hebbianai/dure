const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONFIGURED_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

export class AppControlClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AppControlClientError";
    this.code = code;
  }
}

export function publicAppControlIdentity(descriptor) {
  const identity = {};
  for (const [key, value] of [
    ["channel", descriptor?.channel],
    ["generation", descriptor?.generation],
    ["buildId", descriptor?.buildId],
  ]) {
    if (typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) {
      identity[key] = value;
    }
  }
  return identity;
}

function validatedDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new AppControlClientError(
      "client_unavailable",
      "No connected Dure client was found. The Dure app must be running.",
    );
  }
  const port = Number(descriptor.port);
  const token = typeof descriptor.token === "string" ? descriptor.token : "";
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
    throw new AppControlClientError(
      "client_descriptor_invalid",
      "The connected Dure client descriptor is invalid.",
    );
  }
  return { ...descriptor, port, token };
}

function responseError(payload, status) {
  const serverError =
    payload && typeof payload === "object" && payload.error &&
    typeof payload.error === "object"
      ? payload.error
      : null;
  const code =
    typeof serverError?.code === "string" && serverError.code
      ? serverError.code
      : "client_request_refused";
  const message =
    typeof serverError?.message === "string" && serverError.message
      ? serverError.message
      : `The Dure client request was rejected. (HTTP ${status})`;
  const error = new AppControlClientError(code, message);
  // Typed pane-action refusals carry machine guidance; keep it on the error
  // so agents read {code, retryable, nextAction} instead of prose.
  if (typeof serverError?.retryable === "boolean") {
    error.retryable = serverError.retryable;
  }
  if (typeof serverError?.nextAction === "string" && serverError.nextAction) {
    error.nextAction = serverError.nextAction;
  }
  if (serverError?.execution === "not_started") error.execution = "not_started";
  return error;
}

function requestTimeoutError() {
  return new AppControlClientError(
    "client_request_timeout",
    "The Dure client request timed out.",
  );
}

async function readBoundedResponseText(
  response,
  timeoutSignal,
  maxResponseBytes,
) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    try {
      await response.body?.cancel();
    } catch {}
    throw new AppControlClientError(
      "client_response_too_large",
      "The Dure client response exceeded the size limit.",
    );
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") <= maxResponseBytes) return text;
    throw new AppControlClientError(
      "client_response_too_large",
      "The Dure client response exceeded the size limit.",
    );
  }

  const reader = response.body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new Error("Dure client response stream returned an invalid chunk");
      }
      byteLength += value.byteLength;
      if (byteLength > maxResponseBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new AppControlClientError(
          "client_response_too_large",
          "The Dure client response exceeded the size limit.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppControlClientError) throw error;
    if (timeoutSignal.aborted) throw requestTimeoutError();
    throw new AppControlClientError(
      "client_response_failed",
      "Could not read the Dure client response.",
      { cause: error },
    );
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function requestAppControl({
  descriptor,
  path,
  method = "POST",
  body = {},
  fetchImpl = globalThis.fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  timeoutMs = REQUEST_TIMEOUT_MS,
}) {
  const client = validatedDescriptor(descriptor);
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new AppControlClientError(
      "client_request_invalid",
      "The Dure client action path is invalid.",
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new AppControlClientError(
      "client_request_invalid",
      "The Dure client request timeout is invalid.",
    );
  }
  if (
    !Number.isSafeInteger(maxResponseBytes) ||
    maxResponseBytes < 1 ||
    maxResponseBytes > MAX_CONFIGURED_RESPONSE_BYTES
  ) {
    throw new AppControlClientError(
      "client_request_invalid",
      "The Dure client response limit is invalid.",
    );
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${client.port}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      signal: timeoutSignal,
    });
  } catch (error) {
    if (timeoutSignal.aborted) throw requestTimeoutError();
    throw new AppControlClientError(
      "client_request_failed",
      error?.cause?.code === "ECONNREFUSED"
        ? `Dure connection refused at 127.0.0.1:${client.port} (ECONNREFUSED). Check that the selected Dure app is running.`
        : `Dure client request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let text;
  try {
    text = await readBoundedResponseText(
      response,
      timeoutSignal,
      maxResponseBytes,
    );
  } catch (error) {
    if (error instanceof AppControlClientError) throw error;
    if (timeoutSignal.aborted) throw requestTimeoutError();
    throw new AppControlClientError(
      "client_response_failed",
      "Could not read the Dure client response.",
      { cause: error },
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new AppControlClientError(
      "client_response_invalid",
      "The Dure client did not return a valid JSON response.",
      { cause: error },
    );
  }
  if (!response.ok || !payload || payload.ok !== true) {
    throw responseError(payload, response.status);
  }
  return payload;
}
