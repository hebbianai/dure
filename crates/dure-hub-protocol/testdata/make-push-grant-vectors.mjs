#!/usr/bin/env node
// Writes push-grant-v1.json beside this file: push grant v1 test vectors (#660).
//
// Run once, by hand: `node crates/dure-hub-protocol/testdata/make-push-grant-vectors.mjs`.
// Every run makes a new throwaway P-256 key, kept in memory only, so the
// output differs between runs; the committed file is the reference.
//
// Each vector states what each reader must conclude:
// - `parse`: what PushGrantClaims::parse finds in `claims`: known, unknown
//   (a later version) or refused. dure-hub-protocol checks this.
// - `signatureValid`: whether `signature` is a valid ECDSA P-256 SHA-256
//   signature by `key` over "dure-push-grant-v1\0" || claims. The push
//   service (node) and the phone (ring) check this. A key that is not on the
//   curve is never valid.
// - `verdict`: whether the push service accepts the grant for `token`,
//   `environment`, `preference` and `hub` at `now`. Several vectors carry a
//   valid signature over claims that must still be refused: a verifier that
//   checks only the signature fails them.
// The generator checks every `signatureValid` with node:crypto before writing.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto";
import { writeFileSync } from "node:fs";

const CONTEXT = Buffer.from("dure-push-grant-v1\0", "utf8");
const DAY = 24 * 60 * 60;
const LIFETIME = 14 * DAY;
const MAX_LIFETIME = 15 * DAY;
// Fixed, so the file reads the same way whenever it is checked.
const ISSUED_AT = 1_795_600_000;

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
// crate::fingerprint::of_der: standard base64 of SHA-256, without padding.
const fingerprint = (der) =>
  `SHA256:${createHash("sha256").update(der).digest("base64").replace(/=+$/, "")}`;
// crate::push::push_key_id.
const keyId = (point) =>
  `k.${createHash("sha256").update(point).digest().subarray(0, 8).toString("hex")}`;

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
const point = Buffer.concat([
  Buffer.from([0x04]),
  Buffer.from(jwk.x, "base64url"),
  Buffer.from(jwk.y, "base64url"),
]);

const hub = fingerprint(Buffer.from("push grant vector computer certificate"));
const token = "a1b2c3d4".repeat(8);
const environment = "production";
const preference = "all";

// PushGrantClaims in declaration order. Spreading keeps that order for the
// fields it overrides and appends `nonce`, which is last.
const claimsObject = (overrides = {}) => ({
  version: 1,
  token,
  environment,
  hub,
  preference,
  epoch: 1,
  issuedAt: ISSUED_AT,
  expiresAt: ISSUED_AT + LIFETIME,
  ...overrides,
});
const canonical = (overrides) => Buffer.from(JSON.stringify(claimsObject(overrides)), "utf8");
const signOver = (claims) => sign("sha256", Buffer.concat([CONTEXT, claims]), privateKey);

function signatureHolds(key, claims, signature) {
  let publicKeyObject;
  try {
    publicKeyObject = createPublicKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        x: base64url(key.subarray(1, 33)),
        y: base64url(key.subarray(33)),
      },
    });
  } catch {
    return false;
  }
  return verify("sha256", Buffer.concat([CONTEXT, claims]), publicKeyObject, signature);
}

const vectors = [];
function add(name, why, { key = point, claims, signature = signOver(claims), parse, signatureValid, verdict }) {
  const holds = signatureHolds(key, claims, signature);
  if (holds !== signatureValid) {
    throw new Error(`${name}: signature ${holds ? "holds" : "fails"}, expected the opposite`);
  }
  vectors.push({
    name,
    why,
    key: base64url(key),
    keyId: keyId(key),
    claims: base64url(claims),
    signature: base64url(signature),
    parse,
    signatureValid,
    verdict,
  });
}

const validClaims = canonical();
const validSignature = signOver(validClaims);
const textOf = (claims) => claims.toString("utf8");
const edited = (from, to) => {
  const text = textOf(validClaims);
  if (!text.includes(from)) throw new Error(`missing ${from}`);
  return Buffer.from(text.replace(from, to), "utf8");
};

add("valid", "Canonical claims for this computer, signed by the key.", {
  claims: validClaims,
  signature: validSignature,
  parse: "known",
  signatureValid: true,
  verdict: "accept",
});
add(
  "valid_with_nonce",
  "The grant that answers a challenge carries its nonce as the last field.",
  {
    claims: canonical({ nonce: "0123456789abcdef0123456789abcdef" }),
    parse: "known",
    signatureValid: true,
    verdict: "accept",
  },
);
add("tampered_claims", "Canonical claims with a raised epoch, under the old signature.", {
  claims: canonical({ epoch: 2 }),
  signature: validSignature,
  parse: "known",
  signatureValid: false,
  verdict: "reject",
});
const tamperedSignature = Buffer.from(validSignature);
tamperedSignature[tamperedSignature.length - 1] ^= 0x01;
add("tampered_signature", "The valid claims under a signature with one bit changed.", {
  claims: validClaims,
  signature: tamperedSignature,
  parse: "known",
  signatureValid: false,
  verdict: "reject",
});
add(
  "duplicate_key",
  "Two epochs. serde refuses a duplicate field; JSON.parse keeps the last one.",
  {
    claims: edited('"epoch":1,', '"epoch":9,"epoch":1,'),
    parse: "refused",
    signatureValid: true,
    verdict: "reject",
  },
);
add("whitespace", "A space after a comma: the same meaning, other bytes.", {
  claims: edited(',"token":', ', "token":'),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
const { version, ...afterVersion } = claimsObject();
add("reordered", "The token before the version: the same meaning, other bytes.", {
  claims: Buffer.from(JSON.stringify({ token, version, ...afterVersion }), "utf8"),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
add("float", "An epoch written as a float.", {
  claims: edited('"epoch":1,', '"epoch":1.0,'),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
add("unknown_field", "A field version 1 does not have.", {
  claims: edited('"expiresAt":', '"computer":"other","expiresAt":'),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
add("uppercase_token", "The canonical token is lowercase hex.", {
  claims: canonical({ token: token.toUpperCase() }),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
add("hub_not_a_fingerprint", "The hub must be a whole certificate fingerprint.", {
  claims: canonical({ hub: "SHA256:short" }),
  parse: "refused",
  signatureValid: true,
  verdict: "reject",
});
add(
  "unknown_version",
  "A later claims version: the desktop passes it through, a version 1 service refuses it.",
  {
    claims: canonical({ version: 2 }),
    parse: "unknown",
    signatureValid: true,
    verdict: "reject",
  },
);
const offCurve = Buffer.from(point);
offCurve[offCurve.length - 1] ^= 0x01;
add("point_not_on_curve", "The key's y coordinate with one bit changed is not on P-256.", {
  key: offCurve,
  claims: validClaims,
  signature: validSignature,
  parse: "known",
  signatureValid: false,
  verdict: "reject",
});
add("lifetime_over_maximum", "A grant one second longer than 15 days.", {
  claims: canonical({ expiresAt: ISSUED_AT + MAX_LIFETIME + 1 }),
  parse: "known",
  signatureValid: true,
  verdict: "reject",
});

const document = {
  about:
    "Push grant v1 test vectors (#660), written by make-push-grant-vectors.mjs with a throwaway P-256 key that was never stored. See that file for what each field means.",
  context: "dure-push-grant-v1\u0000",
  hub,
  token,
  environment,
  preference,
  now: ISSUED_AT + DAY,
  maxLifetimeSecs: MAX_LIFETIME,
  vectors,
};
const target = new URL("./push-grant-v1.json", import.meta.url);
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`Wrote ${vectors.length} vectors to ${target.pathname}\n`);
