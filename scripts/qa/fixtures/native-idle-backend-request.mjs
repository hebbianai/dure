import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { performBackendProfileRequest } from "../../../cli/lib/backend-transport.mjs";

// Use the product transport against an already-running disposable service.
// Never bootstrap a backend, select a live profile, or write runtime state here.
const root = realpathSync(process.argv[2]);
assert.equal(basename(root), "codex-resources");
assert.ok(basename(dirname(root)).startsWith("dure-hmux-test."));
assert.equal(root, realpathSync(join(process.env.DURE_HMUX_TEST_STATE_ROOT, "codex-resources")));
assert.equal(root, realpathSync(process.env.DURE_HOME));
const descriptor = JSON.parse(readFileSync(join(root, "backend/control-plane.json"), "utf8"));
assert.equal(dirname(realpathSync(descriptor.socketPath)), join(root, "backend"));
const request = JSON.parse(readFileSync(0, "utf8"));
// Shutdown is a base lifecycle operation, not an advertised extension.
const capabilities = request.operation === "backend.shutdown" ? [] : [request.operation];
const profile = {
  id: "local", default: true,
  transport: { kind: "local", endpoint: { kind: "unix_socket", path: descriptor.socketPath } },
  auth: { kind: "peer" }, trust: { kind: "local_peer" },
  expected: {
    backendId: "dure-local", generation: descriptor.generation,
    protocol: { minimum: { major: 1, minor: 0 }, maximum: { major: 1, minor: 0 } },
    capabilities,
  },
  deadlineMs: 35000,
};
try {
  const response = await performBackendProfileRequest(profile, {
    ...request, requiredCapabilities: capabilities,
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ code: error.code, details: error.details })}\n`);
  process.exitCode = 1;
}
