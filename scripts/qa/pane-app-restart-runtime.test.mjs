import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { observeRestartRuntime } from "./pane-app-restart-client.mjs";

function fixture(response = "live") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dure-pane-restart-runtime-")));
  const discoveryRoot = join(root, "hmux-discovery");
  const directory = join(discoveryRoot, "workspace-1", "session-1");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestFile = join(directory, "manifest.json");
  const envelope = {
    lifecycle: "ready",
    manifest: {
      common: {
        host_instance_id: "host-1",
        host_process: { process_id: 21001, start_marker: "host-generation-1" },
        lifetime: {
          channel_epoch: 1, runner_instance: "runner-1", runner_principal: "qa-owner",
          session_id: "session-1", workspace_id: "workspace-1",
        },
        session_class: "standalone",
      },
      provider_process: { process_id: 21002, start_marker: "shell-generation-1" },
      terminal_epoch: "terminal-1",
    },
  };
  writeFileSync(manifestFile, JSON.stringify(envelope), { mode: 0o600 });
  const callsFile = join(root, "calls.jsonl");
  const hmuxCli = join(root, "hmux-fixture");
  writeFileSync(hmuxCli, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(response)};
if (mode === "exit") process.exit(73);
if (mode === "malformed") { console.log("not-json"); process.exit(0); }
const target = { process_id: Number(args[5]), start_marker: args[6] };
if (mode === "wrong-pid") target.process_id += 1;
if (mode === "wrong-generation") target.start_marker = "replacement";
console.log(JSON.stringify({
  schemaVersion: mode === "wrong-schema" ? 2 : 1,
  status: ["stale", "unknown"].includes(mode) ? mode : "live",
  process: target,
}));
`, { mode: 0o700 });
  const calls = () => existsSync(callsFile)
    ? readFileSync(callsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    : [];
  return { root, discoveryRoot, hmuxCli, calls, envelope, manifestFile };
}

test("reads actual manifest files and probes the exact Host and shell generations", () => {
  const f = fixture();
  const result = observeRestartRuntime(f.discoveryRoot, f.hmuxCli);
  assert.equal(result.length, 1);
  assert.equal(result[0].session_id, "session-1");
  assert.equal(result[0].workspace_id, "workspace-1");
  assert.equal(result[0].terminal_epoch, "terminal-1");
  assert.deepEqual(result[0].hostProcess, f.envelope.manifest.common.host_process);
  assert.deepEqual(result[0].providerProcess, f.envelope.manifest.provider_process);
  assert.deepEqual(f.calls(), [
    ["--discovery-root", f.discoveryRoot, "--json", "process", "probe", "21001", "host-generation-1"],
    ["--discovery-root", f.discoveryRoot, "--json", "process", "probe", "21002", "shell-generation-1"],
  ]);
});

for (const response of ["stale", "unknown", "wrong-pid", "wrong-generation", "wrong-schema", "malformed", "exit"]) {
  test(`does not certify runtime survival after a ${response} process observation`, () => {
    const f = fixture(response);
    assert.throws(() => observeRestartRuntime(f.discoveryRoot, f.hmuxCli));
    assert.equal(f.calls().length, 1, "The real CLI boundary must be reached once without a retry");
  });
}

test("uses the existing manifest parser and does not probe an invalid target", () => {
  const f = fixture();
  delete f.envelope.manifest.common.host_process;
  writeFileSync(f.manifestFile, JSON.stringify(f.envelope), { mode: 0o600 });
  assert.throws(() => observeRestartRuntime(f.discoveryRoot, f.hmuxCli), /host/i);
  assert.deepEqual(f.calls(), []);
});

test("keeps an unready runtime unknown instead of probing a guessed process", () => {
  const f = fixture();
  f.envelope.lifecycle = "starting";
  delete f.envelope.manifest.provider_process;
  delete f.envelope.manifest.terminal_epoch;
  writeFileSync(f.manifestFile, JSON.stringify(f.envelope), { mode: 0o600 });
  assert.throws(() => observeRestartRuntime(f.discoveryRoot, f.hmuxCli), /ready/);
  assert.deepEqual(f.calls(), []);
});
