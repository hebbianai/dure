import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { reapIsolatedHmuxSessions } from "./lib/isolated-hmux-session-cleanup.mjs";
import { resolveQaLogPath } from "./lib/qa-log-receipt.mjs";

const proof = process.env.DURE_QA_WEBVIEW_REALM_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through webview-realm-smoke.sh");
const home = fs.realpathSync(process.env.HOME);
const root = fs.realpathSync(stateRoot);
assert.equal(home, path.join(root, "home"));
assert(path.basename(root).startsWith("dure-webview-realm."));
assert.equal(
  fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT),
  path.join(root, "hmux-discovery"),
);
try {
  const sessions = [];
  for (let index = 0; index < 2; index += 1) {
    sessions.push(
      JSON.parse(
        execFileSync(
          process.env.DURE_QA_HMUX_CLI,
          [
            "--discovery-root",
            process.env.HMUX_DISCOVERY_ROOT,
            "--json",
            "new",
            "--name",
            `qa-realm-${proof}-${index}`,
            "--runtime",
            process.env.DURE_HMUX_RUNTIME_BIN,
            "--",
            "/bin/sh",
          ],
          { cwd: home, encoding: "utf8", timeout: 30_000 },
        ),
      ),
    );
  }
  fs.writeFileSync(
    path.join(home, "realm-sessions.json"),
    JSON.stringify({ proof, sessions }),
    { flag: "wx", mode: 0o600 },
  );
  const deadline = Date.now() + 120_000;
  let receipt;
  while (!receipt && Date.now() < deadline) {
    let log = "";
    try {
      const descriptor = fs.openSync(resolveQaLogPath(), "r");
      try {
        const size = fs.fstatSync(descriptor).size;
        const buffer = Buffer.alloc(Math.min(size, 64 * 1024));
        fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length);
        log = buffer.toString("utf8");
      } finally {
        fs.closeSync(descriptor);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const line of log.split("\n")) {
      const start = line.indexOf("] ");
      if (start < 0) continue;
      let record;
      try {
        record = JSON.parse(line.slice(start + 2));
      } catch {
        continue;
      }
      if (record[0] === "webview-realm" && record[1]?.proof === proof)
        receipt = record[1];
    }
    if (!receipt) await delay(500);
  }
  if (!receipt) throw new Error(`No webview realm receipt for ${proof}`);
  fs.writeFileSync(
    path.join(stateRoot, "evidence", "webview-realm.json"),
    JSON.stringify(receipt, null, 2),
  );
  if (
    receipt.result !== "passed" ||
    receipt.rounds !== 2 ||
    receipt.surfaces !== 2 ||
    receipt.inputReceipts !== 4 ||
    receipt.focused !== false
  )
    throw new Error(JSON.stringify(receipt));
  assert.equal(receipt.visible, true);
  assert.deepEqual(receipt.sessions, sessions.map((session) => session.sessionId));
  console.log(
    "webview realm: unbound/bound predecessors rejected, two panes and exact-once input recovered",
    receipt,
  );
} finally {
  // Creation is finished before cleanup; retain the launch owner while the
  // existing reaper stops exact Host generations and waits for their receipts.
  const processOwners = [
    "app-process-group.json",
    "client-process-group.json",
  ].map((name) => {
    const descriptorPath = path.join(root, name);
    return {
      descriptorPath,
      supervisorPid: JSON.parse(fs.readFileSync(descriptorPath, "utf8"))
        .supervisorPid,
    };
  });
  const cleanup = await reapIsolatedHmuxSessions({
    stateRoot: root,
    discoveryRoot: path.join(root, "hmux-discovery"),
    hmuxCli: process.env.DURE_QA_HMUX_CLI,
    hmuxRuntime: process.env.DURE_HMUX_RUNTIME_BIN,
    processOwners,
    waitMs: 30_000,
  });
  fs.writeFileSync(
    path.join(root, "evidence", "webview-realm-session-cleanup.json"),
    JSON.stringify(cleanup, null, 2),
  );
}
