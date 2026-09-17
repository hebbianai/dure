import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { observeProcessIdentity } from "./process-identity.mjs";
import { parseWindowsProcessIdentity } from "./windows-process-identity.mjs";
import { ensureHeadroom } from "./build-storage-admission.mjs";

export const WINDOWS_JOB_AUTHORITY_KIND = "windows_job_v1";
export const WINDOWS_JOB_SOURCE_PATHS = Object.freeze([
  "crates/hebbian-bounded-process/Cargo.toml",
  "crates/hebbian-bounded-process/Cargo.lock",
  "crates/hebbian-bounded-process/src/lib.rs",
  "crates/hebbian-bounded-process/src/supervisor.rs",
  "crates/hebbian-bounded-process/src/windows_job.rs",
  "crates/hebbian-bounded-process/src/platform/mod.rs",
  "crates/hebbian-bounded-process/src/platform/unix.rs",
  "crates/hebbian-bounded-process/src/platform/windows.rs",
  "crates/hebbian-bounded-process/src/bin/bounded_process_fixture.rs",
  "crates/hebbian-bounded-process/src/bin/process_job.rs",
]);
const execute = promisify(execFile);
const sourceRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const candidateMessage = "windows_job_candidate_ready";
let runtime;
let preparation;

function runtimeLocation() {
  if (runtime) return runtime;
  const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (process.platform !== "win32" || !architecture) {
    throw new Error("Windows Job runtime requires a supported native Windows architecture");
  }
  const hash = createHash("sha256");
  for (const relativePath of WINDOWS_JOB_SOURCE_PATHS) {
    hash.update(relativePath).update("\0").update(readFileSync(join(sourceRoot, relativePath)));
  }
  const target = `${architecture}-pc-windows-msvc`;
  const build = hash.digest("hex");
  const directory = join(sourceRoot, "crates/hebbian-bounded-process/target/dure-process-job", build);
  runtime = { build, target, directory, executable: runtimeExecutable(build) };
  return runtime;
}

function runtimeExecutable(build) {
  if (!process.env.LOCALAPPDATA || !/^[a-f0-9]{64}$/.test(build)) {
    throw new Error("Windows Job runtime identity is unavailable");
  }
  return join(process.env.LOCALAPPDATA, "Dure", "process-job", `${process.arch}-${build}.exe`);
}

// Jobs retain their immutable adapter build, so staged deploy executors and
// future source versions can retire them without compiling during cleanup.
export function prepareWindowsJobRuntime() {
  preparation ??= (async () => {
    const location = runtimeLocation();
    if (!existsSync(location.executable)) {
      const headroom = ensureHeadroom({
        cwd: sourceRoot, label: "Windows process Job helper", requestedBytes: 512 * 1024 * 1024,
        ...(process.env.RUNNER_ENVIRONMENT === "github-hosted" ? { floorBytes: 0, goalBytes: 0 } : {}),
      });
      if (!headroom.ok) throw new Error(headroom.message);
      const temporary = `${location.executable}.${process.pid}.tmp`;
      try {
        await execute("cargo", [
          "build", "--locked", "--manifest-path", join(sourceRoot, "crates/hebbian-bounded-process/Cargo.toml"),
          "--bin", "dure-process-job", "--target", location.target, "--target-dir", location.directory,
        ], { cwd: sourceRoot, windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
        mkdirSync(join(process.env.LOCALAPPDATA, "Dure", "process-job"), { recursive: true });
        copyFileSync(join(location.directory, location.target, "debug/dure-process-job.exe"), temporary);
        renameSync(temporary, location.executable);
      } finally {
        rmSync(temporary, { force: true });
        headroom.reservation?.release();
      }
    }
    const { stdout } = await execute(location.executable, ["--version"], { windowsHide: true, timeout: 5_000 });
    const version = JSON.parse(stdout);
    if (version.protocolVersion !== 1 || version.type !== "windows_job_runtime") {
      throw new Error("Windows Job runtime protocol is incompatible");
    }
    return location.executable;
  })();
  return preparation;
}

function waitForMessage(child, type) {
  return new Promise((resolve, reject) => {
    const finish = (operation, value) => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("disconnect", onDisconnect);
      operation(value);
    };
    const onMessage = (message) => {
      if (message?.type === type) finish(resolve, message);
    };
    const onExit = () => finish(reject, new Error("Windows Job candidate exited before binding"));
    const onError = (error) => finish(reject, error);
    const onDisconnect = () => finish(reject, new Error("Windows Job binding disconnected"));
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    child.once("disconnect", onDisconnect);
  });
}

function send(child, message) {
  return new Promise((resolve, reject) => child.send(message, (error) => error ? reject(error) : resolve()));
}

export function isWindowsJobCandidateMessage(message) {
  return message?.type === candidateMessage;
}

export async function awaitWindowsJobBinding() {
  const bound = waitForMessage(process, "windows_job_bound");
  bound.catch(() => {});
  await send(process, { type: candidateMessage });
  const { witnessPid } = await bound;
  return { pid: witnessPid, async retain() {}, async retire() {} };
}

export function createWindowsJobLease(child, identityPromise) {
  const candidate = waitForMessage(child, candidateMessage);
  candidate.catch(() => {});
  let helperExit = Promise.resolve();
  const authority = (async () => {
    const [processIdentity, ownerIdentity] = await Promise.all([
      identityPromise, observeProcessIdentity(process.pid), candidate,
    ]);
    if (!processIdentity || !ownerIdentity) throw new Error("Windows Job launch generation is unavailable");
    const id = randomBytes(32).toString("hex");
    const helper = spawn(runtimeLocation().executable, ["lease", id, processIdentity, ownerIdentity], {
      detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    helperExit = new Promise((resolve) => {
      helper.once("exit", (code, signal) => resolve({ code, signal }));
      helper.once("error", (error) => resolve({ error }));
    });
    const ready = new Promise((resolve, reject) => {
      let output = "";
      let diagnostics = "";
      helper.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-4_096); });
      helper.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 16_384) {
          reject(new Error("Windows Job readiness exceeded its frame limit"));
          return;
        }
        if (!output.includes("\n")) return;
        try {
          const message = JSON.parse(output.slice(0, output.indexOf("\n")));
          const witness = message.witness;
          const identity = parseWindowsProcessIdentity(witness?.processIdentity);
          if (message.protocolVersion !== 1 || message.type !== "windows_job_ready" ||
              message.jobId !== id || witness?.pid !== helper.pid || identity?.pid !== helper.pid) {
            throw new Error("invalid Windows Job readiness");
          }
          resolve({ kind: WINDOWS_JOB_AUTHORITY_KIND, id, runtimeBuild: runtimeLocation().build, witness });
        } catch (error) { reject(error); }
      });
      helperExit.then(() => reject(new Error(`Windows Job admission failed: ${diagnostics.trim()}`)));
    });
    const group = await ready;
    await send(child, { type: "windows_job_bound", witnessPid: group.witness.pid });
    return group;
  })();
  authority.catch(() => {});
  return { authority, retired: authority.then(() => helperExit, () => helperExit) };
}

async function command(runtimeBuild, args) {
  const { stdout } = await execute(runtimeExecutable(runtimeBuild), args, {
    windowsHide: true, timeout: 35_000, maxBuffer: 16_384,
  });
  return JSON.parse(stdout);
}

export async function observeWindowsJob(owner) {
  const value = await command(owner.processGroup.runtimeBuild, [
    "observe", owner.processGroup.id, owner.processIdentity, owner.processGroup.witness.processIdentity,
  ]);
  if (value.state === "retired") return { state: "retired", authority: owner.processGroup };
  if (value.state !== "owned" || typeof value.leaderCurrent !== "boolean" ||
      typeof value.witnessCurrent !== "boolean") throw new Error("invalid Windows Job observation");
  return { ...value, authority: owner.processGroup };
}

export async function terminateWindowsJob(owner, signal) {
  if (signal !== "SIGTERM" && signal !== "SIGKILL") throw new Error("Windows Jobs support termination only");
  const result = await command(owner.processGroup.runtimeBuild, ["terminate", owner.processGroup.id]);
  if (result.state !== "retired") throw new Error("Windows Job retirement was not confirmed");
  return true;
}
