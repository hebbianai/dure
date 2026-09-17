export const DEFAULT_QA_HTTP_TIMEOUT_MS = 5_000;

export function resolveQaHttpTimeout(value) {
  const timeoutMs = Number(value ?? DEFAULT_QA_HTTP_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("HEBBIAN_QA_HTTP_TIMEOUT_MS must be a positive integer");
  }
  return timeoutMs;
}

export function qaHttpRouteLabel(route) {
  return route.split("?", 1)[0];
}

export async function withHttpTimeout(label, operation, timeoutMs) {
  const resolvedTimeoutMs = resolveQaHttpTimeout(timeoutMs);
  const controller = new AbortController();
  let timeout;
  const timedOut = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new Error(`${label} timed out after ${resolvedTimeoutMs}ms`),
      );
    }, resolvedTimeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timedOut,
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
