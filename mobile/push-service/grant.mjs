// The phone's push grant, as the push service reads and verifies it (#660).
//
// dure-hub-protocol (`push/grant.rs`) owns the format; this module mirrors
// its rules for the one party that checks the signature. The claims travel
// as the exact signed bytes, and they must equal their canonical
// re-serialization: compact JSON, fields in the order below, no duplicate,
// no whitespace, integers only, a lowercase token. That keeps serde on the
// phone and JSON.parse here from reading one grant two ways.
import { createHash, createPublicKey, verify } from "node:crypto";

/** `PUSH_GRANT_CONTEXT`: what the signature covers before the claims. */
const CONTEXT = Buffer.from("dure-push-grant-v1\0");
/** `PUSH_GRANT_VERSION`: the claims version this service reads. */
const VERSION = 1;
/** `PUSH_GRANT_MAX_LIFETIME_SECS`. */
const MAX_LIFETIME_SECS = 15 * 24 * 60 * 60;
/** `PUSH_GRANT_MAX_FUTURE_SKEW_SECS`. */
const MAX_FUTURE_SKEW_SECS = 300;
/** `PUSH_KEY_BYTES`, `MAX_GRANT_CLAIMS_BYTES`, `MAX_GRANT_SIGNATURE_BYTES`. */
const KEY_BYTES = 65;
const MAX_CLAIMS_BYTES = 1024;
const MAX_SIGNATURE_BYTES = 80;
/** `PushGrantClaims` declaration order. `nonce` is last and optional. */
const CLAIMS_ORDER = ["version", "token", "environment", "hub", "preference", "epoch", "issuedAt", "expiresAt", "nonce"];

export class GrantRefused extends Error {}
const refuse = () => { throw new GrantRefused("Refused push grant"); };
const plainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;

/** `push_key_id`: `k.` and the first 8 bytes of the point's SHA-256 in hex. */
export function pushKeyId(point) {
  return `k.${createHash("sha256").update(point).digest().subarray(0, 8).toString("hex")}`;
}

/** An uncompressed P-256 point as a key. Importing refuses a point off the curve. */
export function importPushKey(point) {
  if (point.length !== KEY_BYTES || point[0] !== 0x04) refuse();
  try {
    return createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") } });
  } catch {
    return refuse();
  }
}

/** Unpadded base64url with one spelling: no padding, no stray trailing bits. */
function unpadded(value, min, max) {
  if (typeof value !== "string" || value.length > Math.ceil((max * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(value)) refuse();
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value || bytes.length < min || bytes.length > max) refuse();
  return bytes;
}

/**
 * `PushGrantClaims::parse`: `{ claims }` for version 1, `{ version }` alone
 * for a later version, which this service does not read. Throws for
 * anything else.
 */
export function readClaims(bytes) {
  if (bytes.length === 0 || bytes.length > MAX_CLAIMS_BYTES) refuse();
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { refuse(); }
  if (!plainObject(value) || !Number.isInteger(value.version) || value.version < 0 || value.version > 0xffff) refuse();
  if (value.version > VERSION) return { version: value.version };
  if (value.version !== VERSION
    || typeof value.token !== "string" || !/^(?:[0-9a-f]{2}){1,256}$/.test(value.token)
    || !["sandbox", "production"].includes(value.environment)
    || typeof value.hub !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value.hub)
    || !["all", "approvals"].includes(value.preference)
    || !count(value.epoch) || !count(value.issuedAt) || !count(value.expiresAt)
    || ("nonce" in value && (typeof value.nonce !== "string" || !/^[0-9a-f]{32}$/.test(value.nonce)))) refuse();
  const claims = Object.fromEntries(CLAIMS_ORDER.filter((field) => field in value).map((field) => [field, value[field]]));
  if (!Buffer.from(JSON.stringify(claims), "utf8").equals(bytes)) refuse();
  return { version: VERSION, claims };
}

/**
 * Reads a grant's structure, its key and its claims, without verifying the
 * signature. The key must be a point on P-256: importing it refuses any
 * other.
 */
export function readGrant(value) {
  if (!plainObject(value) || Object.keys(value).sort().join() !== "claims,key,signature") refuse();
  const point = unpadded(value.key, KEY_BYTES, KEY_BYTES);
  const claimsBytes = unpadded(value.claims, 1, MAX_CLAIMS_BYTES);
  const signature = unpadded(value.signature, 1, MAX_SIGNATURE_BYTES);
  const publicKey = importPushKey(point);
  const { claims } = readClaims(claimsBytes);
  if (!claims) refuse();
  return { key: value.key, keyId: pushKeyId(point), publicKey, claimsBytes, signature, claims };
}

/**
 * Whether the grant is for this request: `current`, `expired` (its time has
 * not come or has passed, which a phone with a wrong clock produces) or
 * `refused` (it names another computer or subscription, or lasts too long).
 */
export function grantFits(grant, { hub, subscription, now }) {
  const { claims } = grant;
  const seconds = Math.floor(now / 1000);
  if (claims.hub !== hub || claims.token !== subscription.token || claims.environment !== subscription.environment || claims.preference !== subscription.preference) return "refused";
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > MAX_LIFETIME_SECS) return "refused";
  if (claims.issuedAt > seconds + MAX_FUTURE_SKEW_SECS || seconds >= claims.expiresAt) return "expired";
  return "current";
}

/** ECDSA P-256 SHA-256, DER, over `CONTEXT || claims`. */
export function grantSignatureHolds(grant) {
  try {
    return verify("sha256", Buffer.concat([CONTEXT, grant.claimsBytes]), grant.publicKey, grant.signature);
  } catch {
    return false;
  }
}
