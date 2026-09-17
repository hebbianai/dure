import assert from "node:assert/strict";
import { test } from "vitest";
import { verifyPushSigning } from "./ios-push-signing.mjs";

const info = { CFBundleIdentifier: "dev.hebbian.ide.mobile", DurePushEnvironment: "development" };
const entitlements = {
  "aps-environment": "development",
  "com.apple.developer.team-identifier": "TESTTEAM12",
  "application-identifier": "TESTTEAM12.dev.hebbian.ide.mobile",
};
const profile = {
  TeamIdentifier: ["TESTTEAM12"],
  Entitlements: entitlements,
  ExpirationDate: "2030-01-01T00:00:00Z",
};

test("a matching explicit App ID, environment, team and unexpired profile meet signing prerequisites", () => {
  assert.equal(verifyPushSigning(info, entitlements, profile, 0).environment, "development");
});

test("exporting a development build with a production APNs signature is refused", () => {
  const production = { ...entitlements, "aps-environment": "production" };
  assert.throws(() => verifyPushSigning(info, production, { ...profile, Entitlements: production }, 0), /same APNs environment/);
  assert.equal(verifyPushSigning({ ...info, DurePushEnvironment: "production" }, production, { ...profile, Entitlements: production }, 0).environment, "production");
});

test("a wildcard App ID, missing capability, different team or expired profile cannot claim push readiness", () => {
  assert.throws(() => verifyPushSigning(info, { ...entitlements, "aps-environment": undefined }, profile, 0), /no Push/);
  assert.throws(() => verifyPushSigning(info, entitlements, { ...profile, Entitlements: { ...entitlements, "application-identifier": "TESTTEAM12.*" } }, 0), /exact Dure App ID/);
  assert.throws(() => verifyPushSigning(info, entitlements, { ...profile, TeamIdentifier: ["OTHERTEAM1"] }, 0), /one Apple team/);
  assert.throws(() => verifyPushSigning(info, entitlements, profile, Date.parse("2031-01-01")), /expired/);
});
