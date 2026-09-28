import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBackendProfilesPath } from "./backend-profiles.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { createOrchestrationRequest, isOrchestrationResponse } from "./contracts/orchestration-envelope.mjs";
import { collectSessionQuery } from "./session-query.mjs";
import { sameGeneration } from "./session-runtime-projection.mjs";

async function invoke(backend, method, body, { deadlineMs = 2500, signal } = {}) {
  if (backend?.error) throw backend.error;
  const response = await performBackendProfileRequest(backend.profile, {
    operation: "orchestration.invoke", body: createOrchestrationRequest({ method, body }),
    requiredCapabilities: ["orchestration.invoke", "orchestration.interaction.progress_v1"],
  }, { ...backend.transportOptions, deadlineMs, signal });
  if (!isOrchestrationResponse(response.result, method)) throw new Error("Invalid message observation receipt");
  return response.result.receipt;
}

export function readMessageTracking(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 32768 || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error("Message tracking requires a private regular receipt file (mode 0600).");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.apiVersion !== "dure.message-tracking/v1" || !value.session || !value.query ||
      typeof value.backendId !== "string" || typeof value.query.interactionId !== "string" ||
      typeof value.query.readCapability !== "string") throw new Error("Invalid message tracking file");
  return value;
}

/** The file retains only the exact read authority, never a second delivery state machine. */
export async function sendTrackedMessage(target, text, { backend, hmuxCommand, environment = process.env, querySession = collectSessionQuery, request = invoke } = {}) {
  const report = await querySession({ action: "show", ...target, backend, hmuxCommand });
  const live = report.session;
  if (report.error || !live?.liveness?.exactGeneration || live.runtime?.sessionClass !== "managed") throw new Error("Tracked send requires an observable exact managed Session. Nothing was sent.");
  const session = { sessionId: live.sessionId, workspaceId: live.workspaceId, providerId: live.provider.id, ...live.runtime.generation };
  const context = await request(backend, "dispatch.context.get.exact-session", { schemaVersion: 1, session });
  const interactionId = `message.${randomUUID()}`;
  const query = { schemaVersion: 1, authority: context.target.authority, interactionId,
    participant: context.coordinatorGrant.participant, readCapability: context.interactionCapability };
  if (!query.readCapability || !context.endpointFence?.endpointRef) throw new Error("Exact message context unavailable. Nothing was sent.");
  const directory = path.join(path.dirname(resolveBackendProfilesPath({ environment })), "message-receipts");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(directory, `${interactionId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify({ apiVersion: "dure.message-tracking/v1", backendId: backend.profile.id, session, query }), { flag: "wx", mode: 0o600 });
  try {
    const receipt = await request(backend, "interaction.message.open.exact-session", {
      schemaVersion: 1, session, expectedEndpointRef: context.endpointFence.endpointRef,
      idempotencyKey: interactionId, interactionId, title: "Agent message", descriptionMarkdown: text, openedAtMs: Date.now(),
    });
    return { sessionId: session.sessionId, workspaceId: session.workspaceId,
      receipt: { kind: "durable_message", interactionId, receiptPath, delivery: "accepted", deliveries: receipt.deliveries } };
  } catch (error) {
    // The request may have committed. Preserve its exact query before the write.
    throw Object.assign(new Error(`Message submission outcome is unknown. Inspect with dure wait --message ${JSON.stringify(receiptPath)} --json; do not resend.`), { cause: error, code: "message_submission_unknown", receiptPath });
  }
}

export async function queryTrackedMessage({ tracking, backend, hmuxCommand, deadlineMs, signal, request = invoke, querySession = collectSessionQuery }) {
  if (backend.profile.id !== tracking.backendId) throw new Error("Message receipt belongs to a different backend.");
  const receipt = await request(backend, "interaction.progress", tracking.query, { deadlineMs, signal });
  if (receipt.interactionId !== tracking.query.interactionId || !Array.isArray(receipt.deliveries)) throw new Error("Message progress identity mismatch");
  const observed = receipt.deliveries.length > 0 && receipt.deliveries.every(d => d.observedAtMs !== null && d.observedAtMs !== undefined);
  const acknowledged = receipt.deliveries.length > 0 && receipt.deliveries.every(d => d.acknowledgedAtMs !== null && d.acknowledgedAtMs !== undefined);
  const report = await querySession({ action: "show", sessionId: tracking.session.sessionId, workspaceId: tracking.session.workspaceId, backend, hmuxCommand, deadlineMs, signal });
  const runtime = report.session?.runtime;
  const exact = report.session?.liveness?.exactGeneration && sameGeneration(tracking.session, runtime?.generation);
  const progress = exact ? runtime.agentRuntimeState?.progress : undefined;
  const turns = (progress?.report.message_turns ?? []).filter(t => receipt.deliveries.some(d => d.delivery.receiptId === t.delivery_receipt_id));
  return { receipt: { interactionId: receipt.interactionId, acceptedAtMs: receipt.acceptedAtMs, observed, acknowledged,
    wakeTurnStarted: turns.length > 0, wakeTurns: turns, dispatchState: receipt.dispatchState,
    deliveries: receipt.deliveries, pendingDeliveryCount: receipt.deliveries.filter(d => d.observedAtMs == null).length,
    oldestPendingAgeMs: Math.max(0, ...receipt.deliveries.filter(d => d.observedAtMs == null && Number.isSafeInteger(d.queuedAtMs)).map(d => Date.now() - d.queuedAtMs)),
    progress: progress ?? null,
    runtimeObservation: !report.session?.liveness?.exactGeneration ? "unavailable" : exact ? "current_generation" : "generation_changed" } };
}
