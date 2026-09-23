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
const unnamed = cli(["space", "create"]);
assert.ok(unnamed.space.name.trim());
const mcp = await handleMcpRequest({ jsonrpc: "2.0", method: "tools/call", params: {
  name: "app_space_create", arguments: { name: "MCP Review" },
} }, process.env);
record({ transport: "mcp", receipt: mcp });
assert.equal(mcp.isError, false, JSON.stringify(mcp));
assert.equal(mcp.structuredContent.space.name, "MCP Review");
const created = [named, unnamed, mcp.structuredContent];
const ids = created.map(({ space }) => space.spaceId);
assert.equal(new Set(ids).size, 3);
for (const receipt of created) {
  assert.equal(receipt.kind, "dure.client_space.create");
  assert.equal(receipt.space.mounted, true);
  assert.ok(receipt.space.spaceId);
  assert.ok(!initial.presentation.spaces.some((space) => space.id === receipt.space.spaceId));
  const shown = cli(["space", "show", receipt.space.spaceId]);
  assert.equal(shown.space.spaceId, receipt.space.spaceId);
  assert.equal(shown.space.active, true);
}
const observed = await observe("created Spaces in saved projection", () => cli(["observe"]),
  (value) => created.every(({ space }) => value.presentation.spaces.some(
    (saved) => saved.id === space.spaceId && saved.name === space.name)));
assert.equal(observed.presentation.spaces.length, initial.presentation.spaces.length + 3);
const refused = cli(["space", "create", "--name", "   "], 2);
assert.equal(refused.error.code, "invalid_request");
assert.equal(cli(["observe"]).presentation.spaces.length, observed.presentation.spaces.length);
record({ result: "passed", createdSpaceIds: ids });
console.log("CLI named/default and MCP Space creation, exact-ID activation and saved projection passed");
