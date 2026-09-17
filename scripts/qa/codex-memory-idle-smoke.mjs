// Native provider/config-owner proof. Only the guardian's disposable graph and
// credentials are used; no real model API, account, or live session is touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { openCodexClient } from "../lib/codex-stdio-client.mjs";
import { applyMemoryEntry, planMemoryEntry, readUserConfig } from "../lib/memory-mcp-integration.mjs";
import { observeProcessMembers, processMemberFromObservation } from "../lib/process-identity.mjs";

const [codex, relay, worker] = process.argv.slice(2);
assert.ok([codex, relay, worker].every(path.isAbsolute));
const state = fs.realpathSync(process.env.DURE_HMUX_TEST_STATE_ROOT);
assert.ok(path.basename(state).startsWith("dure-hmux-test."));
assert.ok(path.resolve(process.env.HMUX_DISCOVERY_ROOT).startsWith(`${state}${path.sep}`));
const root = path.join(state, "codex-memory");
fs.mkdirSync(root, { mode: 0o700 });
const graph = path.join(root, "graph.jsonl");
const configPath = path.join(root, "config.toml");
const entry = { command: process.execPath, args: [worker], env: { MEMORY_FILE_PATH: graph }, startup_timeout_sec: 30, tool_timeout_sec: 60 };
fs.writeFileSync(configPath, `model="fixture"\nmodel_provider="fixture"\ncheck_for_update_on_startup=false\n[model_providers.fixture]\nname="fixture"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[mcp_servers.memory]\ncommand=${JSON.stringify(entry.command)}\nargs=${JSON.stringify(entry.args)}\nstartup_timeout_sec=30\ntool_timeout_sec=60\n[mcp_servers.memory.env]\nMEMORY_FILE_PATH=${JSON.stringify(graph)}\n`, { mode: 0o600 });
const evidence = fs.mkdtempSync(path.join(path.dirname(state), "dure-codex-memory-evidence-"));
console.log(JSON.stringify({ evidence }));
const report = { ok: false, idleMs: 300_000, observations: [], liveActivation: false };
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: root, DURE_HOME: root, TMPDIR: root,
  HMUX_DISCOVERY_ROOT: process.env.HMUX_DISCOVERY_ROOT };
const start = () => openCodexClient({ executable: codex, cwd: root, env });
let client;
async function member(pid) {
  const point = await observeProcessMembers({ kind: "point", pids: [pid] });
  report.observations.push(point);
  assert.equal(point.status, "complete");
  return processMemberFromObservation(pid, point);
}
async function children(parent) {
  const census = await observeProcessMembers({ kind: "user_census", expectedProcess: parent });
  assert.equal(census.status, "complete");
  return census.members.filter((child) => child.parentPid === parent.pid);
}
try {
  client = await start();
  const original = await readUserConfig(client.call, configPath, root);
  const next = planMemoryEntry(original.config.mcp_servers.memory, relay);
  assert.deepEqual(next.env, entry.env);
  assert.equal(next.tool_timeout_sec, 60);
  assert.equal(next.startup_timeout_sec, 30);
  // The real owner rejects an intervening edit; the integration never retries.
  await client.call("config/batchWrite", { expectedVersion: original.version, reloadUserConfig: false,
    edits: [{ keyPath: "check_for_update_on_startup", value: true, mergeStrategy: "replace" }] });
  const afterIntervention = fs.readFileSync(configPath, "utf8");
  await assert.rejects(applyMemoryEntry({ call: client.call, profile: original, configPath, name: "memory", entry: next, backupRoot: root }), /read before retry/);
  assert.equal(fs.readFileSync(configPath, "utf8"), afterIntervention);
  const profile = await readUserConfig(client.call, configPath, root);
  await applyMemoryEntry({ call: client.call, profile, configPath, name: "memory", entry: next, backupRoot: root });
  const written = await readUserConfig(client.call, configPath, root);
  const expected = structuredClone(profile.config);
  expected.mcp_servers.memory = next;
  assert.deepEqual(written.config, expected);
  assert.deepEqual(await applyMemoryEntry({ call: client.call, profile: written, configPath, name: "memory", entry: next, backupRoot: root }), { changed: false });
  report.configOwner = { conflictPreserved: true, unrelatedSettingsPreserved: true, idempotent: true };
  await client.close();
  client = await start();
  assert.deepEqual((await readUserConfig(client.call, configPath, root)).config, expected);
  report.freshProviderAdoption = true;
  const started = await client.call("thread/start", { cwd: root, model: "fixture", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only" });
  report.threadId = started.thread.id;
  const callTool = async (tool, args) => {
    const result = await client.call("mcpServer/tool/call", { threadId: report.threadId, server: "memory", tool, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  await callTool("create_entities", { entities: [{ name: "retained", entityType: "fixture", observations: ["before-idle"] }] });
  const before = await callTool("read_graph", {});
  report.idleStartedAt = Date.now();
  report.provider = (await member(client.pid)).member;
  const relays = (await children(report.provider)).filter((child) => {
    const executable = execFileSync("ps", ["-p", String(child.pid), "-o", "comm="], { encoding: "utf8", timeout: 2_000 }).trim();
    return executable && fs.realpathSync(executable) === fs.realpathSync(relay);
  });
  assert.equal(relays.length, 1);
  report.relay = relays[0];
  const workers = await children(report.relay);
  assert.equal(workers.length, 1);
  report.worker = workers[0];
  console.log(JSON.stringify({ phase: "waiting-default-five-minute-idle", provider: client.pid, worker: report.worker.pid }));
  await delay(Math.max(0, report.idleStartedAt + 295_000 - Date.now()));
  assert.equal((await member(report.worker.pid)).member?.processIdentity, report.worker.processIdentity);
  await delay(Math.max(0, report.idleStartedAt + 302_000 - Date.now()));
  const dormant = await member(report.worker.pid);
  assert.ok(dormant.status === "departed" || dormant.member?.processIdentity !== report.worker.processIdentity);
  assert.equal((await member(client.pid)).member.processIdentity, report.provider.processIdentity);
  assert.equal((await member(report.relay.pid)).member.processIdentity, report.relay.processIdentity);
  assert.deepEqual(await callTool("read_graph", {}), before);
  await callTool("add_observations", { observations: [{ entityName: "retained", contents: ["after-idle"] }] });
  assert.match(fs.readFileSync(graph, "utf8"), /after-idle/);
  const replacements = await children(report.relay);
  assert.equal(replacements.length, 1);
  report.replacement = replacements[0];
  assert.notEqual(report.replacement.processIdentity, report.worker.processIdentity);
  assert.equal((await client.call("thread/read", { threadId: report.threadId, includeTurns: false })).thread.id, report.threadId);
  report.ok = true;
} catch (error) {
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  try { if (client) await client.close(); }
  finally { fs.writeFileSync(path.join(evidence, "result.json"), JSON.stringify(report, null, 2)); }
}
