import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  observeProcessMembers,
  processMemberFromObservation,
  signalProcessGeneration,
} from "../../lib/process-identity.mjs";

const [mode, directory] = process.argv.slice(2);
const root = realpathSync(directory);
assert.equal(basename(root), "usage-limit");
assert.ok(basename(dirname(root)).startsWith("dure-hmux-test."));
assert.equal(root, realpathSync(join(process.env.DURE_HMUX_TEST_STATE_ROOT, "usage-limit")));
const read = (name) => JSON.parse(readFileSync(join(root, name), "utf8"));
const server = read("app-server-child.json");
const driver = read("provider-child.json");
assert.equal(server.parentPid, driver.pid);
assert.equal(server.cwd, root);
const observation = await observeProcessMembers({
  kind: "point",
  pids: [server.pid, driver.pid],
});
assert.equal(observation.status, "complete");
const current = processMemberFromObservation(server.pid, observation);
const receipt = join(root, "app-server-generation.json");
if (mode === "capture") {
  assert.equal(current.status, "present");
  assert.equal(current.member.parentPid, driver.pid);
  assert.equal(processMemberFromObservation(driver.pid, observation).status, "present");
  writeFileSync(
    receipt,
    JSON.stringify({ ...server, processIdentity: current.member.processIdentity }),
    { mode: 0o600, flag: "wx" },
  );
} else if (mode === "crash") {
  const expected = read("app-server-generation.json");
  assert.equal(expected.pid, server.pid);
  assert.equal(expected.cwd, root);
  assert.equal(current.status, "present");
  assert.equal(current.member.parentPid, driver.pid);
  assert.equal(current.member.processIdentity, expected.processIdentity);
  // Only the previously captured fixture child; the native signal boundary
  // atomically checks this exact process generation again.
  assert.equal(await signalProcessGeneration(expected, "SIGKILL"), true);
} else if (mode === "verify-exit") {
  assert.equal(current.status, "departed");
  assert.equal(processMemberFromObservation(driver.pid, observation).status, "departed");
} else {
  throw new Error("unknown native loss fixture operation");
}
process.stdout.write(`${JSON.stringify({
  mode,
  owner: read("app-server-generation.json"),
  observation,
})}\n`);
