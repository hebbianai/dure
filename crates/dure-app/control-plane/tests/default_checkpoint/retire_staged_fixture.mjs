import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  processMemberSnapshots,
  signalProcessGenerationSync,
} from "../../../../../scripts/lib/process-identity.mjs";

const [operation, fixtureRoot, target, ...args] = process.argv.slice(2);
const root = fs.realpathSync(fixtureRoot);
assert.equal(path.dirname(root), fs.realpathSync("/tmp"));
assert(path.basename(root).startsWith("dure-mislabeled-control-plane-build-"));
assert.equal(fs.statSync(root).uid, process.getuid());
assert.equal(fs.statSync(root).mode & 0o077, 0);
const proofPath = path.join(root, "replacement-process.json");

if (operation === "launch") {
  assert.equal(args[0], "serve");
  const generation = args[args.indexOf("--expected-generation") + 1];
  assert.match(generation, /^local-v1-[a-f0-9]{32}$/u);
  const observation = processMemberSnapshots([process.pid], process.platform, {
    includeCwd: true,
  });
  assert.equal(observation.status, "complete");
  const identity = observation.members[0];
  assert.equal(identity.pid, process.pid);
  assert(identity.processIdentity && identity.cwd);
  fs.writeFileSync(
    proofPath,
    JSON.stringify({
      identity,
      generation,
      executable: fs.realpathSync(target),
    }),
    { flag: "wx", mode: 0o600 },
  );
  // exec preserves the recorded kernel process generation; no PID-only kill.
  process.execve(target, [target, ...args], process.env);
} else {
  assert.equal(operation, "retire");
  const candidate = JSON.parse(fs.readFileSync(target, "utf8"));
  const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
  assert.equal(candidate.generation, proof.generation);
  assert.equal(candidate.processId, proof.identity.pid);
  assert.equal(
    fs.realpathSync(candidate.hmuxDiscoveryRoot),
    path.join(root, "hmux-discovery"),
  );
  signalProcessGenerationSync(proof.identity, "SIGTERM");
}
