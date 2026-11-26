// The client side of a backend's `agent_recovery.waits` list: every Agent its
// recovery continues by itself once the usage limit that stopped it resets.
// The backend's recovery record owns each wait; reading the list never
// starts, stops or resends anything.
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

export const RECOVERY_WAITS_OPERATION = "agent_recovery.waits";
export const RECOVERY_WAITS_CAPABILITY = "account_recovery.waits.v1";
export const RECOVERY_WAITS_BODY = Object.freeze({ schemaVersion: 1 });

const WAIT_KEYS = ["agentId", "attemptId", "resumeAtMs"];

/** A backend's list, or null when any entry is not exactly a wait. */
export function parseRecoveryWaits(value) {
  if (!Array.isArray(value)) return null;
  const waits = [];
  for (const wait of value) {
    if (
      wait === null || typeof wait !== "object" || Array.isArray(wait) ||
      Object.keys(wait).length !== WAIT_KEYS.length ||
      !WAIT_KEYS.every((key) => Object.hasOwn(wait, key)) ||
      !isDureDomainIdV1(wait.agentId) || !isDureDomainIdV1(wait.attemptId) ||
      !Number.isSafeInteger(wait.resumeAtMs) || wait.resumeAtMs < 0
    ) return null;
    waits.push({ agentId: wait.agentId, attemptId: wait.attemptId, resumeAtMs: wait.resumeAtMs });
  }
  return waits;
}

/** One backend's waits, or null when it cannot say: no backend, a profile
 * that does not declare the list (a backend that predates it is refused
 * before any request), or a request or response that failed. */
export async function readRecoveryWaits(backend, {
  requestBackend = performBackendProfileRequest,
  deadlineMs,
  signal,
} = {}) {
  const profile = backend?.profile;
  if (!profile || backend.error ||
      !profile.expected?.capabilities?.includes(RECOVERY_WAITS_CAPABILITY)) return null;
  try {
    const response = await requestBackend(profile, {
      operation: RECOVERY_WAITS_OPERATION,
      body: RECOVERY_WAITS_BODY,
      requiredCapabilities: [RECOVERY_WAITS_CAPABILITY],
    }, {
      ...backend.transportOptions,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
      ...(signal ? { signal } : {}),
    });
    return parseRecoveryWaits(response?.result?.waits);
  } catch {
    return null;
  }
}
