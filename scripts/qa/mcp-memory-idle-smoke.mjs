// Pinned, real third-party server proof. Run only through run-hmux-tests.mjs;
// all graph writes belong to its disposable root, never the user's graph.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { observeProcessMembers, processMemberFromObservation } from "../lib/process-identity.mjs";

const [relayPath, workerPath] = process.argv.slice(2);
const baselineOnly = relayPath === "--baseline";
assert.ok(path.isAbsolute(workerPath));
if (!baselineOnly) assert.ok(path.isAbsolute(relayPath));
const worker = fs.realpathSync(workerPath);
assert.equal(createHash("sha256").update(fs.readFileSync(worker)).digest("hex"),
  fs.readFileSync(new URL("../../cli/lib/mcp-memory-worker.sha256", import.meta.url), "utf8").trim());
const stateRoot = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
assert.ok(path.basename(stateRoot).startsWith("dure-hmux-test."));
assert.ok(path.resolve(process.env.HMUX_DISCOVERY_ROOT).startsWith(`${stateRoot}${path.sep}`));
const root = path.join(stateRoot, "memory-idle");
fs.mkdirSync(root, { mode: 0o700 });
const graph = path.join(root, "graph.jsonl");
const entity = { type: "entity", name: "retained", entityType: "fixture", observations: ["before"] };
fs.writeFileSync(graph, JSON.stringify(entity), { mode: 0o600 });
const reportRoot = fs.mkdtempSync(path.join(path.dirname(stateRoot), "dure-memory-idle-evidence-"));
console.log(JSON.stringify({ evidence: reportRoot }));
const idleMs = 1_000;
const clients = [];
const result = { ok: false, baselineOnly, liveActivation: false, idleMs, observations: [] };
if (!baselineOnly) {
  result.executable = fs.realpathSync(relayPath);
  result.sha256 = createHash("sha256").update(fs.readFileSync(result.executable)).digest("hex");
}

async function present(pid) {
  const observation = await observeProcessMembers({ kind: "point", pids: [pid] });
  result.observations.push(observation);
  assert.equal(observation.status, "complete");
  const current = processMemberFromObservation(pid, observation);
  assert.equal(current.status, "present");
  return current.member;
}

async function gone(member) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observation = await observeProcessMembers({ kind: "point", pids: [member.pid] });
    result.observations.push(observation);
    assert.equal(observation.status, "complete");
    const current = processMemberFromObservation(member.pid, observation);
    if (current.status === "departed" ||
      (current.status === "present" && current.member.processIdentity !== member.processIdentity)) return;
    await delay(100);
  }
  assert.fail("exact worker generation did not retire");
}

async function childOf(endpoint) {
  const observation = await observeProcessMembers({ kind: "user_census", expectedProcess: endpoint });
  assert.equal(observation.status, "complete");
  const children = observation.members.filter((member) => member.parentPid === endpoint.pid);
  assert.equal(children.length, 1);
  result.observations.push({ kind: "direct-worker-census", sourceStatus: observation.status, sourceScope: observation.scope, endpoint, children });
  return children[0];
}

async function releaseFifo(file, bytes) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
      fs.writeSync(fd, bytes);
      return;
    } catch (error) {
      if (error.code !== "ENXIO") throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    await delay(20);
  }
  assert.fail("Memory worker did not open the held read");
}

function rss(pid) {
  const value = Number(execFileSync("ps", ["-p", String(pid), "-o", "rss="], { encoding: "utf8", timeout: 2_000 }).trim());
  assert.ok(Number.isFinite(value) && value > 0);
  return value;
}

function launch(relay) {
  const child = spawn(relay ? relayPath : process.execPath, relay
    ? ["mcp-memory-relay", "--node", process.execPath, "--worker", worker, "--memory-file", graph, "--idle-ms", String(idleMs)]
    : [worker], {
    cwd: root,
    env: { PATH: process.env.PATH, HOME: root, DURE_HOME: root, TMPDIR: root,
      HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT, MEMORY_FILE_PATH: graph },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (bytes) => { stderr = (stderr + bytes).slice(-16_384); });
  const pending = new Map();
  const notifications = [];
  let sequence = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    const response = JSON.parse(line);
    if (response.id !== undefined) pending.get(response.id)?.resolve(response);
    else notifications.push(response);
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      for (const entry of pending.values()) entry.reject(new Error(`endpoint exited ${code}/${signal}: ${stderr}`));
      resolve({ code, signal, stderr });
    });
  });
  const client = {
    child, exited, notifications,
    notify(method, params = {}) { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`); },
    request(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`response timed out: ${method}: ${stderr}`)); }, 15_000);
        const finish = (callback) => (value) => { clearTimeout(timer); pending.delete(id); callback(value); };
        pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    async initialize(protocolVersion = "2025-06-18") {
      const response = await this.request("initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "dure-memory-proof", version: "1" } });
      assert.equal(response.result?.protocolVersion, protocolVersion === "unknown-future" ? "2025-11-25" : protocolVersion, JSON.stringify(response));
      this.notify("notifications/initialized");
      assert.equal((await this.request("tools/list")).result.tools.length, 9);
      return response.result;
    },
    async call(name, arguments_ = {}) {
      const response = await this.request("tools/call", { name, arguments: arguments_ });
      assert.ok(response.result && !response.result.isError, JSON.stringify(response));
      return response.result;
    },
    async close() { child.stdin.end(); assert.equal((await exited).code, 0, stderr); },
  };
  clients.push(client);
  return client;
}

try {
  const baseline = launch(false);
  result.initialize = await baseline.initialize();
  assert.equal((await baseline.call("read_graph")).structuredContent.entities[0].name, "retained");
  const original = await present(baseline.child.pid);
  await delay(idleMs + 200);
  assert.equal((await present(original.pid)).processIdentity, original.processIdentity);
  result.baselineIdleWorkerResident = true;
  result.baselineRssKiB = rss(original.pid);
  await baseline.close();
  await gone(original);

  if (!baselineOnly) {
    const client = launch(true);
    assert.deepEqual(await client.initialize(), result.initialize);
    const endpoint = await present(client.child.pid);
    const first = await childOf(endpoint);
    await client.call("add_observations", { observations: [{ entityName: "retained", contents: ["after"] }] });
    await gone(first);
    result.dormantRssKiB = rss(endpoint.pid);
    assert.ok(result.baselineRssKiB - result.dormantRssKiB >= 16 * 1024);
    for (let cycle = 0; cycle < 3; cycle++) {
      assert.deepEqual((await client.call("read_graph")).structuredContent.entities[0].observations, ["before", "after"]);
      const member = await childOf(endpoint);
      await gone(member);
      assert.equal((await present(endpoint.pid)).processIdentity, endpoint.processIdentity);
    }
    const uri = "memory://knowledge-graph";
    assert.ok((await client.request("resources/subscribe", { uri })).result);
    const subscribed = await childOf(endpoint);
    await delay(idleMs + 200);
    assert.equal((await present(subscribed.pid)).processIdentity, subscribed.processIdentity);
    await client.call("add_observations", { observations: [{ entityName: "retained", contents: ["notified"] }] });
    assert.ok(client.notifications.some((event) => event.method === "notifications/resources/updated" && event.params.uri === uri));
    const resource = await client.request("resources/read", { uri });
    assert.deepEqual(JSON.parse(resource.result.contents[0].text).entities[0].observations, ["before", "after", "notified"]);
    assert.ok((await client.request("resources/unsubscribe", { uri })).result);
    await gone(subscribed);
    assert.deepEqual((await client.call("read_graph")).structuredContent.entities[0].observations, ["before", "after", "notified"]);
    const last = await childOf(endpoint);
    if (process.platform !== "win32") {
      // A real filesystem read held beyond the timeout is still active work.
      // Only this disposable fixture's graph is temporarily replaced by a FIFO.
      const retainedGraph = path.join(root, "retained.jsonl");
      fs.renameSync(graph, retainedGraph);
      execFileSync("mkfifo", [graph]);
      const pending = client.call("read_graph");
      const outcome = pending.then((response) => ({ response }), (error) => ({ error }));
      await delay(idleMs + 200);
      assert.equal((await present(last.pid)).processIdentity, last.processIdentity);
      await releaseFifo(graph, fs.readFileSync(retainedGraph));
      const settled = await outcome;
      assert.equal(settled.error, undefined);
      assert.deepEqual(settled.response.structuredContent.entities[0].observations, ["before", "after", "notified"]);
      fs.unlinkSync(graph);
      fs.renameSync(retainedGraph, graph);
      result.pendingCallProtected = true;
    }
    await client.close();
    await gone(last);
    result.graph = JSON.parse(fs.readFileSync(graph, "utf8"));

    // Negotiation belongs to the actual SDK, not an echoed client version.
    const fallback = launch(true);
    await fallback.initialize("unknown-future");
    const fallbackEndpoint = await present(fallback.child.pid);
    await gone(await childOf(fallbackEndpoint));
    // Unknown session notifications are forwarded after wake, and preserve
    // that generation. They must not be discarded or break the connection.
    fallback.notify("notifications/roots/list_changed");
    assert.equal((await fallback.call("read_graph")).structuredContent.entities.length, 1);
    const pinned = await childOf(fallbackEndpoint);
    await delay(idleMs + 200);
    assert.equal((await present(pinned.pid)).processIdentity, pinned.processIdentity);
    await fallback.close();
    await gone(pinned);
    result.protocolFallbackAndUnknownNotificationProtected = true;
  }
  result.ok = true;
} catch (error) {
  result.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  for (const client of clients) client.child.stdin.end();
  fs.writeFileSync(path.join(reportRoot, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, evidence: reportRoot, initialize: result.initialize, error: result.error }));
}
