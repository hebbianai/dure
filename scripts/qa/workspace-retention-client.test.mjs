import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it.each([504, 403])("handles startup HTTP %s without hiding a failed workload", async (status) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-retention-client-test-"));
  const home = path.join(root, "home");
  const evidence = path.join(root, "evidence");
  fs.mkdirSync(path.join(home, ".dure"), { recursive: true, mode: 0o700 });
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    if (requests === 1) {
      response.writeHead(status);
      response.end(JSON.stringify({ ok: false, error: { code: status === 504 ? "frontend_timeout" : "forbidden", message: "not claimed" } }));
    } else {
      response.end(JSON.stringify({ ok: true, report: {}, qaStatus: { state: "failed", phase: "setup", error: "fixture stopped" } }));
    }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const descriptor = path.join(home, ".dure", "server.json");
    fs.writeFileSync(descriptor, JSON.stringify({ port: server.address().port, token: "fixture" }), { mode: 0o600 });
    let failure;
    try {
      await execute(process.execPath, ["scripts/qa/workspace-retention-client.mjs"], {
        env: { ...process.env, HOME: home, DURE_QA_STATE_ROOT: root, DURE_QA_EVIDENCE_DIR: evidence,
          DURE_QA_SERVER_DESCRIPTOR: descriptor }, timeout: 10_000,
      });
    } catch (error) { failure = error; }
    expect(failure?.code).toBe(1);
    expect(requests).toBe(status === 504 ? 2 : 1);
    expect(failure?.stderr).toContain(status === 504 ? "fixture stopped" : "forbidden");
    const receipt = JSON.parse(fs.readFileSync(path.join(evidence, "last-status.json"), "utf8"));
    expect(receipt.points).toEqual([]);
    expect(receipt.summary).toBeUndefined();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true });
  }
});
