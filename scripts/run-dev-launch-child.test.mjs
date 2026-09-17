import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  DEV_LAUNCH_CHILD_GENERATION_ENV,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
} from "./lib/dev-launch-contract.mjs";
import {
  boundedDevLaunchFixtureOutcome,
  createDevLaunchFixtureRegistry,
  FIXTURE_LIFECYCLE_TIMEOUT_MS,
  runDevLaunchFixtureCleanup,
  simulatedLinuxProcessBoundaryEnvironment,
} from "./lib/dev-launch-test-support.mjs";
import {
  processGroupId,
  processIdentity,
} from "./lib/process-identity.mjs";

const wrapperPath = fileURLToPath(
  new URL("./run-dev-launch-child.mjs", import.meta.url),
);
const linuxBoundaryPath = fileURLToPath(
  new URL("./native/linux-process-boundary.py", import.meta.url),
);
const temporaryRoots = [];
const runningChildren = [];
const fixtureProcesses = createDevLaunchFixtureRegistry();
const processGroupAdapterSupported =
  process.platform === "darwin" || process.platform === "linux";
const posixShimSimulationSupported =
  process.platform !== "win32" && typeof process.execve === "function";

function captureExactIdentityWhileLive(
  child,
  exited,
  {
    isExited,
    observeIdentity = processIdentity,
    pollMs = 5,
  },
) {
  let timer;
  const identity = new Promise((resolve) => {
    const poll = () => {
      if (isExited()) return;
      let observed = null;
      try {
        observed = observeIdentity(child.pid);
      } catch {}
      if (observed && !isExited()) {
        resolve({ pid: child.pid, processIdentity: observed });
      } else {
        timer = setTimeout(poll, pollMs);
      }
    };
    poll();
  });
  const cancel = () => {
    if (timer) clearTimeout(timer);
  };
  const outcome = Promise.race([
    identity,
    exited.then(() => null, () => null),
  ]).finally(cancel);
  return { cancel, outcome };
}

async function runCommand(
  file,
  args,
  env = process.env,
  { timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS } = {},
) {
  const child = spawn(file, args, {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let childExited = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      childExited = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      childExited = true;
      resolve({ code, signal });
    });
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  runningChildren.push({ child, exited });
  const boundedOutcome = boundedDevLaunchFixtureOutcome(exited, {
    label: "launch child preflight",
    timeoutMs,
  });
  const identityCapture = processGroupAdapterSupported
    ? captureExactIdentityWhileLive(child, exited, {
      isExited: () => childExited,
    })
    : null;
  try {
    if (identityCapture) {
      const identity = await Promise.race([
        identityCapture.outcome,
        boundedOutcome.then(() => null),
      ]);
      if (identity) fixtureProcesses.registerIdentity(identity);
    }
    const outcome = await boundedOutcome;
    return { outcome, stderr };
  } finally {
    identityCapture?.cancel();
  }
}

function runWrapperPreflight(env = process.env) {
  return runCommand(process.execPath, [wrapperPath, "--check"], env);
}

function linuxBoundaryFixture(mode) {
  const root = mkdtempSync(join(tmpdir(), "dure-linux-boundary-preflight-"));
  temporaryRoots.push(root);
  return simulatedLinuxProcessBoundaryEnvironment({ root, mode });
}

function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      try {
        const value = predicate();
        if (value) {
          resolve(value);
          return;
        }
      } catch {}
      if (Date.now() >= deadline) {
        reject(new Error("launch child fixture observation timed out"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function fixtureCommand() {
  const root = mkdtempSync(join(tmpdir(), "dure-launch-child-"));
  temporaryRoots.push(root);
  const script = join(root, "child.mjs");
  const marker = join(root, "started");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  return { marker, root, script };
}

function spawnWrapper({
  channel,
  generation,
  script,
  marker,
  command = process.execPath,
  args = [script, marker],
}) {
  const child = spawn(
    process.execPath,
    [
      wrapperPath,
      JSON.stringify({
        command,
        args,
      }),
    ],
    {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        DURE_APP_CHANNEL: channel,
        [DEV_LAUNCH_CHILD_GENERATION_ENV]: generation,
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const ownership = fixtureProcesses.registerSpawn(child);
  const witnessMessage = new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== "process_group_witness_ready") return;
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
  const running = {
    child,
    exited,
    leaderIdentity: waitFor(() => processIdentity(child.pid)).catch(() => null),
    witnessRecord: null,
    witnessReady: null,
  };
  running.witnessReady = witnessMessage.then(async (message) => {
    const identity = await waitFor(() => processIdentity(message.pid));
    running.witnessRecord = { ...message, processIdentity: identity };
    const leaderIdentity = await running.leaderIdentity;
    if (leaderIdentity) {
      ownership.bind({
        pid: child.pid,
        processIdentity: leaderIdentity,
        processGroup: {
          kind: "posix_process_group_v1",
          id: child.pid,
          witness: {
            pid: message.pid,
            processIdentity: identity,
          },
        },
      });
    }
    return running.witnessRecord;
  });
  runningChildren.push(running);
  return running;
}

afterEach(async () => {
  const children = runningChildren.splice(0);
  const roots = temporaryRoots.splice(0);
  await runDevLaunchFixtureCleanup([
    () => fixtureProcesses.retireAll(),
    ...children.map(({ exited }) => () =>
      boundedDevLaunchFixtureOutcome(exited, {
        label: "launch child fixture exit",
      })
    ),
    ...roots.map((root) => () =>
      rmSync(root, { recursive: true, force: true })
    ),
  ]);
});

it.runIf(processGroupAdapterSupported)(
  "bounds a preflight child and retains exact teardown registration",
  async () => {
    await expect(
      runCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1_000)"],
        process.env,
        { timeoutMs: 25 },
      ),
    ).rejects.toMatchObject({
      code: "DEV_LAUNCH_FIXTURE_TIMEOUT",
      message: "launch child preflight exceeded 25ms",
    });
  },
);

it("stops exact identity polling when child exit wins", async () => {
  let observations = 0;
  let childExited = false;
  let resolveExit;
  const exited = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const capture = captureExactIdentityWhileLive(
    { pid: 41 },
    exited,
    {
      isExited: () => childExited,
      observeIdentity: () => {
        observations += 1;
        return null;
      },
      pollMs: 1,
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  childExited = true;
  resolveExit({ code: 0, signal: null });

  await expect(capture.outcome).resolves.toBeNull();
  const observationsAtExit = observations;
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(observationsAtExit).toBeGreaterThan(0);
  expect(observations).toBe(observationsAtExit);
});

it.runIf(processGroupAdapterSupported)(
  "exits without spawning the app when its supervisor disconnects before activation",
  async () => {
  const fixture = fixtureCommand();
  const running = spawnWrapper({
    channel: "launch-child-disconnect",
    generation: "a".repeat(64),
    ...fixture,
  });
  const witness = await running.witnessReady;
  running.child.disconnect();

  await expect(running.exited).resolves.toEqual({ code: 1, signal: null });
  await waitFor(() => processIdentity(witness.pid) === null);
  expect(existsSync(fixture.marker)).toBe(false);
  },
);

it.runIf(processGroupAdapterSupported)(
  "executes the app in the exact activated process identity",
  async () => {
  const fixture = fixtureCommand();
  const channel = "launch-child-activate";
  const generation = "b".repeat(64);
  const running = spawnWrapper({ channel, generation, ...fixture });
  const identity = await waitFor(() => processIdentity(running.child.pid));
  const witness = await running.witnessReady;
  expect(processGroupId(witness.pid)).toBe(running.child.pid);
  const disconnected = new Promise((resolve) =>
    running.child.once("disconnect", resolve),
  );
  running.child.send({
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "launch_activate",
    channel,
    generation,
  });
  await disconnected;
  await waitFor(() => existsSync(fixture.marker));

  expect(Number(readFileSync(fixture.marker, "utf8"))).toBe(running.child.pid);
  expect(processIdentity(running.child.pid)).toBe(identity);
  },
);

it.runIf(processGroupAdapterSupported)(
  "retains exact cleanup authority when exec activation aborts",
  async () => {
    const fixture = fixtureCommand();
    const channel = "launch-child-exec-failure";
    const generation = "c".repeat(64);
    const running = spawnWrapper({
      channel,
      generation,
      command: fixture.root,
      args: [],
    });
    const witness = await running.witnessReady;
    running.child.send({
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      type: "launch_activate",
      channel,
      generation,
    });

    await expect(running.exited).resolves.toEqual({
      code: null,
      signal: "SIGABRT",
    });
    expect(processIdentity(witness.pid)).toBe(witness.processIdentity);
  },
);

it.runIf(!processGroupAdapterSupported)(
  "reports typed process-group unavailability during wrapper preflight",
  async () => {
    const result = await runWrapperPreflight();

    expect(result.outcome).toEqual({ code: 1, signal: null });
    expect(result.stderr).toContain(
      "development process groups are unsupported",
    );
  },
);

it.runIf(process.platform === "darwin")(
  "preserves macOS wrapper preflight",
  async () => {
    const result = await runWrapperPreflight();

    expect(result.outcome).toEqual({ code: 0, signal: null });
    expect(result.stderr).toBe("");
  },
);

it.runIf(posixShimSimulationSupported).each([
  [
    "missing Python pidfd APIs",
    "missing-apis",
    "pidfd signaling is unavailable",
  ],
  [
    "kernel pidfd-open rejection",
    "kernel-open-unsupported",
    "pidfd self-check failed errno=",
  ],
  [
    "kernel pidfd-signal rejection",
    "kernel-signal-unsupported",
    "pidfd signal self-check failed errno=",
  ],
])(
  "reports Linux %s from the native boundary",
  async (_label, mode, diagnostic) => {
    const result = await runCommand(
      "python3",
      [linuxBoundaryPath, "self-check"],
      linuxBoundaryFixture(mode),
    );

    expect(result.outcome).toEqual({ code: 5, signal: null });
    expect(result.stderr).toContain(diagnostic);
  },
);

it.runIf(posixShimSimulationSupported)(
  "rejects Linux wrapper preflight when the native boundary is unavailable",
  async () => {
    const result = await runWrapperPreflight(
      linuxBoundaryFixture("missing-apis"),
    );

    expect(result.outcome).toEqual({ code: 1, signal: null });
    expect(result.stderr).toContain(
      "Linux process boundary self-check failed",
    );
  },
);

it.runIf(posixShimSimulationSupported)(
  "admits Linux wrapper preflight after the native pidfd self-check",
  async () => {
    const result = await runWrapperPreflight(
      linuxBoundaryFixture("supported"),
    );

    expect(result.outcome).toEqual({ code: 0, signal: null });
    expect(result.stderr).toBe("");
  },
);

it.runIf(posixShimSimulationSupported)(
  "does not repeat the self pidfd probe during a target operation",
  async () => {
    const result = await runCommand(
      "python3",
      [linuxBoundaryPath, "signal", "2147483000", "1", "15"],
      linuxBoundaryFixture("target-operation"),
    );

    expect(result.outcome).toEqual({ code: 3, signal: null });
    expect(result.stderr).not.toContain("unexpected self probe");
  },
);
