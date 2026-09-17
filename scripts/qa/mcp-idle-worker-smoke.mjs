// Run through run-hmux-tests.mjs. No live provider, credentials or backend is
// used here; native-provider continuity is a separate integration observation.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { orchestrationWorkerCatalogue } from "../../cli/lib/orchestration-mcp-server.mjs";
import { observeProcessMembers, processMemberFromObservation, requireNativeProcessGroupSupport } from "../lib/process-identity.mjs";

const [relayPath] = process.argv.slice(2);
assert.ok(relayPath && path.isAbsolute(relayPath));
const relayExecutable = fs.realpathSync(relayPath);
const stateRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
assert.ok(path.basename(stateRoot).startsWith("dure-hmux-test."));
const root = path.join(stateRoot, "mcp-idle");
fs.mkdirSync(root, { mode: 0o700 });
const reportRoot = fs.mkdtempSync(path.join(path.dirname(stateRoot), "dure-mcp-idle-evidence-"));
console.log(JSON.stringify({ evidence: reportRoot }));
const cataloguePath = path.join(root, "catalogue.json");
fs.writeFileSync(cataloguePath, JSON.stringify(await orchestrationWorkerCatalogue()));
const worker = fileURLToPath(new URL("./fixtures/orchestration-idle-worker.mjs", import.meta.url));
const receipt = JSON.stringify({ schemaVersion: 1, provider: "codex", version: "fixture-v1", digest: "a".repeat(64), channel: "test", capabilities: ["event_cursor_v1"] });
const idleMs = 1_000;
const environment = {
  PATH: process.env.PATH,
  HOME: root,
  DURE_HOME: root,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT,
  DURE_HMUX_TEST_STATE_ROOT: stateRoot,
  TMPDIR: root,
};
const result = {
  ok: false, liveActivation: false, nativeProviderVerified: false,
  executable: relayExecutable,
  sha256: createHash("sha256").update(fs.readFileSync(relayExecutable)).digest("hex"),
  idleMs, observations: [],
};
const clients = [];

function events() {
  const file = path.join(root, "events.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
}

async function until(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error(message);
}

async function observe(pid) {
  const observation = await observeProcessMembers({ kind: "point", pids: [pid] });
  result.observations.push(observation);
  assert.equal(observation.status, "complete", JSON.stringify(observation));
  return processMemberFromObservation(pid, observation);
}

async function present(pid) {
  const current = await observe(pid);
  assert.equal(current.status, "present");
  return current.member;
}

async function gone(member) {
  await until(async () => {
    const current = await observe(member.pid);
    return current.status === "departed" || (current.status === "present" && current.member.processIdentity !== member.processIdentity);
  }, "exact MCP worker generation did not exit");
}

function rss(pid) {
  const value = Number(execFileSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8", timeout: 2_000 }).trim());
  assert.ok(Number.isFinite(value) && value > 0);
  return value;
}

function cpuSeconds(pid) {
  const value = execFileSync("ps", ["-p", String(pid), "-o", "time="], { encoding: "utf8", timeout: 2_000 }).trim();
  const parts = value.split(":").map(Number);
  assert.ok(parts.length >= 2 && parts.every(Number.isFinite), value);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function launch(executable, arguments_) {
  const child = spawn(executable, arguments_, { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes.toString()).slice(-16_384); });
  const pending = new Map();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const response = JSON.parse(line);
    pending.get(response.id)?.resolve(response);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const entry of pending.values()) entry.reject(new Error(`MCP endpoint exited: ${code}/${signal}: ${stderr}`));
      resolve({ code, signal, stderr });
    });
  });
  const client = {
    child, exited,
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`MCP fixture response timed out: ${method}: ${stderr}`));
        }, 15_000);
        const finish = (callback) => (value) => { clearTimeout(timer); pending.delete(id); callback(value); };
        pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async initialize() {
      const response = await this.request("initialize", { protocolVersion: "2025-06-18" });
      assert.equal(response.result.protocolVersion, "2025-06-18");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      assert.ok((await this.request("tools/list")).result.tools.length > 0);
    },
    call(body = {}) {
      return this.request("tools/call", { name: "orchestration_interaction_get", arguments: { body } });
    },
    async close() {
      child.stdin.end();
      const exit = await exited;
      assert.equal(exit.code, 0, JSON.stringify(exit));
    },
  };
  clients.push(client);
  return client;
}

function relay() {
  return launch(relayExecutable, ["mcp-stdio-relay", "--node", process.execPath, "--worker", worker, "--catalogue", cataloguePath, "--receipt-json", receipt, "--idle-ms", String(idleMs)]);
}

function workerStarted(client, after = 0) {
  return events().find((event, index) => index >= after && event.event === "started" && event.parentPid === client.child.pid);
}

try {
  await requireNativeProcessGroupSupport();
  const baseline = launch(process.execPath, [worker, "--receipt-json", receipt]);
  await baseline.initialize();
  assert.equal((await baseline.call()).result.structuredContent.receipt.call, 1);
  // The current direct worker remains resident despite having no work. Use
  // the same interval for the candidate; this is not a missing-command RED.
  const baselineGeneration = await present(baseline.child.pid);
  await delay(idleMs + 100);
  assert.equal((await present(baseline.child.pid)).processIdentity, baselineGeneration.processIdentity);
  result.baselineRssKiB = rss(baseline.child.pid);
  await baseline.close();

  const client = relay();
  await client.initialize();
  const endpoint = await present(client.child.pid);
  assert.equal(workerStarted(client), undefined);
  const dormantCpu = cpuSeconds(endpoint.pid);
  await delay(idleMs + 100);
  result.dormantCpuSeconds = cpuSeconds(endpoint.pid) - dormantCpu;
  assert.ok(result.dormantCpuSeconds < 0.1, "dormant endpoint is spending CPU without requests");
  result.dormantRssKiB = rss(client.child.pid);
  assert.ok(result.baselineRssKiB - result.dormantRssKiB >= 16 * 1024, "dormant native endpoint did not save at least 16 MiB versus this Dure worker");

  const held = client.call({ hold: true });
  const heldOutcome = held.then((response) => ({ response }), (error) => ({ error }));
  const started = await until(() => workerStarted(client), "worker was not lazily started");
  const firstWorker = await present(started.pid);
  assert.equal(firstWorker.parentPid, endpoint.pid);
  await until(() => events().some((event) => event.pid === started.pid && event.event === "called"), "tool was not invoked");
  await delay(idleMs + 100);
  assert.equal((await present(started.pid)).processIdentity, firstWorker.processIdentity);
  assert.ok(!events().some((event) => event.pid === started.pid && event.event === "eof"));
  fs.writeFileSync(path.join(root, "release"), "release");
  const settled = await heldOutcome;
  assert.equal(settled.error, undefined);
  assert.equal(settled.response.result.structuredContent.receipt.call, 1);
  await gone(firstWorker);
  assert.equal((await present(endpoint.pid)).processIdentity, endpoint.processIdentity);

  for (let cycle = 0; cycle < 3; cycle++) {
    const offset = events().length;
    fs.unlinkSync(path.join(root, "release"));
    const pending = client.call({ hold: true });
    const outcome = pending.then((response) => ({ response }), (error) => ({ error }));
    const started = await until(() => workerStarted(client, offset), "next worker generation was not started");
    const member = await present(started.pid);
    fs.writeFileSync(path.join(root, "release"), "release");
    const settled = await outcome;
    assert.equal(settled.error, undefined);
    assert.equal(settled.response.result.structuredContent.receipt.call, 1);
    await gone(member);
    assert.equal((await present(endpoint.pid)).processIdentity, endpoint.processIdentity);
    assert.ok((await client.request("tools/list")).result.tools.length > 0);
  }
  result.afterCyclesRssKiB = rss(endpoint.pid);
  assert.ok(result.afterCyclesRssKiB - result.dormantRssKiB < 16 * 1024, "retired worker generations accumulated in the endpoint");

  const offset = events().length;
  assert.ok((await client.call({ error: true })).error);
  assert.equal((await client.call()).result.structuredContent.receipt.call, 2);
  assert.ok((await client.call({ malformed: true })).error.message.includes("outcome is unknown"));
  const poisoned = await present(workerStarted(client, offset).pid);
  const count = events().filter((event) => event.pid === poisoned.pid && event.event === "called").length;
  await delay(idleMs + 100);
  assert.equal((await present(poisoned.pid)).processIdentity, poisoned.processIdentity);
  assert.ok((await client.call()).error.message.includes("state is unknown"));
  assert.equal(events().filter((event) => event.pid === poisoned.pid && event.event === "called").length, count);
  await client.close();
  await gone(poisoned);

  fs.unlinkSync(path.join(root, "release"));
  const disconnected = relay();
  await disconnected.initialize();
  const pending = disconnected.call({ hold: true });
  const outcome = pending.then((response) => ({ response }), (error) => ({ error }));
  const active = await until(() => workerStarted(disconnected), "disconnect worker did not start");
  await until(() => events().some((event) => event.pid === active.pid && event.event === "called"), "disconnect tool was not invoked");
  const member = await present(active.pid);
  disconnected.child.stdin.end();
  await delay(idleMs + 100);
  assert.equal((await present(member.pid)).processIdentity, member.processIdentity);
  fs.writeFileSync(path.join(root, "release"), "release");
  assert.equal((await outcome).response.result.structuredContent.receipt.call, 1);
  assert.equal((await disconnected.exited).code, 0);
  await gone(member);
  result.ok = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  // This only closes fixture-owned input. Any unresolved process cleanup stays
  // with the guardian, and is never reported as successful idle retirement.
  for (const client of clients) client.child.stdin.end();
  result.events = events();
  fs.writeFileSync(path.join(reportRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, evidence: reportRoot, error: result.error }));
}
