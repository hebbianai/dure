import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hmuxTestBinaries } from "../run-hmux-tests.mjs";
import { writeRegistry } from "../lib/dure-session-test-fixture.mjs";
import { managedRuntimeOperation } from "./lib/managed-runtime-rpc.mjs";

// Run through scripts/run-hmux-tests.mjs with prepared Hmux binaries. The
// guardian owns the real Host; the provider below emits only fixture content.
assert(process.env.DURE_HMUX_TEST_STATE_ROOT, "Run through scripts/run-hmux-tests.mjs");
const root = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
const discovery = fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT);
assert.equal(discovery, path.join(root, "hmux-discovery"));
const { hmuxCli, hmuxRuntime } = hmuxTestBinaries(process.env);
const cli = fs.realpathSync(hmuxCli);
const runtime = fs.realpathSync(hmuxRuntime);
const home = path.join(root, "home");
const appRoot = path.join(home, ".dure");
fs.mkdirSync(appRoot, { recursive: true, mode: 0o700 });
const environment = {
  HOME: home, DURE_HOME: appRoot, DURE_APP_CHANNEL: "stable",
  HMUX_DISCOVERY_ROOT: discovery, DURE_HMUX_BIN: cli,
  TMPDIR: path.join(root, "tmp"), TERM: "xterm-256color", LANG: "en_US.UTF-8",
  PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
};
const sourceCli = fileURLToPath(new URL("../../cli/dure.mjs", import.meta.url));
const sessionId = "qa-managed-read-json";
const workspaceId = "qa-read-workspace";
const marker = "MANAGED_JSON_READ_READY";
const stopFile = path.join(root, "stop-provider");
const run = (executable, args) => spawnSync(executable, args, {
  env: environment, cwd: root, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024,
});
const json = (result) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};
const hmux = (args) => json(run(cli, ["--json", ...args]));
const dure = (args) => run(process.execPath, [sourceCli, ...args]);

try {
  const created = await managedRuntimeOperation({ runtime, cwd: root, environment }, "create", {
    schema: "hmux-managed-create-v1", schemaVersion: 1, idempotencyKey: sessionId,
    sessionId, workspaceId, providerId: "codex", permissionMode: "default", providerCwd: root,
    initialRows: 24, initialColumns: 100,
    command: [process.execPath, "-e", `console.log(${JSON.stringify(marker)});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(stopFile)}))process.exit(0)},20)`],
  });
  assert.equal(created.state, "completed", JSON.stringify(created));
  writeRegistry(appRoot, [{
    id: "qa-read-agent", name: "worker", project: "Read QA", provider: "codex", kind: "pty", sessionId,
    runtimeBinding: { runtime: "hmux_managed_v1", source: "local", hostId: "local", sessionId, workspaceId },
  }]);
  const exact = [sessionId, "--workspace", workspaceId];
  const deadline = Date.now() + 10000;
  let nativeReceipt;
  do {
    nativeReceipt = hmux(["read", ...exact, "--lines", "60"]);
    if (nativeReceipt.lines.some(line => line.includes(marker))) break;
    assert(Date.now() < deadline, "Provider marker did not reach Hmux");
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
  assert.equal(nativeReceipt.sessionName, null, "Managed sessions have no standalone name");
  const listed = json(dure(["ls", "--json", "--deadline-ms", "10000"]));
  const session = listed.sessions.find(item => item.sessionId === sessionId && item.workspaceId === workspaceId);
  assert.equal(session?.liveness.state, "alive");
  console.log("Native managed session is alive and Hmux read returns sessionName: null");

  for (const target of [["Read QA/worker"], exact]) {
    const read = json(dure(["read", ...target, "-n", "60", "--json"]));
    assert.equal(read.ok, true);
    assert.equal(read.sessionName, null);
    assert.equal(typeof read.sequenceThrough, "string");
    assert.deepEqual(read.lines, nativeReceipt.lines);
    const text = dure(["read", ...target, "-n", "60"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /MANAGED_JSON_READ_READY/);
  }
  const probe = hmux(["session", "probe", ...exact]);
  assert.equal(probe.status, "healthy");
  assert.equal(probe.terminalEpoch, session.runtime.generation.terminalEpoch);
  console.log("PASS: qualified Agent and exact Session JSON/text reads preserve the live managed generation");
} finally {
  // End only our fixture provider; the existing guardian reaps its owned Host.
  fs.writeFileSync(stopFile, "stop", { mode: 0o600 });
}
