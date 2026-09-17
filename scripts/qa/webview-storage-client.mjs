import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { waitForQaLogReceipt } from "./lib/qa-log-receipt.mjs";
import {
  readOwnedProcessGroup,
  readOwnedProcessLedgerForRetirement,
  supervise,
  verifyOwnedProcessTreeExited,
} from "./lib/owned-process-group.mjs";

const proof = process.env.DURE_QA_WEBVIEW_STORAGE_PROOF;
const stateRoot = process.env.DURE_QA_STATE_ROOT;
if (!proof || !stateRoot) throw new Error("Run through webview-storage-smoke.sh");

// A separate supervisor can exit before the parent verifies its sealed ledger.
if (process.argv[2] === "--native-process") {
  const [, , , descriptor, binary, origin, phase] = process.argv;
  process.exitCode = await supervise(descriptor, binary, [origin, phase], {
    commandTimeoutMs: 30_000,
    terminateDetachedOwnedGenerations: true,
  });
} else {
  await run();
}

async function command(executable, args, env = process.env) {
  const child = spawn(executable, args, { env, stdio: "inherit" });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => signal ? reject(new Error(`${executable} exited from ${signal}`)) : resolve(code));
  });
  assert.equal(status, 0, `${executable} failed`);
  return child.pid;
}

async function run() {
  const expected = Array.from(createHash("sha256").update(stateRoot).digest().subarray(0, 16));
  const receipt = await waitForQaLogReceipt("webview-storage", proof);
  fs.writeFileSync(path.join(stateRoot, "evidence", "webview-storage.json"), JSON.stringify(receipt, null, 2));
  assert.equal(receipt.result, "passed", JSON.stringify(receipt));
  assert.deepEqual(receipt.observations.map(({ role }) => role), ["main", "native", "js", "recreated", "isolated"]);
  for (const observation of receipt.observations) {
    const isolated = observation.role === "isolated";
    assert.deepEqual(observation.identifier, isolated ? expected.map((byte) => byte ^ 0xff) : expected);
    assert.equal(observation.value, isolated ? null : `fixture:${proof}`);
  }
  console.log("Native WebView storage selection, sharing, recreation and same-origin isolation passed", receipt);

  const { executable: binary } = JSON.parse(fs.readFileSync(
    path.join(stateRoot, "evidence", "webview-storage-binary.json"), "utf8",
  ));
  const origin = new URL(receipt.origin);
  assert.equal(origin.protocol, "http:");
  assert.equal(origin.hostname, "127.0.0.1");
  assert.ok(origin.port);
  // Neither process store is held open by the initial Dure app's WebViews.
  const processIdentifier = createHash("sha256").update(`${stateRoot}:process`).digest().subarray(0, 16);
  const processReceipts = [];
  for (const phase of ["seed", "restored", "isolated"]) {
    const identifier = phase === "isolated" ? Buffer.from(processIdentifier.map((byte) => byte ^ 0xff)) : processIdentifier;
    const descriptorPath = path.join(stateRoot, `storage-${phase}-process.json`);
    const supervisorPid = await command(process.execPath, [
      process.argv[1], "--native-process", descriptorPath, binary, origin.href, phase,
    ], { ...process.env, DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER: identifier.toString("hex") });
    const descriptor = readOwnedProcessGroup(descriptorPath, supervisorPid);
    const exit = await verifyOwnedProcessTreeExited(descriptor);
    const observed = JSON.parse(fs.readFileSync(path.join(stateRoot, "evidence", `storage-${phase}.json`), "utf8"));
    const native = readOwnedProcessLedgerForRetirement(descriptor).filter(({ pid }) => pid === observed.pid);
    assert.equal(native.length, 1, "The native receipt must match one exact owned generation");
    assert.equal(observed.report.result, "passed");
    assert.equal(observed.report.proof, proof);
    assert.equal(observed.report.processPhase, phase);
    assert.equal(observed.report.origin, origin.origin);
    assert.deepEqual(observed.report.identifier, Array.from(identifier));
    assert.equal(observed.report.value, phase === "isolated" ? null : `fixture:${proof}`);
    processReceipts.push({ ...observed, generation: native[0].kernelStartMarker, exit });
  }
  assert.equal(new Set(processReceipts.map(({ generation }) => generation)).size, 3);
  fs.writeFileSync(path.join(stateRoot, "evidence", "webview-storage-process-restart.json"), JSON.stringify({
    proof, processReceipts,
    limitations: "Fresh native fixture processes share Dure's configured-storage adapter, patched Tauri conversion and actual WK probe. This is not Dure service/runtime restart or Live migration evidence.",
  }, null, 2));
  console.log("Same-store native-process restart persistence and independent-store isolation passed");
}
