import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { requestAppControl } from "../../cli/lib/app-control-client.mjs";
import { handleMcpRequest } from "../../cli/lib/orchestration-mcp-server.mjs";

const evidence = process.env.DURE_QA_EVIDENCE_DIR;
const descriptorPath = process.env.DURE_QA_SERVER_DESCRIPTOR;
assert.ok(evidence && descriptorPath, "Run through client-space-create-smoke.sh");
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
const transcript = [];
function record(entry) {
  transcript.push(entry);
  writeFileSync(join(evidence, "client-space-create.json"), JSON.stringify(transcript, null, 2));
}
function cli(args, expectedCode = 0) {
  const result = spawnSync(process.execPath, [resolve("cli/dure.mjs"), "client", ...args, "--json"], {
    env: process.env, encoding: "utf8", timeout: 65_000,
  });
  if (result.error) throw result.error;
  const receipt = JSON.parse(result.stdout || result.stderr);
  record({ transport: "cli", args, code: result.status, receipt });
  assert.equal(result.status, expectedCode, JSON.stringify(receipt));
  return receipt;
}
// Retry observations only; an uncertain mutation must not create another Space.
async function observe(label, read, accept, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (accept(last)) return last;
    await new Promise((done) => setTimeout(done, 200));
  } while (Date.now() < deadline);
  throw new Error(`${label}: ${JSON.stringify(last)}`);
}
await observe("frontend diagnostics ready", async () => {
  try {
    return await requestAppControl({ descriptor, path: "/diagnostics", body: {}, timeoutMs: 3000 });
  } catch (error) { return { error: String(error) }; }
}, (value) => !value.error, 90_000);
const initial = await observe("initial Space projection", () => cli(["observe"]),
  (value) => value.presentation.spaces.length > 0);
const named = cli(["space", "create", "--name", "  빌드 QA  "]);
assert.equal(named.space.name, "빌드 QA");
assert.equal(named.space.mounted, false);
const unnamed = cli(["space", "create"]);
assert.ok(unnamed.space.name.trim());
assert.equal(unnamed.space.mounted, false);
const selected = cli(["space", "create", "--name", "Selected QA", "--select"]);
assert.equal(selected.space.mounted, true);
const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
  name: "app_space_create", arguments: { name: "MCP Review" },
} }, process.env);
record({ transport: "mcp", receipt: mcp });
assert.equal(mcp.isError, false, JSON.stringify(mcp));
assert.equal(mcp.structuredContent.space.name, "MCP Review");
const created = [named, unnamed, selected, mcp.structuredContent];
const ids = created.map(({ space }) => space.spaceId);
assert.equal(new Set(ids).size, 4);
for (const receipt of created) {
  assert.equal(receipt.kind, "dure.client_space.create");
  assert.ok(receipt.space.spaceId);
  assert.ok(!initial.presentation.spaces.some((space) => space.id === receipt.space.spaceId));
  const shown = cli(["space", "show", receipt.space.spaceId]);
  assert.equal(shown.space.spaceId, receipt.space.spaceId);
  assert.equal(shown.space.active, true);
}
const observed = await observe("created Spaces in saved projection", () => cli(["observe"]),
  (value) => created.every(({ space }) => value.presentation.spaces.some(
    (saved) => saved.id === space.spaceId && saved.name === space.name)));
assert.equal(observed.presentation.spaces.length, initial.presentation.spaces.length + 4);
const refused = cli(["space", "create", "--name", "   "], 2);
assert.equal(refused.error.code, "invalid_request");
assert.equal(cli(["observe"]).presentation.spaces.length, observed.presentation.spaces.length);
// Exercise the public move route with a real isolated shell and compare exact
// native generations. No provider prompt or foreground input is sent.
const pane = cli(["pane", "create", "--space-id", named.space.spaceId, "--cwd", process.env.HOME]).pane;
function inspect() {
  const result = spawnSync(process.execPath, [resolve("cli/dure.mjs"), "inspect", pane.sessionId, "--workspace", pane.binding.workspaceId, "--json"], { env: process.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const session = JSON.parse(result.stdout).session;
  assert.equal(session.liveness.state, "alive");
  return session.runtime.generation;
}
const generation = inspect();
const move = (from, to) => cli(["pane", "move", pane.panelId, "--from-space-id", from, "--space-id", to]);
assert.equal(move(named.space.spaceId, unnamed.space.spaceId).pane.moved, true);
assert.equal(move(named.space.spaceId, unnamed.space.spaceId).pane.moved, false);
assert.deepEqual(inspect(), generation);
assert.equal(move(unnamed.space.spaceId, named.space.spaceId).pane.moved, true);
assert.deepEqual(inspect(), generation);
record({ result: "passed", createdSpaceIds: ids, movedPaneId: pane.panelId, generation });
console.log("Background/select/MCP Space creation and existing-pane moves with unchanged native generation passed");
