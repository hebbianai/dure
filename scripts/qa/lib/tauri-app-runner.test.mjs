import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import {
  CONTROL_PLANE_BUILD_ID,
  CONTROL_PLANE_CAPABILITIES,
  CONTROL_PLANE_IDENTITY_API_VERSION,
  CONTROL_PLANE_IDENTITY_KIND,
} from "../../../cli/lib/control-plane-contract.mjs";
import {
  processLivenessFromObservation,
  processMemberFromObservation,
  processMemberSnapshots,
} from "../../lib/process-identity.mjs";
import { createBoundedConcurrentTests } from "./bounded-concurrent-tests.mjs";
import {
  exactOwnedProcessIdentity,
  readOwnedProcessGroup,
  readOwnedProcessLedger,
  supervise,
} from "./owned-process-group.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const runner = path.resolve(directory, "tauri-app-runner.sh");
const processGroupRunner = path.join(directory, "owned-process-group.mjs");
const runnerSource = fs.readFileSync(runner, "utf8");
const verifiedRunnerCompletion = {
  cleanup: "verified",
  schema: "dure-qa-tauri-app-runner/v1",
};
const temporaryDirectories = [];
const fixturePids = new Set();
const fixtureProcesses = new Map();
const fixtureControlPlaneIdentity = JSON.stringify({
  schemaVersion: 1,
  apiVersion: CONTROL_PLANE_IDENTITY_API_VERSION,
  kind: CONTROL_PLANE_IDENTITY_KIND,
  buildId: CONTROL_PLANE_BUILD_ID,
  capabilities: CONTROL_PLANE_CAPABILITIES,
});
const suiteTemporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "tauri-runner-suite-"),
);
temporaryDirectories.push(suiteTemporaryRoot);
// Warm the canonical observer before teardown paths compete with loaded
// fixtures. If it is unavailable, those paths rely on child-exit events.
if (process.platform === "darwin" || process.platform === "linux") {
  try {
    processMemberSnapshots([process.pid]);
  } catch {
    // Child-exit observation remains the fail-closed fallback.
  }
}
// 게이트 부하(동시 vitest 파일 + 같은 머신의 CI cargo)에서 프로세스 기동이
// 유휴 대비 수 배 늘어져 10-15s 창이 플레이크를 냈다(2026-07-31 push 게이트
// 2연속, 서로 다른 테스트). 아래 값은 테스트가 기다려 주는 한도일 뿐 러너의
// 내부 bounded wait(3s)와 TERM->KILL 에스컬레이션 의미는 바꾸지 않는다.
const FIXTURE_START_TIMEOUT_MS = 40_000;
const RUNNER_PREPARATION_TIMEOUT_MS = 120_000;
const RUNNER_COMPLETION_TIMEOUT_MS = 60_000;
const DELAYED_RUNNER_COMPLETION_TIMEOUT_MS = 90_000;
const RUNNER_TERMINATION_TIMEOUT_MS = 5_000;
// stderr 내용에 의존하는 단언(retired root 경로 regex 등)이 있어, 기아 시
// pending data 이벤트보다 타이머가 먼저 돌아 꼬리가 잘리는 창을 줄인다 —
// 자손 사망 후 close는 보장되므로 이 대기는 상한일 뿐이다(재설계 문서의
// drain 창; 완전 해소는 영수증-파일 방식으로 후속).
const RUNNER_STDIO_DRAIN_GRACE_MS = 3_000;
// These fixtures exercise bounded 3s waits and TERM-to-KILL escalation.
// The outer deadline also includes time queued behind exclusive reparenting
// fixtures; internal deadlines still report hangs before this last-resort guard.
const FIXTURE_TEST_TIMEOUT_MS = 240_000;
const inheritedPipeHolderProgram = [
  'const fs = require("node:fs");',
  "const writeMarker = process.argv[1];",
  "const releaseMarker = process.argv[2];",
  "let wroteAfterExit = false;",
  "const interval = setInterval(() => {",
  "  if (!wroteAfterExit && fs.existsSync(writeMarker)) {",
  '    process.stderr.write("pipe-holder-after-runner-exit\\n");',
  "    wroteAfterExit = true;",
  "  }",
  "  if (fs.existsSync(releaseMarker)) clearInterval(interval);",
  "}, 20);",
].join("\n");

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o700 });
}

function publishFixtureMarker(file) {
  try {
    fs.writeFileSync(file, "ready\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function observedProcessIdentity(
  pid,
  observation = processMemberSnapshots([pid]),
) {
  const observed = processMemberFromObservation(pid, observation);
  if (observed.status === "unknown") {
    throw new Error("exact process identity observation is incomplete");
  }
  if (observed.status === "departed") return null;
  return {
    pid: observed.member.pid,
    processIdentity: observed.member.processIdentity,
  };
}

function observeProcessLiveness(identity) {
  return processLivenessFromObservation(
    identity,
    processMemberSnapshots([identity.pid]),
  );
}

function allProcessIdentitiesDeparted(identities) {
  const observation = processMemberSnapshots(
    identities.map(({ pid }) => pid),
  );
  return identities.every(
    (identity) =>
      processLivenessFromObservation(identity, observation) === "stale",
  );
}

// The default is a setup/teardown budget, not an assertion: it waits for the
// OS to get around to spawning a fixture process or writing its file, so it
// only has to be longer than a busy machine's scheduling delay. Every
// deliberate deadline in this file passes its own timeout instead — the 3s
// late-manifest containment check below is an assertion about the runner and
// must stay strict. Keep that split: raising this constant must never change
// what any test asserts. Why: at load average 10 (a full repo gate running
// alongside) these setup waits missed a 3s budget and reported a defect in
// code that was correct, which is the most expensive kind of false red.
const SETUP_WAIT_TIMEOUT_MS = 30_000;

async function waitUntil(predicate, timeoutMs = SETUP_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function readReadyPid(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    if (!/^[1-9]\d*$/.test(value)) return null;
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function start(command, args, options) {
  const child = spawn(command, args, options);
  let stdout = "";
  let stderr = "";
  const capture = (status, signal) => ({ signal, status, stderr, stdout });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => {
      resolve(capture(status, signal));
    });
  });
  // Most callers need the fully drained `close` result. Keep the separately
  // registered exit promise handled even when no timeout cleanup consumes it.
  void exited.catch(() => {});
  const result = new Promise((resolve, reject) => {
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve(capture(status, signal));
    });
  });
  return { capture, child, exited, result };
}

function startTracked(command, args, options) {
  const running = start(command, args, options);
  const pid = running.child.pid;
  if (Number.isSafeInteger(pid) && pid > 1) {
    fixturePids.add(pid);
    fixtureProcesses.set(pid, running);
    void running.result.then(
      () => {
        fixturePids.delete(pid);
        fixtureProcesses.delete(pid);
      },
      () => {
        fixturePids.delete(pid);
        fixtureProcesses.delete(pid);
      },
    );
  }
  return running;
}

function run(command, args, options) {
  return start(command, args, options).result;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ state: "fulfilled", value }),
      (error) => ({ error, state: "rejected" }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ state: "timed_out" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
}

async function stopTrackedProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  fixturePids.add(pid);
  const running = fixtureProcesses.get(pid);
  if (running) {
    await stopStartedRunner(running);
    fixturePids.delete(pid);
    fixtureProcesses.delete(pid);
    return;
  }
  if (!processExists(pid)) {
    fixturePids.delete(pid);
    return;
  }
  if (!(await waitUntil(() => !processExists(pid), 6_000))) {
    throw new Error(
      `fixture process ${pid} has no child handle; refusing a numeric-pid signal`,
    );
  }
  fixturePids.delete(pid);
}

/** Capture the unreaped direct child's exact identity before signaling it.
 *  If observation is unavailable, teardown waits for the child event without
 *  guessing that the generation departed. */
function observeDirectChildGeneration(running) {
  const child = running.child;
  if (child.exitCode !== null || child.signalCode !== null) return null;
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  try {
    return observedProcessIdentity(child.pid);
  } catch {
    return null;
  }
}

async function stopStartedRunner(
  running,
  timeoutMs = RUNNER_TERMINATION_TIMEOUT_MS,
  maxObservationSlices = 6,
) {
  // SIGKILL 생존을 타이머 경주로 판정하면, 동시 픽스처의 spawnSync 폭주가
  // 이벤트 루프를 블록했을 때 timers phase가 poll(SIGCHLD)보다 먼저 돌아
  // **이미 죽은** 러너가 "did not report exit"로 오판됐다(2026-08-01 QA
  // 플레이크 결정화, W1 — 순서 결함이라 한도 확대로는 닫히지 않는다).
  // 신호 전에 exact 세대를 캡처하고, 타임아웃 slice에서는 커널 세대 관측이
  // 2회 연속 "생존"일 때만 생존을 선언한다. 세대가 부재(사망/좀비)면 직계
  // child의 exit 이벤트는 도착이 보장되므로 재대기한다.
  const expected = observeDirectChildGeneration(running);
  if (
    running.child.exitCode === null &&
    running.child.signalCode === null
  ) {
    running.child.kill("SIGTERM");
  }
  // W4: TERM 유예를 1s slice로 나눠 slice 사이에 세대를 관측한다 — 러너가
  // 이미 죽었는데(부하로 exit 이벤트만 지연) 유예 만료로 KILL이 정리 중간에
  // 떨어져 supervisor/worker를 고아로 만들던 연쇄를 끊는다. 유예 총량과
  // TERM→KILL 의미(신호를 무시하면 KILL 승격 — runner-timeout 픽스처 계약)는
  // 불변이다.
  const termDeadline = Date.now() + timeoutMs;
  let outcome = await settleWithin(
    running.exited,
    Math.min(1_000, timeoutMs),
  );
  let generationSeenGone = false;
  while (outcome.state === "timed_out" && Date.now() < termDeadline) {
    if (
      expected !== null &&
      observeProcessLiveness(expected) === "stale"
    ) {
      generationSeenGone = true;
      break;
    }
    outcome = await settleWithin(
      running.exited,
      Math.min(1_000, Math.max(50, termDeadline - Date.now())),
    );
  }
  if (outcome.state === "timed_out" && !generationSeenGone) {
    running.child.kill("SIGKILL");
    outcome = await settleWithin(running.exited, timeoutMs);
  }
  let liveObservations = 0;
  let slices = 0;
  while (outcome.state === "timed_out") {
    const live =
      expected !== null &&
      observeProcessLiveness(expected) === "active";
    if (live) {
      liveObservations += 1;
      if (liveObservations >= 2) {
        throw new Error("exact fixture runner generation survived SIGKILL");
      }
    } else {
      liveObservations = 0;
    }
    slices += 1;
    if (slices >= maxObservationSlices) {
      throw new Error(
        "fixture runner generation exited but its exit event was never observed",
      );
    }
    outcome = await settleWithin(running.exited, timeoutMs);
  }
  if (outcome.state === "rejected") throw outcome.error;
  return running.capture(outcome.value.status, outcome.value.signal);
}

async function waitForStartedRunnerClose(
  running,
  timeoutMs = RUNNER_TERMINATION_TIMEOUT_MS,
) {
  const outcome = await settleWithin(running.result, timeoutMs);
  if (outcome.state === "timed_out") {
    throw new Error(
      "fixture runner exited but inherited stdio remained open after exact cleanup",
    );
  }
  if (outcome.state === "rejected") throw outcome.error;
  return outcome.value;
}

async function waitForRunner(
  running,
  completionTimeoutMs = RUNNER_COMPLETION_TIMEOUT_MS,
  terminationTimeoutMs = RUNNER_TERMINATION_TIMEOUT_MS,
  stdioDrainGraceMs = RUNNER_STDIO_DRAIN_GRACE_MS,
) {
  const outcome = await settleWithin(running.exited, completionTimeoutMs);
  if (outcome.state === "fulfilled") {
    const drained = await settleWithin(
      running.result,
      stdioDrainGraceMs,
    );
    if (drained.state === "fulfilled") return drained.value;
    if (drained.state === "rejected") throw drained.error;
    return running.capture(outcome.value.status, outcome.value.signal);
  }
  if (outcome.state === "rejected") throw outcome.error;
  const terminated = await stopStartedRunner(running, terminationTimeoutMs);
  const drained = await settleWithin(
    running.result,
    RUNNER_STDIO_DRAIN_GRACE_MS,
  );
  if (drained.state === "rejected") throw drained.error;
  const diagnostic =
    drained.state === "fulfilled"
      ? drained.value
      : running.capture(terminated.status, terminated.signal);
  throw new Error(
    `fixture runner did not exit within ${completionTimeoutMs}ms ` +
      `(status ${diagnostic.status}, signal ${diagnostic.signal}):\n` +
      `stdout:\n${diagnostic.stdout}\nstderr:\n${diagnostic.stderr}`,
  );
}

async function waitForRunnerPreparation(running, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let exitOutcome;
  void running.exited.then(
    (result) => {
      exitOutcome = { result, state: "exited" };
    },
    (error) => {
      exitOutcome = { error, state: "rejected" };
    },
  );
  while (!fs.existsSync(marker)) {
    if (exitOutcome?.state === "rejected") throw exitOutcome.error;
    if (exitOutcome?.state === "exited") return exitOutcome;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return { state: "timed_out" };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(20, remainingMs)),
    );
  }
  return { state: "prepared" };
}

async function cleanupFixtureProcesses(
  running,
  fixture,
  unrelatedPid,
  { frozenTerminateFailure = false } = {},
) {
  const errors = [];
  try {
    await stopStartedRunner(running);
  } catch (error) {
    errors.push(error);
  }
  if (frozenTerminateFailure && fs.existsSync(fixture.stateRootCapture)) {
    // The injected refusal leaves workers stopped, so their self-exit timers
    // cannot run. Retire them through the same authenticated snapshot owner
    // after the runner's refusal and retained-root assertions have completed.
    const stateRoot = fs.readFileSync(fixture.stateRootCapture, "utf8").trim();
    for (const name of ["client", "app"]) {
      try {
        const descriptorPath = path.join(stateRoot, `${name}-process-group.json`);
        const snapshotPath = path.join(stateRoot, `${name}-frozen-processes.json`);
        const published = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
        const descriptor = readOwnedProcessGroup(descriptorPath, published.supervisorPid);
        const result = await run(process.execPath, [
          processGroupRunner,
          "terminate-frozen",
          descriptorPath,
          String(descriptor.supervisorPid),
          snapshotPath,
        ], { cwd: fixture.root, stdio: ["ignore", "pipe", "pipe"] });
        expect(result.status, result.stderr).toBe(0);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (fs.existsSync(fixture.pidFile)) {
    try {
      await stopTrackedProcess(Number(fs.readFileSync(fixture.pidFile, "utf8")));
    } catch (error) {
      errors.push(error);
    }
  }
  if (fs.existsSync(fixture.lateGrandchildPidFile)) {
    try {
      await stopTrackedProcess(
        Number(fs.readFileSync(fixture.lateGrandchildPidFile, "utf8")),
      );
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await stopTrackedProcess(unrelatedPid);
  } catch (error) {
    errors.push(error);
  }
  try {
    await waitForStartedRunnerClose(running);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "fixture process cleanup failed");
  }
}

function createFixture(mode) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `tauri-app-runner-${mode}-`),
  );
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  const artifacts = path.join(root, "artifacts");
  const dureInstallCapture = path.join(root, "dure-install.txt");
  const runnerPrepared = path.join(root, "runner-prepared.marker");
  const runnerControlEnvCapture = path.join(
    root,
    "runner-control-environment.json",
  );
  const dureInstaller = path.resolve(
    directory,
    "../../install-dure-cli.mjs",
  );
  const hmuxCleanupCapture = path.join(root, "hmux-cleanup-order.txt");
  const launchOwnerFailureMarker = path.join(
    root,
    "launch-owner-failure.marker",
  );
  const launchOwnerGuardRootCapture = path.join(
    root,
    "launch-owner-guard-root.txt",
  );
  const hmuxSessionCleanupRunner = path.join(
    directory,
    "isolated-hmux-session-cleanup.mjs",
  );
  const latePublishMarker = path.join(root, "late-publish.marker");
  const lateGrandchild = path.join(root, "late-hmux-grandchild.mjs");
  const lateGrandchildPidFile = path.join(root, "late-grandchild.pid");
  const latePublisher = path.join(root, "late-hmux-host.mjs");
  const latePublisherLauncher = path.join(root, "late-hmux-launcher.mjs");
  const pidFile = path.join(root, "descendant.pid");
  const pipeReleaseFile = path.join(root, "pipe-release.marker");
  const pipeWriteFile = path.join(root, "pipe-write.marker");
  const signalFile = path.join(root, "descendant.signals");
  const worker = path.join(root, "term-ignoring-worker.mjs");
  const holder = path.join(root, "app-holder.mjs");
  const client = path.join(root, "client.mjs");
  const clientStarted = path.join(root, "client-started.marker");
  const clientReadinessChecked = path.join(
    root,
    "client-readiness-checked.marker",
  );
  const serverReadinessObserved = path.join(
    root,
    "server-readiness-observed.marker",
  );
  const appGroupInspected = path.join(root, "app-group-inspected.marker");
  const cleanupBoundaryMarker = path.join(root, "cleanup-boundary.marker");
  const processGroupDelayMarker = path.join(
    root,
    "process-group-delay.marker",
  );
  const freezeFailureMarker = path.join(root, "freeze-failure.marker");
  const stateRootCapture = path.join(root, "state-root.txt");
  const node = path.join(bin, "node");
  const pnpm = path.join(bin, "pnpm");
  const tauri = path.join(bin, "tauri");
  const tauriLaunchCapture = path.join(root, "tauri-launch.json");
  const tauriPackage = path.join(root, "node_modules", "@tauri-apps", "cli");
  const ps = path.join(bin, "ps");
  const frontTool = path.join(bin, "front-tool");
  const dureControlPlane = path.join(bin, "dure-control-plane");
  const dureClaudeProcessRelay = path.join(
    bin,
    "dure-claude-process-relay",
  );
  const hmuxCli = path.join(bin, "hmux");
  const hmuxRuntime = path.join(bin, "hmux-runtime");
  fs.mkdirSync(bin);
  fs.mkdirSync(tauriPackage, { recursive: true });
  fs.writeFileSync(
    path.join(tauriPackage, "package.json"),
    JSON.stringify({ bin: { tauri: "./entry.cjs" } }),
  );
  fs.writeFileSync(
    path.join(tauriPackage, "entry.cjs"),
    `require("node:fs").writeFileSync(
  ${JSON.stringify(tauriLaunchCapture)},
  JSON.stringify({
    args: process.argv.slice(2),
    home: process.env.HOME,
    dureHome: process.env.DURE_HOME,
    discoveryRoot: process.env.HMUX_DISCOVERY_ROOT,
  }),
);
const result = require("node:child_process").spawnSync(
  "/bin/sh",
  [${JSON.stringify(tauri)}, ...process.argv.slice(2)],
  { stdio: ["inherit", "inherit", "inherit", ...(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD ? [Number(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD)] : [])] },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
  );
  if (mode === "background-focus-startup") {
    fs.writeFileSync(processGroupDelayMarker, "delay\n");
  }
  writeExecutable(
    ps,
    `#!/bin/sh
set -eu
if [ "\${HEBBIAN_QA_TEST_MODE:-}" = "app-server-readiness-delay" ] &&
  [ ! -f "$HEBBIAN_QA_TEST_SERVER_READINESS_OBSERVED" ] &&
  [ -f "$HEBBIAN_QA_TEST_APP_GROUP_INSPECTED" ] &&
  [ -s "$HEBBIAN_QA_TEST_STATE_ROOT_CAPTURE" ]; then
  state_root=$(cat "$HEBBIAN_QA_TEST_STATE_ROOT_CAPTURE")
  descriptor="$state_root/app-process-group.json"
  if [ -f "$descriptor" ]; then
    supervisor_pid=$(sed -n 's/.*"supervisorPid":[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$descriptor" | head -1)
    previous=
    target=
    for argument in "$@"; do
      if [ "$previous" = "-p" ]; then target=$argument; fi
      previous=$argument
    done
    if [ -n "$supervisor_pid" ] && [ "$target" = "$supervisor_pid" ]; then
      : >"$HEBBIAN_QA_TEST_SERVER_READINESS_OBSERVED"
    fi
  fi
fi
exec /bin/ps "$@"
`,
  );
  writeExecutable(
    frontTool,
    `#!/bin/sh
set -eu
case "\${1:-}" in
  front) printf 'fixture-front\n' ;;
  info)
    if [ "\${HEBBIAN_QA_TEST_BACKGROUND_FOCUS_OWNER:-owned}" = "owned" ]; then
      [ -s "$HEBBIAN_QA_TEST_PID_FILE" ] || exit 0
      printf 'pid = %s\n' "$(cat "$HEBBIAN_QA_TEST_PID_FILE")"
    else
      observed_parent=$(ps -o ppid= -p "$PPID" | tr -d ' ')
      printf 'pid = %s\n' "$observed_parent"
    fi
    ;;
esac
`,
  );

  writeExecutable(
    node,
    `#!/bin/sh
set -eu
if [ -n "\${HEBBIAN_QA_STATE_ROOT:-}" ] &&
  [ ! -f "$HEBBIAN_QA_TEST_STATE_ROOT_CAPTURE" ]; then
  printf '%s\\n' "$HEBBIAN_QA_STATE_ROOT" >"$HEBBIAN_QA_TEST_STATE_ROOT_CAPTURE"
fi
if [ "\${HEBBIAN_QA_TEST_LATE_PREFLIGHT_SKIP:-0}" = "1" ] &&
  [ "\${1##*/}" = "exclusive-focus-preflight.mjs" ]; then
  printf '%s\\n' '{"action":"skip","reason":"interactive_desktop_active"}'
  exit 20
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  { [ "\${2:-}" = "run" ] || [ "\${2:-}" = "run-observed" ] || [ "\${2:-}" = "run-contained" ]; }; then
  if [ -f "$HEBBIAN_QA_TEST_PROCESS_GROUP_DELAY_MARKER" ]; then
    sleep "$HEBBIAN_QA_TEST_PROCESS_GROUP_START_DELAY_SECONDS"
  else
    : >"$HEBBIAN_QA_TEST_PROCESS_GROUP_DELAY_MARKER"
  fi
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "inspect" ] &&
  [ "\${3##*/}" = "app-process-group.json" ]; then
  if "$HEBBIAN_QA_TEST_NODE" "$@"; then
    : >"$HEBBIAN_QA_TEST_APP_GROUP_INSPECTED"
    exit 0
  else
    exit $?
  fi
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "contains-live-pid" ] &&
  [ "\${HEBBIAN_QA_TEST_BACKGROUND_FOCUS_OBSERVATION_FAILURE:-0}" = "1" ]; then
  exit 97
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "freeze" ]; then
  : >"$HEBBIAN_QA_TEST_CLEANUP_BOUNDARY_MARKER"
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "freeze" ] &&
  [ "\${HEBBIAN_QA_TEST_FREEZE_FAILURE_AFTER_STOP:-0}" = "1" ] &&
  [ ! -f "$HEBBIAN_QA_TEST_FREEZE_FAILURE_MARKER" ]; then
  : >"$HEBBIAN_QA_TEST_FREEZE_FAILURE_MARKER"
  "$HEBBIAN_QA_TEST_NODE" "$@"
  rm -f "\${5:-}"
  exit 92
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "freeze" ] &&
  [ "\${HEBBIAN_QA_TEST_FREEZE_FAILURE:-0}" = "1" ]; then
  exit 96
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "freeze" ] &&
  [ "\${HEBBIAN_QA_TEST_CLIENT_FREEZE_FAILURE:-0}" = "1" ] &&
  [ "\${3##*/}" = "client-process-group.json" ]; then
  exit 93
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "terminate-frozen" ] &&
  [ "\${HEBBIAN_QA_TEST_FROZEN_TERMINATE_FAILURE:-0}" = "1" ]; then
  exit 95
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER" ] &&
  [ "\${2:-}" = "verify-exited" ] &&
  [ "\${HEBBIAN_QA_TEST_NONATOMIC_PROCESS_RECEIPT:-0}" = "1" ]; then
  receipt=$("$HEBBIAN_QA_TEST_NODE" "$@")
  printf '%s\n' "$receipt" | "$HEBBIAN_QA_TEST_NODE" -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const receipt = JSON.parse(input);
      receipt.capability = "exact_process_observation_v1";
      process.stdout.write(JSON.stringify(receipt) + "\\n");
    });
  '
  exit 0
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_HMUX_SESSION_CLEANUP_RUNNER" ] &&
  [ "\${2:-}" = "reap" ] &&
  [ "\${HEBBIAN_QA_TEST_HMUX_WAIT_FAILURE:-0}" = "1" ]; then
  exit 94
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_DURE_INSTALLER" ]; then
  printf '%s\\n%s\\n' \
    "$DURE_CLI_INSTALL_ROOT" \
    "$DURE_CLI_INSTALL_DIR" \
    >"$HEBBIAN_QA_TEST_DURE_INSTALL_CAPTURE"
  if "$HEBBIAN_QA_TEST_NODE" "$@"; then
    runner_marker_temp="${runnerPrepared}.$$"
    printf 'prepared\\n' >"\$runner_marker_temp"
    mv "\$runner_marker_temp" "${runnerPrepared}"
    exit 0
  else
    exit $?
  fi
fi
if [ "\${1:-}" = "$HEBBIAN_QA_TEST_HMUX_SESSION_CLEANUP_RUNNER" ] &&
  [ "\${2:-}" = "reap" ]; then
  fixture_pid=$(cat "$HEBBIAN_QA_TEST_PID_FILE" 2>/dev/null || true)
  if [ -n "$fixture_pid" ] && kill -0 "$fixture_pid" 2>/dev/null; then
    printf 'alive\\n' >>"$HEBBIAN_QA_TEST_HMUX_CLEANUP_CAPTURE"
  else
    printf 'stopped\\n' >>"$HEBBIAN_QA_TEST_HMUX_CLEANUP_CAPTURE"
  fi
fi
case "\${1:-}" in
  */tauri-app-launch.mjs)
    # Resolve the installed CLI from this fixture, never the real native binary.
    cd "${root}"
    ;;
esac
exec "$HEBBIAN_QA_TEST_NODE" "$@"
`,
  );
  // These cases validate the runner's isolated CLI install contract, not the
  // Rust build. A fixture-owned executable keeps concurrent cases from
  // sharing and corrupting one Cargo target while install paths stay real.
  writeExecutable(
    dureControlPlane,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "identity" ]; then
  printf '%s\\n' '${fixtureControlPlaneIdentity}'
fi
exit 0
`,
  );
  writeExecutable(dureClaudeProcessRelay, "#!/bin/sh\nexit 0\n");
  writeExecutable(hmuxCli, "#!/bin/sh\nexit 98\n");
  writeExecutable(hmuxRuntime, "#!/bin/sh\nexit 98\n");
  fs.writeFileSync(
    worker,
    `import fs from "node:fs";
const [, , pidFile, signalFile] = process.argv;
for (const signal of ["SIGHUP", "SIGTERM"]) {
  process.on(signal, () => fs.appendFileSync(signalFile, \`\${signal}\\n\`));
}
fs.writeFileSync(signalFile, "READY\\n");
fs.writeFileSync(pidFile, String(process.pid));
const autoExitMs = Number(process.env.HEBBIAN_QA_TEST_WORKER_AUTO_EXIT_MS);
if (Number.isSafeInteger(autoExitMs) && autoExitMs > 0) {
  setTimeout(() => process.exit(0), autoExitMs);
} else {
  setInterval(() => {}, 1_000);
}
`,
  );
  fs.writeFileSync(
    holder,
    `setInterval(() => {}, 1_000);
`,
  );
  fs.writeFileSync(
    lateGrandchild,
    `import fs from "node:fs";
import path from "node:path";
const startedAt = Date.now();
fs.writeFileSync(
  process.env.HEBBIAN_QA_TEST_LATE_GRANDCHILD_PID_FILE,
  String(process.pid),
);
// Keep publication later than the runner's bounded 60s cleanup even when the
// full gate delays observer work. The assertion below still requires this
// exact generation to exit, so a containment regression cannot pass by merely
// waiting out this timer.
await new Promise((resolve) => setTimeout(resolve, 120_000));
const directory = path.join(
  process.env.HMUX_DISCOVERY_ROOT,
  "late-workspace",
  "late-grandchild-session",
);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify({
    lifecycle: "starting",
    manifest: {
      common: {
        host_process: {
          process_id: process.pid,
          start_marker: \`\${process.pid}-\${startedAt}\`,
        },
      },
    },
  }),
);
fs.writeFileSync(process.env.HEBBIAN_QA_TEST_LATE_PUBLISH_MARKER, "published\\n");
await new Promise((resolve) => setTimeout(resolve, 100));
`,
  );
  fs.writeFileSync(
    latePublisher,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const startedAt = Date.now();
const originalParent = process.ppid;
for (const signal of ["SIGHUP", "SIGTERM"]) {
  process.on(signal, () => {
    fs.appendFileSync(process.env.HEBBIAN_QA_TEST_SIGNAL_FILE, \`\${signal}\\n\`);
    if (signal === "SIGTERM") {
      const child = spawn(
        process.execPath,
        [process.env.HEBBIAN_QA_TEST_LATE_GRANDCHILD],
        {
          detached: true,
          env: process.env,
          stdio: [
            "ignore",
            "ignore",
            "ignore",
            ...(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD
              ? [Number(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD)] : []),
          ],
        },
      );
      child.unref();
    }
  });
}
fs.writeFileSync(process.env.HEBBIAN_QA_TEST_SIGNAL_FILE, "READY\\n");
fs.writeFileSync(process.env.HEBBIAN_QA_TEST_PID_FILE, String(process.pid));
if (
  process.env.HEBBIAN_QA_TEST_MODE !== "fast-late-manifest" &&
  process.env.HEBBIAN_QA_TEST_MODE !== "fast-late-manifest-no-witness"
) {
  while (process.ppid === originalParent) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
} else {
  while (
    !fs.existsSync(process.env.HEBBIAN_QA_TEST_CLEANUP_BOUNDARY_MARKER)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// Keep publication later than the runner's bounded 60s cleanup even when the
// full gate delays observer work. The assertion below still requires this
// exact generation to exit, so a containment regression cannot pass by merely
// waiting out this timer.
await new Promise((resolve) => setTimeout(resolve, 120_000));
const directory = path.join(
  process.env.HMUX_DISCOVERY_ROOT,
  "late-workspace",
  "late-session",
);
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(
  path.join(directory, "manifest.json"),
  JSON.stringify({
    lifecycle: "starting",
    manifest: {
      common: {
        host_process: {
          process_id: process.pid,
          start_marker: \`\${process.pid}-\${startedAt}\`,
        },
      },
    },
  }),
);
fs.writeFileSync(process.env.HEBBIAN_QA_TEST_LATE_PUBLISH_MARKER, "published\\n");
await new Promise((resolve) => setTimeout(resolve, 100));
`,
  );
  fs.writeFileSync(
    latePublisherLauncher,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
const dropsWitness =
  process.env.HEBBIAN_QA_TEST_MODE === "fast-late-manifest-no-witness";
const child = spawn(process.execPath, [process.env.HEBBIAN_QA_TEST_LATE_PUBLISHER], {
  detached: true,
  env: process.env,
  stdio: dropsWitness
    ? "ignore"
    : [
        "ignore",
        "ignore",
        "ignore",
        ...(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD
          ? [Number(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD)] : []),
      ],
});
child.unref();
if (
  process.env.HEBBIAN_QA_TEST_MODE === "fast-late-manifest" ||
  dropsWitness
) {
  fs.writeFileSync(process.env.HEBBIAN_QA_TEST_PID_FILE, String(child.pid));
  process.exit(0);
}
const deadline = Date.now() + 3_000;
while (
  !fs.existsSync(process.env.HEBBIAN_QA_TEST_PID_FILE) &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await new Promise((resolve) => setTimeout(resolve, 800));
`,
  );
  fs.writeFileSync(
    client,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
fs.writeFileSync(
  process.env.HEBBIAN_QA_TEST_RUNNER_CONTROL_ENV_CAPTURE,
  JSON.stringify(
    Object.fromEntries(
      [
        "DURE_HMUX_BIN",
        "DURE_HMUX_RUNTIME_BIN",
        "DURE_QA_RUNNER_CANCEL_FILE",
        "DURE_QA_RUNNER_COMPLETION_RECEIPT",
        "DURE_QA_RUNNER_TIMEOUT_SECONDS",
        "HEBBIAN_HMUX_BIN",
        "HEBBIAN_HMUX_RUNTIME",
        "HEBBIAN_QA_RUNNER_CANCEL_FILE",
        "HEBBIAN_QA_RUNNER_COMPLETION_RECEIPT",
        "HEBBIAN_QA_RUNNER_TIMEOUT_SECONDS",
        "HMUX_RUNTIME",
      ].map((name) => [name, process.env[name] ?? null]),
    ),
  ),
);
const mode = process.env.HEBBIAN_QA_TEST_MODE;
const pidFile = process.env.HEBBIAN_QA_TEST_PID_FILE;
if (mode === "clean") {
  fs.writeFileSync(pidFile, String(process.pid));
}
if (
  mode === "app-server-readiness-delay" &&
  !fs.existsSync(process.env.DURE_QA_SERVER_DESCRIPTOR)
) {
  fs.writeFileSync(process.env.HEBBIAN_QA_TEST_CLIENT_STARTED, "started\\n");
  fs.writeFileSync(
    process.env.HEBBIAN_QA_TEST_CLIENT_READINESS_CHECKED,
    "descriptor-missing\\n",
  );
  process.exit(75);
}
if (mode === "client") {
  const child = spawn(
    process.execPath,
    [
      process.env.HEBBIAN_QA_TEST_WORKER,
      pidFile,
      process.env.HEBBIAN_QA_TEST_SIGNAL_FILE,
    ],
    { stdio: "ignore" },
  );
  child.unref();
}
if (mode === "client-late-manifest") {
  const launcher = spawn(
    process.execPath,
    [process.env.HEBBIAN_QA_TEST_LATE_PUBLISHER_LAUNCHER],
    {
      env: process.env,
      stdio: [
        "ignore",
        "ignore",
        "ignore",
        ...(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD
          ? [Number(process.env.HEBBIAN_QA_LIVENESS_WITNESS_FD)] : []),
      ],
    },
  );
  await new Promise((resolve, reject) => {
    launcher.once("error", reject);
    launcher.once("close", resolve);
  });
}
if (
  mode === "late-manifest" ||
  mode === "fast-late-manifest" ||
  mode === "fast-late-manifest-no-witness"
) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (mode === "signal") {
  setInterval(() => {}, 1_000);
}
const deadline = Date.now() + 3_000;
while (!fs.existsSync(pidFile) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (!fs.existsSync(pidFile)) process.exitCode = 72;
if (process.env.HEBBIAN_QA_TEST_CLIENT_EXIT_CODE) {
  process.exitCode = Number(process.env.HEBBIAN_QA_TEST_CLIENT_EXIT_CODE);
}
`,
  );
  writeExecutable(
    pnpm,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "hmux:runtime:stage:dev" ]; then
  exit 0
fi
echo "package manager unavailable in isolated HOME: $*" >&2
exit 74
`,
  );
  writeExecutable(
    tauri,
    `#!/bin/sh
set -eu
publish_server_descriptor() {
  mkdir -p "$(dirname "$DURE_QA_SERVER_DESCRIPTOR")"
  printf '{}\n' >"$DURE_QA_SERVER_DESCRIPTOR"
}
if [ "\${1:-}" = "dev" ]; then
  case "$HEBBIAN_QA_TEST_MODE" in
    app | app-readiness-delay | app-server-readiness-delay)
      if [ "$HEBBIAN_QA_TEST_MODE" = "app-server-readiness-delay" ]; then
        attempts=0
        while [ ! -f "$HEBBIAN_QA_TEST_SERVER_READINESS_OBSERVED" ] &&
          [ ! -f "$HEBBIAN_QA_TEST_CLIENT_STARTED" ]; do
          attempts=$((attempts + 1))
          [ "$attempts" -lt 3000 ] || exit 73
          sleep 0.01
        done
        if [ -f "$HEBBIAN_QA_TEST_CLIENT_STARTED" ]; then
          attempts=0
          while [ ! -f "$HEBBIAN_QA_TEST_CLIENT_READINESS_CHECKED" ]; do
            attempts=$((attempts + 1))
            [ "$attempts" -lt 3000 ] || exit 73
            sleep 0.01
          done
        fi
      fi
      publish_server_descriptor
      "$HEBBIAN_QA_TEST_NODE" \
        "$HEBBIAN_QA_TEST_WORKER" \
        "$HEBBIAN_QA_TEST_PID_FILE" \
        "$HEBBIAN_QA_TEST_SIGNAL_FILE" &
      attempts=0
      while [ ! -s "$HEBBIAN_QA_TEST_PID_FILE" ]; do
        attempts=$((attempts + 1))
        [ "$attempts" -lt 300 ] || exit 73
        sleep 0.01
      done
      exit 0
      ;;
    background-focus-startup)
      "$HEBBIAN_QA_TEST_NODE" \
        "$HEBBIAN_QA_TEST_WORKER" \
        "$HEBBIAN_QA_TEST_PID_FILE" \
        "$HEBBIAN_QA_TEST_SIGNAL_FILE" &
      attempts=0
      while [ ! -s "$HEBBIAN_QA_TEST_PID_FILE" ]; do
        attempts=$((attempts + 1))
        [ "$attempts" -lt 300 ] || exit 73
        sleep 0.01
      done
      sleep 1
      publish_server_descriptor
      wait
      ;;
    late-manifest | fast-late-manifest | fast-late-manifest-no-witness)
      publish_server_descriptor
      exec "$HEBBIAN_QA_TEST_NODE" "$HEBBIAN_QA_TEST_LATE_PUBLISHER_LAUNCHER"
      ;;
    clean | client | client-late-manifest)
      publish_server_descriptor
      exec "$HEBBIAN_QA_TEST_NODE" "$HEBBIAN_QA_TEST_HOLDER"
      ;;
    signal)
      sleep "$HEBBIAN_QA_TEST_START_DELAY_SECONDS"
      publish_server_descriptor
      "$HEBBIAN_QA_TEST_NODE" \
        "$HEBBIAN_QA_TEST_WORKER" \
        "$HEBBIAN_QA_TEST_PID_FILE" \
        "$HEBBIAN_QA_TEST_SIGNAL_FILE" &
      wait
      ;;
  esac
fi
echo "unexpected Tauri invocation: $*" >&2
exit 74
`,
  );

  return {
    appGroupInspected,
    artifacts,
    bin,
    client,
    clientReadinessChecked,
    clientStarted,
    cleanupBoundaryMarker,
    dureControlPlane,
    dureInstallCapture,
    dureInstaller,
    holder,
    hmuxCleanupCapture,
    hmuxCli,
    hmuxRuntime,
    hmuxSessionCleanupRunner,
    launchOwnerFailureMarker,
    launchOwnerGuardRootCapture,
    lateGrandchild,
    lateGrandchildPidFile,
    latePublishMarker,
    latePublisher,
    latePublisherLauncher,
    mode,
    pidFile,
    pipeReleaseFile,
    pipeWriteFile,
    ps,
    freezeFailureMarker,
    frontTool,
    processGroupDelayMarker,
    runnerPrepared,
    runnerControlEnvCapture,
    root,
    serverReadinessObserved,
    signalFile,
    stateRootCapture,
    tauriLaunchCapture,
    worker,
  };
}

function runnerOptions(
  fixture,
  clientExitCode = "",
  {
    clientFreezeFailure = false,
    freezeFailure = false,
    freezeFailureAfterStop = false,
    frozenTerminateFailure = false,
    hmuxWaitFailure = false,
    latePreflightSkip = false,
    launchOwnerCleanupGraceMs = "6000",
    legacyRunnerEnvironment = false,
    ambientRootRetirementCapability = false,
    backgroundFocusDuringStartup = false,
    backgroundFocusObservationFailure = false,
    backgroundFocusOwner = "owned",
    layer = "process_cleanup",
    nonAtomicProcessReceipt = false,
    requireExecution = false,
    runnerCancelFile,
    runnerCompletionReceipt,
    runnerTimeoutSeconds,
  } = {},
) {
  const inheritedEnvironment = { ...process.env };
  const runnerInputSuffixes = [
    "ARTIFACT_NAME",
    "ARTIFACT_ROOT",
    "CLIENT",
    "HMUX_CLI",
    "HMUX_RUNTIME",
    "LAYER",
    "LAUNCH_OWNER_CLEANUP_GRACE_MS",
    "LAUNCH_OWNER_KILL_GRACE_MS",
    "LAUNCH_OWNER_POLL_MS",
    "NAME",
    "PROCESS_KILL_GRACE_MS",
    "PROCESS_TERM_GRACE_MS",
    "REQUIRE_EXECUTION",
    "ROOT_RETIREMENT_CAPABILITY",
    "RUNNER_CANCEL_FILE",
    "RUNNER_COMPLETION_RECEIPT",
    "RUNNER_TIMEOUT_SECONDS",
  ];
  for (const prefix of ["DURE_QA", "HEBBIAN_QA"]) {
    for (const suffix of runnerInputSuffixes) {
      delete inheritedEnvironment[`${prefix}_${suffix}`];
    }
  }
  const qaPrefix = legacyRunnerEnvironment ? "HEBBIAN_QA" : "DURE_QA";
  const runnerEnvironment = {
    [`${qaPrefix}_ARTIFACT_NAME`]: `process-cleanup-${fixture.mode}`,
    [`${qaPrefix}_ARTIFACT_ROOT`]: fixture.artifacts,
    [`${qaPrefix}_CLIENT`]: fixture.client,
    [`${qaPrefix}_HMUX_CLI`]: fixture.hmuxCli,
    [`${qaPrefix}_HMUX_RUNTIME`]: fixture.hmuxRuntime,
    [`${qaPrefix}_LAYER`]: layer,
    [`${qaPrefix}_NAME`]: `process cleanup ${fixture.mode} fixture`,
    [`${qaPrefix}_PROCESS_KILL_GRACE_MS`]: "1000",
    // Keep TERM-to-KILL escalation covered without making a loaded Node
    // signal callback race an unrealistically short test-only deadline.
    [`${qaPrefix}_PROCESS_TERM_GRACE_MS`]: "1000",
    ...(requireExecution
      ? { [`${qaPrefix}_REQUIRE_EXECUTION`]: "1" }
      : {}),
    ...(ambientRootRetirementCapability
      ? {
          [`${qaPrefix}_ROOT_RETIREMENT_CAPABILITY`]:
            "hard_process_containment_v1",
        }
      : {}),
    ...(runnerCancelFile
      ? { [`${qaPrefix}_RUNNER_CANCEL_FILE`]: runnerCancelFile }
      : {}),
    ...(runnerCompletionReceipt
      ? {
          [`${qaPrefix}_RUNNER_COMPLETION_RECEIPT`]:
            runnerCompletionReceipt,
        }
      : {}),
    ...(runnerTimeoutSeconds
      ? { [`${qaPrefix}_RUNNER_TIMEOUT_SECONDS`]: runnerTimeoutSeconds }
      : {}),
  };
  return {
    cwd: path.resolve(directory, "../../.."),
    encoding: "utf8",
    env: {
      ...inheritedEnvironment,
      ...runnerEnvironment,
      DURE_CONTROL_PLANE_BIN: fixture.dureControlPlane,
      HEBBIAN_HMUX_BIN: path.join(fixture.root, "ambient-hmux"),
      HEBBIAN_QA_TEST_APP_GROUP_INSPECTED: fixture.appGroupInspected,
      HEBBIAN_QA_TEST_BACKGROUND_FOCUS_OBSERVATION_FAILURE:
        backgroundFocusObservationFailure ? "1" : "0",
      HEBBIAN_QA_TEST_CLIENT_EXIT_CODE: clientExitCode,
      HEBBIAN_QA_TEST_CLIENT_READINESS_CHECKED:
        fixture.clientReadinessChecked,
      HEBBIAN_QA_TEST_CLIENT_STARTED: fixture.clientStarted,
      HEBBIAN_QA_TEST_CLEANUP_BOUNDARY_MARKER:
        fixture.cleanupBoundaryMarker,
      HEBBIAN_QA_TEST_CLIENT_FREEZE_FAILURE:
        clientFreezeFailure ? "1" : "0",
      HEBBIAN_QA_TEST_DURE_INSTALL_CAPTURE: fixture.dureInstallCapture,
      HEBBIAN_QA_TEST_DURE_INSTALLER: fixture.dureInstaller,
      HEBBIAN_QA_TEST_FREEZE_FAILURE: freezeFailure ? "1" : "0",
      HEBBIAN_QA_TEST_FREEZE_FAILURE_AFTER_STOP:
        freezeFailureAfterStop ? "1" : "0",
      HEBBIAN_QA_TEST_FREEZE_FAILURE_MARKER: fixture.freezeFailureMarker,
      ...(backgroundFocusDuringStartup
        ? {
            DURE_QA_TEST_FRONT_TOOL: fixture.frontTool,
            HEBBIAN_QA_TEST_BACKGROUND_FOCUS_OWNER: backgroundFocusOwner,
          }
        : {}),
      HEBBIAN_QA_TEST_FROZEN_TERMINATE_FAILURE:
        frozenTerminateFailure ? "1" : "0",
      HEBBIAN_QA_TEST_HOLDER: fixture.holder,
      HEBBIAN_QA_TEST_HMUX_CLEANUP_CAPTURE: fixture.hmuxCleanupCapture,
      HEBBIAN_QA_TEST_HMUX_SESSION_CLEANUP_RUNNER:
        fixture.hmuxSessionCleanupRunner,
      HEBBIAN_QA_TEST_HMUX_WAIT_FAILURE: hmuxWaitFailure ? "1" : "0",
      HEBBIAN_QA_TEST_LAUNCH_OWNER_FAILURE_MARKER:
        fixture.launchOwnerFailureMarker,
      HEBBIAN_QA_TEST_LAUNCH_OWNER_GUARD_ROOT_CAPTURE:
        fixture.launchOwnerGuardRootCapture,
      HEBBIAN_QA_TEST_LATE_GRANDCHILD: fixture.lateGrandchild,
      HEBBIAN_QA_TEST_LATE_GRANDCHILD_PID_FILE:
        fixture.lateGrandchildPidFile,
      HEBBIAN_QA_TEST_LATE_PUBLISHER: fixture.latePublisher,
      HEBBIAN_QA_TEST_LATE_PUBLISHER_LAUNCHER:
        fixture.latePublisherLauncher,
      HEBBIAN_QA_TEST_LATE_PUBLISH_MARKER: fixture.latePublishMarker,
      HEBBIAN_QA_TEST_LATE_PREFLIGHT_SKIP:
        latePreflightSkip ? "1" : "0",
      HEBBIAN_QA_TEST_MODE: fixture.mode,
      HEBBIAN_QA_TEST_NONATOMIC_PROCESS_RECEIPT:
        nonAtomicProcessReceipt ? "1" : "0",
      HEBBIAN_QA_TEST_NODE: process.execPath,
      HEBBIAN_QA_TEST_PID_FILE: fixture.pidFile,
      HEBBIAN_QA_TEST_PROCESS_GROUP_DELAY_MARKER:
        fixture.processGroupDelayMarker,
      HEBBIAN_QA_TEST_PROCESS_GROUP_RUNNER: processGroupRunner,
      HEBBIAN_QA_TEST_PROCESS_GROUP_START_DELAY_SECONDS:
        fixture.mode === "app-readiness-delay"
          ? "10"
          : fixture.mode === "background-focus-startup"
            ? "1"
            : "0",
      HEBBIAN_QA_TEST_SERVER_READINESS_OBSERVED:
        fixture.serverReadinessObserved,
      HEBBIAN_QA_TEST_SIGNAL_FILE: fixture.signalFile,
      // Reproduce a loaded full-suite scheduler: the old fixed 3s readiness
      // wait failed before this otherwise healthy process group became ready.
      HEBBIAN_QA_TEST_START_DELAY_SECONDS:
        fixture.mode === "signal" ? "4" : "0",
      HEBBIAN_QA_TEST_STATE_ROOT_CAPTURE: fixture.stateRootCapture,
      HEBBIAN_QA_TEST_RUNNER_CONTROL_ENV_CAPTURE:
        fixture.runnerControlEnvCapture,
      HEBBIAN_QA_TEST_WORKER: fixture.worker,
      HEBBIAN_QA_TEST_WORKER_AUTO_EXIT_MS: "5000",
      DURE_QA_LAUNCH_OWNER_CLEANUP_GRACE_MS:
        launchOwnerCleanupGraceMs,
      DURE_QA_LAUNCH_OWNER_KILL_GRACE_MS: "1000",
      DURE_QA_LAUNCH_OWNER_POLL_MS: "20",
      PATH: `${fixture.bin}:${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  };
}

function assertIsolatedDureCliPrepared(fixture) {
  const [installRoot, commandDirectory] = fs
    .readFileSync(fixture.dureInstallCapture, "utf8")
    .trim()
    .split("\n");
  const normalizedInstallRoot = path.resolve(installRoot);
  const isolatedHome = path.resolve(normalizedInstallRoot, "../../..");
  expect(normalizedInstallRoot).toBe(
    path.join(isolatedHome, ".local", "share", "hebbian-ide-cli"),
  );
  expect(path.resolve(commandDirectory)).toBe(
    path.join(isolatedHome, ".local", "bin"),
  );
  expect(isolatedHome).not.toBe(os.homedir());
}

function assertRunnerControlEnvironmentScrubbed(fixture) {
  expect(
    JSON.parse(fs.readFileSync(fixture.runnerControlEnvCapture, "utf8")),
  ).toEqual({
    DURE_HMUX_BIN: fixture.hmuxCli,
    DURE_HMUX_RUNTIME_BIN: fixture.hmuxRuntime,
    DURE_QA_RUNNER_CANCEL_FILE: null,
    DURE_QA_RUNNER_COMPLETION_RECEIPT: null,
    DURE_QA_RUNNER_TIMEOUT_SECONDS: null,
    HEBBIAN_HMUX_BIN: null,
    HEBBIAN_HMUX_RUNTIME: null,
    HEBBIAN_QA_RUNNER_CANCEL_FILE: null,
    HEBBIAN_QA_RUNNER_COMPLETION_RECEIPT: null,
    HEBBIAN_QA_RUNNER_TIMEOUT_SECONDS: null,
    HMUX_RUNTIME: null,
  });
}

async function assertFixtureDescendantStopped(
  fixture,
  {
    expectHmuxCapture = "stopped",
    expectTerm = false,
    ownedGenerations = Promise.resolve(null),
  } = {},
) {
  const pid = readReadyPid(fixture.pidFile);
  expect(pid).not.toBeNull();
  fixturePids.add(pid);
  let exited = await waitUntil(() => !processExists(pid), 6_000);
  if (!exited && (await ownedGenerations)) {
    // numeric-pid가 계속 "생존"으로 보이면 PID 재사용일 수 있다 — 캡처된
    // exact 세대 전멸(커널 marker 기반, 재사용 면역)을 권위 판정으로 쓴다.
    // 세대가 하나라도 살아 있으면 기존 메시지로 실패한다(W2).
    const captured = await ownedGenerations;
    exited = await waitUntil(
      () => exactFixtureGenerationsExited(captured),
      6_000,
    );
  }
  expect(exited, `fixture descendant ${pid} remained alive`).toBe(true);
  fixturePids.delete(pid);
  if (expectTerm) {
    expect(fs.readFileSync(fixture.signalFile, "utf8")).toContain("SIGTERM");
  }
  if (expectHmuxCapture !== null) {
    const cleanupStates = fs
      .readFileSync(fixture.hmuxCleanupCapture, "utf8")
      .trim()
      .split("\n");
    expect(cleanupStates.at(-1)).toBe(expectHmuxCapture);
  }
}

function startUnrelatedProcess(fixture) {
  const running = startTracked(process.execPath, [fixture.holder], {
    detached: true,
    stdio: "ignore",
  });
  const { child } = running;
  child.unref();
  expect(Number.isSafeInteger(child.pid) && child.pid > 1).toBe(true);
  return child.pid;
}

async function assertUnrelatedProcessUntouched(pid) {
  expect(processExists(pid)).toBe(true);
  const running = fixtureProcesses.get(pid);
  expect(running).toBeDefined();
  await stopStartedRunner(running);
  // exit 이벤트 성취(위)가 직계 child의 종료 증명이다 — 사후 numeric 재확인은
  // PID 재사용 시 무관 프로세스를 "생존"으로 오판한다(동계열 창, 재설계 문서).
  fixturePids.delete(pid);
  fixtureProcesses.delete(pid);
}

function readFixtureOwnedGenerations(stateRoot) {
  return ["app", "client"].map((name) => {
    const descriptorPath = path.join(
      stateRoot,
      `${name}-process-group.json`,
    );
    const published = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    const descriptor = readOwnedProcessGroup(
      descriptorPath,
      published.supervisorPid,
    );
    return {
      processes: [
        ...readOwnedProcessLedger(descriptor),
        {
          kernelStartMarker: descriptor.supervisorKernelStartMarker,
          pid: descriptor.supervisorPid,
          startMarker: descriptor.supervisorStartMarker,
        },
      ].map(exactOwnedProcessIdentity),
    };
  });
}

function exactFixtureGenerationsExited(ownedGenerations) {
  const identities = ownedGenerations.flatMap(({ processes }) => processes);
  return allProcessIdentitiesDeparted(identities);
}

/** 러너 수명 중 descriptor+ledger가 읽히는 순간을 폴링으로 잡아 exact 세대를
 *  캡처한다 — 베스트에포트(null 가능): fast/clean 모드에서는 러너 수명과
 *  경쟁하므로 실패가 정상이고, 그 경우 호출부는 현행 numeric-pid 판정을
 *  유지한다(재설계 조건 2 — 하드 expect 금지). 파일 읽기만 하므로 동시
 *  픽스처의 이벤트 루프를 굶기지 않는다. */
function captureFixtureGenerationsDuringRun(fixture, timeoutMs = 8_000) {
  return (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(fixture.stateRootCapture)) {
          const stateRoot = fs
            .readFileSync(fixture.stateRootCapture, "utf8")
            .trim();
          if (stateRoot) {
            const captured = readFixtureOwnedGenerations(stateRoot);
            if (captured.every(({ processes }) => processes.length > 0)) {
              return captured;
            }
          }
        }
      } catch {
        // ENOENT·부분 기록 등 — 다음 시도에서 다시 본다.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  })();
}

function captureFixturePidOwnershipDuringRun(fixture, attempts = 800) {
  return (async () => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (fs.existsSync(fixture.stateRootCapture)) {
          const stateRoot = fs
            .readFileSync(fixture.stateRootCapture, "utf8")
            .trim();
          const fixturePid = readReadyPid(fixture.pidFile);
          if (
            stateRoot &&
            fixturePid !== null &&
            readFixtureOwnedGenerations(stateRoot).some(({ processes }) =>
              processes.some(({ pid }) => pid === fixturePid),
            )
          ) {
            return true;
          }
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  })();
}

async function runCleanupFixture(
  mode,
  {
    clientFreezeFailure = false,
    clientExitCode = "",
    completionTimeoutMs = RUNNER_COMPLETION_TIMEOUT_MS,
    expectedHmuxCapture,
    expectedSignal = null,
    expectedStatus = 0,
    expectedStderr,
    freezeFailure = false,
    freezeFailureAfterStop = false,
    frozenTerminateFailure = false,
    hmuxWaitFailure = false,
    incompleteReceiptsPreserved = false,
    latePreflightSkip = false,
    launchOwnerFailure = false,
    launchOwnerCleanupGraceMs = "6000",
    legacyRunnerEnvironment = false,
    preservedState = false,
    ambientRootRetirementCapability = false,
    backgroundFocusDuringStartup = false,
    backgroundFocusObservationFailure = false,
    backgroundFocusOwner = "owned",
    layer = "process_cleanup",
    nonAtomicProcessReceipt = false,
    requireExecution = false,
    expectCompletionReceipt,
    verifiedPreClientPreservation = false,
    verifiedPreservation = !preservedState,
    assertHmuxRuntimeSelection = false,
  } = {},
) {
  const fixture = createFixture(mode);
  const completionReceiptPath =
    expectCompletionReceipt === undefined
      ? undefined
      : path.join(fixture.root, "runner-completion.json");
  const unrelatedPid = startUnrelatedProcess(fixture);
  const ownedGenerationCapture = captureFixtureGenerationsDuringRun(fixture);
  const fixturePidOwnershipCapture =
    mode.includes("late-manifest")
      ? captureFixturePidOwnershipDuringRun(fixture)
      : Promise.resolve(false);
  const running = startTracked(
    "sh",
    [runner],
    runnerOptions(fixture, clientExitCode, {
      freezeFailure,
      freezeFailureAfterStop,
      frozenTerminateFailure,
      hmuxWaitFailure,
      clientFreezeFailure,
      latePreflightSkip,
      launchOwnerCleanupGraceMs,
      legacyRunnerEnvironment,
      ambientRootRetirementCapability,
      backgroundFocusDuringStartup,
      backgroundFocusObservationFailure,
      backgroundFocusOwner,
      layer,
      nonAtomicProcessReceipt,
      requireExecution,
      runnerCompletionReceipt: completionReceiptPath,
    }),
  );
  let failure;
  let ownedGenerations = [];
  try {
    if (launchOwnerFailure) {
      expect(
        await waitUntil(() => {
          if (
            !fs.existsSync(fixture.launchOwnerGuardRootCapture) ||
            !fs.existsSync(fixture.stateRootCapture)
          ) {
            return false;
          }
          const stateRoot = fs
            .readFileSync(fixture.stateRootCapture, "utf8")
            .trim();
          const guardRoot = fs
            .readFileSync(fixture.launchOwnerGuardRootCapture, "utf8")
            .trim();
          if (
            !fs.existsSync(path.join(guardRoot, "runner-owner.json")) ||
            !fs.existsSync(path.join(stateRoot, "app-process-group.json")) ||
            !fs.existsSync(path.join(stateRoot, "client-process-group.json")) ||
            readReadyPid(fixture.pidFile) === null
          ) {
            return false;
          }
          try {
            const captured = readFixtureOwnedGenerations(stateRoot);
            const fixturePid = readReadyPid(fixture.pidFile);
            if (
              captured.some(({ processes }) => processes.length < 3) ||
              !captured.some(({ processes }) =>
                processes.some(({ pid }) => pid === fixturePid),
              )
            ) {
              return false;
            }
            ownedGenerations = captured;
            return true;
          } catch (error) {
            if (error?.code === "ENOENT") return false;
            throw error;
          }
        }, FIXTURE_START_TIMEOUT_MS),
      ).toBe(true);
      const guardRoot = fs
        .readFileSync(fixture.launchOwnerGuardRootCapture, "utf8")
        .trim();
      temporaryDirectories.push(guardRoot);
      const guardDescriptor = JSON.parse(
        fs.readFileSync(
          path.join(guardRoot, "runner-owner.json"),
          "utf8",
        ),
      );
      expect(guardDescriptor.runner.pid).toBe(running.child.pid);
      expect(guardDescriptor.runner.processIdentity).toMatch(
        /^kernel-start-v3:macos:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/u,
      );
      expect(guardDescriptor.schemaVersion).toBe(2);
      fs.writeFileSync(fixture.launchOwnerFailureMarker, "injected\n", {
        flag: "wx",
        mode: 0o600,
      });
    }
    const preparation = await waitForRunnerPreparation(
      running,
      fixture.runnerPrepared,
      RUNNER_PREPARATION_TIMEOUT_MS,
    );
    if (preparation.state === "timed_out") {
      throw new Error(
        `fixture runner preparation did not finish within ${RUNNER_PREPARATION_TIMEOUT_MS}ms`,
      );
    }
    const result = await waitForRunner(
      running,
      completionTimeoutMs,
      RUNNER_TERMINATION_TIMEOUT_MS,
      // 내용 의존 단언(expectedStderr·state root regex)이 있으면 pipe 보유
      // 픽스처의 close(worker auto-exit 5s)까지 기다린다 — 부하에서 stderr
      // 꼬리가 잘려 refusal 단언이 플레이크했다(게이트 실측 23:44).
      expectedStderr ? 8_000 : RUNNER_STDIO_DRAIN_GRACE_MS,
    );
    if (result.status !== expectedStatus) {
      throw new Error(
        `fixture runner exited ${result.status} (${result.signal}):\n` +
          `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    }
    expect(result.signal).toBe(expectedSignal);
    if (expectCompletionReceipt !== undefined) {
      expect(fs.existsSync(completionReceiptPath)).toBe(
        expectCompletionReceipt,
      );
    }
    if (launchOwnerFailure) {
      expect(
        await waitUntil(
          () => exactFixtureGenerationsExited(ownedGenerations),
          10_000,
        ),
        "an exact app, client, Host, or supervisor generation survived launch-owner cleanup",
      ).toBe(true);
      const guardRoot = fs
        .readFileSync(fixture.launchOwnerGuardRootCapture, "utf8")
        .trim();
      if (expectedSignal === null) {
        expect(fs.existsSync(guardRoot)).toBe(false);
      } else {
        const guardDescriptor = JSON.parse(
          fs.readFileSync(
            path.join(guardRoot, "runner-owner.json"),
            "utf8",
          ),
        );
        expect(
          await waitUntil(
            () =>
              processLivenessFromObservation(
                guardDescriptor.guard,
                processMemberSnapshots([guardDescriptor.guard.pid]),
              ) === "stale",
            3_000,
          ),
          "launch-owner guard remained alive after exact runner cleanup",
        ).toBe(true);
      }
    }
    if (expectedStderr) {
      const output = `${result.stdout}\n${result.stderr}`;
      const expectedFragments = Array.isArray(expectedStderr)
        ? expectedStderr
        : [expectedStderr];
      expect(
        expectedFragments.some((fragment) => output.includes(fragment)),
        `expected output to contain one safe refusal: ${expectedFragments.join(" | ")}`,
      ).toBe(true);
    }
    assertIsolatedDureCliPrepared(fixture);
    if (assertHmuxRuntimeSelection) {
      assertRunnerControlEnvironmentScrubbed(fixture);
    }
    if (frozenTerminateFailure) {
      const frozenPid = readReadyPid(fixture.pidFile);
      expect(frozenPid).not.toBeNull();
      if (processExists(frozenPid)) fixturePids.add(frozenPid);
    } else {
      await assertFixtureDescendantStopped(fixture, {
        expectHmuxCapture:
          expectedHmuxCapture ??
          (preservedState ? null : "stopped"),
        ownedGenerations: ownedGenerationCapture,
      });
    }
    if (
      mode === "late-manifest" ||
      mode === "client-late-manifest" ||
      mode === "fast-late-manifest" ||
      mode === "fast-late-manifest-no-witness"
    ) {
      expect(fs.existsSync(fixture.lateGrandchildPidFile)).toBe(false);
      const publisherPid = readReadyPid(fixture.pidFile);
      expect(publisherPid).not.toBeNull();
      expect(
        await fixturePidOwnershipCapture,
        "contained publisher generation was not recorded in an ownership ledger",
      ).toBe(true);
      expect(
        await waitUntil(() => !processExists(publisherPid), 3_000),
      ).toBe(true);
      expect(fs.existsSync(fixture.latePublishMarker)).toBe(false);
    }
    let stateRoot;
    if (expectedSignal !== null) {
      stateRoot = fs.readFileSync(fixture.stateRootCapture, "utf8").trim();
      expect(fs.lstatSync(stateRoot).isDirectory()).toBe(true);
      temporaryDirectories.push(stateRoot);
    } else if (incompleteReceiptsPreserved) {
      const match = result.stderr.match(
        /incomplete cleanup capability receipts; preserving (.+)$/mu,
      );
      expect(match).not.toBeNull();
      stateRoot = match[1].trim();
      expect(fs.lstatSync(stateRoot).isDirectory()).toBe(true);
      temporaryDirectories.push(stateRoot);
    } else if (verifiedPreClientPreservation) {
      const match = result.stderr.match(
        /cleanup verified before client startup; preserving (.+)$/mu,
      );
      expect(match).not.toBeNull();
      expect(result.stderr).not.toContain(
        "incomplete cleanup capability receipts",
      );
      stateRoot = match[1].trim();
      expect(fs.lstatSync(stateRoot).isDirectory()).toBe(true);
      expect(
        fs.existsSync(path.join(stateRoot, "client-process-group.json")),
      ).toBe(false);
      expect(fs.existsSync(fixture.clientStarted)).toBe(false);
      temporaryDirectories.push(stateRoot);
    } else if (preservedState || verifiedPreservation) {
      const match = result.stderr.match(
        verifiedPreservation
          ? /cleanup verified without generation-atomic process containment; preserving (.+)$/mu
          : /cleanup ownership is uncertain; preserving (.+)$/mu,
      );
      expect(match).not.toBeNull();
      stateRoot = match[1].trim();
      expect(fs.lstatSync(stateRoot).isDirectory()).toBe(true);
      temporaryDirectories.push(stateRoot);
    } else {
      const match = result.stderr.match(
        /cleanup verified; retired isolated root (.+)$/mu,
      );
      expect(match).not.toBeNull();
      stateRoot = match[1].trim();
      expect(fs.existsSync(stateRoot)).toBe(false);
    }
    if (assertHmuxRuntimeSelection) {
      expect(stateRoot).toBe(fs.realpathSync(stateRoot));
    }
    await assertUnrelatedProcessUntouched(unrelatedPid);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupFixtureProcesses(running, fixture, unrelatedPid, {
      frozenTerminateFailure,
    });
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError(
        [failure, cleanupError],
        "fixture failed and cleanup was incomplete",
      );
    }
    throw cleanupError;
  }
  if (failure) throw failure;
  return fixture;
}

async function runSignalFixture() {
  const fixture = createFixture("signal");
  const unrelatedPid = startUnrelatedProcess(fixture);
  const running = startTracked("sh", [runner], runnerOptions(fixture));
  let failure;
  try {
    const ready = await waitUntil(
      () => readReadyPid(fixture.pidFile) !== null,
      FIXTURE_START_TIMEOUT_MS,
    );
    if (!ready) {
      throw new Error(
        `fixture runner did not become ready within ${FIXTURE_START_TIMEOUT_MS}ms`,
      );
    }
    running.child.kill("SIGTERM");
    const result = await waitForRunner(running);
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(143);
    assertIsolatedDureCliPrepared(fixture);
    await assertFixtureDescendantStopped(fixture);
    const preserved = result.stderr.match(
      /(?:cleanup verified without generation-atomic process containment|incomplete cleanup capability receipts); preserving (.+)$/mu,
    );
    expect(preserved, result.stderr).not.toBeNull();
    const stateRoot = preserved[1].trim();
    expect(fs.lstatSync(stateRoot).isDirectory()).toBe(true);
    temporaryDirectories.push(stateRoot);
    await assertUnrelatedProcessUntouched(unrelatedPid);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupFixtureProcesses(running, fixture, unrelatedPid);
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError(
        [failure, cleanupError],
        "fixture failed and cleanup was incomplete",
      );
    }
    throw cleanupError;
  }
  if (failure) throw failure;
}

async function runCancellationFixture() {
  const fixture = createFixture("signal");
  const cancelPath = path.join(fixture.root, "runner.cancel");
  const completionPath = path.join(fixture.root, "runner-completion.json");
  const unrelatedPid = startUnrelatedProcess(fixture);
  const ownedGenerationCapture = captureFixtureGenerationsDuringRun(
    fixture,
    FIXTURE_START_TIMEOUT_MS,
  );
  const running = startTracked(
    "sh",
    [runner],
    runnerOptions(fixture, "", {
      runnerCancelFile: cancelPath,
      runnerCompletionReceipt: completionPath,
    }),
  );
  let failure;
  try {
    const ownedGenerations = await ownedGenerationCapture;
    expect(
      ownedGenerations,
      `app and client exact generations were not captured before cancellation: ${JSON.stringify(running.capture())}`,
    ).not.toBeNull();
    expect(
      await waitUntil(() => {
        if (!fs.existsSync(fixture.launchOwnerGuardRootCapture)) return false;
        const guardRoot = fs
          .readFileSync(fixture.launchOwnerGuardRootCapture, "utf8")
          .trim();
        return fs.existsSync(path.join(guardRoot, "runner-owner.json"));
      }, FIXTURE_START_TIMEOUT_MS),
    ).toBe(true);
    const guardRoot = fs
      .readFileSync(fixture.launchOwnerGuardRootCapture, "utf8")
      .trim();
    temporaryDirectories.push(guardRoot);
    const guardDescriptor = JSON.parse(
      fs.readFileSync(path.join(guardRoot, "runner-owner.json"), "utf8"),
    );
    expect(fs.existsSync(completionPath)).toBe(false);
    fs.writeFileSync(cancelPath, "", { flag: "wx", mode: 0o600 });
    expect(
      await waitUntil(
        () => fs.existsSync(fixture.cleanupBoundaryMarker),
        15_000,
      ),
      "runner cleanup did not reach the process ownership boundary",
    ).toBe(true);
    expect(running.child.kill("SIGHUP")).toBe(true);

    let receiptWasEarly = false;
    expect(
      await waitUntil(() => {
        const generationsExited =
          exactFixtureGenerationsExited(ownedGenerations);
        const guardExited =
          processLivenessFromObservation(
            guardDescriptor.guard,
            processMemberSnapshots([guardDescriptor.guard.pid]),
          ) === "stale";
        const receiptExists = fs.existsSync(completionPath);
        if (receiptExists && (!generationsExited || !guardExited)) {
          receiptWasEarly = true;
        }
        return receiptExists && generationsExited && guardExited;
      }, 15_000),
      "runner completion was not published after exact subtree and guard cleanup",
    ).toBe(true);
    expect(receiptWasEarly).toBe(false);
    expect(JSON.parse(fs.readFileSync(completionPath, "utf8"))).toEqual(
      verifiedRunnerCompletion,
    );
    expect(fs.existsSync(fixture.cleanupBoundaryMarker)).toBe(true);
    assertRunnerControlEnvironmentScrubbed(fixture);

    const result = await waitForRunner(running);
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(129);
    const preserved = result.stderr.match(
      /(?:cleanup verified without generation-atomic process containment|incomplete cleanup capability receipts); preserving (.+)$/mu,
    );
    expect(preserved, result.stderr).not.toBeNull();
    temporaryDirectories.push(preserved[1].trim());
    assertIsolatedDureCliPrepared(fixture);
    await assertFixtureDescendantStopped(fixture, {
      ownedGenerations: Promise.resolve(ownedGenerations),
    });
    await assertUnrelatedProcessUntouched(unrelatedPid);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupFixtureProcesses(running, fixture, unrelatedPid);
  } catch (cleanupError) {
    if (failure) {
      throw new AggregateError(
        [failure, cleanupError],
        "cancellation fixture failed and cleanup was incomplete",
      );
    }
    throw cleanupError;
  }
  if (failure) throw failure;
}

// Two isolated roots overlap their process waits without recreating the
// unbounded spawn pressure that originally made this suite flaky.
const boundedFixtures = createBoundedConcurrentTests(test, 2);
const exclusiveFixtureTest = boundedFixtures.exclusiveTest;
const fixtureCases = boundedFixtures.each;
const fixtureTest = boundedFixtures.test;

afterAll(async () => {
  boundedFixtures.assertIdle();
  // Each entry has an exact child handle and an independent fixture root.
  // Clean them concurrently so bounded termination waits do not stack.
  const cleanupErrors = (
    await Promise.all(
      [...fixtureProcesses.entries()].map(async ([pid, running]) => {
        try {
          await stopStartedRunner(running, RUNNER_TERMINATION_TIMEOUT_MS, 2);
          await waitForStartedRunnerClose(running);
          fixtureProcesses.delete(pid);
          fixturePids.delete(pid);
          return null;
        } catch (error) {
          return error;
        }
      }),
    )
  ).filter((error) => error !== null);
  const unproven = (
    await Promise.all(
      [...fixturePids].map(async (pid) => {
        if (
          processExists(pid) &&
          !(await waitUntil(() => !processExists(pid), 6_000))
        ) {
          return pid;
        }
        fixturePids.delete(pid);
        return null;
      }),
    )
  ).filter((pid) => pid !== null);
  if (unproven.length > 0) {
    cleanupErrors.push(
      new Error(
        `refusing numeric-pid fixture cleanup without child handles: ${unproven.join(",")}`,
      ),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Tauri QA runner fixture cleanup was incomplete; retained fixture roots",
    );
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Tauri QA runner pipe ownership", () => {
  test("stops waiting for runner preparation when the runner exits first", async () => {
    const exit = { signal: null, status: 74 };
    const observed = await settleWithin(
      waitForRunnerPreparation(
        { exited: Promise.resolve(exit) },
        path.join(suiteTemporaryRoot, "preparation-never-published"),
        1_000,
      ),
      250,
    );

    expect(observed).toEqual({
      state: "fulfilled",
      value: { result: exit, state: "exited" },
    });
  });

  test("provisions the canonical Dure home before any isolated app writes", () => {
    const canonicalRoot = runnerSource.indexOf('"$qa_home/.dure"');
    const compatibilityAlias = runnerSource.indexOf(
      'ln -s .dure "$qa_home/.hebbian"',
    );
    const homeSetup = runnerSource.indexOf('node "$setup_path"');
    const appLaunch = runnerSource.indexOf('HOME="$qa_home"', homeSetup + 1);

    expect(canonicalRoot).toBeGreaterThan(0);
    expect(compatibilityAlias).toBeGreaterThan(canonicalRoot);
    expect(homeSetup).toBeGreaterThan(compatibilityAlias);
    expect(appLaunch).toBeGreaterThan(homeSetup);
    expect(runnerSource).toContain(
      '"$repo_root"/scripts/qa/*) ;;',
    );
    expect(runnerSource).toContain('HMUX_INSTALL_ROOT="$qa_hmux_install"');
    expect(runnerSource).toContain('DURE_HOME="$qa_home/.dure"');
    expect(runnerSource).toContain(
      'DURE_QA_EXPECTED_HMUX_BUILD_ID="$expected_hmux_build_id"',
    );
    expect(runnerSource).toContain('DURE_QA_HMUX_CLI="$hmux_cli"');
  });

  test("uses one shared environment ingress for setup, app and client", () => {
    const ingress = "sh scripts/qa/lib/run-isolated-app.sh";

    expect(runnerSource.split(ingress).length - 1).toBe(3);
    expect(runnerSource).toContain(`${ingress} node "$setup_path"`);
    const setup = runnerSource.slice(
      runnerSource.indexOf("failure_class=home_setup"),
      runnerSource.indexOf(`${ingress} node "$setup_path"`),
    );
    expect(setup).toContain('DURE_HMUX_BIN="$hmux_cli"');
    expect(setup).toContain('DURE_HMUX_RUNTIME_BIN="$hmux_runtime"');
    for (const descriptor of ["dev_descriptor", "client_descriptor"]) {
      expect(runnerSource).toContain(
        `node "$process_group_runner" run-observed "$${descriptor}" -- \\\n  ${ingress}`,
      );
    }
  });

  test("gives each isolated QA root its own native WebView data store", () => {
    const root = runnerSource.indexOf(
      'state_root=$(mktemp -d "${TMPDIR:-/tmp}/dure-${artifact_name}.XXXXXX")',
    );
    const identifier = runnerSource.indexOf(
      'DURE_DEV_WEBVIEW_DATA_STORE_IDENTIFIER="$qa_webview_data_store_identifier"',
    );
    const appLaunch = runnerSource.indexOf(
      'node "$process_group_runner" run-observed "$dev_descriptor"',
    );

    expect(root).toBeGreaterThan(0);
    expect(identifier).toBeGreaterThan(root);
    expect(identifier).toBeLessThan(appLaunch);
    expect(runnerSource).toContain(
      'createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 32)',
    );
  });

  test.skipIf(process.platform === "win32").each([0, 7])(
    "keeps the client FIFO open across a delayed writer, preserving exit %i",
    async (clientStatus) => {
      const root = fs.mkdtempSync(
        path.join(suiteTemporaryRoot, "client-pipe-"),
      );
      const closeAnchor = runnerSource.slice(
        runnerSource.indexOf("close_client_pipe_anchor() {"),
        runnerSource.indexOf("process_is_running() {"),
      );
      // Execute the real launch/wait sequence. Hold only the writer's open(2)
      // after its inherited anchor closes, making the scheduler gap explicit.
      const launch = runnerSource
        .slice(runnerSource.indexOf('mkfifo "$client_pipe"'))
        .replace(
          'DURE_QA_ROOT_PID="$dev_pid"',
          '(\nexec 9>&-\ntouch "$writer_waiting"\nwait_for_marker "$writer_release"\nDURE_QA_ROOT_PID="$dev_pid"',
        )
        .replace(
          'node "$qa_client" 9>&- >"$client_pipe" 2>&1 &',
          'node "$qa_client" 9>&- >"$client_pipe" 2>&1\n) &',
        );
      const program = `
set -e
client_pipe="$1/client.pipe"
client_log="$1/client.log"
client_descriptor="$1/client.json"
reader_done="$1/reader.done"
writer_waiting="$1/writer.waiting"
writer_release="$1/writer.release"
client_pipe_anchor_open=0
${closeAnchor}
wait_for_marker() {
  fixture_wait_count=0
  while [ ! -f "$1" ]; do
    fixture_wait_count=$((fixture_wait_count + 1))
    if [ "$fixture_wait_count" -ge 300 ]; then
      printf 'fixture marker missing: %s\\n' "$1" >&2
      return 88
    fi
    sleep 0.01
  done
}
tee() {
  exec sh -c 'command tee "$1"; touch "$2"' pipe-reader "$1" "$reader_done"
}
node() {
  touch "$client_descriptor"
  printf 'client-output\\n'
  return "$fixture_client_status"
}
wait_owned_group_ready() {
  wait_for_marker "$writer_waiting" || return $?
  if ! ( : >&9 ) 2>/dev/null; then
    wait_for_marker "$reader_done" || return $?
    # Let the failed fixture finish without a blocked orphan writer. This
    # rescue descriptor cannot restore tee or recover its missing output.
    exec 8<>"$client_pipe"
  fi
  touch "$writer_release"
  wait_for_marker "$client_descriptor" || return $?
  printf '%s\\n' "$$"
}
${launch}
`;
      const running = startTracked(
        "sh",
        ["-c", program, "pipe-fixture", root],
        {
          env: {
            PATH: process.env.PATH,
            fixture_client_status: String(clientStatus),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const result = await waitForRunner(running, 10_000);

      expect(result.signal, result.stderr).toBeNull();
      expect(
        fs.existsSync(path.join(root, "client.json")),
        JSON.stringify(result),
      ).toBe(true);
      expect(
        fs.existsSync(path.join(root, "reader.done")),
        JSON.stringify(result),
      ).toBe(true);
      expect(fs.readFileSync(path.join(root, "client.log"), "utf8")).toBe(
        "client-output\n",
      );
      expect(result.stdout).toBe("client-output\n");
      expect(result.status, result.stderr).toBe(clientStatus);
    },
    20_000,
  );

  test("arms synthetic exclusive input only after one final idle preflight", () => {
    const requestCheck = runnerSource.indexOf(
      'if [ -f "$exclusive_input_request" ] && [ ! -L "$exclusive_input_request" ]; then',
    );
    const finalPreflight = runnerSource.indexOf(
      "if node scripts/qa/lib/exclusive-focus-preflight.mjs",
      requestCheck,
    );
    const acknowledge = runnerSource.indexOf(
      'writeFileSync(process.argv[1], "", { flag: "wx", mode: 0o600 })',
      finalPreflight,
    );

    expect(requestCheck).toBeGreaterThan(0);
    expect(finalPreflight).toBeGreaterThan(requestCheck);
    expect(acknowledge).toBeGreaterThan(finalPreflight);
    expect(runnerSource).toContain(
      'DURE_QA_EXCLUSIVE_INPUT_REQUEST="$exclusive_input_request"',
    );
    expect(runnerSource).toContain(
      'DURE_QA_EXCLUSIVE_INPUT_ACK="$exclusive_input_ack"',
    );
  });
});

describe.skipIf(process.platform !== "darwin")(
  "Tauri QA runner process cleanup",
  () => {
    fixtureTest(
      "awaits exact runner exit while its descendant retains inherited pipes",
      async () => {
        const fixture = createFixture("runner-timeout");
        const running = startTracked(
          process.execPath,
          [
            "-e",
            [
              'const { spawn } = require("node:child_process");',
              'const fs = require("node:fs");',
              'process.on("SIGTERM", () => {});',
              'fs.writeFileSync(process.argv[1], "");',
              "const pipeHolder = spawn(process.execPath, [\"-e\", process.argv[3], process.argv[4], process.argv[5]], { stdio: [\"ignore\", \"inherit\", \"inherit\"] });",
              "pipeHolder.unref();",
              "fs.writeFileSync(process.argv[2], String(pipeHolder.pid));",
              "setTimeout(() => fs.writeFileSync(process.argv[1], String(process.pid)), 50);",
              "setInterval(() => {}, 1_000);",
            ].join("\n"),
            fixture.signalFile,
            fixture.pidFile,
            inheritedPipeHolderProgram,
            fixture.pipeWriteFile,
            fixture.pipeReleaseFile,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let failure;
        let pid = 0;
        let pipeHolderPid = 0;
        try {
          expect(
            await waitUntil(() => {
              const readyPid = readReadyPid(fixture.signalFile);
              const readyPipeHolderPid = readReadyPid(fixture.pidFile);
              if (readyPid === null || readyPipeHolderPid === null) return false;
              pid = readyPid;
              pipeHolderPid = readyPipeHolderPid;
              return true;
            }, FIXTURE_START_TIMEOUT_MS),
          ).toBe(true);
          expect(processExists(pipeHolderPid)).toBe(true);

          await expect(
            waitForRunner(running, 50, RUNNER_TERMINATION_TIMEOUT_MS),
          ).rejects.toThrow("fixture runner did not exit within 50ms");

          expect(running.child.pid).toBe(pid);
          expect(running.child.signalCode).toBe("SIGKILL");
          expect(processExists(pipeHolderPid)).toBe(true);
        } catch (error) {
          failure = error;
        }
        publishFixtureMarker(fixture.pipeReleaseFile);
        try {
          await cleanupFixtureProcesses(
            running,
            fixture,
            pid,
          );
        } catch (cleanupError) {
          if (failure) {
            throw new AggregateError(
              [failure, cleanupError],
              "timeout fixture failed and cleanup was incomplete",
            );
          }
          throw cleanupError;
        }
        if (failure) throw failure;
        expect(fixturePids.has(pid)).toBe(false);
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "reports normal exact exit before a descendant closes inherited pipes",
      async () => {
        const fixture = createFixture("runner-normal-exit");
        const running = startTracked(
          process.execPath,
          [
            "-e",
            [
              'const { spawn } = require("node:child_process");',
              'const fs = require("node:fs");',
              "const pipeHolder = spawn(process.execPath, [\"-e\", process.argv[2], process.argv[3], process.argv[4]], { stdio: [\"ignore\", \"inherit\", \"inherit\"] });",
              "pipeHolder.unref();",
              "fs.writeFileSync(process.argv[1], String(pipeHolder.pid));",
            ].join("\n"),
            fixture.pidFile,
            inheritedPipeHolderProgram,
            fixture.pipeWriteFile,
            fixture.pipeReleaseFile,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let failure;
        let pipeHolderPid = running.child.pid;
        try {
          const exactExit = await settleWithin(
            running.exited,
            FIXTURE_START_TIMEOUT_MS,
          );
          expect(exactExit.state).toBe("fulfilled");
          publishFixtureMarker(fixture.pipeWriteFile);
          expect(
            await waitUntil(
              () =>
                running
                  .capture(exactExit.value.status, exactExit.value.signal)
                  .stderr.includes("pipe-holder-after-runner-exit"),
              FIXTURE_START_TIMEOUT_MS,
            ),
          ).toBe(true);
          const result = await waitForRunner(
            running,
            FIXTURE_START_TIMEOUT_MS,
            100,
          );
          pipeHolderPid = readReadyPid(fixture.pidFile);
          expect(result.status).toBe(0);
          expect(result.signal).toBeNull();
          expect(result.stderr).toContain("pipe-holder-after-runner-exit");
          expect(pipeHolderPid).not.toBeNull();
          expect(processExists(pipeHolderPid)).toBe(true);
          expect((await settleWithin(running.result, 50)).state).toBe(
            "timed_out",
          );
        } catch (error) {
          failure = error;
        }
        publishFixtureMarker(fixture.pipeReleaseFile);
        try {
          await cleanupFixtureProcesses(running, fixture, pipeHolderPid);
        } catch (cleanupError) {
          if (failure) {
            throw new AggregateError(
              [failure, cleanupError],
              "normal-exit fixture failed and cleanup was incomplete",
            );
          }
          throw cleanupError;
        }
        if (failure) throw failure;
        expect(fixturePids.has(pipeHolderPid)).toBe(false);
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "starts the installed Tauri CLI without a package manager in isolated HOME",
      async () => {
        const fixture = await runCleanupFixture("clean");
        const stateRoot = fs
          .readFileSync(fixture.stateRootCapture, "utf8")
          .trim();
        const launch = JSON.parse(
          fs.readFileSync(fixture.tauriLaunchCapture, "utf8"),
        );

        expect(launch.args.slice(0, 3)).toEqual([
          "dev", "--no-watch", "--config",
        ]);
        expect(launch.args).toHaveLength(4);
        expect(JSON.parse(launch.args[3]).build.devUrl).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+$/u,
        );
        expect(launch.home).toBe(path.join(stateRoot, "home"));
        expect(launch.dureHome).toBe(path.join(stateRoot, "home", ".dure"));
        expect(launch.discoveryRoot).toBe(
          path.join(stateRoot, "hmux-discovery"),
        );
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "pins canonical isolated roots and the Hmux pair while preserving state after exact generations exit",
      async () => {
        await runCleanupFixture("clean", {
          assertHmuxRuntimeSelection: true,
          completionTimeoutMs: DELAYED_RUNNER_COMPLETION_TIMEOUT_MS,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "ignores ambient capability and preserves state without an atomic receipt",
      async () => {
        await runCleanupFixture("clean", {
          ambientRootRetirementCapability: true,
          nonAtomicProcessReceipt: true,
          verifiedPreservation: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "accepts deprecated HEBBIAN_QA runner inputs during migration",
      async () => {
        await runCleanupFixture("clean", {
          legacyRunnerEnvironment: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "cleans an app descendant while the exact leader remains anchored",
      async () => {
        await runCleanupFixture("app");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    // These cases intentionally race a reparented publisher against a 1.5s
    // manifest delay. Observation mode must terminate its exact observed
    // generation before publication, even when it leaves the original group
    // or drops the inherited witness.
    exclusiveFixtureTest(
      "stops a ledgered reparented setsid Host by exact generation",
      async () => {
        await runCleanupFixture("late-manifest");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    exclusiveFixtureTest(
      "stops a client-owned setsid Host by exact generation",
      async () => {
        await runCleanupFixture("client-late-manifest");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    exclusiveFixtureTest(
      "stops an immediate setsid publisher before its late manifest",
      async () => {
        await runCleanupFixture("fast-late-manifest");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    exclusiveFixtureTest(
      "contains an observed late publisher after it drops the witness",
      async () => {
        await runCleanupFixture("fast-late-manifest-no-witness");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "preserves the isolated root when client freeze fails twice",
      async () => {
        await runCleanupFixture("app", {
          clientFreezeFailure: true,
          expectCompletionReceipt: false,
          expectedStatus: 1,
          preservedState: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    // Establish a healthy exact ledger before injecting owner loss. Running
    // beside another fork-heavy fault fixture can intentionally trip macOS
    // observation status 19 first, which exercises a different refusal path.
    exclusiveFixtureTest(
      "reaps exact runner generations when its launch owner disappears during repeated client freeze failure",
      async () => {
        await runCleanupFixture("signal", {
          clientFreezeFailure: true,
          expectedSignal: "SIGKILL",
          expectedStatus: null,
          launchOwnerFailure: true,
          launchOwnerCleanupGraceMs: "100",
          preservedState: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "re-enters freeze after a stopped tree loses its first snapshot",
      async () => {
        await runCleanupFixture("app", {
          freezeFailureAfterStop: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureCases(
      [
        ["freeze", { freezeFailure: true }],
        ["frozen termination", { frozenTerminateFailure: true }],
        ["exact manifest wait", { hmuxWaitFailure: true }],
      ],
      "preserves the isolated root when %s proof is unavailable",
      async (_failure, injected) => {
        await runCleanupFixture("app", {
          ...injected,
          expectedStatus: 1,
          preservedState: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "waits for a live process-group supervisor under scheduler delay",
      async () => {
        await runCleanupFixture("app-readiness-delay", {
          // The fixture injects 10s before the process-group runner starts.
          // Full-suite scheduler load can consume the old 5s margin even when
          // the production runner stays within its bounded 30s readiness wait.
          completionTimeoutMs: DELAYED_RUNNER_COMPLETION_TIMEOUT_MS,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "starts a non-focus client only after the app publishes readiness",
      async () => {
        await runCleanupFixture("app-server-readiness-delay");
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "treats a late exclusive-focus skip before client startup as verified cleanup",
      async () => {
        await runCleanupFixture("app", {
          expectedStatus: 22,
          latePreflightSkip: true,
          layer: "exclusive_focus",
          requireExecution: true,
          verifiedPreClientPreservation: true,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "observes background focus activation before app readiness",
      async () => {
        await runCleanupFixture("background-focus-startup", {
          backgroundFocusDuringStartup: true,
          expectedStatus: 23,
          incompleteReceiptsPreserved: true,
          layer: "background",
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "ignores an unrelated foreground process in the repository",
      async () => {
        await runCleanupFixture("background-focus-startup", {
          backgroundFocusDuringStartup: true,
          backgroundFocusOwner: "unrelated",
          layer: "background",
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "fails when foreground process ownership cannot be observed",
      async () => {
        await runCleanupFixture("background-focus-startup", {
          backgroundFocusDuringStartup: true,
          backgroundFocusObservationFailure: true,
          expectedStatus: 24,
          incompleteReceiptsPreserved: true,
          layer: "background",
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    fixtureTest(
      "cleans a reparented client descendant after client failure",
      async () => {
        await runCleanupFixture("client", {
          clientExitCode: "23",
          expectedStatus: 23,
        });
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    exclusiveFixtureTest(
      "cleans the app process group when the runner receives TERM",
      async () => {
        await runSignalFixture();
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    exclusiveFixtureTest(
      "publishes completion only after a parent cancellation is fully cleaned",
      async () => {
        await runCancellationFixture();
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    test(
      "refuses to start the command when the exact owner exits after ACK",
      async () => {
        const fixture = createFixture("startup-owner-loss");
        const descriptorPath = path.join(
          fixture.root,
          "owner-loss-group.json",
        );
        const supervisorOwner = path.join(
          fixture.root,
          "exiting-supervisor-owner.mjs",
        );
        const supervisorPidFile = path.join(
          fixture.root,
          "owner-loss-supervisor.pid",
        );
        const leaderPidFile = path.join(
          fixture.root,
          "owner-loss-leader.pid",
        );
        // successor가 descriptor를 자율 삭제하므로 테스트 측 사후 캡처는
        // 경쟁한다 — 이미 descriptor를 읽는 owner 스크립트가 전체 JSON
        // 사본을 남기고 테스트는 사본에서 exact triplet을 얻는다(재설계
        // 조건 3).
        const descriptorCopyFile = path.join(
          fixture.root,
          "owner-loss-descriptor-copy.json",
        );
        const acknowledgeMarker = `${descriptorPath}.startup-ack`;
        const supervisorLog = path.join(
          fixture.root,
          "owner-loss-supervisor.log",
        );
        fs.writeFileSync(
          supervisorOwner,
          `import { spawn } from "node:child_process";
import fs from "node:fs";
const [
  ,
  ,
  processGroupRunner,
  descriptorPath,
  worker,
  pidFile,
  signalFile,
  supervisorPidFile,
  leaderPidFile,
  acknowledgeMarker,
  supervisorLog,
  descriptorCopyFile,
] = process.argv;
const supervisorStderr = fs.openSync(supervisorLog, "a", 0o600);
const supervisor = spawn(
  process.execPath,
  [
    processGroupRunner,
    "run",
    descriptorPath,
    "--",
    process.execPath,
    worker,
    pidFile,
    signalFile,
  ],
  { env: process.env, stdio: ["ignore", "ignore", supervisorStderr] },
);
fs.closeSync(supervisorStderr);
fs.writeFileSync(supervisorPidFile, String(supervisor.pid));
let stopping = false;
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    supervisor.kill("SIGTERM");
    supervisor.once("close", () => process.exit(0));
  });
}
while (!fs.existsSync(acknowledgeMarker)) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
fs.writeFileSync(descriptorCopyFile, JSON.stringify(descriptor));
fs.writeFileSync(leaderPidFile, String(descriptor.leaderPid));
process.exit(0);
`,
        );
        const running = startTracked(
          process.execPath,
          [
            supervisorOwner,
            processGroupRunner,
            descriptorPath,
            fixture.worker,
            fixture.pidFile,
            fixture.signalFile,
            supervisorPidFile,
            leaderPidFile,
            acknowledgeMarker,
            supervisorLog,
            descriptorCopyFile,
          ],
          {
            cwd: path.resolve(directory, "../../.."),
            env: {
              ...process.env,
              HEBBIAN_QA_PROCESS_KILL_GRACE_MS: "1000",
              HEBBIAN_QA_PROCESS_TERM_GRACE_MS: "1000",
              HEBBIAN_QA_TEST_ACK_MARKER: "1",
              HEBBIAN_QA_TEST_OWNER_MONITOR_INTERVAL_MS: "5000",
              HEBBIAN_QA_TEST_POST_ACK_DELAY_MS: "1000",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const result = await waitForRunner(running);
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        const supervisorPid = readReadyPid(supervisorPidFile);
        const leaderPid = readReadyPid(leaderPidFile);
        expect(fs.existsSync(acknowledgeMarker)).toBe(true);
        expect(supervisorPid).not.toBeNull();
        expect(leaderPid).not.toBeNull();
        fixturePids.add(supervisorPid);
        fixturePids.add(leaderPid);

        // The owner's descriptor copy preserves exact identities after the
        // original state root is retired, so PID reuse cannot extend cleanup.
        const descriptorCopy = JSON.parse(
          fs.readFileSync(descriptorCopyFile, "utf8"),
        );
        const supervisorExpected = exactOwnedProcessIdentity({
          kernelStartMarker: descriptorCopy.supervisorKernelStartMarker,
          pid: descriptorCopy.supervisorPid,
        });
        const leaderExpected = exactOwnedProcessIdentity({
          kernelStartMarker: descriptorCopy.leaderKernelStartMarker,
          pid: descriptorCopy.leaderPid,
        });
        const expectedGenerations = [supervisorExpected, leaderExpected];
        const cleaned = await waitUntil(
          () =>
            allProcessIdentitiesDeparted(expectedGenerations) &&
            !fs.existsSync(descriptorPath),
          6_000,
        );
        expect(
          cleaned,
          JSON.stringify({
            descriptorExists: fs.existsSync(descriptorPath),
            leaderGeneration: observeProcessLiveness(leaderExpected),
            leaderPid,
            supervisorGeneration:
              observeProcessLiveness(supervisorExpected),
            supervisorPid,
          }),
        ).toBe(true);
        expect(readReadyPid(fixture.pidFile)).toBeNull();
        expect(fs.readFileSync(supervisorLog, "utf8")).toContain(
          "launch owner disappeared before command execution",
        );
        fixturePids.delete(supervisorPid);
        fixturePids.delete(leaderPid);
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    test(
      "hands exact cleanup to a successor when supervisor and owner crash",
      async () => {
        const fixture = createFixture("supervisor-crash");
        const descriptorPath = path.join(
          fixture.root,
          "crashed-supervisor-group.json",
        );
        const supervisorOwner = path.join(
          fixture.root,
          "supervisor-owner.mjs",
        );
        const supervisorPidFile = path.join(
          fixture.root,
          "supervisor.pid",
        );
        fs.writeFileSync(
          supervisorOwner,
          `import { spawn } from "node:child_process";
import fs from "node:fs";
const [
  ,
  ,
  processGroupRunner,
  descriptorPath,
  worker,
  pidFile,
  signalFile,
  supervisorPidFile,
] = process.argv;
const supervisor = spawn(
  process.execPath,
  [
    processGroupRunner,
    "run",
    descriptorPath,
    "--",
    process.execPath,
    worker,
    pidFile,
    signalFile,
  ],
  { env: process.env, stdio: "ignore" },
);
fs.writeFileSync(supervisorPidFile, String(supervisor.pid));
let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  supervisor.kill(signal);
  supervisor.once("close", () => process.exit(0));
}
process.on("SIGUSR1", () => stop("SIGKILL"));
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop("SIGTERM"));
}
setInterval(() => {}, 1_000);
`,
        );
        const running = startTracked(
          process.execPath,
          [
            supervisorOwner,
            processGroupRunner,
            descriptorPath,
            fixture.worker,
            fixture.pidFile,
            fixture.signalFile,
            supervisorPidFile,
          ],
          {
            cwd: path.resolve(directory, "../../.."),
            env: {
              ...process.env,
              HEBBIAN_QA_PROCESS_KILL_GRACE_MS: "1000",
              HEBBIAN_QA_PROCESS_TERM_GRACE_MS: "1000",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        expect(
          await waitUntil(
            () =>
              fs.existsSync(descriptorPath) &&
              readReadyPid(supervisorPidFile) !== null &&
              readReadyPid(fixture.pidFile) !== null,
            FIXTURE_START_TIMEOUT_MS,
          ),
        ).toBe(true);
        const descriptor = JSON.parse(
          fs.readFileSync(descriptorPath, "utf8"),
        );
        const descriptorIdentity = fs.lstatSync(descriptorPath);
        const descriptorBytes = fs.readFileSync(descriptorPath);
        const supervisorPid = readReadyPid(supervisorPidFile);
        const leaderPid = descriptor.leaderPid;
        const workerPid = readReadyPid(fixture.pidFile);
        expect(Number.isSafeInteger(leaderPid) && leaderPid > 1).toBe(
          true,
        );
        expect(supervisorPid).not.toBeNull();
        expect(workerPid).not.toBeNull();
        fixturePids.add(supervisorPid);
        fixturePids.add(leaderPid);
        fixturePids.add(workerPid);
        // Capture exact identities before the crash. The worker is absent
        // from the descriptor, so observe it while it is still alive.
        const supervisorExpected = exactOwnedProcessIdentity({
          kernelStartMarker: descriptor.supervisorKernelStartMarker,
          pid: descriptor.supervisorPid,
        });
        const leaderExpected = exactOwnedProcessIdentity({
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          pid: descriptor.leaderPid,
        });
        let workerExpected = null;
        try {
          workerExpected = observedProcessIdentity(workerPid);
        } catch {
          workerExpected = null;
        }
        const expectedGenerations = [
          supervisorExpected,
          leaderExpected,
          ...(workerExpected ? [workerExpected] : []),
        ];

        running.child.kill("SIGUSR1");
        const result = await waitForRunner(running);
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        const cleaned = await waitUntil(
          () =>
            allProcessIdentitiesDeparted(expectedGenerations) &&
            (workerExpected ? true : !processExists(workerPid)),
          6_000,
        );
        expect(
          cleaned,
          JSON.stringify({
            descriptorExists: fs.existsSync(descriptorPath),
            leaderGeneration: observeProcessLiveness(leaderExpected),
            leaderPid,
            supervisorGeneration:
              observeProcessLiveness(supervisorExpected),
            supervisorPid,
            workerGeneration: workerExpected
              ? observeProcessLiveness(workerExpected)
              : processExists(workerPid),
            workerPid,
          }),
        ).toBe(true);
        expect(fs.lstatSync(descriptorPath)).toMatchObject({
          dev: descriptorIdentity.dev,
          ino: descriptorIdentity.ino,
        });
        expect(fs.readFileSync(descriptorPath)).toEqual(descriptorBytes);
        expect(
          fs.existsSync(
            `${descriptorPath}.cleanup-handoff-frozen-v1.json`,
          ),
        ).toBe(true);
        fixturePids.delete(supervisorPid);
        fixturePids.delete(leaderPid);
        fixturePids.delete(workerPid);
      },
      FIXTURE_TEST_TIMEOUT_MS,
    );

    test("refuses a mismatched supervisor without signaling the group", async () => {
      const fixture = createFixture("ownership");
      const unrelatedPid = startUnrelatedProcess(fixture);
      const descriptor = path.join(fixture.root, "unowned-group.json");
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({
          groupId: unrelatedPid,
          leaderPid: unrelatedPid,
          livenessWitnessVersion: "inherited-fd-v1",
          schemaVersion: 1,
          supervisorPid: unrelatedPid,
        })}\n`,
        { mode: 0o600 },
      );

      const result = await run(
        process.execPath,
        [
          processGroupRunner,
          "terminate",
          descriptor,
          String(process.pid),
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      expect(result.status).toBe(97);
      expect(result.stderr).toContain("supervisor identity does not match");
      await assertUnrelatedProcessUntouched(unrelatedPid);
    });

    test("rolls back the process group when descriptor publication fails", async () => {
      const fixture = createFixture("publication");
      let leaderPid;
      let leaderExpected = null;

      await expect(
        supervise(
          path.join(fixture.root, "never-published.json"),
          process.execPath,
          [fixture.holder],
          {
            publishDescriptor(_descriptorPath, descriptor) {
              leaderPid = descriptor.leaderPid;
              // Publication is the stable boundary for the exact identity;
              // a later numeric PID check would be vulnerable to reuse.
              leaderExpected = exactOwnedProcessIdentity({
                kernelStartMarker: descriptor.leaderKernelStartMarker,
                pid: descriptor.leaderPid,
              });
              fixturePids.add(leaderPid);
              throw new Error("injected descriptor publication failure");
            },
          },
        ),
      ).rejects.toThrow("injected descriptor publication failure");

      expect(Number.isSafeInteger(leaderPid) && leaderPid > 1).toBe(true);
      expect(
        await waitUntil(() =>
          leaderExpected
            ? allProcessIdentitiesDeparted([leaderExpected])
            : !processExists(leaderPid),
        ),
      ).toBe(true);
      fixturePids.delete(leaderPid);
    });
  },
);
