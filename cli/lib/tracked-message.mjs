import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBackendProfilesPath } from "./backend-profiles.mjs";
import { BackendTransportError, backendTransportErrorReport, performBackendProfileRequest } from "./backend-transport.mjs";
import { createOrchestrationRequest, isOrchestrationResponse } from "./contracts/orchestration-envelope.mjs";
import { orchestrationFailureDetail } from "./orchestration-failure.mjs";
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

/** Typed codes only; backend messages may carry private paths. */
function refusalReason(error) {
  const detail = backendTransportErrorReport(error).error;
  return [detail.remoteCode ?? detail.code, detail.reasonCode].filter(Boolean).join(": ");
}

export const MESSAGE_NOT_STORED = "message_not_stored";

/** The exact read of a tracked message. The backend commits an interaction with
 * its Event and answers a missing one as a terminal not-found, so that answer
 * proves the message was never stored and never will be by reading again. */
async function readMessageProgress(backend, query, options, request) {
  try {
    return await request(backend, "interaction.progress", query, options);
  } catch (error) {
    if (backendTransportErrorReport(error).error.remoteCode !== "orchestration_record_not_found") throw error;
    throw Object.assign(new Error("The backend has no message for this receipt: it was not stored and will not be delivered."), { cause: error, code: MESSAGE_NOT_STORED });
  }
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
export async function sendTrackedMessage(target, text, { backend, hmuxCommand, title, environment = process.env, querySession = collectSessionQuery, request = invoke } = {}) {
  const report = await querySession({ action: "show", ...target, backend, hmuxCommand });
  const live = report.session;
  // An exited Session keeps its exact generation but can no longer resolve a message context.
  if (!report.error && live?.liveness?.state === "exited") throw Object.assign(new Error(`Session ${live.sessionId} has exited. Nothing was sent.`), { code: "dure_send_session_exited", sessionId: live.sessionId });
  if (report.error || !live?.liveness?.exactGeneration || live.runtime?.sessionClass !== "managed") throw new Error("Tracked send requires an observable exact managed Session. Nothing was sent.");
  const session = { sessionId: live.sessionId, workspaceId: live.workspaceId, providerId: live.provider.id, ...live.runtime.generation };
  let context;
  try {
    context = await request(backend, "dispatch.context.get.exact-session", { schemaVersion: 1, session });
  } catch (error) {
    // Nothing is opened before the context resolves. Report typed codes and
    // the guidance derived from them only; backend messages may carry private paths.
    const detail = orchestrationFailureDetail(error);
    const guided = detail.message !== backendTransportErrorReport(error).error.message;
    const next = guided ? `. ${detail.message}` : "; check the target with dure ls --alive.";
    throw Object.assign(new Error(`The message context of Session ${session.sessionId} is unavailable (${refusalReason(error)}). Nothing was sent${next}`), { code: "dure_send_context_unavailable", cause: error });
  }
  const interactionId = `message.${randomUUID()}`;
  const query = { schemaVersion: 1, authority: context.target.authority, interactionId,
    participant: context.coordinatorGrant.participant, readCapability: context.interactionCapability };
  if (!query.readCapability || !context.endpointFence?.endpointRef) throw new Error("Exact message context unavailable. Nothing was sent.");
  const directory = path.join(path.dirname(resolveBackendProfilesPath({ environment })), "message-receipts");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const receiptPath = path.join(directory, `${interactionId}.json`);
  fs.writeFileSync(receiptPath, JSON.stringify({ apiVersion: "dure.message-tracking/v1", backendId: backend.profile.id, session, query }), { flag: "wx", mode: 0o600 });
  const accepted = (deliveries) => ({ sessionId: session.sessionId, workspaceId: session.workspaceId,
    receipt: { kind: "durable_message", interactionId, receiptPath, delivery: "accepted", deliveries } });
  let failure;
  try {
    const receipt = await request(backend, "interaction.message.open.exact-session", {
      schemaVersion: 1, session, expectedEndpointRef: context.endpointFence.endpointRef,
      idempotencyKey: interactionId, interactionId, title, descriptionMarkdown: text, openedAtMs: Date.now(),
    });
    return accepted(receipt.deliveries);
  } catch (error) {
    failure = error;
  }
  // The request may have committed, so its exact query was kept before the write.
  // A backend answer means the request is no longer in flight: the exact read of
  // that query then settles whether the message was stored. It never resubmits.
  if (failure instanceof BackendTransportError && failure.code === "backend_transport_remote_error") {
    try {
      const progress = await readMessageProgress(backend, query, {}, request);
      if (progress.interactionId === interactionId && Array.isArray(progress.deliveries)) {
        return accepted(progress.deliveries.map((entry) => entry.delivery));
      }
    } catch (readError) {
      if (readError.code === MESSAGE_NOT_STORED) {
        fs.rmSync(receiptPath, { force: true });
        throw Object.assign(new Error(`The backend refused the message (${refusalReason(failure)}). Nothing was stored, so it is safe to send again once the cause is resolved.`), { cause: failure, code: "message_submission_refused" });
      }
    }
  }
  throw Object.assign(new Error(`Message submission outcome is unknown (${refusalReason(failure)}). Inspect with dure wait --message ${JSON.stringify(receiptPath)} --json; do not resend.`), { cause: failure, code: "message_submission_unknown", receiptPath });
}

// A wake prompt names the first 12 characters of its receipt digest
// (control-plane interaction_wake.rs); wakes from older runtimes named the whole receipt.
function namesReceipt(reference, receiptId) {
  if (typeof reference !== "string" || typeof receiptId !== "string") return false;
  return reference === receiptId || reference === receiptId.replace(/^delivery-/, "").slice(0, 12);
}

export async function queryTrackedMessage({ tracking, backend, hmuxCommand, deadlineMs, signal, request = invoke, querySession = collectSessionQuery }) {
  if (backend.profile.id !== tracking.backendId) throw new Error("Message receipt belongs to a different backend.");
  const receipt = await readMessageProgress(backend, tracking.query, { deadlineMs, signal }, request);
  if (receipt.interactionId !== tracking.query.interactionId || !Array.isArray(receipt.deliveries)) throw new Error("Message progress identity mismatch");
  const observed = receipt.deliveries.length > 0 && receipt.deliveries.every(d => d.observedAtMs !== null && d.observedAtMs !== undefined);
  const acknowledged = receipt.deliveries.length > 0 && receipt.deliveries.every(d => d.acknowledgedAtMs !== null && d.acknowledgedAtMs !== undefined);
  const report = await querySession({ action: "show", sessionId: tracking.session.sessionId, workspaceId: tracking.session.workspaceId, backend, hmuxCommand, deadlineMs, signal });
  const runtime = report.session?.runtime;
  const exact = report.session?.liveness?.exactGeneration && sameGeneration(tracking.session, runtime?.generation);
  const progress = exact ? runtime.agentRuntimeState?.progress : undefined;
  const turns = (progress?.report.message_turns ?? []).filter(t => receipt.deliveries.some(d => namesReceipt(t.delivery_receipt_id, d.delivery.receiptId)));
  return { receipt: { interactionId: receipt.interactionId, acceptedAtMs: receipt.acceptedAtMs, observed, acknowledged,
    wakeTurnStarted: turns.length > 0, wakeTurns: turns, dispatchState: receipt.dispatchState,
    deliveries: receipt.deliveries, pendingDeliveryCount: receipt.deliveries.filter(d => d.observedAtMs == null).length,
    oldestPendingAgeMs: Math.max(0, ...receipt.deliveries.filter(d => d.observedAtMs == null && Number.isSafeInteger(d.queuedAtMs)).map(d => Date.now() - d.queuedAtMs)),
    progress: progress ?? null,
    runtimeObservation: !report.session?.liveness?.exactGeneration ? "unavailable" : exact ? "current_generation" : "generation_changed" } };
}
