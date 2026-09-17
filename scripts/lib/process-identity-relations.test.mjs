import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  macosProcessBoundaryCompileArguments,
  observeCurrentUserProcessIdentities,
  observeProcessMembers,
  processCurrentUserTopology,
  processMemberSnapshots,
} from "./process-identity.mjs";

const LINUX_PROCESS_BOUNDARY = fileURLToPath(
  new URL("../native/linux-process-boundary.py", import.meta.url),
);
const PROCESS_IDENTITY_MODULE = fileURLToPath(
  new URL("./process-identity.mjs", import.meta.url),
);
const CENSUS_TEST_IDENTITY = process.platform === "darwin"
  ? "kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:101"
  : "linux:test-boot:101";

function nativeUserTopology(fault, operation = "observe-user-topology") {
  let fixtureRoot;
  let command;
  let args;
  if (process.platform === "darwin") {
    fixtureRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(os.tmpdir()), "dure-user-topology-"),
    );
    command = path.join(fixtureRoot, "process-boundary");
    const compileArguments = macosProcessBoundaryCompileArguments(command);
    compileArguments.splice(
      1,
      0,
      "-DDURE_OWNERSHIP_OBSERVER_FAULT_INJECTION=1",
    );
    const compiled = spawnSync("cc", compileArguments, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    if (compiled.status !== 0) {
      throw new Error(`process boundary compile failed: ${compiled.stderr}`);
    }
    args = [operation];
  } else {
    command = "python3";
    args = [LINUX_PROCESS_BOUNDARY, operation];
  }

  try {
    const observed = spawnSync(command, args, {
      encoding: "utf8",
      env: fault
        ? {
            ...process.env,
            DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: fault,
          }
        : process.env,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
    });
    return {
      observerPid: observed.pid,
      signal: observed.signal,
      status: observed.status,
      stderr: observed.stderr,
      stdout: observed.stdout,
    };
  } finally {
    if (fixtureRoot) {
      fs.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  }
}

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "process identity relations",
  () => {
    it("returns one complete authoritative member shape", () => {
      const observation = processMemberSnapshots([process.pid]);
      expect(observation).toMatchObject({
        status: "complete",
        scope: { kind: "point", requestedPids: [process.pid] },
      });
      expect(observation.members).toHaveLength(1);
      expect(observation.members[0]).toMatchObject({
        pid: process.pid,
        parentPid: process.ppid,
        groupId: expect.any(Number),
        sessionId: expect.any(Number),
        state: expect.stringMatching(/^(?:live|stopped|zombie)$/u),
        processIdentity: expect.any(String),
        startedAtUnixSeconds: expect.any(Number),
      });
      expect(observation.members[0].startedAtUnixSeconds).toBeGreaterThan(0);
    });

    it("returns the same identity from positive current-user topology", () => {
      const point = processMemberSnapshots([process.pid]);
      const topology = processCurrentUserTopology();
      expect(topology).toMatchObject({
        status: "complete",
        scope: {
          evidence: "positive_only",
          kind: "current_user_topology",
        },
      });
      expect(topology.members.find(({ pid }) => pid === process.pid)).toEqual(
        point.members[0],
      );
      expect(
        topology.members.some(
          ({ groupId, parentPid, pid }) =>
            parentPid === process.pid && groupId === pid,
        ),
      ).toBe(false);
    });

    it("returns a fail-closed current-user census through the shared observation contract", async () => {
      const point = processMemberSnapshots([process.pid]);
      const census = await observeProcessMembers({ kind: "user_census" });
      expect(census).toMatchObject({
        status: "complete",
        scope: {
          effectiveUid: process.geteuid(),
          evidence: "closed_enumeration",
          kind: "user_census",
        },
      });
      expect(census.members.find(({ pid }) => pid === process.pid)).toEqual(
        point.members[0],
      );
    });

    it("rejects a reused exact process before enumerating a native census", async () => {
      const point = processMemberSnapshots([process.pid]);
      expect(point.status).toBe("complete");
      const identity = point.members[0].processIdentity;
      const split = identity.lastIndexOf(":");
      const expectedProcess = {
        pid: process.pid,
        processIdentity: identity.slice(0, split + 1) +
          (BigInt(identity.slice(split + 1)) + 1n),
      };
      const observation = await observeProcessMembers({
        kind: "user_census",
        expectedProcess,
      });

      expect(observation).toMatchObject({
        reason: "process_generation_changed",
        scope: { expectedProcess },
        status: "incomplete",
      });
      expect(observation.members).toBeUndefined();
    });

    it.each([
      null,
      { pid: 1, processIdentity: CENSUS_TEST_IDENTITY },
      { pid: 41_001.5, processIdentity: CENSUS_TEST_IDENTITY },
      { pid: 41_001, processIdentity: "ps-lstart-v1:approximate" },
    ])("rejects an invalid exact census precondition: %j", async (expectedProcess) => {
      await expect(observeProcessMembers({
        kind: "user_census",
        expectedProcess,
      })).rejects.toThrow("invalid census process precondition");
    });

    it("checks the Linux census generation before metadata and preserves unknown", () => {
      const result = spawnSync("python3", ["-c", `
import importlib.util
import sys
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location("boundary", sys.argv[1])
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)
boundary.read_boot_id = lambda: "boot-current"
boundary.read_boot_time_seconds = Mock(return_value=1)
boundary.read_clock_ticks_per_second = lambda: 100
boundary.os.listdir = Mock(return_value=[])

for boot, ticks in [("boot-current", "102"), ("boot-old", "101")]:
    boundary.read_process_identity = lambda _pid: {"start_ticks": "101"}
    try:
        boundary.observe_user_census(["41001", boot, ticks])
    except SystemExit as error:
        assert error.code == 4
    else:
        raise AssertionError("reused census process accepted")
    boundary.read_boot_time_seconds.assert_not_called()
    boundary.os.listdir.assert_not_called()

def unknown(_pid):
    boundary.fail("injected identity unknown")
boundary.read_process_identity = unknown
try:
    boundary.observe_user_census(["41001", "boot-current", "101"])
except SystemExit as error:
    assert error.code == 5
else:
    raise AssertionError("unknown identity accepted")
boundary.read_boot_time_seconds.assert_not_called()
boundary.os.listdir.assert_not_called()

for identity in [None, {"start_ticks": "101"}]:
    boundary.read_process_identity = lambda _pid: identity
    boundary.observe_user_census(["41001", "boot-current", "101"])
assert boundary.os.listdir.call_count == 2
`, LINUX_PROCESS_BOUNDARY], {
        encoding: "utf8",
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
        timeout: 5_000,
      });
      expect(result.status, result.stderr).toBe(0);
    });

    it.runIf(process.platform === "darwin")(
      "returns exact parent identities without requiring BSD metadata",
      async () => {
        const point = processMemberSnapshots([process.pid]);
        const census = await observeCurrentUserProcessIdentities();
        expect(census).toMatchObject({
          scope: {
            effectiveUid: process.geteuid(),
            evidence: "closed_enumeration",
            kind: "user_identity_census",
          },
          status: "complete",
        });
        expect(
          census.relations.find(({ pid }) => pid === process.pid),
        ).toMatchObject({
          parentProcessIdentity: expect.any(String),
          processIdentity: point.members[0].processIdentity,
        });

        const bsdUnavailable = nativeUserTopology(
          "bsd-eperm",
          "observe-user-identities",
        );
        expect(bsdUnavailable, bsdUnavailable.stderr).toMatchObject({
          signal: null,
          status: 0,
        });
      },
    );

    it("omits the transient observer from current-user topology", () => {
      const observation = nativeUserTopology();
      expect(observation, observation.stderr).toMatchObject({
        signal: null,
        status: 0,
      });
      const observedPids = observation.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => Number(line.split(" ")[1]));
      expect(observedPids).not.toContain(observation.observerPid);
    });

    it("keeps a large point observation inside bounded argv batches", async () => {
      const requestedPids = Array.from(
        { length: 25_000 },
        (_, index) => 2_000_000_000 + index,
      );
      const observation = await observeProcessMembers(
        { kind: "point", pids: requestedPids },
        { timeoutMs: 30_000 },
      );
      expect(observation.status).toBe("complete");
      expect(observation.scope.requestedPids).toHaveLength(
        requestedPids.length,
      );
      expect(observation.members).toEqual([]);
    }, 45_000);

    it.runIf(process.platform === "darwin")(
      "skips a stale user-topology UID candidate",
      () => {
        const observation = nativeUserTopology(
          "user-topology-uid-mismatch",
        );
        expect(observation, observation.stderr).toMatchObject({
          signal: null,
          status: 0,
          stdout: "",
        });
      },
    );

    it.runIf(process.platform === "darwin")(
      "fails a closed user census on an unclassified UID candidate",
      () => {
        const observation = nativeUserTopology(
          "user-topology-uid-mismatch",
          "observe-user-census",
        );
        expect(observation).toMatchObject({ signal: null, status: 15 });
      },
    );

    it.runIf(process.platform === "darwin")(
      "fails a same-generation session transition closed",
      () => {
        const observation = nativeUserTopology("member-session-drift");
        expect(observation, observation.stderr).toMatchObject({
          signal: null,
          status: 15,
        });
      },
    );

    it.runIf(process.platform === "darwin")(
      "keeps cold boundary preparation inside the observation deadline",
      () => {
        const fixtureRoot = fs.mkdtempSync(
          path.join(fs.realpathSync(os.tmpdir()), "dure-cold-boundary-"),
        );
        const compilerRoot = path.join(fixtureRoot, "bin");
        const temporaryRoot = path.join(fixtureRoot, "tmp");
        fs.mkdirSync(compilerRoot, { mode: 0o700 });
        fs.mkdirSync(temporaryRoot, { mode: 0o700 });
        fs.writeFileSync(
          path.join(compilerRoot, "cc"),
          `#!${process.execPath}\nsetTimeout(() => {}, 500);\n`,
          { mode: 0o700 },
        );
        try {
          const result = spawnSync(
            process.execPath,
            [
              "--input-type=module",
              "-e",
              `
                import { pathToFileURL } from "node:url";
                const { observeProcessMembers } = await import(
                  pathToFileURL(process.argv[1])
                );
                const startedAt = performance.now();
                const observation = await observeProcessMembers(
                  { kind: "point", pids: [process.pid] },
                  { timeoutMs: 50 },
                );
                process.stdout.write(JSON.stringify({
                  durationMs: performance.now() - startedAt,
                  observation,
                }));
              `,
              PROCESS_IDENTITY_MODULE,
            ],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                PATH: `${compilerRoot}:${process.env.PATH ?? ""}`,
                TMPDIR: temporaryRoot,
              },
              timeout: 2_000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          const measured = JSON.parse(result.stdout);
          expect(measured.observation).toMatchObject({
            reason: "process_member_observation_timeout",
            status: "incomplete",
          });
          expect(measured.durationMs).toBeLessThan(500);
        } finally {
          fs.rmSync(fixtureRoot, { force: true, recursive: true });
        }
      },
    );

    it("classifies a synchronous adapter deadline as a timeout", () => {
      const fixtureRoot = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-sync-timeout-"),
      );
      const adapterRoot = path.join(fixtureRoot, "bin");
      fs.mkdirSync(adapterRoot, { mode: 0o700 });
      fs.writeFileSync(
        path.join(adapterRoot, "python3"),
        `#!${process.execPath}\nsetTimeout(() => {}, 5000);\n`,
        { mode: 0o700 },
      );
      try {
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
              import { pathToFileURL } from "node:url";
              const { processCurrentUserTopology } = await import(
                pathToFileURL(process.argv[1])
              );
              process.stdout.write(
                JSON.stringify(processCurrentUserTopology("linux")),
              );
            `,
            PROCESS_IDENTITY_MODULE,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${adapterRoot}:${process.env.PATH ?? ""}`,
            },
            timeout: 4_000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          reason: "process_member_observation_timeout",
          status: "incomplete",
        });
      } finally {
        fs.rmSync(fixtureRoot, { force: true, recursive: true });
      }
    });

    it.runIf(process.platform === "linux")(
      "accepts a legal non-UTF-8 Linux process name",
      async () => {
        const child = spawn(
          "python3",
          [
            "-c",
            "import ctypes,time; " +
              "libc=ctypes.CDLL(None,use_errno=True); " +
              "result=libc.prctl(15,ctypes.c_char_p(b'\\xff'),0,0,0); " +
              "assert result == 0; print('ready',flush=True); time.sleep(300)",
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        const closed = new Promise((resolve) => child.once("close", resolve));
        await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.stdout.once("data", resolve);
        });
        try {
          const point = processMemberSnapshots([child.pid], "linux");
          expect(point.status).toBe("complete");
          expect(point.members).toHaveLength(1);
          const topology = processCurrentUserTopology("linux");
          expect(topology.status).toBe("complete");
          expect(topology.members.find(({ pid }) => pid === child.pid)).toEqual(
            point.members[0],
          );
        } finally {
          child.kill("SIGKILL");
          await closed;
        }
      },
    );

    it(
      "skips inaccessible PIDs only for positive user topology",
      () => {
        const result = spawnSync(
          "python3",
          [
            "-c",
            `
import errno
import importlib.util
import sys

spec = importlib.util.spec_from_file_location("boundary", sys.argv[1])
boundary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boundary)

def denied(*_args, **_kwargs):
    raise PermissionError(errno.EACCES, "hidden proc entry")

boundary.os.open = denied
assert boundary.read_user_process_identity(42) is None
try:
    boundary.read_user_process_identity(42, closed_enumeration=True)
except SystemExit as error:
    assert error.code == 5
else:
    raise AssertionError("closed user census permission failure was hidden")
            `,
            LINUX_PROCESS_BOUNDARY,
          ],
          {
            encoding: "utf8",
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
          },
        );
        expect(result.status, result.stderr).toBe(0);
      },
    );
  },
);
