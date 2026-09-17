import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/** 구간 측정과 타임아웃 판정에 쓰는 단조 시계.
 *
 *  `Date.now()`(벽시계)로 재면 실행 중 NTP가 시계를 조정할 때 경과가 틀어진다.
 *  2026-07-31 게이트 실패가 그것이다: operation elapsedMs가 -812ms로 나와
 *  `toBeGreaterThanOrEqual(0)`이 깨졌다. 시계가 앞으로 당겨지면 반대로
 *  타임아웃이 즉시 터진다. 경과는 언제나 단조 시계로 잰다. */
function monotonicMs() {
  return performance.now();
}
import { afterEach, describe, expect, test } from "vitest";
import {
  HostRefusal,
  parseProbeOutput,
  planHostAction,
  quoteForRemoteShell,
  selectPrebuiltTriple,
} from "./lib/hmux-remote-provisioning.mjs";
import { processMemberSnapshots } from "./lib/process-identity.mjs";
import { terminateOwnedProcessGroup } from "./qa/lib/owned-process-group.mjs";

const repositoryRoot = path.resolve(".");
const provisionScript = path.join(
  repositoryRoot,
  "scripts/provision-hmux-remote.mjs",
);
const FIXTURE_SETUP_TIMEOUT_MS = 10_000;
const FIXTURE_READINESS_TIMEOUT_MS = 5_000;
// Test-only deadline, calibrated above four times the 3.66s maximum observed
// across 12 conflict runs under four-way parallel load. Product timeouts are
// defined by the provisioner; this only bounds a fixture after readiness.
const FIXTURE_OPERATION_TIMEOUT_MS = 15_000;
const FIXTURE_TERM_GRACE_MS = 2_000;
const FIXTURE_KILL_GRACE_MS = 1_000;
const FIXTURE_CLEANUP_TIMEOUT_MS =
  FIXTURE_TERM_GRACE_MS + FIXTURE_KILL_GRACE_MS;
// The outer watchdog leaves room for stage-specific failure plus process-group
// cleanup. Setup, readiness, and operation always fail on their earlier bounds.
const FIXTURE_TEST_TIMEOUT_MS = 70_000;
const FIXTURE_POLL_INTERVAL_MS = 10;
const FIXTURE_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const temporaryDirectories = [];
const fixtureSetupEvidence = new Map();
const activeFixtureGroups = new Map();
let fixtureSequence = 0;

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-provision-"));
  temporaryDirectories.push(directory);
  return directory;
}

function executable(pathname, contents) {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, contents, { mode: 0o755 });
}

// The simulated remote. It is not a mock of the provisioner's steps: it runs
// every command the provisioner sends through a real `/bin/sh`, against a real
// HOME with no checkout and no toolchain, with the payload arriving on a real
// stdin pipe. What it fakes is only the network.
//
// FAKE_SSH_CORRUPT_TREE substitutes the delivered binary after extraction,
// which is the only faithful way to simulate a transfer that did not arrive
// intact: corrupting the tree on the laptop instead would change the pin too,
// and prove nothing.
const FAKE_SSH = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [host, script] = process.argv.slice(2);
const sandbox = process.env.FAKE_SSH_SANDBOX;
const delayOnceMs = Number(process.env.FAKE_SSH_DELAY_ONCE_MS ?? 0);
const delayMarker = path.join(sandbox, "ssh-delay-used");
if (
  Number.isSafeInteger(delayOnceMs) &&
  delayOnceMs > 0 &&
  delayOnceMs <= 10_000
) {
  try {
    fs.writeFileSync(delayMarker, String(process.pid), { flag: "wx" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayOnceMs);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
}
const barrierDirectory = process.env.FAKE_SSH_BARRIER_DIRECTORY;
if (barrierDirectory && process.env.FAKE_SSH_SKIP_READY !== "1") {
  fs.mkdirSync(barrierDirectory, { recursive: true });
  const ready = path.join(barrierDirectory, "ready");
  const release = path.join(barrierDirectory, "release");
  if (!fs.existsSync(ready)) {
    fs.writeFileSync(ready, String(process.pid) + "\\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  const releaseDeadline = Date.now() + 30_000;
  while (
    process.env.FAKE_SSH_IGNORE_RELEASE === "1" ||
    !fs.existsSync(release)
  ) {
    if (Date.now() >= releaseDeadline) {
      process.stderr.write(
        "fake ssh fixture timed out waiting for release\\n",
      );
      process.exit(70);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (host === process.env.FAKE_SSH_UNREACHABLE) {
  process.stderr.write("ssh: connect to host " + host + ": No route to host\\n");
  process.exit(255);
}
const home = path.join(sandbox, "hosts", host);
const temporary = path.join(home, "tmp");
fs.mkdirSync(temporary, { recursive: true });
fs.appendFileSync(path.join(sandbox, "ssh.log"), "### " + host + "\\n" + script + "\\n");
const result = spawnSync("/bin/sh", ["-c", script], {
  env: {
    FAKE_UNAME_MACHINE: process.env.FAKE_UNAME_MACHINE ?? "",
    FAKE_UNAME_SYSTEM: process.env.FAKE_UNAME_SYSTEM ?? "",
    HOME: home,
    PATH: path.join(sandbox, "shims") + ":" + process.env.FAKE_SSH_PATH,
    TMPDIR: temporary,
  },
  stdio: "inherit",
});
if (process.env.FAKE_SSH_CORRUPT_TREE === "1") {
  for (const entry of fs.readdirSync(temporary)) {
    const delivered = path.join(temporary, entry, "tree/bin/hmux");
    if (fs.existsSync(delivered)) {
      fs.writeFileSync(delivered, "#!/bin/sh\\necho substituted\\n", { mode: 0o755 });
    }
  }
}
process.exit(result.status ?? 1);
`;

const FAKE_UNAME = `#!/bin/sh
case "\$1" in
  -s)
    if [ -n "\${FAKE_UNAME_SYSTEM:-}" ]; then
      printf '%s\\n' "\$FAKE_UNAME_SYSTEM"
      exit 0
    fi
    ;;
  -m)
    if [ -n "\${FAKE_UNAME_MACHINE:-}" ]; then
      printf '%s\\n' "\$FAKE_UNAME_MACHINE"
      exit 0
    fi
    ;;
esac
exec /usr/bin/uname "\$@"
`;

function simulatedFleet(root) {
  const sandbox = path.join(root, "fleet");
  const shims = path.join(sandbox, "shims");
  fs.mkdirSync(sandbox, { recursive: true });
  // A server that has never had Hmux has no checkout and no Rust toolchain.
  // Making git and rustc fail is what keeps the prebuilt path honest.
  executable(path.join(shims, "git"), "#!/bin/sh\nexit 127\n");
  executable(path.join(shims, "rustc"), "#!/bin/sh\nexit 127\n");
  executable(path.join(shims, "uname"), FAKE_UNAME);
  const ssh = path.join(sandbox, "fake-ssh.mjs");
  executable(ssh, FAKE_SSH);
  fs.writeFileSync(path.join(sandbox, "ssh.log"), "");
  return {
    home: (host) => path.join(sandbox, "hosts", host),
    log: () => fs.readFileSync(path.join(sandbox, "ssh.log"), "utf8"),
    resetLog: () => fs.writeFileSync(path.join(sandbox, "ssh.log"), ""),
    sandbox,
    ssh,
  };
}

async function prebuiltRoot(
  root,
  name,
  triple,
  buildId,
  banner,
  {
    outputLimitBytes = FIXTURE_OUTPUT_LIMIT_BYTES,
    packageArgs,
    packageCommand = "sh",
    setupTimeoutMs = FIXTURE_SETUP_TIMEOUT_MS,
  } = {},
) {
  const setupStartedAt = monotonicMs();
  const artifacts = path.join(root, `artifacts-${name}-${triple}`);
  const directory = path.join(root, name);
  executable(path.join(artifacts, "hmux"), `#!/bin/sh\necho '${banner}'\n`);
  executable(
    path.join(artifacts, "hmux-runtime"),
    `#!/bin/sh
# hmux-product-profile=structured-terminal-v1
if [ "\${1:-}" = "--no-autostart" ] &&
  [ "\${2:-}" = "hmux-build-info" ]; then
  printf '%s\\n' '{"productProfile":"structured-terminal-v1"}'
  exit 0
fi
echo '${banner} runtime'
`,
  );
  const controller = spawnOwnedFixtureProcess(
    packageCommand,
    packageArgs ?? [
      "scripts/package-hmux-prebuilt.sh",
      triple,
      path.join(directory, triple),
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HMUX_ARTIFACT_DIR: artifacts,
        HMUX_BUILD_ID: buildId,
      },
      outputLimitBytes,
    },
  );
  try {
    const result = await waitForFixtureOperation(
      controller,
      {
        stage: "setup",
        timeoutMessage: `packaging ${name} did not exit`,
        timeoutMs: setupTimeoutMs,
      },
    );
    if (result.status !== 0) {
      throw fixtureFailure(
        "setup",
        `could not package ${name}; status=${result.status} stderr=${result.stderr.trim()}`,
        setupTimeoutMs,
      );
    }
  } catch (error) {
    await cleanupFixtureController(controller, error);
    throw error;
  }
  await cleanupFixtureController(controller);
  const existingEvidence = fixtureSetupEvidence.get(directory);
  fixtureSetupEvidence.set(directory, {
    elapsedMs:
      (existingEvidence?.elapsedMs ?? 0) + monotonicMs() - setupStartedAt,
    stepTimeoutMs: setupTimeoutMs,
    steps: (existingEvidence?.steps ?? 0) + 1,
  });
  return directory;
}

function fixtureFailure(stage, message, timeoutMs) {
  return new Error(
    `hmux_provision_fixture_failed stage=${stage} timeoutMs=${timeoutMs}: ${message}`,
  );
}

function outputCollector(stream, output, budget, outputLimitBytes, onLimit) {
  stream.on("data", (chunk) => {
    output.bytes += chunk.length;
    budget.bytes += chunk.length;
    if (budget.bytes <= outputLimitBytes) {
      output.chunks.push(chunk);
    } else if (!budget.limitExceeded) {
      budget.limitExceeded = true;
      onLimit();
    }
  });
}

function childOutcome(child, stdout, stderr) {
  return new Promise((resolve) => {
    let spawnError = null;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      resolve({
        error: spawnError,
        signal,
        status,
        stderr: Buffer.concat(stderr.chunks).toString("utf8"),
        stdout: Buffer.concat(stdout.chunks).toString("utf8"),
      });
    });
  });
}

function spawnOwnedFixtureProcess(
  command,
  args,
  {
    cwd,
    env,
    outputLimitBytes = FIXTURE_OUTPUT_LIMIT_BYTES,
  },
) {
  const output = { bytes: 0, limitExceeded: false };
  const stdout = { bytes: 0, chunks: [] };
  const stderr = { bytes: 0, chunks: [] };
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const leaderObservation = processMemberSnapshots([child.pid]);
  const exactLeader = leaderObservation.status === "complete" &&
      leaderObservation.members[0]?.groupId === child.pid
    ? leaderObservation.members[0]
    : null;
  const outcome = childOutcome(child, stdout, stderr);
  const outputLimit = Symbol("output-limit");
  let resolveOutputLimit;
  const outputLimitReached = new Promise((resolve) => {
    resolveOutputLimit = () => resolve(outputLimit);
  });
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (Number.isSafeInteger(child.pid) && child.pid > 1) {
        if (!exactLeader) {
          throw new Error(
            "fixture process group has no exact leader identity",
          );
        }
        await terminateOwnedProcessGroup(exactLeader, {
          environment: {
            HEBBIAN_QA_PROCESS_KILL_GRACE_MS: String(FIXTURE_KILL_GRACE_MS),
            HEBBIAN_QA_PROCESS_TERM_GRACE_MS: String(FIXTURE_TERM_GRACE_MS),
          },
        });
      }
      const result = await outcome;
      if (activeFixtureGroups.get(child.pid) === cleanup) {
        activeFixtureGroups.delete(child.pid);
      }
      return result;
    })();
    return cleanupPromise;
  };
  if (Number.isSafeInteger(child.pid) && child.pid > 1) {
    activeFixtureGroups.set(child.pid, cleanup);
  }
  const onLimit = () => {
    resolveOutputLimit();
    void cleanup().catch(() => {});
  };
  outputCollector(child.stdout, stdout, output, outputLimitBytes, onLimit);
  outputCollector(child.stderr, stderr, output, outputLimitBytes, onLimit);
  return {
    child,
    cleanup,
    outcome,
    output,
    outputLimit,
    outputLimitBytes,
    outputLimitReached,
    stderr,
    stdout,
  };
}

async function cleanupFixtureController(controller, primaryError) {
  try {
    return await controller.cleanup();
  } catch (cleanupError) {
    throw fixtureFailure(
      "cleanup",
      `${primaryError ? `after ${primaryError instanceof Error ? primaryError.message : String(primaryError)}: ` : ""}${
        cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError)
      }`,
      FIXTURE_CLEANUP_TIMEOUT_MS,
    );
  }
}

async function waitForFixtureReadiness(ready, controller, timeoutMs) {
  const startedAt = monotonicMs();
  let settled = null;
  let outputLimitReached = false;
  void controller.outcome.then((result) => {
    settled = result;
  });
  void controller.outputLimitReached.then(() => {
    outputLimitReached = true;
  });
  const assertReadinessCanContinue = () => {
    if (outputLimitReached || controller.output.limitExceeded) {
      throw fixtureFailure(
        "readiness",
        `fixture output exceeded ${controller.outputLimitBytes} bytes`,
        timeoutMs,
      );
    }
    if (settled) {
      throw fixtureFailure(
        "readiness",
        `provisioner exited before the fake remote became ready; status=${settled.status} stderr=${settled.stderr.trim()}`,
        timeoutMs,
      );
    }
  };
  while (true) {
    assertReadinessCanContinue();
    const elapsedMs = monotonicMs() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw fixtureFailure(
        "readiness",
        `fake remote did not report readiness at ${ready}`,
        timeoutMs,
      );
    }
    if (fs.existsSync(ready)) {
      // Let output and exit callbacks already queued with the marker settle so
      // a simultaneous failure remains attributed to readiness.
      await delay(0);
      assertReadinessCanContinue();
      return monotonicMs() - startedAt;
    }
    await delay(FIXTURE_POLL_INTERVAL_MS);
  }
}

async function waitForFixtureOperation(
  controller,
  { stage, timeoutMessage, timeoutMs },
) {
  const timeout = Symbol("operation-timeout");
  const result = await Promise.race([
    controller.outcome,
    controller.outputLimitReached,
    delay(timeoutMs, timeout, { ref: false }),
  ]);
  if (result === timeout) {
    throw fixtureFailure(stage, timeoutMessage, timeoutMs);
  }
  if (
    result === controller.outputLimit ||
    controller.output.limitExceeded
  ) {
    throw fixtureFailure(
      stage,
      `fixture output exceeded ${controller.outputLimitBytes} bytes`,
      timeoutMs,
    );
  }
  if (result.error) {
    throw fixtureFailure(stage, result.error.message, timeoutMs);
  }
  return result;
}

async function provision(
  fleet,
  artifacts,
  hosts,
  environment = {},
  {
    operationTimeoutMs = FIXTURE_OPERATION_TIMEOUT_MS,
    outputLimitBytes = FIXTURE_OUTPUT_LIMIT_BYTES,
    readinessTimeoutMs = FIXTURE_READINESS_TIMEOUT_MS,
  } = {},
) {
  const barrierDirectory = path.join(
    fleet.sandbox,
    "barriers",
    `${process.pid}-${fixtureSequence++}`,
  );
  fs.mkdirSync(barrierDirectory, { recursive: true });
  const controller = spawnOwnedFixtureProcess(
    process.execPath,
    [provisionScript, "--json", "--prebuilt-root", artifacts, ...hosts],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        FAKE_SSH_BARRIER_DIRECTORY: barrierDirectory,
        FAKE_SSH_PATH: process.env.PATH,
        FAKE_SSH_SANDBOX: fleet.sandbox,
        HMUX_PROVISION_SSH: fleet.ssh,
        ...environment,
      },
      outputLimitBytes,
    },
  );
  const ready = path.join(barrierDirectory, "ready");
  const release = path.join(barrierDirectory, "release");
  let result;
  try {
    const readyAfterMs = await waitForFixtureReadiness(
      ready,
      controller,
      readinessTimeoutMs,
    );
    fs.writeFileSync(release, "release\n", { flag: "wx", mode: 0o600 });
    const operationStartedAt = monotonicMs();
    result = await waitForFixtureOperation(controller, {
      stage: "operation",
      timeoutMessage:
        "provisioner did not exit after the fake remote was released",
      timeoutMs: operationTimeoutMs,
    });
    result.fixture = {
      schemaVersion: 1,
      operation: {
        elapsedMs: monotonicMs() - operationStartedAt,
        timeoutMs: operationTimeoutMs,
      },
      outputLimitBytes,
      readiness: {
        elapsedMs: readyAfterMs,
        timeoutMs: readinessTimeoutMs,
      },
      setup: fixtureSetupEvidence.get(artifacts),
    };
  } catch (error) {
    await cleanupFixtureController(controller, error);
    throw error;
  }
  await cleanupFixtureController(controller);
  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = null;
  }
  return { report, result };
}

const hostTriple = `${
  execFileSync("uname", ["-m"], { encoding: "utf8" }).trim() === "x86_64"
    ? "x86_64"
    : "aarch64"
}-apple-darwin`;
const onDarwin =
  execFileSync("uname", ["-s"], { encoding: "utf8" }).trim() === "Darwin";

function remoteProvisioningTest(name, body) {
  test.runIf(onDarwin)(
    name,
    { timeout: FIXTURE_TEST_TIMEOUT_MS },
    body,
  );
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

function readyFixturePid(fleet) {
  const barriers = path.join(fleet.sandbox, "barriers");
  const ready = fs
    .readdirSync(barriers)
    .map((entry) => path.join(barriers, entry, "ready"))
    .find((candidate) => fs.existsSync(candidate));
  if (!ready) throw new Error("fixture did not leave a readiness receipt");
  return Number(fs.readFileSync(ready, "utf8").trim());
}

function expectFixtureEvidence(result, setupSteps = 1) {
  expect(result.fixture).toMatchObject({
    schemaVersion: 1,
    operation: { timeoutMs: FIXTURE_OPERATION_TIMEOUT_MS },
    outputLimitBytes: FIXTURE_OUTPUT_LIMIT_BYTES,
    readiness: { timeoutMs: FIXTURE_READINESS_TIMEOUT_MS },
    setup: {
      stepTimeoutMs: FIXTURE_SETUP_TIMEOUT_MS,
      steps: setupSteps,
    },
  });
  for (const phase of ["setup", "readiness", "operation"]) {
    const elapsedMs = result.fixture[phase].elapsedMs;
    expect(Number.isFinite(elapsedMs), `${phase} elapsedMs`).toBe(true);
    expect(elapsedMs, `${phase} elapsedMs`).toBeGreaterThanOrEqual(0);
  }
}

afterEach(async () => {
  const cleanupResults = await Promise.allSettled(
    [...activeFixtureGroups.values()].map((cleanup) => cleanup()),
  );
  const cleanupFailures = cleanupResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (cleanupFailures.length > 0 || activeFixtureGroups.size > 0) {
    throw new AggregateError(
      cleanupFailures,
      `${activeFixtureGroups.size} fixture process groups survived cleanup`,
    );
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
  fixtureSetupEvidence.clear();
});

describe("remote Hmux provisioning", () => {
  remoteProvisioningTest(
    "installs onto a server that has never had Hmux and leaves it runnable",
    async () => {
      const root = temporaryDirectory();
      const fleet = simulatedFleet(root);
      const artifacts = await prebuiltRoot(
        root,
        "fresh",
        hostTriple,
        "0.1.4+fresh",
        "hmux 0.1.4+fresh",
      );

      const { report, result } = await provision(fleet, artifacts, ["desk-a"]);

      expect(result.status, result.stderr).toBe(0);
      expectFixtureEvidence(result);
      expect(report.hosts[0]).toMatchObject({
        buildId: "0.1.4+fresh",
        host: "desk-a",
        outcome: "installed",
        triple: hostTriple,
      });
      // Not "the files were copied": the command symlink chain was resolved and
      // executed on the far side, which is the claim that matters for a phone
      // that will run it under a forced command.
      expect(report.hosts[0].version).toBe("hmux 0.1.4+fresh");
      expect(
        fs.readlinkSync(
          path.join(fleet.home("desk-a"), ".local/share/hmux/current"),
        ),
      ).toBe("versions/0.1.4+fresh");
    },
  );

  remoteProvisioningTest("re-running against a current server sends nothing", async () => {
    const root = temporaryDirectory();
    const fleet = simulatedFleet(root);
    const artifacts = await prebuiltRoot(
      root,
      "idempotent",
      hostTriple,
      "0.1.4+idempotent",
      "hmux 0.1.4+idempotent",
    );
    const loadedNetwork = { FAKE_SSH_DELAY_ONCE_MS: "6000" };
    const loadedReadinessBudget = { readinessTimeoutMs: 10_000 };

    const firstProvision = await provision(
      fleet,
      artifacts,
      ["desk-a"],
      loadedNetwork,
      loadedReadinessBudget,
    );
    expect(firstProvision.result.status).toBe(0);
    fleet.resetLog();
    const { report, result } = await provision(
      fleet,
      artifacts,
      ["desk-a"],
      loadedNetwork,
      loadedReadinessBudget,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.fixture.readiness.timeoutMs).toBe(10_000);
    expect(report.hosts[0]).toMatchObject({
      outcome: "already-current",
      version: "hmux 0.1.4+idempotent",
    });
    // Honest idempotence, not a reinstall that happens to converge: the second
    // run must not push the tree or invoke the installer at all.
    expect(fleet.log()).not.toContain("HMUX_EXPECTED_DIGEST");
    expect(fleet.log()).toContain("--print-prebuilt-digest");
  });

  // The important one. It fails if the digest check is removed from
  // scripts/install-hmux.sh: a substituted binary is still a valid executable,
  // so without verification the install succeeds and `current` moves onto it.
  remoteProvisioningTest(
    "refuses an artifact that did not arrive intact, before anything becomes runnable",
    async () => {
      const root = temporaryDirectory();
      const fleet = simulatedFleet(root);
      const artifacts = await prebuiltRoot(
        root,
        "corrupt",
        hostTriple,
        "0.1.4+corrupt",
        "hmux 0.1.4+corrupt",
      );

      const { report, result } = await provision(
        fleet,
        artifacts,
        ["desk-a"],
        {
          FAKE_SSH_CORRUPT_TREE: "1",
        },
      );

      expect(result.status).toBe(1);
      expect(report.hosts[0]).toMatchObject({
        outcome: "failed",
        reason: "install-refused",
      });
      expect(report.hosts[0].detail).toContain(
        "digest does not match the pinned value",
      );
      const installRoot = path.join(
        fleet.home("desk-a"),
        ".local/share/hmux",
      );
      expect(fs.existsSync(path.join(installRoot, "current"))).toBe(false);
      expect(
        fs.existsSync(path.join(installRoot, "versions/0.1.4+corrupt")),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(fleet.home("desk-a"), ".local/bin/hmux")),
      ).toBe(false);
    },
  );

  remoteProvisioningTest(
    "reports a different build already filed under the same id instead of overwriting it",
    async () => {
      const root = temporaryDirectory();
      const fleet = simulatedFleet(root);
      const first = await prebuiltRoot(
        root,
        "conflict-first",
        hostTriple,
        "0.1.4+conflict",
        "hmux original",
      );
      const second = await prebuiltRoot(
        root,
        "conflict-second",
        hostTriple,
        "0.1.4+conflict",
        "hmux rebuilt",
      );

      const firstProvision = await provision(fleet, first, ["desk-a"]);
      expect(firstProvision.result.status).toBe(0);
      expectFixtureEvidence(firstProvision.result);
      fleet.resetLog();
      const { report, result } = await provision(fleet, second, ["desk-a"]);

      expect(result.status).toBe(1);
      expectFixtureEvidence(result);
      expect(report.hosts[0]).toMatchObject({
        outcome: "failed",
        reason: "build-id-conflict",
      });
      // An actionable message, not a stack trace and not the installer's bare
      // one-liner: it names the id, both digests, and the two ways out.
      expect(report.hosts[0].detail).toContain("0.1.4+conflict");
      expect(report.hosts[0].detail).toContain("nothing was changed");
      expect(report.hosts[0].detail).toContain("own build id");
      // Refused before the bytes were sent, so a conflicting host costs one
      // round trip rather than a full upload.
      expect(fleet.log()).not.toContain("HMUX_EXPECTED_DIGEST");
      expect(
        execFileSync(
          path.join(fleet.home("desk-a"), ".local/bin/hmux"),
          [],
          { encoding: "utf8" },
        ).trim(),
      ).toBe("hmux original");
    },
  );

  remoteProvisioningTest("provisions the reachable hosts and names the ones it could not", async () => {
    const root = temporaryDirectory();
    const fleet = simulatedFleet(root);
    const artifacts = await prebuiltRoot(
      root,
      "fleet",
      hostTriple,
      "0.1.4+fleet",
      "hmux 0.1.4+fleet",
    );

    const { report, result } = await provision(
      fleet,
      artifacts,
      ["desk-down", "desk-b"],
      { FAKE_SSH_UNREACHABLE: "desk-down" },
    );

    // One dead server is one failed row. The others still get provisioned, and
    // the caller is told which did not — "provisioning finished" and "every
    // server can serve the phone" are different claims.
    expect(result.status).toBe(1);
    expect(report.hosts[0]).toMatchObject({
      host: "desk-down",
      outcome: "failed",
      reason: "unreachable",
    });
    expect(report.hosts[1]).toMatchObject({
      host: "desk-b",
      outcome: "installed",
    });
    expect(report.summary).toMatchObject({
      changed: ["desk-b"],
      failed: ["desk-down"],
      total: 2,
    });
  });

  remoteProvisioningTest("selects the artifact by what the remote reports, not by what is at hand", async () => {
    const root = temporaryDirectory();
    const fleet = simulatedFleet(root);
    const artifacts = await prebuiltRoot(
      root,
      "mixed",
      "aarch64-apple-darwin",
      "0.1.4+mixed",
      "hmux aarch64",
    );
    await prebuiltRoot(
      root,
      "mixed",
      "x86_64-apple-darwin",
      "0.1.4+mixed",
      "hmux x86_64",
    );

    // Both candidates are present, so a provisioner that picked the only tree
    // it could find would pass this by accident. The remote claims x86_64.
    const { report, result } = await provision(
      fleet,
      artifacts,
      ["desk-a"],
      {
        FAKE_UNAME_MACHINE: "x86_64",
        FAKE_UNAME_SYSTEM: "Darwin",
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(report.hosts[0]).toMatchObject({
      outcome: "installed",
      triple: "x86_64-apple-darwin",
      version: "hmux x86_64",
    });
  });

  remoteProvisioningTest("refuses a machine no published artifact targets", async () => {
    const root = temporaryDirectory();
    const fleet = simulatedFleet(root);
    const artifacts = await prebuiltRoot(
      root,
      "arm32",
      hostTriple,
      "0.1.4+arm32",
      "hmux 0.1.4+arm32",
    );

    const { report, result } = await provision(
      fleet,
      artifacts,
      ["desk-a"],
      {
        FAKE_UNAME_MACHINE: "armv7l",
        FAKE_UNAME_SYSTEM: "Linux",
      },
    );

    expect(result.status).toBe(1);
    expect(report.hosts[0]).toMatchObject({
      outcome: "failed",
      reason: "unsupported-platform",
    });
    expect(
      fs.existsSync(path.join(fleet.home("desk-a"), ".local/share/hmux")),
    ).toBe(false);
  });
});

describe("remote Hmux provisioning fixture", () => {
  remoteProvisioningTest("classifies package preparation failures as setup failures", async () => {
    const root = temporaryDirectory();

    await expect(
      prebuiltRoot(
        root,
        "invalid-build",
        hostTriple,
        "invalid/build",
        "hmux invalid",
      ),
    ).rejects.toThrow(
      `hmux_provision_fixture_failed stage=setup timeoutMs=${FIXTURE_SETUP_TIMEOUT_MS}`,
    );
  });

  remoteProvisioningTest(
    "kills owned packaging descendants when setup stalls",
    async () => {
      const root = temporaryDirectory();
      const descendantPidPath = path.join(root, "setup-descendant.pid");
      const stalledPackage = path.join(root, "stalled-package.sh");
      executable(
        stalledPackage,
        "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' \"$!\" > \"$1\"\nwait\n",
      );

      await expect(
        prebuiltRoot(
          root,
          "stalled-setup",
          hostTriple,
          "0.1.4+stalled-setup",
          "hmux stalled-setup",
          {
            packageArgs: [stalledPackage, descendantPidPath],
            setupTimeoutMs: 500,
          },
        ),
      ).rejects.toThrow(
        "hmux_provision_fixture_failed stage=setup timeoutMs=500",
      );
      expect(fs.existsSync(descendantPidPath)).toBe(true);
      expect(
        processExists(Number(fs.readFileSync(descendantPidPath, "utf8").trim())),
      ).toBe(false);
    },
  );

  remoteProvisioningTest(
    "fails at readiness when the simulated remote never reports ready",
    async () => {
      const root = temporaryDirectory();
      const fleet = simulatedFleet(root);
      const artifacts = await prebuiltRoot(
        root,
        "missing-ready",
        hostTriple,
        "0.1.4+missing-ready",
        "hmux missing-ready",
      );

      await expect(
        provision(
          fleet,
          artifacts,
          ["desk-a"],
          { FAKE_SSH_SKIP_READY: "1" },
          { readinessTimeoutMs: 100 },
        ),
      ).rejects.toThrow(
        "hmux_provision_fixture_failed stage=readiness timeoutMs=100",
      );
    },
  );

  remoteProvisioningTest(
    "kills the owned provision tree when operation stalls after readiness",
    async () => {
      const root = temporaryDirectory();
      const fleet = simulatedFleet(root);
      const artifacts = await prebuiltRoot(
        root,
        "stalled-operation",
        hostTriple,
        "0.1.4+stalled-operation",
        "hmux stalled-operation",
      );

      await expect(
        provision(
          fleet,
          artifacts,
          ["desk-a"],
          { FAKE_SSH_IGNORE_RELEASE: "1" },
          { operationTimeoutMs: 100 },
        ),
      ).rejects.toThrow(
        "hmux_provision_fixture_failed stage=operation timeoutMs=100",
      );
      expect(processExists(readyFixturePid(fleet))).toBe(false);
    },
  );

  remoteProvisioningTest(
    "kills the owned packaging tree as soon as output exceeds its bound",
    async () => {
      const root = temporaryDirectory();
      const descendantPidPath = path.join(root, "output-descendant.pid");
      const noisyPackage = path.join(root, "noisy-package.sh");
      executable(
        noisyPackage,
        "#!/bin/sh\nsleep 30 &\nprintf '%s\\n' \"$!\" > \"$1\"\nexec yes fixture-output\n",
      );

      await expect(
        prebuiltRoot(
          root,
          "excessive-output",
          hostTriple,
          "0.1.4+excessive-output",
          "hmux excessive-output",
          {
            outputLimitBytes: 1024,
            packageArgs: [noisyPackage, descendantPidPath],
          },
        ),
      ).rejects.toThrow(
        `hmux_provision_fixture_failed stage=setup timeoutMs=${FIXTURE_SETUP_TIMEOUT_MS}: fixture output exceeded 1024 bytes`,
      );
      expect(fs.existsSync(descendantPidPath)).toBe(true);
      expect(
        processExists(Number(fs.readFileSync(descendantPidPath, "utf8").trim())),
      ).toBe(false);
    },
  );
});

describe("remote Hmux provisioning decisions", () => {
  const probe = (versions, current) => ({
    current: current ?? null,
    machine: "x86_64",
    system: "Linux",
    versions,
  });

  test("selects the musl artifact for every published Linux machine", () => {
    expect(selectPrebuiltTriple({ machine: "x86_64", system: "Linux" })).toBe(
      "x86_64-unknown-linux-musl",
    );
    expect(selectPrebuiltTriple({ machine: "aarch64", system: "Linux" })).toBe(
      "aarch64-unknown-linux-musl",
    );
    // A wrong-arch binary installs and then fails to exec, so an unrecognized
    // machine has to be a refusal rather than a nearest match.
    expect(() =>
      selectPrebuiltTriple({ machine: "riscv64", system: "Linux" }),
    ).toThrow(HostRefusal);
    expect(() => selectPrebuiltTriple({ machine: "", system: "Linux" })).toThrow(
      HostRefusal,
    );
  });

  test("treats a probe with no marker as unreadable rather than as an empty machine", () => {
    expect(() => parseProbeOutput("Welcome to Ubuntu\n")).toThrow(HostRefusal);
    expect(
      parseProbeOutput(
        "probe=1\nsystem=Linux\nmachine=aarch64\ncurrent=versions/0.1.4+a\nversion=0.1.4+a\nversion=0.1.4+b\n",
      ),
    ).toEqual({
      current: "versions/0.1.4+a",
      machine: "aarch64",
      system: "Linux",
      versions: ["0.1.4+a", "0.1.4+b"],
    });
  });

  test("separates a no-op from a repair from a conflict", () => {
    const shared = { buildId: "0.1.4+a", expectedDigest: "a".repeat(64) };

    expect(
      planHostAction({
        ...shared,
        installedDigest: null,
        probe: probe([]),
      }),
    ).toEqual({ action: "install" });
    expect(
      planHostAction({
        ...shared,
        installedDigest: "a".repeat(64),
        probe: probe(["0.1.4+a"], "versions/0.1.4+a"),
      }),
    ).toEqual({ action: "none" });
    // Right bytes on disk but `current` elsewhere is an interrupted install,
    // and re-pointing it is real work — it does not get to claim it was a no-op.
    expect(
      planHostAction({
        ...shared,
        installedDigest: "a".repeat(64),
        probe: probe(["0.1.4+a", "0.1.4+b"], "versions/0.1.4+b"),
      }),
    ).toEqual({ action: "activate" });
    expect(
      planHostAction({
        ...shared,
        installedDigest: "b".repeat(64),
        probe: probe(["0.1.4+a"], "versions/0.1.4+a"),
      }),
    ).toMatchObject({ action: "refuse", reason: "build-id-conflict" });
    // A version directory that will not hash fails closed. Pushing over an
    // immutable build nobody can read is the one thing the store exists to stop.
    expect(
      planHostAction({
        ...shared,
        installedDigest: null,
        probe: probe(["0.1.4+a"], "versions/0.1.4+a"),
      }),
    ).toMatchObject({ action: "refuse", reason: "unreadable-installed-build" });
  });

  test("quotes values that reach the remote shell", () => {
    expect(quoteForRemoteShell("0.1.4+a")).toBe("'0.1.4+a'");
    expect(quoteForRemoteShell("a'; rm -rf /; '")).toBe(
      `'a'\\''; rm -rf /; '\\'''`,
    );
  });
});
