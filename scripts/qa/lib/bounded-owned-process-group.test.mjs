import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { BOUNDED_GROUP_COMPLETION } from "./bounded-owned-process-group.mjs";
import {
  exactOwnedProcessIdentity,
  readOwnedProcessGroup,
  readOwnedProcessLedger,
  readOwnedProcessLedgerForRetirement,
  terminateOwnedProcessGroup,
} from "./owned-process-group.mjs";
import { macosProcessMarkerToolPath } from "./macos-ownership-observer.mjs";
import { compileFaultInjectableMacosObserver } from "./owned-process-observer-fixture.mjs";
import {
  processLivenessFromObservation,
  processMemberFromObservation,
  processMemberSnapshots,
  signalProcessGenerationSync,
} from "../../lib/process-identity.mjs";

const adapter = fileURLToPath(
  new URL("./bounded-owned-process-group.mjs", import.meta.url),
);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(condition, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("bounded fixture timed out");
    await wait(20);
  }
}

function observeIdentity(pid) {
  const observation = processMemberSnapshots([pid]);
  const observed = processMemberFromObservation(pid, observation);
  return observed.status === "present"
    ? {
        pid: observed.member.pid,
        processIdentity: observed.member.processIdentity,
      }
    : null;
}

function identityLiveness(identity) {
  if (!identity) return "unknown";
  return processLivenessFromObservation(
    identity,
    processMemberSnapshots([identity.pid]),
  );
}

function isActive(identity) {
  return identityLiveness(identity) === "active";
}

async function captureIdentity(pid) {
  let identity;
  await waitFor(() => {
    identity = observeIdentity(pid);
    return identity !== null;
  });
  return identity;
}

function startFixture({
  environment = {},
  nodeImports = [],
  source,
  timeout = "5",
  root = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-group-"),
  ),
}) {
  const marker = path.join(root, "command.pid");
  const child = spawn(
    process.execPath,
    [
      ...nodeImports.flatMap((module) => ["--import", module]),
      adapter,
      "run",
      root,
      "--timeout-seconds",
      timeout,
      "--",
      process.execPath,
      "-e",
      source,
      marker,
    ],
    {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    closed,
    descriptor: path.join(root, "group.json"),
    identities: new Map(),
    marker,
    receipt: path.join(root, "completion.json"),
    root,
    stderr: () => stderr,
  };
}

async function rememberMarkerIdentity(fixture, waitForActive = false) {
  if (!fs.existsSync(fixture.marker)) return null;
  const pid = Number(fs.readFileSync(fixture.marker, "utf8").trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const identity = waitForActive
    ? await captureIdentity(pid)
    : observeIdentity(pid);
  if (!identity) return null;
  fixture.identities.set(identity.pid, identity);
  return identity;
}

function rememberDescriptorIdentities(fixture) {
  if (!fs.existsSync(fixture.descriptor)) return;
  const descriptor = readOwnedProcessGroup(fixture.descriptor);
  for (const identity of [
    exactOwnedProcessIdentity({
      kernelStartMarker: descriptor.leaderKernelStartMarker,
      pid: descriptor.leaderPid,
    }),
    exactOwnedProcessIdentity({
      kernelStartMarker: descriptor.supervisorKernelStartMarker,
      pid: descriptor.supervisorPid,
    }),
  ]) {
    fixture.identities.set(identity.pid, identity);
  }
}

async function cleanupFixture(fixture) {
  try {
    if (fs.existsSync(fixture.marker)) await rememberMarkerIdentity(fixture);
  } catch {
    // A captured descriptor below remains the cleanup authority.
  }
  try {
    rememberDescriptorIdentities(fixture);
    if (fs.existsSync(fixture.descriptor)) {
      const descriptor = readOwnedProcessGroup(fixture.descriptor);
      await terminateOwnedProcessGroup(
        exactOwnedProcessIdentity({
          kernelStartMarker: descriptor.leaderKernelStartMarker,
          pid: descriptor.leaderPid,
        }),
        { timeoutMs: 3_000 },
      );
    }
  } catch {
    // Exact per-generation fallback below handles a retired descriptor.
  }
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGTERM");
    await Promise.race([fixture.closed.catch(() => {}), wait(5_000)]);
  }
  for (const identity of fixture.identities.values()) {
    if (isActive(identity)) signalProcessGenerationSync(identity, "SIGKILL");
  }
  for (const identity of fixture.identities.values()) {
    await waitFor(() => identityLiveness(identity) === "stale", 5_000);
  }
  fs.rmSync(fixture.root, { force: true, recursive: true });
}

function expectCompletion(fixture) {
  expect(JSON.parse(fs.readFileSync(fixture.receipt, "utf8"))).toEqual(
    BOUNDED_GROUP_COMPLETION,
  );
}

function expectRememberedIdentitiesStopped(fixture) {
  for (const identity of fixture.identities.values()) {
    expect(identityLiveness(identity), `process ${identity.pid} did not exit`).toBe(
      "stale",
    );
  }
}

describe.runIf(["darwin", "linux"].includes(process.platform))(
  "bounded owned process groups",
  () => {
    test("rejects invalid deadlines before starting a command", () => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-invalid-"),
      );
      try {
        for (const timeout of ["NaN", "0", "2147483.648"]) {
          const marker = path.join(root, `ran-${timeout}`);
          const result = spawnSync(
            process.execPath,
            [
              adapter,
              "run",
              root,
              "--timeout-seconds",
              timeout,
              "--",
              process.execPath,
              "-e",
              'require("node:fs").writeFileSync(process.argv[1], "ran\\n")',
              marker,
            ],
            { encoding: "utf8", timeout: 5_000 },
          );
          expect(result.status, result.stderr).toBe(97);
          expect(fs.existsSync(marker)).toBe(false);
        }
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    });

    test("distinguishes command status 97 from cleanup failure", () => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-status-"),
      );
      try {
        const result = spawnSync(
          process.execPath,
          [
            adapter,
            "run",
            root,
            "--timeout-seconds",
            "2",
            "--",
            process.execPath,
            "-e",
            "process.exit(97)",
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(97);
        expect(
          JSON.parse(
            fs.readFileSync(path.join(root, "completion.json"), "utf8"),
          ),
        ).toEqual(BOUNDED_GROUP_COMPLETION);
        expect(fs.readdirSync(root)).toEqual(["completion.json"]);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    });

    test("admits only one supervisor for a control root", async () => {
      const fixture = startFixture({
        source: [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], `${process.pid}\\n`);',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      });
      const contenderMarker = path.join(fixture.root, "contender-ran");
      try {
        await waitFor(
          () =>
            fs.existsSync(fixture.descriptor) &&
            fs.existsSync(fixture.marker),
        );
        rememberDescriptorIdentities(fixture);
        await rememberMarkerIdentity(fixture, true);
        const contender = spawnSync(
          process.execPath,
          [
            adapter,
            "run",
            fixture.root,
            "--timeout-seconds",
            "2",
            "--",
            process.execPath,
            "-e",
            'require("node:fs").writeFileSync(process.argv[1], "ran\\n")',
            contenderMarker,
          ],
          { encoding: "utf8", timeout: 5_000 },
        );
        expect(contender.status, contender.stderr).toBe(97);
        expect(contender.stderr).toContain("control root is already active");
        expect(fs.existsSync(contenderMarker)).toBe(false);

        fs.writeFileSync(path.join(fixture.root, "cancel"), "", {
          flag: "wx",
          mode: 0o600,
        });
        await expect(fixture.closed).resolves.toEqual({
          code: 143,
          signal: null,
        });
        expectCompletion(fixture);
        expectRememberedIdentitiesStopped(fixture);
      } finally {
        await cleanupFixture(fixture);
      }
    });

    test("starts its deadline after admission and cleans the exact command", async () => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-deadline-"),
      );
      const observationPath = path.join(root, "retirement.json");
      const groupModule = new URL("./owned-process-group.mjs", import.meta.url).href;
      // Observe the real retirement without changing deletion or deadline timing.
      const observer = `
import fs from "node:fs";
import {
  readOwnedProcessGroup,
  readOwnedProcessLedgerForRetirement,
} from ${JSON.stringify(groupModule)};
const descriptorPath = ${JSON.stringify(path.join(root, "group.json"))};
const remove = fs.rmSync;
fs.rmSync = function(file, options) {
  if (file === descriptorPath) {
    const descriptor = readOwnedProcessGroup(file);
    const processes = readOwnedProcessLedgerForRetirement(descriptor);
    fs.writeFileSync(${JSON.stringify(observationPath)}, JSON.stringify({ descriptor, processes }), { flag: "wx", mode: 0o600 });
  }
  return remove.call(this, file, options);
};
`;
      const fixture = startFixture({
        root,
        nodeImports: [`data:text/javascript,${encodeURIComponent(observer)}`],
        environment: {
          DURE_QA_PROCESS_KILL_GRACE_MS: "100",
          DURE_QA_PROCESS_TERM_GRACE_MS: "100",
          DURE_QA_TEST_POST_ACK_DELAY_MS: "500",
        },
        source: [
          'const fs = require("node:fs");',
          'fs.writeFileSync(process.argv[1], `${process.pid}\\n`);',
          'process.on("SIGTERM", () => {});',
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        timeout: "0.2",
      });
      try {
        // A delayed observer can first run after the bounded command exits.
        await expect(fixture.closed).resolves.toEqual({ code: 124, signal: null });
        const { descriptor, processes } = JSON.parse(
          fs.readFileSync(observationPath, "utf8"),
        );
        for (const process of [
          ...processes,
          {
            pid: descriptor.supervisorPid,
            kernelStartMarker: descriptor.supervisorKernelStartMarker,
          },
        ]) {
          const identity = exactOwnedProcessIdentity(process);
          fixture.identities.set(identity.pid, identity);
        }
        const commandPid = Number(fs.readFileSync(fixture.marker, "utf8").trim());
        expect(processes.find(({ pid }) => pid === commandPid)).toMatchObject({
          parentPid: descriptor.leaderPid,
          groupId: descriptor.groupId,
        });
        const command = fixture.identities.get(commandPid);
        expect(command).toBeDefined();
        expect(fixture.stderr()).toBe("");
        expectCompletion(fixture);
        expect(identityLiveness(command)).toBe("stale");
        expectRememberedIdentitiesStopped(fixture);
        fs.rmSync(observationPath);
        expect(fs.readdirSync(fixture.root)).toEqual([
          "command.pid",
          "completion.json",
        ]);
      } finally {
        await cleanupFixture(fixture);
      }
    });

    test("cancels during startup acknowledgement with a verified receipt", async () => {
      const fixture = startFixture({
        environment: {
          DURE_QA_TEST_ACK_MARKER: "1",
          DURE_QA_TEST_POST_ACK_DELAY_MS: "1000",
        },
        source:
          'require("node:fs").writeFileSync(process.argv[1], `${process.pid}\\n`); setInterval(() => {}, 1000);',
      });
      try {
        await waitFor(() =>
          fs.existsSync(`${fixture.descriptor}.startup-ack`),
        );
        rememberDescriptorIdentities(fixture);
        fs.writeFileSync(path.join(fixture.root, "cancel"), "", {
          flag: "wx",
          mode: 0o600,
        });
        await expect(fixture.closed).resolves.toEqual({
          code: 143,
          signal: null,
        });
        expectCompletion(fixture);
        expect(fs.existsSync(fixture.marker)).toBe(false);
        expectRememberedIdentitiesStopped(fixture);
        expect(fs.readdirSync(fixture.root).sort()).toEqual([
          "cancel",
          "completion.json",
          "group.json.startup-ack",
        ]);
      } finally {
        await cleanupFixture(fixture);
      }
    });

    test.runIf(process.platform === "darwin").each([
      ["deadline", "exited", 124],
      ["cancellation", "exited", 143],
      ["cancellation", "live", 97],
      ["cancellation", "descendant", 97],
    ])(
      "%s preserves false-policy identity seals (%s closure)",
      async (ending, closure, status) => {
        const root = fs.mkdtempSync(
          path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-seal-"),
        );
        let fixture;
        try {
          compileFaultInjectableMacosObserver(
            macosProcessMarkerToolPath(path.join(root, "group.json")),
          );
          const seedSource = [
            'const fs = require("node:fs");',
            'const path = require("node:path");',
            'const { spawn } = require("node:child_process");',
            "const root = process.argv[1];",
            ...(closure === "descendant"
              ? [
                  'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
                  "child.unref();",
                  'fs.writeFileSync(path.join(root, "descendant.pid"), String(child.pid));',
                ]
              : []),
            "const timer = setInterval(() => {",
            '  if (fs.existsSync(path.join(root, "release-seed"))) clearInterval(timer);',
            "}, 20);",
          ].join("\n");
          fixture = startFixture({
            root,
            environment: {
              DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT: "bsd-eperm-after-barrier",
              NODE_ENV: "test",
            },
            source: [
              'const fs = require("node:fs");',
              'const path = require("node:path");',
              'const { spawn } = require("node:child_process");',
              "const root = path.dirname(process.argv[1]);",
              "fs.writeFileSync(process.argv[1], String(process.pid));",
              "const seed = spawn(process.execPath, ['-e', " +
                JSON.stringify(seedSource) +
                ', root], { detached: true, stdio: "ignore" });',
              "seed.unref();",
              'fs.writeFileSync(path.join(root, "seed.pid"), String(seed.pid));',
              "setInterval(() => {}, 1000);",
            ].join("\n"),
          });
          const seedPath = path.join(root, "seed.pid");
          await waitFor(() => fs.existsSync(seedPath));
          rememberDescriptorIdentities(fixture);
          await rememberMarkerIdentity(fixture, true);
          const seed = await captureIdentity(
            Number(fs.readFileSync(seedPath, "utf8")),
          );
          fixture.identities.set(seed.pid, seed);
          let descendant;
          if (closure === "descendant") {
            const descendantPath = path.join(root, "descendant.pid");
            await waitFor(() => fs.existsSync(descendantPath));
            descendant = await captureIdentity(
              Number(fs.readFileSync(descendantPath, "utf8")),
            );
            fixture.identities.set(descendant.pid, descendant);
          }
          await waitFor(() => {
            try {
              readOwnedProcessLedgerForRetirement(
                readOwnedProcessGroup(fixture.descriptor),
              );
              return false;
            } catch (error) {
              return String(error).includes(
                "identity-only ownership requires exact recovery",
              );
            }
          });
          if (closure !== "live") {
            fs.writeFileSync(path.join(root, "release-seed"), "", { mode: 0o600 });
            await waitFor(() => identityLiveness(seed) === "stale");
          }
          if (ending === "cancellation") {
            fs.writeFileSync(path.join(root, "cancel"), "", {
              flag: "wx",
              mode: 0o600,
            });
          }
          // A refusal can leave owned children holding the runner's stderr.
          // Observe its exit before fixture cleanup closes those child pipes.
          await waitFor(() =>
            fixture.child.exitCode !== null || fixture.child.signalCode !== null
          );
          expect(
            { code: fixture.child.exitCode, signal: fixture.child.signalCode },
            fixture.stderr(),
          ).toEqual({ code: status, signal: null });
          if (status === 97) {
            expect(fs.existsSync(fixture.receipt)).toBe(false);
            expect(fs.existsSync(path.join(root, "active"))).toBe(true);
            expect(fs.existsSync(fixture.descriptor)).toBe(true);
            const survivor = descendant ?? seed;
            const observation = processMemberSnapshots([survivor.pid]);
            expect(processLivenessFromObservation(survivor, observation)).toBe(
              "active",
            );
            expect(
              processMemberFromObservation(survivor.pid, observation).member?.state,
            ).toBe("live");
          } else {
            await fixture.closed;
            expectCompletion(fixture);
            expect(fs.existsSync(path.join(root, "active"))).toBe(false);
            expect(fs.existsSync(fixture.descriptor)).toBe(false);
            expectRememberedIdentitiesStopped(fixture);
          }
        } finally {
          if (fixture) await cleanupFixture(fixture);
          else fs.rmSync(root, { force: true, recursive: true });
        }
      },
      20_000,
    );

    test("does not arm a deadline after command admission lifecycle closes", async () => {
      const fixture = startFixture({
        environment: {
          DURE_QA_TEST_COMMAND_GATE_ADMISSION_DELAY_MS: "500",
        },
        source:
          'require("node:fs").writeFileSync(process.argv[1], `${process.pid}\\n`)',
        timeout: "60",
      });
      try {
        const admissionMarker = `${fixture.descriptor}.command-gate-admission`;
        await waitFor(() => fs.existsSync(admissionMarker));
        const descriptor = readOwnedProcessGroup(fixture.descriptor);
        const admittedGate = readOwnedProcessLedger(descriptor).find(
          (member) =>
            member.parentPid === descriptor.leaderPid &&
            member.pid !== descriptor.leaderPid,
        );
        expect(admittedGate).toBeDefined();
        const gateIdentity = exactOwnedProcessIdentity({
          kernelStartMarker: admittedGate.kernelStartMarker,
          pid: admittedGate.pid,
        });
        fixture.identities.set(gateIdentity.pid, gateIdentity);
        rememberDescriptorIdentities(fixture);
        expect(
          signalProcessGenerationSync(
            fixture.identities.get(descriptor.leaderPid),
            "SIGKILL",
          ),
        ).toBe(true);

        const result = await Promise.race([
          fixture.closed,
          wait(5_000).then(() => {
            throw new Error("late command deadline kept the supervisor alive");
          }),
        ]);
        expect([97, 137]).toContain(result.code);
        expect(result.signal).toBeNull();
        if (result.code === 137) {
          expectCompletion(fixture);
          expect(fs.existsSync(path.join(fixture.root, "active"))).toBe(false);
        } else {
          expect(fs.existsSync(fixture.receipt)).toBe(false);
          expect(fs.existsSync(path.join(fixture.root, "active"))).toBe(true);
        }
        expect(fs.existsSync(fixture.marker)).toBe(false);
        expectRememberedIdentitiesStopped(fixture);
      } finally {
        await cleanupFixture(fixture);
      }
    });

    test.runIf(process.platform === "darwin")(
      "withholds completion when ownership monitoring fails",
      async () => {
        const fixture = startFixture({
          environment: {
            DURE_QA_TEST_OWNERSHIP_MONITOR_RUNTIME_FAILURE: "1",
          },
          source: [
            'const fs = require("node:fs");',
            'fs.writeFileSync(process.argv[1], `${process.pid}\\n`);',
            "setInterval(() => {}, 1000);",
          ].join("\n"),
        });
        try {
          await waitFor(() =>
            fs.existsSync(fixture.descriptor) ||
            fixture.child.exitCode !== null ||
            fixture.child.signalCode !== null,
          );
          if (fs.existsSync(fixture.descriptor)) {
            rememberDescriptorIdentities(fixture);
          }
          await expect(fixture.closed).resolves.toEqual({
            code: 97,
            signal: null,
          });
          expect(fixture.stderr()).toContain(
            "ownership monitor runtime failure",
          );
          expect(fs.existsSync(fixture.receipt)).toBe(false);
          expect(fs.existsSync(path.join(fixture.root, "active"))).toBe(true);
          expect(fs.existsSync(fixture.descriptor)).toBe(true);
          expect(
            fs.existsSync(`${fixture.descriptor}.ownership-ledger.json`),
          ).toBe(true);
          expectRememberedIdentitiesStopped(fixture);
        } finally {
          await cleanupFixture(fixture);
        }
      },
    );

    test.each([
      [
        "retires its group while leaving an intentional detached child",
        "'ignore'",
        0,
      ],
      [
        "withholds completion while a detached child retains the liveness witness",
        "['ignore', 'ignore', 'ignore', Number(process.env.DURE_QA_LIVENESS_WITNESS_FD)]",
        97,
      ],
    ])("%s", async (_name, childStdio, expectedStatus) => {
      const root = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "dure-bounded-detached-"),
      );
      const childPidPath = path.join(root, "detached.pid");
      let childIdentity;
      try {
        const source = [
          'const { spawn } = require("node:child_process");',
          'const fs = require("node:fs");',
          `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ${childStdio} });`,
          "child.unref();",
          'fs.writeFileSync(process.argv[1], `${child.pid}\\n`);',
        ].join("\n");
        const result = spawnSync(
          process.execPath,
          [
            adapter,
            "run",
            root,
            "--timeout-seconds",
            "2",
            "--",
            process.execPath,
            "-e",
            source,
            childPidPath,
          ],
          { encoding: "utf8", timeout: 15_000 },
        );
        const childPid = Number(fs.readFileSync(childPidPath, "utf8").trim());
        childIdentity = await captureIdentity(childPid);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(identityLiveness(childIdentity)).toBe("active");
        if (expectedStatus === 0) {
          expect(fs.readdirSync(root).sort()).toEqual([
            "completion.json",
            "detached.pid",
          ]);
        } else {
          expect(result.stderr).toContain(
            "inherited liveness witness remains open",
          );
          expect(fs.existsSync(path.join(root, "completion.json"))).toBe(false);
        }
      } finally {
        if (!childIdentity && fs.existsSync(childPidPath)) {
          const childPid = Number(fs.readFileSync(childPidPath, "utf8").trim());
          if (Number.isSafeInteger(childPid) && childPid > 1) {
            childIdentity = observeIdentity(childPid);
          }
        }
        if (identityLiveness(childIdentity) === "active") {
          signalProcessGenerationSync(childIdentity, "SIGKILL");
          await waitFor(
            () => identityLiveness(childIdentity) === "stale",
            5_000,
          );
        }
        fs.rmSync(root, { force: true, recursive: true });
      }
    });
  },
);
