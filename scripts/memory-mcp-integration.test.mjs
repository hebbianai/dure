import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { applyMemoryEntry, planMemoryEntry, readUserConfig, verifiedMemoryRelay } from "./lib/memory-mcp-integration.mjs";

test("unsupported entries fail without reading or modifying their graph", () => {
  for (const entry of [undefined, { enabled: false }, { url: "https://example.invalid" },
    { command: process.execPath, args: ["memory"], env: { MEMORY_FILE_PATH: "relative" } },
    { command: process.execPath, args: ["memory"], env: { MEMORY_FILE_PATH: "/private/graph", NODE_OPTIONS: "--inspect" } },
    { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], env: { MEMORY_FILE_PATH: "/private/graph" } },
    { command: process.execPath, args: ["/unknown"], env: { MEMORY_FILE_PATH: "/private/graph" }, env_vars: ["MEMORY_FILE_PATH"] },
  ]) assert.throws(() => planMemoryEntry(entry, "/bundle/bin/dure-control-plane"));
});

test("an unverified bundle cannot supply a runtime", () => {
  assert.throws(() => verifiedMemoryRelay("/nonexistent/unverified-memory-bundle"));
});

test("an arbitrary worker cannot opt into the persistence contract", () => {
  assert.throws(() => planMemoryEntry({
    command: process.execPath, args: [new URL(import.meta.url).pathname],
    env: { MEMORY_FILE_PATH: "/never-opened/graph.jsonl" },
  }, "/bundle/bin/dure-control-plane"), /Unsupported Memory worker source/);
});

test("only the requested user layer supplies the version and original entry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-config-unit-"));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true }));
  const configPath = path.join(root, "config.toml");
  fs.writeFileSync(configPath, "# fixture");
  const profile = { name: { type: "user", file: configPath }, version: "v1", config: { mcp_servers: { memory: { command: "old" }, keep: { command: "keep" } } } };
  const read = async () => ({ layers: [{ name: { type: "project", file: "/other" }, config: {} }, profile] });
  assert.equal(await readUserConfig(read, configPath, root), profile);
  await assert.rejects(readUserConfig(async () => ({ layers: [] }), configPath, root));
  const entry = { command: "relay", args: ["retained"], env: { MEMORY_FILE_PATH: "/same/graph" } };
  const requests = [];
  const call = async (method, params) => { requests.push({ method, params }); return { filePath: configPath }; };
  const result = await applyMemoryEntry({ call, profile, configPath, name: "memory", entry, backupRoot: root });
  assert.equal(result.changed, true);
  assert.deepEqual(requests, [{ method: "config/batchWrite", params: {
    expectedVersion: "v1", reloadUserConfig: false,
    edits: [{ keyPath: "mcp_servers.memory", value: entry, mergeStrategy: "replace" }],
  } }]);
  const backup = path.join(result.backup, "previous-entry.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(backup)).entry, { command: "old" });
  assert.equal(fs.statSync(result.backup).mode & 0o777, 0o700);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o600);
  profile.config.mcp_servers.memory = entry;
  assert.deepEqual(await applyMemoryEntry({ call, profile, configPath, name: "memory", entry, backupRoot: root }), { changed: false });
  assert.equal(requests.length, 1);
  await assert.rejects(applyMemoryEntry({ call, profile, configPath, name: "memory.bad", entry, backupRoot: root }), /server key/);
});

test("a config conflict is surfaced, never retried or rolled back over another writer", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-conflict-unit-"));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true }));
  let calls = 0;
  const profile = { version: "old", config: { mcp_servers: { memory: { command: "original" } } } };
  await assert.rejects(applyMemoryEntry({
    call: async () => { calls++; throw new Error("version conflict"); },
    profile, configPath: path.join(root, "config.toml"), name: "memory", entry: { command: "new" }, backupRoot: root,
  }), /read before retry/);
  assert.equal(calls, 1);
  assert.equal(fs.readdirSync(root).length, 1);
});
