export const ORCHESTRATION_API_VERSION = "dure.orchestration/v1";

export function createOrchestrationRequest({ method, body }) {
  if (
    typeof method !== "string" ||
    method.length === 0 ||
    method.length > 128 ||
    !/^[a-z][a-z0-9._-]*$/u.test(method) ||
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body)
  ) {
    throw new Error("orchestration request is invalid");
  }
  return Object.freeze({
    apiVersion: ORCHESTRATION_API_VERSION,
    method,
    body,
  });
}

/** Correlates the wire envelope only. Each operation owns its receipt schema. */
export function isOrchestrationResponse(value, method) {
  return value !== null && typeof value === "object" &&
    value.apiVersion === ORCHESTRATION_API_VERSION &&
    value.method === method && "receipt" in value;
}
