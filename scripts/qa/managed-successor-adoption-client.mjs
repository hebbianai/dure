import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { collectIsolatedHmuxCleanupTargets } from "./lib/isolated-hmux-session-cleanup.mjs";

const proof = process.env.DURE_QA_SUCCESSOR_PROOF;
const root = fs.realpathSync(process.env.DURE_QA_STATE_ROOT);
const home = fs.realpathSync(process.env.HOME);
assert.ok(proof);
assert.equal(home, path.join(root, "home"));
assert.equal(fs.realpathSync(process.env.HMUX_DISCOVERY_ROOT), path.join(root, "hmux-discovery"));
async function waitFor(name) {
  const file = path.join(home, name);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
    const failure = path.join(home, "successor-result.json");
    if (fs.existsSync(failure)) throw new Error(fs.readFileSync(failure, "utf8"));
    await delay(100);
  }
  throw new Error(`Missing ${name}`);
}
const source = await waitFor("successor-source.json");
assert.equal(source.proof, proof);
assert.ok(source.sessionId.startsWith("qa-successor-"));
const rehost = JSON.parse(execFileSync(process.env.DURE_HMUX_BIN, [
  "--discovery-root", process.env.HMUX_DISCOVERY_ROOT, "--json",
  "managed-rehost-start", "--session", source.sessionId,
  "--workspace", source.workspaceId, "--operation-id", `qa-successor-${proof}`,
  "--confirm-restart", "--runtime", process.env.DURE_HMUX_RUNTIME_BIN,
], { cwd: path.join(home, "successor-project"), encoding: "utf8", maxBuffer: 1024 * 1024 }));
assert.equal(rehost.sourceStopReceipt.sessionId, source.sessionId);
assert.equal(rehost.conversationId, source.conversationId);
assert.notEqual(rehost.replacementReceipt.sessionId, source.sessionId);
fs.writeFileSync(path.join(root, "evidence", "successor-rehost.json"), JSON.stringify(rehost, null, 2));
fs.writeFileSync(path.join(home, "successor-target.json"), JSON.stringify({
  proof, sessionId: rehost.replacementReceipt.sessionId,
}), { flag: "wx", mode: 0o600 });
let result;
try {
  result = await waitFor("successor-result.json");
} finally {
  // End the owned fixture through its completion channel before handing all
  // process/root cleanup to the runner. No PID signals or manifest rewrites.
  const pipe = fs.openSync(path.join(home, "provider-completion.pipe"), fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  try { fs.writeSync(pipe, "completed\n"); } finally { fs.closeSync(pipe); }
  const deadline = Date.now() + 10_000;
  while (collectIsolatedHmuxCleanupTargets(process.env.HMUX_DISCOVERY_ROOT)
    .find((target) => target.session_id === rehost.replacementReceipt.sessionId)?.lifecycle !== "exited") {
    if (Date.now() >= deadline) throw new Error("Owned fixture did not exit after completion");
    await delay(100);
  }
}
fs.writeFileSync(path.join(root, "evidence", "successor-adoption.json"), JSON.stringify(result, null, 2));
assert.equal(result.proof, proof);
assert.equal(result.result, "passed", JSON.stringify(result));
assert.equal(fs.readFileSync(path.join(home, "provider-starts"), "utf8"), "started\nstarted\n");
console.log("Real Hmux successor adopted by unmanaged backend and WebView; two provider starts, no stale checkpoint", result);
