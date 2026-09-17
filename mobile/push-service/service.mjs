import { createHash, verify, X509Certificate } from "node:crypto";
import { createServer } from "node:http";

const MAX_REQUEST = 16 * 1024;
const SIGNING_CONTEXT = Buffer.from("dure-push-request-v1\0");

function parseEnvelope(envelope, allowedHubs, now, operation) {
  if (!envelope || typeof envelope !== "object") throw new Error("Invalid request");
  const decode = (value, limit) => {
    if (typeof value !== "string" || value.length > limit || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error("Invalid encoding");
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error("Invalid encoding");
    return bytes;
  };
  const certificate = new X509Certificate(decode(envelope.certificate, 8192));
  const sender = `SHA256:${createHash("sha256").update(certificate.raw).digest("base64")}`;
  if (!allowedHubs.has(sender)) throw new Error("Hub is not authorized");
  const messageBytes = decode(envelope.message, 4096);
  const signature = decode(envelope.signature, 256);
  if (!verify("sha256", Buffer.concat([SIGNING_CONTEXT, messageBytes]), certificate.publicKey, signature)) throw new Error("Invalid signature");
  const message = JSON.parse(messageBytes.toString("utf8"));
  if (message.version !== 1 || message.operation !== operation || !Number.isSafeInteger(message.issuedAt) || Math.abs(now / 1000 - message.issuedAt) > 120) throw new Error("Expired request or wrong operation");
  const { event, subscription } = message;
  if (operation === "send" && (!event || !["approval", "done"].includes(event.kind) || typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 512)) throw new Error("Invalid event");
  if (!subscription || typeof subscription.token !== "string" || subscription.token.length > 512 || !/^(?:[a-f0-9]{2})+$/.test(subscription.token)) throw new Error("Invalid device token");
  if (!["sandbox", "production"].includes(subscription.environment) || !["all", "approvals"].includes(subscription.preference) || !["en", "ko"].includes(subscription.language)) throw new Error("Invalid subscription");
  return { message, sender };
}

/** The allowlist grants use of the provider key, not access to a user's
 * sessions. Paired Hub consent is still required before the token is sent. */
export function createPushServer({ allowedHubs, sender, now = Date.now }) {
  if (!(allowedHubs instanceof Set) || allowedHubs.size === 0) throw new Error("At least one authorized Hub fingerprint is required");
  const receipts = new Map();
  const pending = new Map();
  const server = createServer(async (request, response) => {
    const reply = (status, result) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: result }));
    };
    if (request.url === "/health" && request.method === "GET") {
      reply(200, "ready");
      return;
    }
    const operation = request.url === "/v1/register" ? "register" : "send";
    if (!["/v1/send", "/v1/register"].includes(request.url) || request.method !== "POST") {
      reply(404, "not_found");
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_REQUEST) {
      reply(413, "too_large");
      request.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    let parsed;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST) { reply(413, "too_large"); return; }
        chunks.push(chunk);
      }
      parsed = parseEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")), allowedHubs, now(), operation);
    } catch {
      if (!response.headersSent) reply(403, "refused");
      return;
    }
    const { message, sender: hub } = parsed;
    if (operation === "register") { reply(200, "registered"); return; }
    if (message.subscription.preference === "approvals" && message.event.kind !== "approval") {
      reply(200, "filtered");
      return;
    }
    const key = createHash("sha256").update(`${hub}\0${message.subscription.environment}\0${message.subscription.token}\0${message.event.eventId}`).digest("hex");
    for (const [id, at] of receipts) if (now() - at > 3600_000) receipts.delete(id);
    if (receipts.has(key)) { reply(200, "duplicate"); return; }
    if (!pending.has(key)) {
      if (pending.size >= 16) { reply(429, "busy"); return; }
      const delivery = Promise.resolve().then(() => sender.send(message, hub)).catch(() => ({ status: "unavailable" }));
      pending.set(key, delivery);
    }
    const result = await pending.get(key);
    if (result.status === "accepted") {
      receipts.set(key, now());
      if (receipts.size > 4096) receipts.delete(receipts.keys().next().value);
    }
    pending.delete(key);
    reply(result.status === "accepted" ? 202 : result.status === "unregistered" ? 410 : 502, result.status);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  return server;
}
