import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { runQaTauriApp } from "./tauri-app-launch.mjs";
import { readDescriptor, requestDevLaunchRestart } from "../../lib/dev-launch-client.mjs";
import { descriptorPath } from "../../lib/dev-launch-storage.mjs";
import { observeProcessMembers } from "../../lib/process-identity.mjs";
import { exactOwnedProcessIdentity, readOwnedProcessGroup, readOwnedProcessLedger } from "./owned-process-group.mjs";

const adapter = fileURLToPath(new URL("./tauri-app-launch.mjs", import.meta.url));
const processOwner = fileURLToPath(new URL("./owned-process-group.mjs", import.meta.url));

const fakeCli = `
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = process.env.DURE_QA_STATE_ROOT;
const file = path.join(root, "application.json");
const generation = process.env.DURE_DEV_LAUNCH_GENERATION;
const worker = path.join(root, "worker.mjs");
spawn(process.execPath, [worker, "frontend", generation], { stdio: "ignore" });
if (!fs.existsSync(path.join(root, "provider.json"))) {
  spawn(process.execPath, [worker, "provider", generation], { detached: true, stdio: "ignore" }).unref();
}
fs.writeFileSync(file, JSON.stringify({
  pid: process.pid,
  generation,
  args: process.argv.slice(2),
  home: process.env.HOME,
  dureHome: process.env.DURE_HOME,
  discoveryRoot: process.env.HMUX_DISCOVERY_ROOT,
  channel: process.env.DURE_APP_CHANNEL,
}));
const interval = setInterval(() => {
  if (fs.existsSync(path.join(root, "release"))) process.exit(0);
}, 20);
setTimeout(() => { clearInterval(interval); process.exit(71); }, 90000);
`;
const worker = `
import fs from "node:fs";
import path from "node:path";
import { observeProcessMembers } from ${JSON.stringify(new URL("../../lib/process-identity.mjs", import.meta.url).href)};
const [role, generation] = process.argv.slice(2);
const root = process.env.DURE_QA_STATE_ROOT;
const observation = await observeProcessMembers({ kind: "point", pids: [process.pid] });
if (observation.status !== "complete" || observation.members.length !== 1) process.exit(72);
fs.writeFileSync(path.join(root, role === "provider" ? "provider.json" : "frontend-" + generation + ".json"), JSON.stringify(observation.members[0]));
const interval = setInterval(() => {
  if (fs.existsSync(path.join(root, "release"))) process.exit(0);
}, 20);
setTimeout(() => { clearInterval(interval); process.exit(71); }, 90000);
`;

function fixture() {
  const stateRoot = realpathSync(mkdtempSync(join(tmpdir(), "dure-pane-restart-")));
  const home = join(stateRoot, "home");
  const discoveryRoot = join(stateRoot, "hmux-discovery");
  const root = join(stateRoot, "checkout");
  const packageRoot = join(root, "node_modules/@tauri-apps/cli");
  const channel = "qa-pane-restart";
  for (const directory of [join(home, ".dure/channels", channel), discoveryRoot, packageRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ bin: { tauri: "entry.cjs" } }));
  writeFileSync(join(packageRoot, "entry.cjs"), fakeCli);
  writeFileSync(join(stateRoot, "worker.mjs"), worker);
  const environment = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    HOME: home,
    DURE_HOME: join(home, ".dure"),
    DURE_QA_STATE_ROOT: stateRoot,
    DURE_QA_APP_CHANNEL: channel,
    DURE_APP_CHANNEL: channel,
    VITE_DURE_APP_CHANNEL: channel,
    HMUX_DISCOVERY_ROOT: discoveryRoot,
  };
  return { stateRoot, root, home, discoveryRoot, environment, channel };
}

test("launch adapter reuses exact isolated authority and installed CLI resolution", async () => {
  const f = fixture();
  const calls = [];
  const outcome = { code: 0 };
  assert.equal(await runQaTauriApp('{"app":{"windows":[]}}', {
    worktreeRoot: f.root,
    environment: f.environment,
    supervise: async (options) => { calls.push(options); return outcome; },
  }), outcome);
  assert.deepEqual(calls, [{
    home: f.home, worktreeRoot: f.root, channel: f.channel,
    command: process.execPath,
    args: [join(f.root, "node_modules/@tauri-apps/cli/entry.cjs"), "dev", "--no-watch", "--config", '{"app":{"windows":[]}}'],
    spawnOptions: { cwd: f.root, env: f.environment, stdio: "inherit" },
  }]);
});

test("restart cannot admit a split HOME, DURE_HOME, channel or discovery root", async () => {
  const f = fixture();
  for (const change of [
    { HOME: f.stateRoot },
    { DURE_HOME: f.stateRoot },
    { DURE_APP_CHANNEL: "other" },
    { VITE_DURE_APP_CHANNEL: "other" },
    { HMUX_DISCOVERY_ROOT: f.home },
  ]) {
    let called = false;
    await assert.rejects(runQaTauriApp("{}", {
      worktreeRoot: f.root,
      environment: { ...f.environment, ...change },
      supervise: async () => { called = true; },
    }));
    assert.equal(called, false);
  }
});

test("retains the outer witness without advertising its FD to an exec-replaced child", async () => {
  const f = fixture();
  const environment = { ...f.environment, DURE_QA_LIVENESS_WITNESS_FD: "3", HEBBIAN_QA_LIVENESS_WITNESS_FD: "3" };
  let childEnvironment;
  await runQaTauriApp("{}", {
    worktreeRoot: f.root,
    environment,
    supervise: async ({ spawnOptions }) => { childEnvironment = spawnOptions.env; return { code: 0 }; },
  });
  assert.deepEqual(childEnvironment, f.environment);
  assert.equal(environment.DURE_QA_LIVENESS_WITNESS_FD, "3");
  assert.equal(environment.HEBBIAN_QA_LIVENESS_WITNESS_FD, "3");
});

for (const owned of [false, true]) test.runIf(process.platform === "darwin" || process.platform === "linux")(`actual supervisor preserves detached runtime while replacing the CLI/frontend (${owned ? "QA owned launch" : "direct launch"})`, async () => {
  const f = fixture();
  const config = '{"build":{"devUrl":"http://127.0.0.1:54321"}}';
  const ownerPath = join(f.stateRoot, "app-process-group.json");
  const args = owned
    ? [processOwner, "run-observed", ownerPath, "--", process.execPath, adapter, config]
    : [adapter, config];
  const child = spawn(process.execPath, args, {
    cwd: f.root, env: f.environment, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let outcome;
  child.stdout.on("data", (data) => { output = (output + data).slice(-16000); });
  child.stderr.on("data", (data) => { output = (output + data).slice(-16000); });
  child.once("error", (error) => { outcome = { error: error.message }; });
  child.once("exit", (code, signal) => { outcome = { code, signal }; });
  const options = { home: f.home, channel: f.channel, worktreeRoot: f.root, root: f.root };
  async function waitFor(label, operation, expectRunning = true) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (expectRunning && outcome) throw new Error(`${label}: launcher exited ${JSON.stringify(outcome)} ${output}`);
      const value = await operation();
      if (value) return value;
      await delay(20);
    }
    throw new Error(`${label}: observation deadline ${output}`);
  }
  function application() {
    try { return JSON.parse(readFileSync(join(f.stateRoot, "application.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  const observations = [];
  const readWorker = (name) => {
    try { return JSON.parse(readFileSync(join(f.stateRoot, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  try {
    const before = await waitFor("initial ready", () => {
      if (!existsSync(descriptorPath(f.home, f.channel))) return null;
      const value = readDescriptor(options).value;
      return value?.state === "ready" ? value : null;
    });
    if (owned) {
      await waitFor("QA owner witnesses nested supervisor", () => {
        if (!existsSync(ownerPath)) return false;
        const owner = readOwnedProcessGroup(ownerPath, child.pid);
        return readOwnedProcessLedger(owner).some((entry) => entry.pid === before.supervisor.pid);
      });
    } else assert.equal(before.supervisor.pid, child.pid);
    const initial = await waitFor("initial application", application);
    assert.equal(initial.pid, before.launch.pid);
    const initialFrontend = await waitFor("initial frontend", () => readWorker(`frontend-${initial.generation}.json`));
    const provider = await waitFor("initial detached runtime", () => readWorker("provider.json"));
    observations.push(initialFrontend, provider);
    if (owned) {
      await waitFor("QA owner records detached runtime", () => readOwnedProcessLedger(readOwnedProcessGroup(ownerPath, child.pid))
        .some((entry) => entry.pid === provider.pid && exactOwnedProcessIdentity(entry).processIdentity === provider.processIdentity));
    }
    const inputs = { ...initial };
    delete inputs.pid;
    delete inputs.generation;
    assert.deepEqual(inputs, {
      args: ["dev", "--no-watch", "--config", config], home: f.home,
      dureHome: join(f.home, ".dure"), discoveryRoot: f.discoveryRoot, channel: f.channel,
    });
    observations.push(before.launch);
    const receipt = await requestDevLaunchRestart({ ...options, expectedAuthority: before });
    const after = await waitFor("successor ready", () => {
      const value = readDescriptor(options).value;
      return value?.state === "ready" && value.launch.generation === receipt.launch.generation ? value : null;
    });
    const successor = await waitFor("successor application", () => {
      const value = application();
      return value?.generation === after.launch.generation ? value : null;
    });
    observations.push(after.launch);
    assert.equal(successor.pid, after.launch.pid);
    assert.notEqual(after.launch.processIdentity, before.launch.processIdentity);
    assert.notEqual(after.launch.generation, before.launch.generation);
    assert.deepEqual(after.supervisor, before.supervisor);
    assert.deepEqual(receipt.previousLaunch, before.launch);
    const successorFrontend = await waitFor("successor frontend", () => readWorker(`frontend-${successor.generation}.json`));
    observations.push(successorFrontend);
    const observation = await observeProcessMembers({ kind: "point", pids: [before.launch.pid, initialFrontend.pid, provider.pid] });
    assert.equal(observation.status, "complete");
    assert.equal(observation.members.some((member) => member.state !== "zombie" &&
      [before.launch, initialFrontend].some((old) => member.pid === old.pid && member.processIdentity === old.processIdentity)), false);
    assert.equal(observation.members.some((member) => member.state !== "zombie" && member.pid === provider.pid && member.processIdentity === provider.processIdentity), true);
    assert.deepEqual(readWorker("provider.json"), provider);
    assert.deepEqual({ ...successor, pid: initial.pid, generation: initial.generation }, initial);
    writeFileSync(join(f.stateRoot, "restart-evidence.json"), JSON.stringify({ initial, successor, receipt, observation, provider, initialFrontend, successorFrontend, owned }));
    if (owned) {
      const descriptor = readOwnedProcessGroup(ownerPath, child.pid);
      const ledger = JSON.parse(readFileSync(`${ownerPath}.ownership-ledger.json`, "utf8"));
      const cases = [
        { name: "owned detached runtime", pid: provider.pid, status: 0 },
        { name: "outer group leader", pid: descriptor.leaderPid, status: 0 },
        { name: "unrelated current process", pid: process.pid, status: 1 },
        { name: "retired predecessor", pid: before.launch.pid, status: 1 },
        { name: "reused outer-group PID", pid: descriptor.leaderPid, status: 1,
          mutate: (value) => { value.processes = value.processes.map((entry) => entry.pid === descriptor.leaderPid ? { ...entry, kernelStartMarker: ledger.processes.find((entry) => entry.pid === provider.pid).kernelStartMarker } : entry); } },
        { name: "missing ownership", pid: descriptor.leaderPid, status: 1,
          mutate: (value) => { value.processes = []; } },
        { name: "unhealthy ownership", pid: descriptor.leaderPid, status: 97,
          mutate: (value) => { value.healthy = false; value.failureReason = "fixture observer unavailable"; } },
      ];
      for (const [index, entry] of cases.entries()) {
        let target = ownerPath;
        if (entry.mutate) {
          const root = join(f.stateRoot, `read-only-ownership-${index}`);
          mkdirSync(root, { mode: 0o700 });
          target = join(root, "group.json");
          writeFileSync(target, JSON.stringify({ ...descriptor, descriptorPath: target }), { flag: "wx", mode: 0o600 });
          const value = structuredClone(ledger);
          entry.mutate(value);
          writeFileSync(`${target}.ownership-ledger.json`, JSON.stringify(value), { flag: "wx", mode: 0o600 });
        }
        const result = spawnSync(process.execPath, [processOwner, "contains-live-pid", target, String(child.pid), String(entry.pid)], { encoding: "utf8", timeout: 3000 });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, entry.status, `${entry.name}: ${result.stderr}`);
      }
    }
  } finally {
    writeFileSync(join(f.stateRoot, "release"), "release\n", { mode: 0o600 });
    await waitFor("cooperative fixture exit", () => outcome, false);
    await waitFor("recorded fixture generation exit", async () => {
      const observation = await observeProcessMembers({ kind: "point", pids: observations.map(({ pid }) => pid) });
      assert.equal(observation.status, "complete");
      return !observation.members.some((member) => member.state !== "zombie" && observations.some((old) => old.processIdentity === member.processIdentity));
    }, false);
    console.log(`retained fixture root: ${f.stateRoot}`);
  }
  assert.deepEqual(outcome, { code: 0, signal: null }, output);
});
