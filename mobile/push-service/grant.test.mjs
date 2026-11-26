import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { grantFits, grantSignatureHolds, importPushKey, pushKeyId, readClaims, readGrant } from "./grant.mjs";

// Written by crates/dure-hub-protocol/testdata/make-push-grant-vectors.mjs;
// dure-hub-protocol checks the same file's parse verdicts with serde.
const vectors = JSON.parse(readFileSync(new URL("../../crates/dure-hub-protocol/testdata/push-grant-v1.json", import.meta.url), "utf8"));
const subscription = { token: vectors.token, environment: vectors.environment, preference: vectors.preference, language: "en" };
const now = vectors.now * 1000;
const grantOf = ({ key, claims, signature }) => ({ key, claims, signature });

function parseVerdict(claims) {
  try {
    return readClaims(Buffer.from(claims, "base64url")).claims ? "known" : "unknown";
  } catch {
    return "refused";
  }
}

/** The service's whole check of one grant, structure to signature. */
function serviceVerdict(vector) {
  let grant;
  try {
    grant = readGrant(grantOf(vector));
  } catch {
    return "reject";
  }
  assert.equal(grant.keyId, vector.keyId);
  return grantFits(grant, { hub: vectors.hub, subscription, now }) === "current" && grantSignatureHolds(grant) ? "accept" : "reject";
}

/** The signature alone: canonical failures must not hide whether it holds. */
function signatureVerdict(vector) {
  let publicKey;
  try {
    publicKey = importPushKey(Buffer.from(vector.key, "base64url"));
  } catch {
    return false;
  }
  return grantSignatureHolds({ publicKey, claimsBytes: Buffer.from(vector.claims, "base64url"), signature: Buffer.from(vector.signature, "base64url") });
}

for (const vector of vectors.vectors) {
  test(`push grant vector ${vector.name}: ${vector.why}`, () => {
    assert.equal(pushKeyId(Buffer.from(vector.key, "base64url")), vector.keyId, "keyId");
    assert.equal(parseVerdict(vector.claims), vector.parse, "parse");
    assert.equal(signatureVerdict(vector), vector.signatureValid, "signatureValid");
    assert.equal(serviceVerdict(vector), vector.verdict, "verdict");
  });
}

test("every vector verdict the protocol names is covered", () => {
  assert.deepEqual(new Set(vectors.vectors.map((vector) => vector.verdict)), new Set(["accept", "reject"]));
  assert(vectors.vectors.some((vector) => vector.verdict === "reject" && vector.signatureValid), "a validly signed grant that must still be refused");
});

test("a grant fits only the computer, token, environment and preference it names, inside its lifetime", () => {
  const grant = readGrant(grantOf(vectors.vectors.find((vector) => vector.name === "valid")));
  const fits = (change = {}) => grantFits(grant, { hub: vectors.hub, subscription: { ...subscription, ...change.subscription }, now: change.now ?? now, ...("hub" in change ? { hub: change.hub } : {}) });
  assert.equal(fits(), "current");
  assert.equal(fits({ hub: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), "refused");
  assert.equal(fits({ subscription: { token: "cd".repeat(32) } }), "refused");
  assert.equal(fits({ subscription: { environment: "sandbox" } }), "refused");
  assert.equal(fits({ subscription: { preference: "approvals" } }), "refused");
  const { issuedAt, expiresAt } = grant.claims;
  assert.equal(fits({ now: (issuedAt - 300) * 1000 }), "current", "five minutes of phone clock ahead");
  assert.equal(fits({ now: (issuedAt - 301) * 1000 }), "expired", "issued too far in the future");
  assert.equal(fits({ now: (expiresAt - 1) * 1000 }), "current");
  assert.equal(fits({ now: expiresAt * 1000 }), "expired");
});

test("the grant structure has one spelling and no extra field", () => {
  const { key, claims, signature } = vectors.vectors.find((vector) => vector.name === "valid");
  assert.doesNotThrow(() => readGrant({ key, claims, signature }));
  for (const [label, grant] of [
    ["an extra field", { key, claims, signature, epoch: 2 }],
    ["a missing field", { key, claims }],
    ["padding", { key, claims: `${claims}=`, signature }],
    ["standard base64", { key: Buffer.from(key, "base64url").toString("base64"), claims, signature }],
    ["a compressed point", { key: Buffer.concat([Buffer.from([0x02]), Buffer.from(key, "base64url").subarray(1, 33)]).toString("base64url"), claims, signature }],
    ["a signature over the bound", { key, claims, signature: Buffer.alloc(81, 1).toString("base64url") }],
    ["not an object", [key, claims, signature]],
  ]) {
    assert.throws(() => readGrant(grant), undefined, label);
  }
});
