import assert from "node:assert/strict";
import { execFileSync, fork, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeProcessIdentity } from "../lib/process-identity.mjs";
import {
  awaitWindowsJobBinding,
  createWindowsJobLease,
  observeWindowsJob,
  prepareWindowsJobRuntime,
} from "../lib/windows-process-job.mjs";

assert.equal(process.platform, "win32", "This proof requires native Windows.");
const testTarget = process.argv[2];
assert.ok([
  "windows_launching_client_environment",
  "windows_managed_create_advance",
].includes(testTarget), "Select one supported native lifecycle test target.");
const repository = fileURLToPath(new URL("../..", import.meta.url));
const rust = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = rust.match(/^host: (.+)$/mu)?.[1].trim();
assert.equal(host, "x86_64-pc-windows-msvc");
assert.ok(!process.env.CARGO_BUILD_TARGET || process.env.CARGO_BUILD_TARGET === host);
const target = path.resolve(repository, process.env.CARGO_TARGET_DIR || "hmux/target");
const binaries = path.join(target, ...(process.env.CARGO_BUILD_TARGET ? [host] : []), "debug");
const runtimeBinary = path.join(binaries, "hmux-runtime.exe");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repository,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, `${command} failed`);
}

if (process.argv[3] === "--owned-windows-test-child") {
  const admitted = new Promise((resolve, reject) => {
    process.on("message", (message) => {
      if (message?.type === "windows_native_start") resolve();
    });
    process.once("disconnect", () => reject(new Error("QA owner disconnected before admission")));
  });
  admitted.catch(() => {});
  try {
    await awaitWindowsJobBinding();
    await admitted;
    run("cargo", [
      "test", "--locked", "--manifest-path", "hmux/Cargo.toml", "--package", "hmux-runtime",
      "--test", testTarget, "--", "--nocapture", "--test-threads=1",
    ]);
  } finally {
    if (process.connected) process.disconnect();
  }
} else {
  assert.equal(process.argv.length, 3);
  // These proofs own the launch/lifecycle boundary, which is shared by both
  // terminal cores. It does not certify Ghostty rendering or the desktop suite.
  run("cargo", [
    "build", "--locked", "--manifest-path", "hmux/Cargo.toml",
    "--package", "hmux-runtime", "--bin", "hmux-runtime",
  ]);
  console.log(JSON.stringify({
    observation: "native-windows-lifecycle-build",
    testTarget,
    rust: rust.trim(),
    node: process.version,
    runtimeSha256: createHash("sha256").update(fs.readFileSync(runtimeBinary)).digest("hex"),
  }));
  await prepareWindowsJobRuntime();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "dure-windows-lifecycle-"));
  const child = fork(fileURLToPath(import.meta.url), [testTarget, "--owned-windows-test-child"], {
    cwd: repository,
    env: {
      ...process.env,
      DURE_HMUX_TEST_STATE_ROOT: state,
      HMUX_DISCOVERY_ROOT: path.join(state, "discovery"),
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  exited.catch(() => {});
  const identity = observeProcessIdentity(child.pid);
  const lease = createWindowsJobLease(child, identity);
  try {
    const processGroup = await lease.authority;
    const owner = { pid: child.pid, processIdentity: await identity, processGroup };
    // Persist the exact native Job capability before admitting any test process.
    // The child has already joined that Job, but still waits for this admission.
    fs.writeFileSync(path.join(state, "windows-job-owner.json"), JSON.stringify(owner), {
      flag: "wx", mode: 0o600,
    });
    child.send({ type: "windows_native_start" });
    const outcome = await exited;
    const retirement = await lease.retired;
    assert.equal(retirement.code, 0, "Windows Job did not finish exact tree retirement");
    assert.equal((await observeWindowsJob(owner)).state, "retired");
    console.log(JSON.stringify({
      observation: "native-windows-lifecycle-retired",
      testTarget,
      runtimeSha256: createHash("sha256").update(fs.readFileSync(runtimeBinary)).digest("hex"),
      outcome, jobEmpty: true, evidenceRoot: state,
    }));
    assert.equal(outcome.signal, null);
    assert.equal(outcome.code, 0, "Native Windows lifecycle assertions failed");
  } finally {
    if (child.connected) child.disconnect();
    // Keep the private fixture/ownership records on failure; never delete a
    // root based only on the leader exiting. The disposable runner owns them.
  }
}
