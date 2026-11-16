import { createHash } from "node:crypto";
import { supportsHmuxCapability } from "./runtime-diagnostics.mjs";

const NATIVE_QUERY_TIMEOUT_MS = 5_000;
const HOST_ABSENT_CAPABILITY = "managed_rehost_host_absent_start_v1";

/** Whether the local runtime can prove a Host is gone before it replaces the source. */
export async function supportsHostAbsentStart({ command, run }) {
  let manifest;
  try {
    const response = await run([command, "capabilities", "--json"], { timeoutMs: NATIVE_QUERY_TIMEOUT_MS });
    manifest = response?.kind === "success" ? JSON.parse(response.stdout) : undefined;
  } catch {
    return false;
  }
  return supportsHmuxCapability(manifest, HOST_ABSENT_CAPABILITY);
}

/** Hmux's current observation of one exact session, or undefined when it gave none. */
export async function readSourceSession({ command, run, sessionId, workspaceId }) {
  let response;
  try {
    response = await run([command, "--json", "session", "show", sessionId, "--workspace", workspaceId],
      { timeoutMs: NATIVE_QUERY_TIMEOUT_MS, maxCaptureBytes: 1024 * 1024 });
  } catch {
    return undefined;
  }
  if (response?.kind !== "success") return undefined;
  try {
    const parsed = JSON.parse(response.stdout);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify Hmux's observation of the exact selected session. `target.source`
 * is the backend's selected generation; `target.conversationId` the provider
 * conversation it recorded. Only a Host that stopped answering can restore
 * behind the Host-absence fence, which the native broker proves again.
 */
export function classifySourceSession(session, target, { includeExited }) {
  if (session.host_instance_id !== target.source.hostInstanceId ||
      session.terminal_epoch !== target.source.terminalEpoch) {
    return session.health === "healthy" ? { outcome: "running" } : { outcome: "skipped", reason: "runtime_generation_changed" };
  }
  const conversationId = target.conversationId ?? session.providerConversationIdentity?.conversation_id ?? null;
  const restore = (extra) => conversationId
    ? { outcome: "restore", conversationId, ...extra }
    : { outcome: "skipped", reason: "no_conversation_id" };
  switch (session.health) {
    case "healthy": return { outcome: "running" };
    case "stale_transport": return restore({ requireHostAbsent: true });
    // An exited tombstone is the Host's own proof, and its generation cannot
    // satisfy the live-Host socket check.
    case "exited": return includeExited ? restore({ requireHostAbsent: false }) : { outcome: "skipped", reason: "provider_exited" };
    case "incompatible_protocol": return { outcome: "skipped", reason: "host_incompatible" };
    default: return { outcome: "skipped", reason: "host_state_unknown" };
  }
}

/** One operation per gone source generation, so every restore of it continues the same one. */
export function hostAbsentOperationId({ source, workspaceId, sessionId }) {
  const digest = createHash("sha256")
    .update(["dure-resume-all-v1", workspaceId, sessionId, source.hostInstanceId, source.terminalEpoch].join("\0"))
    .digest("hex");
  return `resume-all-${digest.slice(0, 48)}`;
}
