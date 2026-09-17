import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { handleMcpRequest } from "../cli/lib/orchestration-mcp-server.mjs";

const worker = fileURLToPath(
  new URL("../cli/lib/orchestration-mcp-server.mjs", import.meta.url),
);

function run(arguments_, input = "") {
  return spawnSync(process.execPath, [worker, ...arguments_], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    // Metadata inspection must not inherit a live session or backend route.
    env: {},
  });
}

describe("orchestration worker metadata boundary", () => {
  it("exports the actual handler catalogue without starting a backend", async () => {
    const result = run(["--catalogue"]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const catalogue = JSON.parse(result.stdout);
    expect(catalogue).toEqual({
      schemaVersion: 1,
      kind: "dure.mcp.stateless-worker-catalogue",
      initialize: await handleMcpRequest({ jsonrpc: "2.0", method: "initialize" }),
      tools: await handleMcpRequest({ jsonrpc: "2.0", method: "tools/list" }),
    });
    expect(catalogue.tools.tools.length).toBeGreaterThan(0);
  });

  it("preserves direct stdio initialization and tool discovery", async () => {
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ];
    const result = run([], `${messages.map(JSON.stringify).join("\n")}\n`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const responses = result.stdout.trim().split("\n").map(JSON.parse);
    expect(responses).toEqual([
      { jsonrpc: "2.0", id: 1, result: await handleMcpRequest(messages[0]) },
      { jsonrpc: "2.0", id: 2, result: await handleMcpRequest(messages[2]) },
    ]);
  });

  it("refuses an unknown launch mode instead of silently serving stdio", () => {
    const result = run(["--unknown"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("accepts a frozen integration receipt without reading a mutable installation", () => {
    const receipt = {
      schemaVersion: 1,
      provider: "codex",
      version: "fixture-v1",
      digest: "a".repeat(64),
      channel: "test",
      capabilities: ["event_cursor_v1"],
    };
    const message = { jsonrpc: "2.0", id: 1, method: "initialize" };
    const result = run(["--receipt-json", JSON.stringify(receipt)], `${JSON.stringify(message)}\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    for (const invalid of ["not-json", "{}", JSON.stringify({ ...receipt, digest: "invalid" })]) {
      const rejected = run(["--receipt-json", invalid]);
      expect(rejected.status).toBe(2);
      expect(rejected.stdout).toBe("");
    }
  });
});
