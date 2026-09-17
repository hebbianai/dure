import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { managedSessionEnrollmentEvidence } from "./managed-session-enrollment-evidence.mjs";
import { isOrchestrationResponse } from "./contracts/orchestration-envelope.mjs";
export { ORCHESTRATION_API_VERSION, createOrchestrationRequest } from "./contracts/orchestration-envelope.mjs";
export const ORCHESTRATION_CLIENT_CAPABILITIES = Object.freeze([
  "event_cursor_v1",
  "idempotent_delivery_receipt_v1",
  "interaction_message_v1",
  "interaction_decision_v1",
  "mcp_stdio_v1",
]);

export function orchestrationIntegrationInstallRootRef(provider, digest) {
  if (
    typeof provider !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(provider) ||
    typeof digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(digest)
  ) {
    return null;
  }
  return `install-${provider}-${digest.slice(0, 32)}`;
}

export function managedSessionEnrollmentIdempotencyKey(
  session,
  integrationReceipt,
  predecessor,
) {
  const evidence = managedSessionEnrollmentEvidence(
    session,
    integrationReceipt,
    predecessor,
  );
  return `run-${crypto.createHash("sha256").update(evidence).digest("hex")}`;
}

export function loadCursor(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) return 0;
  const value = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.lastAcknowledgedCursor) ||
    value.lastAcknowledgedCursor < 0 ||
    typeof value.deliveryReceiptId !== "string" ||
    value.deliveryReceiptId.length === 0
  ) {
    throw new Error("orchestration cursor checkpoint is invalid");
  }
  return value.lastAcknowledgedCursor;
}

export function checkpointCursor(checkpointPath, cursor, receipt) {
  if (
    !Number.isSafeInteger(cursor) ||
    cursor < 0 ||
    typeof receipt !== "string" ||
    receipt.length === 0
  ) {
    throw new Error("orchestration acknowledgement checkpoint is invalid");
  }
  const parent = path.dirname(checkpointPath);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(checkpointPath)) {
    const metadata = fs.lstatSync(checkpointPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("refusing unsafe orchestration cursor checkpoint");
    }
  }
  const current = loadCursor(checkpointPath);
  if (cursor < current) throw new Error("orchestration cursor checkpoint would move backwards");
  const temporary = path.join(
    parent,
    `.${path.basename(checkpointPath)}.next-${process.pid}-${crypto.randomUUID()}`,
  );
  let descriptor;
  let directoryDescriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({
        schemaVersion: 1,
        lastAcknowledgedCursor: cursor,
        deliveryReceiptId: receipt,
      })}\n`,
    );
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, checkpointPath);
    if (process.platform !== "win32") {
      directoryDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
      fs.closeSync(directoryDescriptor);
      directoryDescriptor = undefined;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export function exactAcknowledgementCheckpoint(
  receipt,
  through,
  expectedDeliveryReceiptId,
) {
  const acknowledgement = receipt?.acknowledgement;
  const deliveryReceiptId = acknowledgement?.delivery?.receiptId;
  if (
    acknowledgement?.through !== through ||
    acknowledgement?.delivery?.eventCursor !== through ||
    acknowledgement?.delivery?.state !== "acknowledged" ||
    typeof deliveryReceiptId !== "string" ||
    deliveryReceiptId.length === 0 ||
    (expectedDeliveryReceiptId !== undefined &&
      deliveryReceiptId !== expectedDeliveryReceiptId)
  ) {
    throw new Error("orchestration acknowledgement receipt does not match delivery");
  }
  return Object.freeze({ through, deliveryReceiptId });
}

export function defaultOrchestrationEndpoint(environment) {
  if (environment.DURE_ORCHESTRATION_HOME) return "backend-profile:local";
  return (
    environment.DURE_ORCHESTRATION_ENDPOINT ??
    `backend-profile:${environment.DURE_BACKEND_PROFILE ?? ""}`
  );
}

export async function requestOrchestration(endpoint, request, {
  fetchImplementation = globalThis.fetch,
  authorization,
  environment = globalThis.process?.env ?? {},
  signal,
  transportImplementation,
} = {}) {
  let receipt;
  if (typeof transportImplementation === "function") {
    receipt = await transportImplementation(endpoint, request, { signal });
  } else if (typeof endpoint === "string" && endpoint.startsWith("backend-profile:")) {
    const { requestOrchestrationThroughBackendProfile } = await import(
      "./orchestration-backend-transport.mjs"
    );
    receipt = await requestOrchestrationThroughBackendProfile(endpoint, request, {
      environment,
      signal,
    });
  } else {
    if (typeof fetchImplementation !== "function") {
      throw new Error("orchestration transport is unavailable");
    }
    let hostedEndpoint;
    try {
      hostedEndpoint = new URL(endpoint);
    } catch {
      throw new Error("orchestration hosted endpoint is invalid");
    }
    if (hostedEndpoint.protocol !== "https:") {
      throw new Error("orchestration hosted endpoint must use HTTPS");
    }
    if (
      typeof authorization !== "string" ||
      authorization.trim().length === 0 ||
      /[\u0000-\u001f\u007f]/u.test(authorization)
    ) {
      throw new Error("orchestration hosted endpoint requires authentication");
    }
    const response = await fetchImplementation(hostedEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization,
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`orchestration request failed (${response.status})`);
    receipt = await response.json();
  }
  if (
    !isOrchestrationResponse(receipt, request.method) ||
    receipt?.receipt === undefined
  ) {
    throw new Error("orchestration API version mismatch");
  }
  return receipt;
}

export async function resumeDurableInbox({
  endpoint,
  checkpointPath,
  identity,
  read,
  handle,
  acknowledge,
  signal,
}) {
  if (typeof read !== "function" || typeof handle !== "function" || typeof acknowledge !== "function") {
    throw new Error("orchestration inbox adapter is incomplete");
  }
  let cursor = loadCursor(checkpointPath);
  while (!signal?.aborted) {
    const receipt = await read({ endpoint, identity, afterCursor: cursor, signal });
    const deliveries = new Map();
    for (const delivery of receipt.deliveries ?? []) {
      if (
        typeof delivery?.receiptId !== "string" ||
        delivery.receiptId.length === 0 ||
        !Number.isSafeInteger(delivery.eventCursor) ||
        deliveries.has(delivery.eventCursor)
      ) {
        throw new Error("orchestration delivery receipt is invalid");
      }
      deliveries.set(delivery.eventCursor, delivery);
    }
    for (const event of receipt.events ?? []) {
      if (!Number.isSafeInteger(event?.cursor) || event.cursor <= cursor) {
        throw new Error("orchestration Event cursor is not monotonic");
      }
      const delivery = deliveries.get(event.cursor);
      if (!delivery) {
        throw new Error("orchestration delivery receipt is invalid");
      }
      await handle(event, delivery);
      const acknowledged = await acknowledge({
        endpoint,
        identity,
        throughCursor: event.cursor,
        deliveryReceiptId: delivery.receiptId,
        signal,
      });
      const checkpoint = exactAcknowledgementCheckpoint(
        acknowledged,
        event.cursor,
        delivery.receiptId,
      );
      checkpointCursor(
        checkpointPath,
        checkpoint.through,
        checkpoint.deliveryReceiptId,
      );
      cursor = checkpoint.through;
    }
    if ((receipt.events ?? []).length === 0) return cursor;
  }
  return cursor;
}
