#!/usr/bin/env node
// Prove provider resource release and exact history/tool reuse, not automatic
// idle admission or native pane adoption. No model turns or real credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { observeProcessMembers } from "../lib/process-identity.mjs";
import { supervise } from "./lib/owned-process-group.mjs";
import { macosSandboxProfile } from "./plugin-native-provider-conformance.mjs";

const file = fileURLToPath(import.meta.url);
const fixture = fileURLToPath(new URL("./fixtures/idle-counter-mcp.mjs", import.meta.url));
const prefix = "/private/tmp/dure-codex-idle-resume-";
const marker = "Retain this synthetic task across resource reclamation.";

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function seed(root) {
  for (const name of ["home/.codex/sessions", "state", "tmp", "xdg-cache", "xdg-config"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  }
  fs.copyFileSync(fixture, path.join(root, "counter.mjs"));
  const threadId = randomUUID();
  const timestamp = "2026-09-01T00:00:00.000Z";
  const rollout = path.join(root, "home/.codex/sessions", `rollout-2026-09-01T00-00-00-${threadId}.jsonl`);
  const records = [
    ["session_meta", {
      id: threadId, timestamp, cwd: root, originator: "dure-idle-fixture",
      cli_version: "0.154.0-alpha.3", source: "cli", thread_source: "user",
      model_provider: "fixture", history_mode: "paginated",
      base_instructions: { text: "Synthetic history. Do not contact a model." },
    }],
    ["event_msg", { type: "task_started", turn_id: "fixture-turn", started_at: 1788220800 }],
    ["response_item", { type: "message", role: "user", content: [{ type: "input_text", text: marker }] }],
    ["event_msg", { type: "item_completed", thread_id: threadId, turn_id: "fixture-turn",
      item: { type: "UserMessage", id: "fixture-user", content: [{ type: "text", text: marker, text_elements: [] }] },
      started_at_ms: 1788220800000, completed_at_ms: 1788220800000 }],
    ["response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Fixture completed." }] }],
    ["event_msg", { type: "item_completed", thread_id: threadId, turn_id: "fixture-turn",
      item: { type: "AgentMessage", id: "fixture-answer", content: [{ type: "Text", text: "Fixture completed." }], phase: "final_answer" },
      started_at_ms: 1788220800000, completed_at_ms: 1788220801000 }],
    ["event_msg", { type: "task_complete", turn_id: "fixture-turn", started_at: 1788220800, completed_at: 1788220801, last_agent_message: "Fixture completed." }],
  ];
  fs.writeFileSync(rollout, records.map(([type, payload], ordinal) =>
    JSON.stringify({ timestamp, ordinal, type, payload })).join("\n") + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(root, "home/.codex/config.toml"), [
    'model="fixture-model"', 'model_provider="fixture"', "check_for_update_on_startup=false",
    "[model_providers.fixture]", 'name="Offline fixture"', 'base_url="http://127.0.0.1:9/v1"',
    'wire_api="responses"', "requires_openai_auth=false", "[analytics]", "enabled=false",
    "[mcp_servers.idle_fixture]", `command=${JSON.stringify(process.execPath)}`,
    `args=${JSON.stringify([path.join(root, "counter.mjs"), path.join(root, "state/mcp.jsonl")])}`,
  ].join("\n") + "\n", { mode: 0o600 });
  writeJson(path.join(root, "fixture.json"), { threadId, rollout });
}

class Server {
  constructor(root, executable) {
    this.sequence = 0;
    this.pending = new Map();
    const profile = macosSandboxProfile({ stateRoot: root, testBinaryRoot: root,
      providerRoots: [path.dirname(executable), path.dirname(process.execPath)] });
    this.child = spawn("/usr/bin/sandbox-exec", ["-p", profile, executable, "app-server", "--listen", "stdio://"], {
      cwd: root, stdio: ["pipe", "pipe", "ignore"], env: {
        PATH: "/usr/bin:/bin", HOME: path.join(root, "home"),
        CODEX_HOME: path.join(root, "home/.codex"), CODEX_SQLITE_HOME: path.join(root, "home/.codex"),
        DURE_HOME: path.join(root, "state/dure"), HMUX_DISCOVERY_ROOT: path.join(root, "state/discovery"),
        TMPDIR: path.join(root, "tmp"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      },
    });
    this.exited = once(this.child, "exit");
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on("line", (line) => {
      if (line.length > 1024 * 1024) {
        this.fail(new Error("fixture response exceeded its bound"));
        return;
      }
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () => this.fail(new Error("fixture server exited")));
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: fixture timeout`));
      }, 12000);
      this.pending.set(id, { method, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async close() {
    this.child.stdin.end();
    let timer;
    try {
      const status = await Promise.race([this.exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("fixture server did not exit after EOF")), 8000);
      })]);
      assert.deepEqual(status, [0, null]);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function worker(root, executable) {
  assert.equal(fs.realpathSync(root), root);
  assert(root.startsWith(prefix) && path.dirname(root) === "/private/tmp");
  assert.equal(fs.statSync(root).uid, process.getuid());
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
  const receipt = { ok: false, root, executable, observedAt: new Date().toISOString(),
    modelTurnsRequested: 0, realCredentialsUsed: false, networkDenied: true,
    automaticIdleAdmissionTested: false, nativePaneTested: false, cycles: [] };
  try {
    for (const phase of ["before", "after_recreation"]) {
      const server = new Server(root, executable);
      let owned;
      try {
        await server.call("initialize", { clientInfo: { name: "dure_idle_fixture", version: "1.0.0" }, capabilities: { experimentalApi: true } });
        server.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        const resumed = await server.call("thread/resume", { threadId: fixture.threadId, path: fixture.rollout,
          cwd: root, model: "fixture-model", modelProvider: "fixture", approvalPolicy: "never", sandbox: "read-only", excludeTurns: true });
        assert.equal(resumed.thread.id, fixture.threadId);
        assert.equal(resumed.thread.status.type, "idle");
        const history = await server.call("thread/turns/list", { threadId: fixture.threadId, limit: 3, itemsView: "full" });
        assert.equal(history.data[0].id, "fixture-turn");
        assert(JSON.stringify(history.data[0].items).includes(marker));
        const tool = await server.call("mcpServer/tool/call", { threadId: fixture.threadId, server: "idle_fixture", tool: "counter", arguments: {} });
        assert.equal(tool.content[0].text, "fixture-call-1", "each recreated runtime must own a fresh usable MCP");
        const events = fs.readFileSync(path.join(root, "state/mcp.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
        const child = events.findLast((event) => event.event === "started" && event.parentPid === server.child.pid);
        assert(child, "the tool must run in an observed owned MCP process");
        owned = await observeProcessMembers({ kind: "point", pids: [server.child.pid, child.pid] });
        assert.equal(owned.status, "complete");
        assert.equal(owned.members.length, 2);
        receipt.cycles.push({ phase, threadId: resumed.thread.id, turnId: history.data[0].id,
          firstToolResult: tool.content[0].text, beforeStop: owned });
      } finally {
        await server.close();
      }
      const after = await observeProcessMembers({ kind: "point", pids: owned.scope.requestedPids });
      assert.equal(after.status, "complete");
      assert.equal(after.members.length, 0, "server EOF must release the actual MCP, not just its metadata");
      receipt.cycles.at(-1).afterStop = after;
    }
    receipt.ok = true;
  } catch (error) {
    receipt.error = String(error);
  }
  writeJson(path.join(root, "receipt.json"), receipt);
  console.log(JSON.stringify(receipt));
  return receipt.ok ? 0 : 1;
}

async function main() {
  assert.equal(process.platform, "darwin", "this fixture requires macOS network/filesystem containment");
  if (process.argv[2] === "--worker") return worker(process.argv[3], process.argv[4]);
  assert.equal(process.argv[2], "--codex", "usage: node scripts/qa/codex-idle-resume-smoke.mjs --codex /absolute/native/codex");
  assert(path.isAbsolute(process.argv[3]));
  const executable = fs.realpathSync(process.argv[3]);
  assert(fs.statSync(executable).isFile());
  const root = fs.mkdtempSync(prefix);
  fs.chmodSync(root, 0o700);
  seed(root);
  writeJson(path.join(root, "executable.json"), { executable,
    sha256: createHash("sha256").update(fs.readFileSync(executable)).digest("hex") });
  console.log(JSON.stringify({ root, scope: "provider_resource_recreation_only" }));
  return supervise(path.join(root, "owner.json"), process.execPath, [file, "--worker", root, executable], {
    commandTimeoutMs: 90000, terminateDetachedOwnedGenerations: true,
  });
}

process.exitCode = await main();
