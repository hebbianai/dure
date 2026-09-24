import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hmuxSession, runSessionCli } from "./lib/dure-session-test-fixture.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(session = hmuxSession(), input = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-send-session-"));
  roots.push(root);
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const hmux = join(root, "hmux.mjs");
  writeFileSync(hmux, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('capabilities')) console.log(JSON.stringify({schemaVersion:2,capabilities:['semantic_command_input_v1']}));
else if (args.includes('show')) console.log(JSON.stringify(${JSON.stringify(session)}));
else if (args.includes('command-input')) {
  console.log(JSON.stringify({ok:true,receipt:{terminalEpoch:'terminal-1',text:{recordId:'1',state:'written_to_pty'},submit:args.includes('--submit')?{recordId:'2',state:'written_to_pty'}:null},...${JSON.stringify(input)}}));
} else process.exit(72);
`);
  chmodSync(hmux, 0o700);
  return { root, hmux, calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
}

describe("exact managed Session send without a client registry", () => {
  it.each([[], ["--workspace", "workspace-1"]])("looks up the live generation and sends once: %j", (...scope) => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", ...scope, "--json"]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).target).toEqual({ sessionId: "session-1", workspaceId: "workspace-1" });
    const writes = f.calls().filter((args) => args.includes("command-input"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][writes[0].indexOf("--expected-fence-json") + 1])).toMatchObject({session_id:"session-1",workspace_id:"workspace-1",terminal_epoch:"terminal-1",channel_epoch:"7"});
  });
  it.each([
    { session_id: "different" }, { workspace_id: "different" },
    { health: "unprobed" }, { health: "exited", effectiveLifecycle: "exited" },
    { session_class: "standalone" }, { terminal_epoch: "" },
  ])("refuses mismatched or unavailable authority: %j", (patch) => {
    const f = fixture(hmuxSession(1, patch));
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", "--workspace", "workspace-1"]);
    expect(result.status).not.toBe(0);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it.each([["--backend", "remote"], ["--idempotency-key", "request-1"], ["--window-label", "peer"]])("refuses unsupported routing before input: %j", (...options) => {
    const f = fixture();
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello", ...options]);
    expect(result.status).not.toBe(0);
    expect(f.calls().some((args) => args.includes("command-input"))).toBe(false);
  });
  it("does not retry an uncertain input receipt", () => {
    const f = fixture(hmuxSession(), { receipt: {terminalEpoch:"different"} });
    const result = runSessionCli(f.root, f.hmux, ["send", "session-1", "hello"]);
    expect(result.status).not.toBe(0);
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });
});
