#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBoundedOwnedProcessGroup } from "./lib/bounded-owned-process-group.mjs";

const self = fileURLToPath(import.meta.url);
const prefix = "dure-managed-claude-native-hook-";
const token = "qa-only-hook-report-token";
const generation = "qa-only-server-generation";

function environment(scope, port) {
  return {
    HOME: path.join(scope, "home"), DURE_HOME: path.join(scope, "dure"),
    CLAUDE_CONFIG_DIR: path.join(scope, "config"), PATH: path.join(scope, "bin"),
    HMUX_DISCOVERY_ROOT: path.join(scope, "discovery"), DURE_APP_CHANNEL: "stable",
    HMUX_SESSION_ID: "qa-only-session", HMUX_WORKSPACE_ID: "qa-only-workspace",
    HMUX_RUNNER_PRINCIPAL: "qa-only-principal", HMUX_RUNNER_INSTANCE: "qa-only-runner",
    HMUX_CHANNEL_EPOCH: "1", HMUX_HOST_INSTANCE_ID: "qa-only-host",
    HMUX_TERMINAL_EPOCH: "qa-only-terminal",
    ANTHROPIC_API_KEY: "qa-no-real-provider-access", ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    TERM: "dumb", CI: "1", LANG: "en_US.UTF-8", TMPDIR: scope,
  };
}

async function prepare(scope) {
  for (const directory of ["home", "dure", "config", "bin", "discovery"]) {
    await mkdir(path.join(scope, directory), { recursive: true, mode: 0o700 });
  }
}

async function runProvider(scope, runtime, claude, existingHooks, publishedSettings) {
  await prepare(scope);
  const hook = path.join(scope, "managed-hook.sh");
  await writeFile(hook, `#!/bin/sh\nexec '${runtime.replaceAll("'", "'\\''")}' managed-claude-hook\n`, { mode: 0o700 });
  const settings = publishedSettings ?? path.join(scope, "managed-settings.json");
  if (!publishedSettings) await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command", command: hook,
    args: ["claude", "--managed-direct", "--terminal-events"], timeout: 3,
  }] }] } }), { mode: 0o600 });
  const originals = [];
  if (existingHooks) {
    for (const [name, directory] of [
      ["account", path.join(scope, "config")],
      ["project", path.join(scope, "home", ".claude")],
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const marker = path.join(scope, `${name}-hook-count`);
      const command = path.join(scope, `${name}-hook.sh`);
      await writeFile(command, `#!/bin/sh\nprintf 'x' >> '${marker.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
      const file = path.join(directory, "settings.json");
      const contents = `  ${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command }] }] } }, null, 2)}\n\n`;
      await writeFile(file, contents, { mode: 0o600 });
      originals.push({ file, contents, marker });
    }
  }
  let reports = 0;
  let providerRequests = 0;
  let exactFence = false;
  let hasConversation = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      providerRequests += 1;
      request.resume();
      response.writeHead(401).end("{}");
      return;
    }
    if (request.url === "/ping") {
      request.resume();
      response.writeHead(200).end(JSON.stringify({
        ok: true, channel: "stable", generation, processId: process.pid,
        capabilities: ["managed_claude_host_report_v1", "managed_claude_host_report_causality_v1"],
      }));
      return;
    }
    let raw = "";
    request.on("data", chunk => {
      raw += chunk.toString();
      if (raw.length > 65_536) request.destroy();
    });
    request.on("end", () => {
      const body = JSON.parse(raw);
      if (request.url === "/hooks/claude" && body.hook_event_name === "SessionStart") {
        reports += 1;
        hasConversation = typeof body.session_id === "string" && body.session_id.length > 0;
        exactFence = [
          ["session-id", "qa-only-session"], ["workspace-id", "qa-only-workspace"],
          ["runner-principal", "qa-only-principal"], ["runner-instance", "qa-only-runner"],
          ["channel-epoch", "1"], ["host-instance-id", "qa-only-host"], ["terminal-epoch", "qa-only-terminal"],
        ].every(([key, value]) => request.headers[`x-hebbian-hmux-${key}`] === value);
      }
      response.writeHead(200).end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await writeFile(path.join(scope, "dure", "server.json"), JSON.stringify({
    port, processId: process.pid, generation, reportToken: token, channel: "stable",
  }), { mode: 0o600 });
  try {
    const child = spawn(claude, ["--settings", settings, "--init-only"], {
      cwd: path.join(scope, "home"), env: environment(scope, port), stdio: ["pipe", "ignore", "ignore"],
    });
    child.stdin.end();
    const [code, signal] = await once(child, "close");
    assert.equal(code, 0, "Actual provider initialization failed");
    assert.equal(reports, 1, "No-Python native SessionStart must arrive exactly once");
    assert(exactFence && hasConversation, "Native identity or inherited fence is missing");
    for (const { file, contents, marker } of originals) {
      assert.equal(await readFile(file, "utf8"), contents, "Existing hook configuration changed");
      assert.equal(await readFile(marker, "utf8"), "x", "Existing hook must execute exactly once");
    }
    return { existingHooks, code, signal, reports, exactFence, hasConversation, providerRequests, preservedFiles: originals.length };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

export async function runNativeHookProbe(root, runtime, claude, publishedSettings) {
  assert(path.isAbsolute(root) && path.basename(root).startsWith(prefix));
  const receipts = [];
  for (const existingHooks of [false, true]) {
    const receipt = await runProvider(path.join(root, existingHooks ? "existing-hooks" : "clean"), runtime, claude, existingHooks, publishedSettings);
    receipts.push(receipt);
    console.log(JSON.stringify(receipt));
  }
  // Keep stdin open: the invocation must finish at its own deadline, including
  // runtime teardown, without relying on the supervisor to kill it.
  const scope = path.join(root, "held-stdin");
  await prepare(scope);
  const start = performance.now();
  const child = spawn(runtime, ["managed-claude-hook"], {
    cwd: scope, env: environment(scope, 1), stdio: ["pipe", "ignore", "pipe"],
  });
  let error = "";
  child.stderr.on("data", chunk => { error = (error + chunk.toString()).slice(-1_024); });
  const [code, signal] = await once(child, "close");
  const elapsedMs = Math.round(performance.now() - start);
  assert.equal(code, 1);
  assert.equal(signal, null);
  assert(error.includes("managed_hook_report_timeout"));
  assert(elapsedMs < 4_000, "Held stdin prevented bounded runtime teardown");
  receipts.push({ heldStdin: true, code, signal, elapsedMs });
  await writeFile(path.join(root, "receipt.json"), JSON.stringify(receipts, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(receipts.at(-1)));
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === "--worker") {
    await runNativeHookProbe(...args);
    return;
  }
  assert(operation && args.length === 1, "Usage: node scripts/qa/managed-claude-native-hook-smoke.mjs <dure-control-plane> <claude>");
  const runtime = await realpath(operation);
  const claude = await realpath(args[0]);
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const control = path.join(root, "control");
  await mkdir(control, { mode: 0o700 });
  console.log(`Managed Claude native hook QA root: ${root}`);
  process.exitCode = await runBoundedOwnedProcessGroup(control, "90", process.execPath, [self, "--worker", root, runtime, claude]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) await main();
