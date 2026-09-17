#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestSlackStatus } from "../../cli/lib/slack/control.mjs";

const source = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(source), "../..");
const cli = path.join(repository, "cli/dure.mjs");
const [mode, ...arguments_] = process.argv.slice(2);

if (mode === "--owner") {
  const [config, fixture] = arguments_;
  const preload = fixture === "fixture" ? ["--import", path.join(repository, "scripts/fixtures/slack-connector-network.mjs")] : [];
  const connector = spawn(process.execPath, [...preload, cli, "slack", "serve", "--config", config, "--backend", "local", "--owner-lifetime", "stdin"], {
    cwd: repository, stdio: ["pipe", "inherit", "inherit"],
  });
  connector.once("error", () => { process.exitCode = 2; process.stdin.pause(); });
  connector.once("exit", (code) => { process.exitCode = code ?? 2; process.stdin.pause(); });
  process.stdin.resume();
  // Deliberately leave connector.stdin open. Exiting this owner closes the
  // kernel pipe; the product must retire itself without a PID signal or retry.
  process.stdin.once("end", () => process.exit(0));
} else {
  if (mode !== "--fixture" && !(mode === "--credentials" && arguments_.length === 2)) {
    throw new Error("Usage: run-hmux-tests.mjs -- node scripts/qa/slack-connector-lifetime.mjs --fixture | --credentials FILE TEAM_ID");
  }
  const discovery = process.env.HMUX_DISCOVERY_ROOT;
  const stateRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
  assert.ok(stateRoot && discovery && process.env.TMPDIR, "Run under the existing isolated Hmux QA guardian");
  assert.equal(path.dirname(fs.realpathSync(discovery)), fs.realpathSync(stateRoot));
  assert.equal(path.dirname(fs.realpathSync(process.env.TMPDIR)), fs.realpathSync(stateRoot));
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR, "slack-lifetime-"));
  const config = path.join(root, "config.json");
  const teamId = mode === "--fixture" ? "T1" : arguments_[1];
  // An idle workspace has no task routes. This smoke only opens Socket Mode;
  // it neither posts messages nor creates provider tasks.
  fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, teamId, channels: [] }), { mode: 0o600 });
  const credentials = mode === "--fixture" ? { appToken: "fixture-app", botToken: "fixture-bot" } : JSON.parse(fs.readFileSync(arguments_[0], "utf8"));
  const environment = { ...process.env, DURE_HOME: path.join(root, "dure"),
    DURE_SLACK_APP_TOKEN: credentials.appToken, DURE_SLACK_BOT_TOKEN: credentials.botToken };
  const connected = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const events = [];
  let buffer = "";
  let stderr = false;
  const owner = spawn(process.execPath, [source, "--owner", config, mode === "--fixture" ? "fixture" : "real"], {
    cwd: repository, env: environment, stdio: ["pipe", "pipe", "pipe"],
  });
  delete environment.DURE_SLACK_APP_TOKEN;
  delete environment.DURE_SLACK_BOT_TOKEN;
  owner.once("error", () => { connected.resolve(false); closed.resolve({ code: null }); });
  owner.once("close", (code, signal) => { connected.resolve(false); closed.resolve({ code, signal }); });
  owner.stderr.on("data", () => { stderr = true; });
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event.event);
        if (event.event === "slack.connected") connected.resolve(true);
      } catch { /* Raw child output is never logged; it can contain credentials. */ }
    }
  });
  const deadline = setTimeout(() => {
    connected.resolve(false);
    owner.stdin.end();
    closed.resolve({ code: "timeout" });
  }, 45_000);
  let succeeded = false;
  try {
    assert.equal(await connected.promise, true, "Connector did not report Slack hello");
    const live = await requestSlackStatus(`${config}.connector.json`, teamId);
    assert.equal(live.connection, "connected");
    assert.equal(live.threads, 0);
    assert.equal(live.queued, 0);
    assert.equal(live.failed, 0);
    const connectorGeneration = live.generation;
    owner.stdin.end();
    const outcome = await closed.promise;
    assert.equal(outcome.code, 0, "Owned process closure did not complete");
    assert.equal(outcome.signal, null);
    assert.ok(events.includes("slack.stopped"), "Product did not finish its own cleanup");
    assert.equal(stderr, false, "Child reported an unexpected failure");
    assert.equal(fs.existsSync(`${config}.connector.json`), false);
    assert.equal(fs.existsSync(`${config}.deliveries.json.lock`), false);
    const journal = JSON.parse(fs.readFileSync(`${config}.deliveries.json`, "utf8"));
    assert.deepEqual(journal.threads, {});
    assert.deepEqual(journal.inbox, {});
    assert.deepEqual(journal.outbound, {});
    succeeded = true;
    const sources = ["cli/dure.mjs", "cli/lib/slack-command.mjs", "cli/lib/slack/control.mjs", "cli/lib/slack/event.mjs", "cli/lib/slack/socket.mjs"];
    console.log(JSON.stringify({ realSlack: mode !== "--fixture", realProvider: false,
      connection: live.connection, connectorGeneration, ownerExit: outcome.code,
      connectorStopped: true, deliveryJournalPreserved: true, threads: 0,
      node: process.version, sources: Object.fromEntries(sources.map((file) =>
        [file, createHash("sha256").update(fs.readFileSync(path.join(repository, file))).digest("hex")])) }));
  } finally {
    clearTimeout(deadline);
    owner.stdin.end();
    if (!succeeded) console.error("Slack lifetime QA failed; the existing guardian owns remaining process and root cleanup.");
  }
}
