import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { writeRegistry } from "./lib/dure-session-test-fixture.mjs";

const cli = fileURLToPath(new URL("../cli/dure.mjs", import.meta.url));
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ source = "local", fence = true, capability = true, response, failure = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-send-keys-"));
  roots.push(root);
  const hmux = join(root, "hmux");
  const calls = join(root, "calls.jsonl");
  writeFileSync(calls, "");
  const binding = { runtime: "hmux_managed_v1", source, hostId: "local", sessionId: "session-1", workspaceId: "workspace-1",
    ...(fence ? { stopFence: { runnerPrincipal: "runner", runnerInstance: "instance", channelEpoch: "18446744073709551615", hostInstanceId: "host", terminalEpoch: "epoch-1" } } : {}) };
  writeRegistry(root, [{ id: "agent-1", name: "worker", project: "fixture", sessionId: "session-1", runtimeBinding: binding }]);
  const receipt = response ?? { schemaVersion: 1, ok: true, sessionId: "session-1", workspaceId: "workspace-1",
    receipt: { terminalEpoch: "epoch-1", keys: ["11", "12", "13"].map((recordId) => ({ recordId, state: "written_to_pty" })) } };
  writeFileSync(hmux, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args.includes('capabilities')) {
  console.log(JSON.stringify({ schemaVersion: 1, capabilities: ${JSON.stringify(capability ? ["semantic_key_input_v1"] : [])} }));
} else {
  console.log(${JSON.stringify(JSON.stringify(receipt))});
  process.exitCode = ${failure ? 1 : 0};
}
`, { mode: 0o700 });
  return {
    run: (args) => spawnSync(process.execPath, [cli, "send-keys", ...args], {
      env: { PATH: process.env.PATH, HOME: root, DURE_HOME: root, DURE_APP_CHANNEL: "stable", DURE_HMUX_BIN: hmux,
        HMUX_DISCOVERY_ROOT: join(root, "discovery") }, encoding: "utf8", timeout: 10_000,
    }),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
  };
}

describe("dure send-keys", () => {
  it("prints help without contacting a runtime", () => {
    const f = fixture();
    const result = f.run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dure send-keys worker C-c");
    expect(f.calls()).toEqual([]);
  });

  it("sends ordered semantic keys once to an exact fenced target and emits receipts", () => {
    const f = fixture();
    const result = f.run(["worker", "C-c", "Up", "Enter", "--json"]);
    expect(result.status, result.stderr).toBe(0);
    const commands = f.calls().filter((args) => args.includes("command-input"));
    expect(commands).toHaveLength(1);
    expect(commands[0].slice(-6)).toEqual(["--key", "C-c", "--key", "Up", "--key", "Enter"]);
    const fence = JSON.parse(commands[0][commands[0].indexOf("--expected-fence-json") + 1]);
    expect(fence).toMatchObject({ session_id: "session-1", workspace_id: "workspace-1", channel_epoch: "18446744073709551615", terminal_epoch: "epoch-1" });
    expect(JSON.parse(result.stdout)).toMatchObject({ apiVersion: "dure.send-keys/v1", ok: true,
      target: { agentId: "agent-1", sessionId: "session-1", workspaceId: "workspace-1" },
      receipt: { keys: [{ recordId: "11" }, { recordId: "12" }, { recordId: "13" }] } });
  });

  it.each([{ source: "ssh" }, { fence: false }, { capability: false }])("refuses unavailable authority or capability without input: %j", (options) => {
    const f = fixture(options);
    const result = f.run(["worker", "C-c", "--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { deliveryState: "not_written" } });
    expect(f.calls().filter((args) => args.includes("command-input"))).toEqual([]);
  });

  it.each([[], ["worker"], ["worker", "Enter", "--typo"], ["worker", ...Array(65).fill("Enter")]].map((args) => ({ args })))("rejects invalid command arguments before invoking Hmux: %j", ({ args }) => {
    const f = fixture();
    const result = f.run([...args, "--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(false);
    expect(f.calls()).toEqual([]);
  });

  it("preserves a partial failure receipt without retrying input", () => {
    const f = fixture({ failure: true, response: { schemaVersion: 1, ok: false,
      error: { code: "hmux_terminal_input_outcome_unknown", message: "Receipt deadline elapsed", deliveryState: "outcome_unknown", keyIndex: 1 },
      receipt: { terminalEpoch: "epoch-1", keys: [{ recordId: "11", state: "written_to_pty" }] } } });
    const result = f.run(["worker", "C-c", "Enter", "--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { deliveryState: "outcome_unknown", keyIndex: 1 },
      receipt: { keys: [{ recordId: "11" }] } });
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });

  it.each([
    { terminalEpoch: "wrong", keys: [{ recordId: "11", state: "written_to_pty" }] },
    { terminalEpoch: "epoch-1", keys: [{ recordId: "11", state: "accepted" }] },
    { terminalEpoch: "epoch-1", keys: [] },
  ])("does not claim delivery from an invalid final receipt: %j", (receipt) => {
    const f = fixture({ response: { schemaVersion: 1, ok: true, sessionId: "session-1", workspaceId: "workspace-1", receipt } });
    const result = f.run(["worker", "Enter", "--json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, error: { deliveryState: "outcome_unknown" } });
    expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
  });

  it("does not accept receipts from a different target or noncontiguous records", () => {
    for (const patch of [
      { sessionId: "replacement" }, { workspaceId: "wrong-workspace" },
      { receipt: { terminalEpoch: "epoch-1", keys: ["11", "13", "14"].map((recordId) => ({ recordId, state: "written_to_pty" })) } },
    ]) {
      const f = fixture({ response: { schemaVersion: 1, ok: true, sessionId: "session-1", workspaceId: "workspace-1",
        receipt: { terminalEpoch: "epoch-1", keys: ["11", "12", "13"].map((recordId) => ({ recordId, state: "written_to_pty" })) }, ...patch } });
      const result = f.run(["worker", "C-c", "Up", "Enter", "--json"]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout).error.deliveryState).toBe("outcome_unknown");
      expect(f.calls().filter((args) => args.includes("command-input"))).toHaveLength(1);
    }
  });
});
