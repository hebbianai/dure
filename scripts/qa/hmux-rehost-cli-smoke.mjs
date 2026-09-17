import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutLocalGitOverrides } from "../lib/git-environment.mjs";
import { runLauncher } from "../run-hmux-tests.mjs";
import { QaExecutionTimeline } from "./lib/qa-execution.mjs";
import { cargoArtifact, cargoArtifacts } from "./managed-provider-fixture.mjs";

const script = fileURLToPath(import.meta.url);
const repository = fs.realpathSync(path.resolve(path.dirname(script), "../.."));
const filters = {
  admission: "rehost_cli::dure_start_and_retry_preserve_one_operation_and_successor",
  start: "rehost_cli::dure_start_and_retry_preserve_one_operation_and_successor",
  retry: "rehost_cli::dure_start_and_retry_preserve_one_operation_and_successor",
  named: "rehost_cli::named::confirmed_name_pins_execution_and_publication",
  wait: "dure_wait_observes_host_completion_without_an_app_server",
};
const usage = `Rehost CLI QA — real native broker, Host and PTY; fixture provider/backend metadata.

  pnpm test:hmux-rehost-cli                         Prepare once, then run all groups
  pnpm test:hmux-rehost-cli named                   Prepare once, then run one group
  pnpm test:hmux-rehost-cli prepare /tmp/rehost.json Build only; retain exact artifact paths/hashes
  pnpm test:hmux-rehost-cli run /tmp/rehost.json [admission|start|retry|named|wait]

Run never invokes Cargo or falls back to a build. Each group owns fresh isolated state.
Prepare again after native/test changes. A run checks prepared binaries, not current-source freshness.
The Rust fixture uses this checkout's current source Dure CLI; this is not installed/live proof.
The wait group runs inspect → send → wait through the native PTY, including a lost
input receipt, fast completion, duplicate completion and observer restart without resending.
Each result includes retained timing receipts and separate runner startup, build/verification,
and guardian cleanup durations. Verification includes the native fixture's own Host setup/stop.
Missing timing evidence stays unavailable and never overrides the command's exit status.`;

function groups(selected) {
  if (selected === undefined) return Object.keys(filters);
  assert(Object.hasOwn(filters, selected), "Unknown rehost QA group");
  return [selected];
}

async function artifact(executable) {
  const resolved = fs.realpathSync(executable);
  fs.accessSync(resolved, fs.constants.X_OK);
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(resolved)) hash.update(chunk);
  return { path: resolved, sha256: hash.digest("hex") };
}

async function prepare(receipt) {
  assert(!fs.existsSync(receipt), "Prepared receipt already exists; choose a new output file");
  const cli = await cargoArtifact([
    "build", "--locked", "--manifest-path", "hmux/Cargo.toml", "-p", "hmux-cli",
  ], "hmux", { kind: "qa" });
  const artifacts = await cargoArtifacts([
    "test", "--locked", "--manifest-path", "hmux/Cargo.toml", "-p", "hmux-runtime",
    "--features", "terminal-state-stream", "--test", "managed_smoke", "--no-run",
  ], { kind: "qa" });
  const executable = (name) => {
    const result = artifacts.findLast((entry) => entry.target.name === name)?.executable;
    assert(result, `Cargo did not publish ${name}`);
    return result;
  };
  const git = (...args) => execFileSync("git", args, {
    cwd: repository, encoding: "utf8", env: withoutLocalGitOverrides(),
  }).trim();
  const prepared = {
    schemaVersion: 1,
    kind: "dure.qa.rehost.prepared",
    worktree: repository,
    source: { commit: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain").length > 0 },
    artifacts: {
      cli: await artifact(cli),
      runtime: await artifact(executable("hmux-runtime")),
      test: await artifact(executable("managed_smoke")),
    },
  };
  fs.writeFileSync(receipt, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

async function readPrepared(receipt) {
  const prepared = JSON.parse(fs.readFileSync(receipt, "utf8"));
  assert(prepared.schemaVersion === 1 && prepared.kind === "dure.qa.rehost.prepared",
    "Unsupported rehost QA receipt");
  assert.equal(prepared.worktree, repository, "Prepared test belongs to another worktree");
  for (const name of ["cli", "runtime", "test"]) {
    const expected = prepared.artifacts?.[name];
    assert(expected && path.isAbsolute(expected.path), `Missing prepared ${name}`);
    assert.deepEqual(await artifact(expected.path), expected,
      `Prepared ${name} changed; prepare a new receipt before running`);
  }
  return prepared;
}

function writeTiming(file, value, flag) {
  try {
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600, flag });
    return true;
  } catch (error) {
    console.error(`qa_phase_timing_unavailable: ${error.message}`);
    return false;
  }
}

async function timeCommand(file, run) {
  if (!file) return run();
  const startedAtMs = Date.now();
  const recorded = writeTiming(file, { startedAtMs }, "wx");
  try { return await run(); }
  finally {
    if (recorded) writeTiming(file, { startedAtMs, finishedAtMs: Date.now() }, "w");
  }
}

function stepTiming(name, status, file, startedAtMs, finishedAtMs) {
  try {
    const command = JSON.parse(fs.readFileSync(file, "utf8"));
    const points = [startedAtMs, command.startedAtMs, command.finishedAtMs, finishedAtMs];
    assert(points.every((point, index) => Number.isSafeInteger(point) &&
      (index === 0 || point >= points[index - 1])), "Incomplete or non-monotonic timing receipt");
    let observedAtMs = startedAtMs;
    const execution = new QaExecutionTimeline("native", () => observedAtMs);
    execution.begin("startup");
    observedAtMs = command.startedAtMs;
    execution.begin(name === "prepare" ? "build" : "verification");
    observedAtMs = command.finishedAtMs;
    execution.begin("cleanup");
    observedAtMs = finishedAtMs;
    execution.complete();
    return execution.decorate({ name, status });
  } catch (error) {
    return { name, status, qaExecution: null,
      timingError: { code: "qa_phase_timing_unavailable", message: error.message } };
  }
}

async function runCase(group, executable, timingFile) {
  groups(group);
  const stateRoot = process.env.DURE_HMUX_TEST_STATE_ROOT;
  assert(stateRoot, "Run through scripts/run-hmux-tests.mjs");
  const home = path.join(stateRoot, "provider-home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { ...process.env, HOME: home, DURE_HOME: path.join(home, "dure"), DURE_QA_REHOST_GROUP: group };
  const args = [filters[group], "--ignored", "--exact"];
  const listed = execFileSync(executable, [...args, "--list"], { cwd: repository, env, encoding: "utf8" });
  assert(listed.split(/\r?\n/u).includes(`${filters[group]}: test`),
    "Prepared executable does not contain the selected test; refusing a zero-test success");
  return timeCommand(timingFile, () => {
    const result = spawnSync(executable, [...args, "--nocapture"], { cwd: repository, env, stdio: "inherit" });
    if (result.error) throw result.error;
    assert(!result.signal, `Rehost QA exited from signal ${result.signal}`);
    return result.status ?? 1;
  });
}

async function main(args) {
  if (args[0] === "--help") { console.log(usage); return 0; }
  if (args[0] === "--case") {
    assert(args.length === 3 || args.length === 4, usage);
    return runCase(args[1], args[2], args[3]);
  }
  if (args[0] === "--build") {
    assert((args.length === 2 || args.length === 3) && process.env.DURE_HMUX_TEST_STATE_ROOT, usage);
    await timeCommand(args[2], () => prepare(args[1]));
    return 0;
  }
  const mode = ["prepare", "run"].includes(args[0]) ? args[0] : "all";
  assert(mode === "all" ? args.length <= 1 : args.length >= 2 && args.length <= (mode === "run" ? 3 : 2), usage);
  const selected = mode === "all" ? groups(args[0]) : mode === "run" ? groups(args[2]) : [];
  const receipt = mode === "all"
    ? path.join(fs.mkdtempSync(path.join(tmpdir(), "dure-rehost-prepared-")), "prepared.json")
    : path.resolve(args[1]);
  const execution = new QaExecutionTimeline("native");
  const timingRoot = fs.mkdtempSync(path.join(tmpdir(), "dure-rehost-timing-"));
  const steps = [];
  const launch = async (name, command, options) => {
    const file = path.join(timingRoot, `${name}.json`);
    const startedAtMs = Date.now();
    let status = 1;
    try {
      status = await runLauncher([...command, file], options);
      return status;
    } finally {
      steps.push(stepTiming(name, status, file, startedAtMs, Date.now()));
    }
  };
  let status = 1;
  try {
    if (mode !== "run") {
      assert(!fs.existsSync(receipt), "Prepared receipt already exists; choose a new output file");
      execution.begin("prepare");
      status = await launch("prepare", [
        process.execPath, "scripts/run-with-build-storage.mjs", "qa", "--",
        process.execPath, script, "--build", receipt,
      ]);
      if (status !== 0) { execution.fail("qa_prepare"); return status; }
    }
    execution.begin("artifacts");
    const prepared = await readPrepared(receipt);
    const environment = {
      ...process.env,
      DURE_QA_HMUX_BIN: prepared.artifacts.cli.path,
      DURE_QA_HMUX_RUNTIME: prepared.artifacts.runtime.path,
    };
    for (const group of selected) {
      execution.begin(group);
      status = await launch(group, [
        process.execPath, script, "--case", group, prepared.artifacts.test.path,
      ], { environment });
      if (status !== 0) { execution.fail("qa_native_or_cleanup"); return status; }
    }
    status = 0;
    return status;
  } catch (error) {
    status = 1;
    execution.fail("qa_runner");
    throw error;
  } finally {
    execution.complete();
    console.log(JSON.stringify(execution.decorate({
      kind: "dure.qa.rehost.result", prepared: receipt, status, timingRoot, steps,
    })));
  }
}

if (process.argv[1] === script) {
  try { process.exitCode = await main(process.argv.slice(2).filter((arg) => arg !== "--")); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
