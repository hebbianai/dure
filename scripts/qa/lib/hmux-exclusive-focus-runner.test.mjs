import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const runner = path.resolve(
  "scripts/qa/lib/hmux-exclusive-focus-runner.sh",
);
const webviewRecoveryRunner = path.resolve(
  "scripts/qa/hmux-webview-recovery-smoke.sh",
);
const temporaryDirectories = [];
const holders = [];

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hmux-focus-lock-"));
  temporaryDirectories.push(directory);
  return directory;
}

function runPreflight(overrides = {}) {
  const env = {
    ...process.env,
    HEBBIAN_QA_NAME: "exclusive preflight fixture",
    HEBBIAN_QA_EXCLUSIVE_PREFLIGHT_ONLY: "1",
    HEBBIAN_QA_EXCLUSIVE_MIN_IDLE_MS: "0",
    ...overrides,
  };
  if (overrides.HEBBIAN_QA_ALLOW_FOCUS_STEAL === undefined) {
    delete env.HEBBIAN_QA_ALLOW_FOCUS_STEAL;
  }
  return spawnSync("/bin/sh", [runner], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8",
    timeout: 5_000,
  });
}

afterEach(() => {
  for (const holder of holders.splice(0)) holder.kill("SIGTERM");
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  webviewRecoveryRunner,
  path.resolve("scripts/qa/pane-focus-history-smoke.sh"),
])("%s skips before entering the app runner", (smokeRunner) => {
  const fixtureDirectory = temporaryDirectory();
  const binDirectory = path.join(fixtureDirectory, "bin");
  const appRunnerMarker = path.join(fixtureDirectory, "app-runner-entered");
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(
    path.join(binDirectory, "uname"),
    [
      "#!/bin/sh",
      ': >"$DURE_QA_TEST_APP_RUNNER_MARKER"',
      "printf 'Linux\\n'",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    DURE_QA_TEST_APP_RUNNER_MARKER: appRunnerMarker,
    HEBBIAN_QA_EXCLUSIVE_LOCK_WAIT_SECONDS: "0",
    PATH: `${binDirectory}:${process.env.PATH}`,
  };
  delete env.DURE_QA_REQUIRE_EXECUTION;
  delete env.HEBBIAN_QA_ALLOW_FOCUS_STEAL;
  delete env.HEBBIAN_QA_REQUIRE_EXECUTION;

  const result = spawnSync("/bin/sh", [smokeRunner], {
    cwd: path.resolve("."),
    env,
    encoding: "utf8",
    timeout: 5_000,
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toContain("SKIP");
  expect(result.stderr).toContain("explicit_opt_in_required");
  expect(fs.existsSync(appRunnerMarker)).toBe(false);
});

describe.skipIf(process.platform !== "darwin")(
  "exclusive focus runner admission",
  () => {
    test("skips before starting Tauri without explicit permission", () => {
      const result = runPreflight();

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("SKIP");
      expect(result.stderr).toContain("explicit_opt_in_required");
      expect(result.stdout).not.toContain("RUN");
    });

    test("treats a requested CI execution skip as non-success", () => {
      const result = runPreflight({
        HEBBIAN_QA_REQUIRE_EXECUTION: "1",
      });

      expect(result.status).toBe(22);
      expect(result.stderr).toContain("explicit_opt_in_required");
      expect(result.stdout).not.toContain("RUN");
    });

    test("admits an explicitly allowed idle preflight", () => {
      const lockFile = path.join(temporaryDirectory(), "focus.lock");
      const result = runPreflight({
        HEBBIAN_QA_ALLOW_FOCUS_STEAL: "1",
        HEBBIAN_QA_EXCLUSIVE_LOCK_FILE: lockFile,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("RUN");
      expect(result.stderr).not.toContain("SKIP");
    });

    test("skips when another checkout owns the machine-global advisory lock", async () => {
      const fixtureDirectory = temporaryDirectory();
      const lockFile = path.join(fixtureDirectory, "focus.lock");
      const holderReady = path.join(fixtureDirectory, "holder.ready");
      const holder = spawn(
        "/usr/bin/lockf",
        [
          "-k",
          lockFile,
          "/bin/sh",
          "-c",
          ': >"$1"; exec /bin/sleep 5',
          "focus-lock-holder",
          holderReady,
        ],
        { stdio: "ignore" },
      );
      holders.push(holder);
      const deadline = Date.now() + 2_000;
      while (!fs.existsSync(holderReady) && Date.now() < deadline) {
        if (holder.exitCode !== null || holder.signalCode !== null) {
          throw new Error(
            `focus lock holder exited before readiness: code=${holder.exitCode} signal=${holder.signalCode}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(fs.existsSync(holderReady)).toBe(true);
      const probe = spawnSync(
        "/usr/bin/lockf",
        ["-s", "-t", "0", lockFile, "/usr/bin/true"],
        { timeout: 1_000 },
      );
      expect(probe.status).toBe(75);

      const result = runPreflight({
        HEBBIAN_QA_ALLOW_FOCUS_STEAL: "1",
        HEBBIAN_QA_EXCLUSIVE_LOCK_FILE: lockFile,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("exclusive_lock_busy");
      expect(result.stdout).not.toContain("RUN");
    });

    test("releases the advisory lock when the runner exits", () => {
      const lockFile = path.join(temporaryDirectory(), "focus.lock");
      const result = runPreflight({
        HEBBIAN_QA_ALLOW_FOCUS_STEAL: "1",
        HEBBIAN_QA_EXCLUSIVE_LOCK_FILE: lockFile,
      });

      expect(result.status).toBe(0);
      const reacquire = spawnSync(
        "/usr/bin/lockf",
        ["-s", "-t", "0", lockFile, "/usr/bin/true"],
        { timeout: 1_000 },
      );
      expect(reacquire.status).toBe(0);
    });
  },
);
