import assert from "node:assert/strict";
import { processMemberSnapshots } from "../lib/process-identity.mjs";
import { requireWindowsProcessIdentitySupport } from "../lib/windows-process-identity-support.mjs";

assert.equal(process.platform, "win32");
const started = performance.now();
// Reuse the desktop doctor's bounded Windows bootstrap before storage asks
// for an ordinary point observation. No new retry or process identity path.
const support = await requireWindowsProcessIdentitySupport();
const readyAt = performance.now();
const observation = processMemberSnapshots([process.pid]);
console.log(JSON.stringify({
  observation: "windows-native-identity-preflight",
  bootstrapDurationMs: readyAt - started,
  pointObservationDurationMs: performance.now() - readyAt,
  result: observation,
}));
assert.equal(observation.status, "complete");
assert.equal(observation.members.length, 1);
assert.equal(observation.members[0].processIdentity, support.current.processIdentity);
