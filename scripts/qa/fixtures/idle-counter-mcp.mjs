import fs from "node:fs";
import { createInterface } from "node:readline";

const journal = process.argv[2];
const record = (event) => fs.appendFileSync(journal, `${JSON.stringify({
  event, pid: process.pid, parentPid: process.ppid,
})}\n`);
record("started");
let calls = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  let result;
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "dure-idle-counter-fixture", version: "1.0.0" },
    };
  } else if (message.method === "tools/list") {
    result = { tools: [{
      name: "counter", description: "Credential-free local counter.",
      inputSchema: { type: "object", properties: {} },
    }] };
  } else if (message.method === "tools/call") {
    record("tool_call");
    result = { content: [{ type: "text", text: `fixture-call-${++calls}` }] };
  }
  if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: result ?? {} })}\n`);
  }
}
record("stdin_eof");
