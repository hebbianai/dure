import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectIsolatedHmuxCleanupTargets } from "./lib/isolated-hmux-session-cleanup.mjs";

const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
const discovery = fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT);
const proof = process.env.DURE_QA_RECOVERY_PROOF;
const healthReturn = process.env.DURE_QA_RECOVERY_HEALTH_RETURN === "1";
assert.ok(proof);
assert.equal(home, path.join(root, "home"));
assert.equal(discovery, path.join(root, "hmux-discovery"));
let result;
try {
  const file = path.join(home, "recovery-result.json");
  const deadline = Date.now() + 100_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error("Recovery QA result missing");
    await delay(100);
  }
  result = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(path.join(root, "evidence", "recovery-admission.json"), JSON.stringify(result, null, 2));
  if (result.result === "passed" && !healthReturn) {
    const channel = process.env.DURE_APP_CHANNEL;
    assert.match(channel, /^qa-[a-z0-9-]+$/);
    const cli = path.join(home, ".local/share/hebbian-ide-cli/channels", channel, "bin/dure");
    assert.ok(fs.realpathSync(cli).startsWith(`${home}/`));
    const report = JSON.parse(execFileSync(cli, ["perf", "report", "--json"], { encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }));
    const recovery = report.terminalAttach?.recovery;
    assert.deepEqual(recovery?.counts, { queued: 4, admitted: 7, cancelled: 1, backendAttachRequests: 7, exhausted: 0 });
    assert.equal(recovery.detail.state, process.env.DURE_QA_RECOVERY_DETAIL === "1" ? "stopped" : "disabled");
    assert.equal(recovery.detail.samples.length, process.env.DURE_QA_RECOVERY_DETAIL === "1" ? 19 : 0);
    fs.writeFileSync(path.join(root, "evidence", "recovery-cli-report.json"), JSON.stringify(recovery, null, 2));
  }
} finally {
  const targets = collectIsolatedHmuxCleanupTargets(discovery);
  if (targets.some((target) => target.lifecycle !== "exited")) {
    const pipe = fs.openSync(path.join(home, "provider-completion.pipe"), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    try { fs.writeSync(pipe, "completed\n"); } finally { fs.closeSync(pipe); }
    const deadline = Date.now() + 10_000;
    while (collectIsolatedHmuxCleanupTargets(discovery).some((target) => target.lifecycle !== "exited")) {
      if (Date.now() > deadline) throw new Error("Owned providers did not complete");
      await delay(100);
    }
  }
}
assert.equal(result.proof, proof);
assert.equal(result.result, "passed", JSON.stringify(result));
if (healthReturn) {
  assert.equal(fs.existsSync(path.join(home, "provider-starts")), false);
  assert.equal(result.sameHost, true);
  assert.deepEqual(result.episodes.map(({ retryDirective, attempts, errorCleared }) => ({ retryDirective, attempts, errorCleared })), [
    { retryDirective: "unknown", attempts: 3, errorCleared: true },
    { retryDirective: "retry_after_resync", attempts: 12, errorCleared: true },
  ]);
} else {
  assert.equal(fs.readFileSync(path.join(home, "provider-starts"), "utf8"), "started\n".repeat(8));
}
console.log("Real WebView recovery admission verified", result);
