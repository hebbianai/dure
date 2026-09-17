// Disposable worker with the production Dure catalogue and handlers. Only its
// backend request is replaced, allowing deterministic slow/error side effects.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout } from "node:timers/promises";
import { handleMcpRequest } from "../../../cli/lib/orchestration-mcp-server.mjs";
import { parseOrchestrationIntegrationReceipt } from "../../../cli/lib/orchestration-lifecycle.mjs";

const stateRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
if (!path.basename(stateRoot).startsWith("dure-hmux-test.")) {
  throw new Error("idle-worker fixture requires its guardian-owned root");
}
const root = fs.realpathSync(path.join(stateRoot, "mcp-idle"));
if (path.dirname(root) !== stateRoot) throw new Error("idle-worker fixture root escaped");
if (process.argv[2] !== "--receipt-json" || process.argv.length !== 4) {
  throw new Error("idle-worker fixture requires its exact integration receipt");
}
const integrationReceipt = parseOrchestrationIntegrationReceipt(JSON.parse(process.argv[3]));
const record = (event, detail = {}) => fs.appendFileSync(
  path.join(root, "events.jsonl"),
  `${JSON.stringify({ event, pid: process.pid, parentPid: process.ppid, ...detail })}\n`,
);
record("started");
let calls = 0;
const request = async (_endpoint, operation) => {
  const call = ++calls;
  record("called", { call, body: operation.body });
  if (operation.body.hold) {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(root, "release"))) {
      if (Date.now() > deadline) throw new Error("fixture call was not released");
      await setTimeout(10);
    }
  }
  if (operation.body.error) throw new Error("expected fixture tool error");
  return { apiVersion: "dure.orchestration/v1", method: operation.method, receipt: { call } };
};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const message = JSON.parse(line);
  record("request", { method: message.method });
  let response;
  try {
    const result = await handleMcpRequest(message, {}, { request, integrationReceipt });
    if (message.id === undefined) continue;
    response = { jsonrpc: "2.0", id: message.id, result };
  } catch (error) {
    if (message.id === undefined) continue;
    response = { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error.message } };
  }
  if (message.params?.arguments?.body?.malformed) response.id = "wrong-request";
  process.stdout.write(`${JSON.stringify(response)}\n`);
  record("responded", { id: message.id });
}
record("eof");
