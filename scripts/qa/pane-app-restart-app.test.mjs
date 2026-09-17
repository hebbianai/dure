import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import { observeRestartApp } from "./pane-app-restart-client.mjs";
import { loadAppControlDescriptor } from "../../cli/lib/app-control-location.mjs";
import { readOwnedProcessGroup, readOwnedProcessLedger } from "./lib/owned-process-group.mjs";

const ownerCommand = fileURLToPath(new URL("./lib/owned-process-group.mjs", import.meta.url));
const serverSource = `
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const root = process.env.DURE_QA_STATE_ROOT;
const channel = process.env.DURE_APP_CHANNEL;
const directory = path.join(process.env.DURE_HOME, "channels", channel);
const descriptor = { channel, generation: "fixture-native-generation", processId: process.pid, token: "fixture-only-token" };
const server = http.createServer((request, response) => {
  fs.appendFileSync(path.join(root, "requests.jsonl"), JSON.stringify({ method: request.method, url: request.url }) + "\\n");
  const mode = fs.readFileSync(path.join(root, "mode"), "utf8");
  const identity = { ...descriptor, ok: true };
  if (mode === "wrong-generation") identity.generation = "different-native-generation";
  if (mode === "wrong-pid") identity.processId += 1;
  if (mode === "wrong-channel") identity.channel = "qa-other";
  if (mode === "unowned") identity.processId = Number(fs.readFileSync(path.join(root, "unowned-pid"), "utf8"));
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(identity));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
descriptor.port = server.address().port;
fs.writeFileSync(path.join(directory, "server.json"), JSON.stringify(descriptor));
const interval = setInterval(() => {
  if (fs.existsSync(path.join(root, "release"))) {
    clearInterval(interval);
    clearTimeout(deadline);
    server.close();
    server.closeAllConnections();
  }
}, 20);
const deadline = setTimeout(() => { process.exit(71); }, 90000);
`;

test.runIf(process.platform === "darwin" || process.platform === "linux")("actual app observation authenticates backend generation and exact QA ownership", async () => {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "dure-pane-restart-app-")));
  const channel = "qa-native-observation";
  const home = join(stateRoot, "home");
  const directory = join(home, ".dure", "channels", channel);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(join(stateRoot, "hmux-discovery"), { mode: 0o700 });
  const ownerPath = join(stateRoot, "app-process-group.json");
  const source = join(stateRoot, "server.mjs");
  writeFileSync(source, serverSource, { mode: 0o600 });
  writeFileSync(join(stateRoot, "mode"), "live", { mode: 0o600 });
  writeFileSync(join(stateRoot, "unowned-pid"), String(process.pid), { mode: 0o600 });
  const child = spawn(process.execPath, [ownerCommand, "run-observed", ownerPath, "--", process.execPath, source], {
    cwd: stateRoot,
    env: { PATH: process.env.PATH, HOME: home, DURE_HOME: join(home, ".dure"), DURE_APP_CHANNEL: channel,
      DURE_QA_STATE_ROOT: stateRoot, HMUX_DISCOVERY_ROOT: join(stateRoot, "hmux-discovery") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let outcome;
  child.stdout.on("data", (data) => { output = (output + data).slice(-16000); });
  child.stderr.on("data", (data) => { output = (output + data).slice(-16000); });
  child.once("exit", (code, signal) => { outcome = { code, signal }; });
  child.once("error", (error) => { outcome = { error: error.message }; });
  async function waitFor(label, ready) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = ready();
      if (value) return value;
      await delay(20);
    }
    throw new Error(`${label}: ${output}`);
  }
  try {
    const descriptor = await waitFor("owned HTTP server ready", () => {
      const value = loadAppControlDescriptor(directory);
      if (!value || !existsSync(ownerPath)) return null;
      const owner = readOwnedProcessGroup(ownerPath, child.pid);
      return readOwnedProcessLedger(owner).some(({ pid }) => pid === value.processId) ? value : null;
    });
    const context = { channel, stateRoot };
    const identity = await observeRestartApp(descriptor, context);
    assert.equal(identity.pid, descriptor.processId);
    assert.equal(identity.generation, descriptor.generation);
    assert.equal(identity.channel, channel);
    assert.ok(identity.processIdentity.length > 0);
    assert.deepEqual(JSON.parse(readFileSync(join(stateRoot, "requests.jsonl"), "utf8").trim()), { method: "GET", url: "/ping" });
    for (const mode of ["wrong-generation", "wrong-pid", "wrong-channel"]) {
      writeFileSync(join(stateRoot, "mode"), mode, { mode: 0o600 });
      await assert.rejects(observeRestartApp(descriptor, context));
    }
    writeFileSync(join(stateRoot, "mode"), "unowned", { mode: 0o600 });
    await assert.rejects(observeRestartApp({ ...descriptor, processId: process.pid }, context), /not owned/);
  } finally {
    writeFileSync(join(stateRoot, "release"), "release\n", { mode: 0o600 });
    await waitFor("cooperative owner exit", () => outcome);
    assert.equal(outcome.code, 0, output);
    writeFileSync(join(stateRoot, "test-evidence.json"), JSON.stringify({ ownerPid: child.pid, stateRoot, outcome }), { mode: 0o600 });
    console.log(`retained fixture: ${stateRoot}`);
  }
});
