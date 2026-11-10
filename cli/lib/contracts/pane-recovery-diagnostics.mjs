import { isDureDomainIdV1 } from "./protocol-identity.mjs";

// One bounded public projection for the desktop producer and CLI reader. A row
// says which step of a pane's Resume failed and with which code, never why in
// free text: messages, paths and conversation content stay out of the journal.
export const PANE_RECOVERY_DIAGNOSTIC_STAGES = Object.freeze([
  "exact_resume", "lineage_wake",
]);
export const PANE_RECOVERY_UNCLASSIFIED_CODE = "unclassified";
export const MAX_PANE_RECOVERY_DIAGNOSTIC_EVENTS = 64;
const CODE = /^[a-z][a-z0-9_]{0,127}$/;

export function isPaneRecoveryDiagnosticCode(value) {
  return typeof value === "string" && CODE.test(value);
}

export function parsePaneRecoveryDiagnostics(value) {
  if (value?.schemaVersion !== 1 || !["available", "unavailable"].includes(value.state) ||
      !Array.isArray(value.events) || value.events.length > MAX_PANE_RECOVERY_DIAGNOSTIC_EVENTS ||
      (value.state === "unavailable" && value.events.length !== 0)) return null;
  const events = [];
  for (const event of value.events) {
    if (!event || !PANE_RECOVERY_DIAGNOSTIC_STAGES.includes(event.stage) ||
        !isPaneRecoveryDiagnosticCode(event.code) ||
        (event.agentId !== undefined && !isDureDomainIdV1(event.agentId)) ||
        !Number.isSafeInteger(event.firstSeenMs) || event.firstSeenMs < 0 ||
        !Number.isSafeInteger(event.lastSeenMs) || event.lastSeenMs < event.firstSeenMs ||
        !Number.isInteger(event.count) || event.count < 1 || event.count > 0xffff_ffff) return null;
    events.push({ stage: event.stage, code: event.code,
      ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
      firstSeenMs: event.firstSeenMs, lastSeenMs: event.lastSeenMs, count: event.count });
  }
  return { schemaVersion: 1, state: value.state, events };
}
