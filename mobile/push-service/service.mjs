// The Dure push service: it turns a paired computer's signed request into an
// APNs alert with fixed text and identifiers only.
//
// Every request is signed by the computer's Hub certificate (P-256). What
// lets that computer reach a phone depends on the route:
// - /v2 (#660): a grant the phone signed with its push key for exactly this
//   computer, token and preference, where that key has proved it receives the
//   token's alerts by signing back a challenge alert (a binding).
// - /v1: membership in the operator's allowlist, while one is configured.
//   Unsetting the allowlist ends v1.
//
// Checks run cheapest first, and signatures are verified only once the
// request could otherwise be answered: a forged request costs no signature
// check and no APNs call. Before the sender is proven, every refusal is a bare
// 403; a typed refusal only ever reaches the computer that holds the bound
// phone's grant.
import { createHash, verify, X509Certificate } from "node:crypto";
import { createServer } from "node:http";
import { bindingId, createBindings } from "./bindings.mjs";
import { CHALLENGE_REPEAT_MS, createChallenges, createRefusedTokens } from "./challenges.mjs";
import { grantFits, grantSignatureHolds, readGrant } from "./grant.mjs";
import { APPROVAL_RESERVE, charge, createLimits } from "./limits.mjs";

const MAX_REQUEST = 16 * 1024;
/** The alert kinds this service sends. */
export const KINDS = ["approval", "done", "input"];
/** What each version's Hub signature covers before the message, and its largest base64 message. */
const VERSIONS = {
  1: { context: Buffer.from("dure-push-request-v1\0"), maxMessage: 4096 },
  2: { context: Buffer.from("dure-push-request-v2\0"), maxMessage: 6144 },
};
const ROUTES = {
  "/v1/register": { version: 1, operation: "register" },
  "/v1/send": { version: 1, operation: "send" },
  "/v2/register": { version: 2, operation: "register" },
  "/v2/send": { version: 2, operation: "send" },
};
const MAX_SKEW_SECS = 120;
const MAX_PENDING = 16;
const RECEIPT_MS = 3600_000;

/** `PushId` in dure-hub-protocol: the alphabet Hmux mints opaque ids from. */
const opaque = (value) => typeof value === "string" && /^[A-Za-z0-9._:+-]{1,256}$/.test(value);
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

class Refused extends Error {}
const refuse = () => { throw new Refused("Refused push request"); };
const answer = (code, status, fields = {}, headers = {}) => ({ code, status, fields, headers });
/** The only answer before the sender is proven, and the one that counts as a failure. */
const REFUSED = answer(403, "refused");
const limited = (seconds) => answer(429, "rate_limited", {}, { "retry-after": String(seconds) });

/** `fingerprint::of_der` in dure-hub-protocol: SHA-256 of the DER in base64, unpadded. */
const fingerprintOf = (der) => `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;

/** An allowlist entry, padded as v1 operators wrote it or unpadded, in the unpadded form. */
export function readHubFingerprint(value) {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(value)) throw new Error("Invalid authorized Hub fingerprint");
  return value.replace(/=$/, "");
}

/**
 * A base URL this service answers v2 requests for, as the desktop names its
 * push service: https, no credentials, query or fragment, a path ending in
 * `/`. A signed request names it, so it cannot be replayed to another service.
 */
export function readAudience(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid push audience"); }
  if (url.protocol !== "https:" || url.username || url.password || value.includes("?") || value.includes("#")) throw new Error("Invalid push audience");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function decode(value, limit) {
  if (typeof value !== "string" || value.length > limit || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) refuse();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) refuse();
  return bytes;
}

/** Reads a signed request. `signed()` verifies it, which the caller does last. */
function readEnvelope(envelope, version) {
  if (!plainObject(envelope)) refuse();
  const { context, maxMessage } = VERSIONS[version];
  const der = decode(envelope.certificate, 8192);
  const messageBytes = decode(envelope.message, maxMessage);
  const signature = decode(envelope.signature, 256);
  const certificate = new X509Certificate(der);
  const { publicKey } = certificate;
  // Hub certificates are P-256. Any other key is refused before it is used.
  if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") refuse();
  return {
    hub: fingerprintOf(certificate.raw),
    message: JSON.parse(messageBytes.toString("utf8")),
    signed: () => verify("sha256", Buffer.concat([context, messageBytes]), publicKey, signature),
  };
}

function readSubscription(subscription) {
  if (!plainObject(subscription) || typeof subscription.token !== "string" || subscription.token.length > 512 || !/^(?:[a-f0-9]{2})+$/.test(subscription.token)) refuse();
  if (!["sandbox", "production"].includes(subscription.environment) || !["all", "approvals"].includes(subscription.preference) || !["en", "ko"].includes(subscription.language)) refuse();
  return subscription;
}

/**
 * The event's shape. A kind this service does not send is refused on v1; on
 * v2 it reads as not `known`, and the proven sender learns it is unsupported.
 */
function readEvent(event, version) {
  if (!plainObject(event) || typeof event.eventId !== "string" || !event.eventId || event.eventId.length > 512) refuse();
  // On v2 the event id is an identifier as well: the desktop hashes any other.
  if (version === 2 && !/^[A-Za-z0-9._:+-]{1,512}$/.test(event.eventId)) refuse();
  if (!KINDS.includes(event.kind)) {
    if (version === 1 || !opaque(event.kind)) refuse();
    return { known: false };
  }
  // What travels to APNs beside the text is opaque identifiers only: never a path or a title.
  if (event.sessionId !== undefined && !opaque(event.sessionId)) refuse();
  if (event.approval !== undefined && (event.kind !== "approval" || event.sessionId === undefined || !plainObject(event.approval) || Object.keys(event.approval).sort().join() !== "attentionId,terminalEpoch" || !opaque(event.approval.attentionId) || !opaque(event.approval.terminalEpoch))) refuse();
  if (event.reply !== undefined && (event.kind !== "done" || event.sessionId === undefined || !plainObject(event.reply) || Object.keys(event.reply).join() !== "terminalEpoch" || !opaque(event.reply.terminalEpoch))) refuse();
  return { known: true };
}

function readMessage(message, { version, operation, now, audiences }) {
  if (!plainObject(message) || message.version !== version || message.operation !== operation || !Number.isSafeInteger(message.issuedAt) || Math.abs(now / 1000 - message.issuedAt) > MAX_SKEW_SECS) refuse();
  if (version === 2 && !audiences.has(message.audience)) refuse();
  const subscription = readSubscription(message.subscription);
  if (operation === "register") return { subscription, event: message.event == null ? null : refuse() };
  return { subscription, event: readEvent(message.event, version) };
}

/**
 * - `allowedHubs`: v1 computers, padded or unpadded fingerprints. Empty ends v1.
 * - `audiences`: the base URLs v2 requests may name. At least one.
 * - `bindings`: the proven bindings; in memory unless given a durable store.
 * - `clientAddressHeader`: a header the proxy in front sets to the client's
 *   address, such as `fly-client-ip`. Without one, the socket's address.
 * - `limits`: the abuse limits, {@link createLimits} unless a test narrows one.
 */
export function createPushServer({ allowedHubs = [], audiences = [], sender, now = Date.now, bindings = createBindings({ now }), limits = createLimits({ now }), clientAddressHeader }) {
  const hubs = new Set([...allowedHubs].map(readHubFingerprint));
  const services = new Set([...audiences].map(readAudience));
  if (services.size === 0) throw new Error("At least one push audience is required");
  const api = hubs.size ? [1, 2] : [2];
  const challenges = createChallenges({ now });
  const refusedTokens = createRefusedTokens({ now });
  const receipts = new Map();
  const pending = new Map();
  const addressHeader = clientAddressHeader?.toLowerCase();
  const clientAddress = (request) => String((addressHeader && request.headers[addressHeader]) || request.socket.remoteAddress || "unknown").slice(0, 64);

  // The alert itself, for a sender already allowed to reach this token.
  // Concurrent copies of one event share one APNs call and one charge.
  async function deliverAlert({ hub, message, id, version }) {
    const { subscription, event } = message;
    if (subscription.preference === "approvals" && event.kind !== "approval") return answer(200, "filtered");
    const key = createHash("sha256").update(`${hub}\0${subscription.environment}\0${subscription.token}\0${event.eventId}`).digest("hex");
    for (const [receipt, at] of receipts) if (now() - at > RECEIPT_MS) receipts.delete(receipt);
    if (receipts.has(key)) return answer(200, "duplicate");
    if (!pending.has(key)) {
      if (pending.size >= MAX_PENDING) return answer(429, "busy");
      // Per token, with the last alerts of the day kept for approvals; on v2
      // also per computer, so one computer cannot spend another's alerts.
      const wait = charge(
        [limits.tokenSends, id, { reserve: event.kind === "approval" ? 0 : APPROVAL_RESERVE }],
        ...(version === 2 ? [[limits.hubSends, `${id}\0${hub}`]] : []),
      );
      if (wait) return limited(wait);
      const delivery = Promise.resolve().then(() => sender.send(message, hub)).catch(() => ({ status: "unavailable" })).then(async (result) => {
        if (result.status === "accepted") {
          receipts.set(key, now());
          if (receipts.size > 4096) receipts.delete(receipts.keys().next().value);
        }
        if (result.status === "unregistered") {
          refusedTokens.add(id);
          await bindings.drop(id);
        }
        return result;
      });
      pending.set(key, delivery);
    }
    const result = await pending.get(key);
    pending.delete(key);
    if (result.status === "accepted") return answer(202, "accepted");
    return result.status === "unregistered" ? answer(410, "unregistered") : answer(502, "unavailable");
  }

  async function v1(operation, { hub, signed, message }, { subscription }) {
    if (!hubs.has(hub) || !signed()) refuse();
    if (operation === "register") return answer(200, "registered");
    return deliverAlert({ hub, message, id: bindingId(subscription.environment, subscription.token), version: 1 });
  }

  // A phone key that has not proved receipt is sent a challenge. The answer
  // is the same whether the token is unbound or bound to another key.
  async function challenge({ id, grant, subscription, ip }) {
    const entry = challenges.open(id, grant.keyId);
    if (!entry) return limited(Math.ceil(CHALLENGE_REPEAT_MS / 1000));
    const sent = answer(202, "challenge_sent", { key: grant.keyId });
    if (entry.pushedAt !== undefined && now() - entry.pushedAt < CHALLENGE_REPEAT_MS) return sent;
    const wait = charge([limits.challengeStarts, ip], [limits.challenges, "all"], [limits.tokenChallengesHour, id], [limits.tokenChallengesDay, id]);
    if (wait) return limited(wait);
    const previous = entry.pushedAt;
    entry.pushedAt = now();
    const result = await Promise.resolve().then(() => sender.challenge(subscription, { nonce: entry.nonce, key: grant.keyId }, id)).catch(() => ({ status: "unavailable" }));
    if (result.status === "accepted") return sent;
    if (result.status === "unregistered") {
      refusedTokens.add(id);
      challenges.close(id, grant.keyId);
      return REFUSED;
    }
    entry.pushedAt = previous;
    return answer(502, "unavailable");
  }

  const stored = (result) => (result === "saved" ? answer(200, "registered") : answer(503, result));

  async function v2(operation, { hub, signed, message }, { subscription, event }, ip) {
    const grant = readGrant(message.grant);
    const fit = grantFits(grant, { hub, subscription, now: now() });
    if (fit === "refused") refuse();
    const id = bindingId(subscription.environment, subscription.token);
    if (refusedTokens.has(id)) refuse();
    const binding = bindings.get(id);
    const own = binding?.key === grant.key;
    // An alert needs the bound key, so a forged one costs no signature check.
    if (operation === "send" && !own) refuse();
    if (!signed() || !grantSignatureHolds(grant)) refuse();
    // The computer signed this request, and the phone key signed its grant.
    const { claims } = grant;
    if (operation === "send") {
      if (fit === "expired") return answer(403, "grant_expired");
      if (claims.epoch < binding.epoch) return answer(403, "grant_superseded");
      if (!event.known) return answer(422, "unsupported_kind");
      return deliverAlert({ hub, message, id, version: 2 });
    }
    const wait = limits.hubRegisters.take(hub);
    if (wait) return limited(wait);
    if (own) {
      if (fit === "expired") return answer(403, "grant_expired");
      if (claims.epoch < binding.epoch) return answer(403, "grant_superseded");
      const renewed = { ...binding, epoch: claims.epoch, until: Math.max(binding.until, claims.expiresAt) };
      if (renewed.epoch === binding.epoch && renewed.until === binding.until) return answer(200, "registered");
      return stored(await bindings.put(id, renewed));
    }
    if (fit === "expired") return REFUSED;
    if (claims.nonce && challenges.answers(id, grant.keyId, claims.nonce)) {
      // Proof of receipt: this key's phone got the challenge. It binds the
      // token, replacing any other key.
      const result = await bindings.put(id, { key: grant.key, epoch: claims.epoch, until: claims.expiresAt, boundAt: Math.floor(now() / 1000) });
      if (result === "saved") challenges.close(id, grant.keyId);
      return stored(result);
    }
    return challenge({ id, grant, subscription, ip });
  }

  const server = createServer(async (request, response) => {
    const reply = ({ code, status, fields, headers }) => {
      response.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      response.end(JSON.stringify({ status, ...fields }));
    };
    if (request.url === "/health" && request.method === "GET") {
      reply(answer(200, "ready", { api, kinds: KINDS }));
      return;
    }
    const route = ROUTES[request.url];
    if (!route || request.method !== "POST") {
      reply(answer(404, "not_found"));
      return;
    }
    const ip = clientAddress(request);
    const fail = (result) => {
      limits.failures.take(ip);
      reply(result);
    };
    const early = limits.failures.check(ip) || (route.operation === "register" ? limits.registers.take(ip) : 0);
    if (early) {
      request.resume();
      reply(limited(early));
      return;
    }
    if (route.version === 1 && hubs.size === 0) {
      request.resume();
      fail(REFUSED);
      return;
    }
    if (Number(request.headers["content-length"]) > MAX_REQUEST) {
      request.resume();
      fail(answer(413, "too_large"));
      return;
    }
    let size = 0;
    const chunks = [];
    let result;
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST) { fail(answer(413, "too_large")); return; }
        chunks.push(chunk);
      }
      const envelope = readEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")), route.version);
      const read = readMessage(envelope.message, { ...route, now: now(), audiences: services });
      result = await (route.version === 1 ? v1 : v2)(route.operation, envelope, read, ip);
    } catch {
      result = REFUSED;
    }
    if (response.headersSent) return;
    if (result === REFUSED) fail(result);
    else reply(result);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxConnections = 64;
  return server;
}
