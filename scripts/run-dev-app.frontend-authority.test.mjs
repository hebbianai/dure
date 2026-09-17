import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { appControlDirectory, worktreeDevIdentity } from "./lib/app-channel.mjs";
import { computeBackendRuntimeFingerprint } from "./lib/backend-runtime-fingerprint.mjs";
import { requireCurrentNodeDependencyInstall } from "./node-dependency-preflight.mjs";
import {
  observeDevLaunchParentGeneration,
  observeDevLaunchRestartAuthority,
  requestDevLaunchRestart,
  socketPathFor,
} from "./lib/dev-launch-client.mjs";
import {
  DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  RESTART_STATUS_REQUEST_TIMEOUT_MS,
} from "./lib/dev-launch-contract.mjs";
import { claimStaleDescriptor } from "./lib/dev-launch-supervisor.mjs";
import { DEV_CHAIN_RESTART_STATE } from "./lib/dev-chain-recovery.mjs";
import { prepareDevLaunchCheckout } from "./lib/dev-launch-checkout.mjs";
import {
  createDevLaunchFixtureRegistry,
  processGroupWitnessReadySource,
  runDevLaunchFixtureCleanup,
  writeFixtureBackendRuntime,
  writeFixtureNodeDependencies,
  writeFixtureTauriCli,
} from "./lib/dev-launch-test-support.mjs";
import { writeAtomicFile } from "./lib/durable-file.mjs";
import {
  processGroupId,
  processGroupMemberStates,
  processIdentity,
} from "./lib/process-identity.mjs";
import { signalOwnedProcessGroup } from "./lib/process-group-authority.mjs";

const runnerPath = fileURLToPath(
  new URL("./fixtures/run-dev-app-fixture.mjs", import.meta.url),
);
const temporaryRoots = [];
const runningRunners = [];
const fixtureProcesses = createDevLaunchFixtureRegistry({ timeoutMs: 5_000 });

function waitFor(predicate, timeoutMs = 10_000) {
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
        reject(new Error("frontend authority fixture observation timed out"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function unusedPort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "localhost", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") {
    listener.close();
    throw new Error("fixture listener did not allocate a TCP port");
  }
  await new Promise((resolve) => listener.close(resolve));
  return address.port;
}

function jsonLines(pathname) {
  if (!existsSync(pathname)) return [];
  return readFileSync(pathname, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function appStarts(pathname) {
  return jsonLines(pathname).filter((event) => event.type === "started");
}

function recoveryClaimPath(descriptorPath, supervisorGeneration) {
  return `${descriptorPath}.claim-${supervisorGeneration}`;
}

function processGroupAlive(groupId) {
  const observation = processGroupMemberStates(groupId);
  if (observation.status !== "complete") {
    throw new Error("fixture process group observation failed");
  }
  return observation.members.some(({ state }) => state !== "zombie");
}

async function retireExactFixtureGroup(identity) {
  await signalOwnedProcessGroup(identity, "SIGTERM");
  await waitFor(
    () =>
      processIdentity(identity.pid) === null &&
      processIdentity(identity.processGroup.witness.pid) === null &&
      !processGroupAlive(identity.processGroup.id),
  );
}

async function spawnLegacyFixtureLaunch(cwd, generation) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)",
    ],
    { cwd, detached: true, stdio: "ignore" },
  );
  fixtureProcesses.registerSpawn(child);
  return {
    pid: child.pid,
    processIdentity: await waitFor(() => processIdentity(child.pid)),
    generation,
  };
}

function createFixtureRepository() {
  const root = mkdtempSync(join(tmpdir(), "dure-frontend-authority-"));
  temporaryRoots.push(root);
  mkdirSync(join(root, "src-tauri"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFixtureBackendRuntime(root);
  writeFixtureNodeDependencies(root);
  writeFileSync(
    join(root, "src-tauri", "tauri.conf.json"),
    `${JSON.stringify({
      productName: "Dure",
      version: "0.1.0",
      identifier: "dev.dure.frontend-authority-fixture",
      build: {},
      app: { windows: [{ title: "Dure" }] },
    })}\n`,
  );
  writeFileSync(
    join(root, "scripts", "node-dependency-preflight.mjs"),
    "process.exit(0);\n",
  );
  writeFileSync(
    join(root, "scripts", "guard-dev-channel.mjs"),
    "process.exit(0);\n",
  );
  writeFileSync(
    join(root, "scripts", "stage-mobile-runtime.mjs"),
    "process.exit(0);\n",
  );
  writeFileSync(
    join(root, "scripts", "prepare-agent-tools.sh"),
    "#!/bin/sh\nexit 0\n",
  );
  writeFileSync(
    join(root, "scripts", "run-dev-launch-child.mjs"),
    "if (process.argv[2] !== '--check') process.exit(1);\n",
  );
  writeFileSync(
    join(root, "scripts", "run-dev-frontend.mjs"),
    `import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { computeBackendRuntimeFingerprint } from ${JSON.stringify(new URL("./lib/backend-runtime-fingerprint.mjs", import.meta.url).href)};
import { requireCurrentNodeDependencyInstall } from ${JSON.stringify(new URL("./node-dependency-preflight.mjs", import.meta.url).href)};

const args = process.argv.slice(2);
if (args.includes("--check")) process.exit(0);
// Like Vite's define, this observation is fixed at configuration time.
const backendRuntimeFingerprint = computeBackendRuntimeFingerprint(process.cwd());
const nodeDependencyFingerprint = requireCurrentNodeDependencyInstall(process.cwd()).fingerprint;
const value = (name) => args[args.indexOf(name) + 1];
const host = value("--host");
const port = Number(value("--port"));
const generation = process.env.DURE_DEV_FRONTEND_GENERATION ?? "a".repeat(64);
const channel = process.env.DURE_APP_CHANNEL;
${processGroupWitnessReadySource("channel", "generation")}
appendFileSync(
  process.env.DURE_TEST_FRONTEND_EVENTS,
  JSON.stringify({ type: "started", pid: process.pid, generation, channel }) + "\\n",
);
const starts = existsSync(process.env.DURE_TEST_FRONTEND_START_COUNT)
  ? Number(readFileSync(process.env.DURE_TEST_FRONTEND_START_COUNT, "utf8"))
  : 0;
writeFileSync(process.env.DURE_TEST_FRONTEND_START_COUNT, String(starts + 1));
const failCandidate = existsSync(process.env.DURE_TEST_FAIL_CANDIDATE)
  ? readFileSync(process.env.DURE_TEST_FAIL_CANDIDATE, "utf8").trim()
  : null;
if (
  starts > 0 &&
  (failCandidate === "fail" || Number(failCandidate) === starts)
) {
  appendFileSync(
    process.env.DURE_TEST_FRONTEND_EVENTS,
    JSON.stringify({ type: "failed", pid: process.pid, generation, channel }) + "\\n",
  );
  process.exit(7);
}
const cleanupTrap = existsSync(process.env.DURE_TEST_FRONTEND_CLEANUP_TRAP) &&
  Number(readFileSync(process.env.DURE_TEST_FRONTEND_CLEANUP_TRAP, "utf8")) === starts;
let cleanupHelper = null;
let activated = false;
process.once("message", async (message) => {
  if (message.type !== "frontend_activate") process.exit(9);
  await groupWitness.retain();
  activated = true;
  process.send({ schemaVersion: 1, type: "frontend_activated", channel, generation });
  if (!cleanupTrap) return;
  cleanupHelper = spawn(
    process.execPath,
    [
      "-e",
      "const { appendFileSync } = require('node:fs'); let heldSocket; process.on('SIGHUP', () => {}); process.once('SIGTERM', () => process.exit(0)); process.on('message', (_message, socket) => { heldSocket = socket; socket.on('error', () => {}); appendFileSync(process.env.DURE_TEST_FRONTEND_EVENTS, JSON.stringify({ type: 'group_helper', owner: 'frontend', pid: process.pid }) + String.fromCharCode(10)); }); setInterval(() => void heldSocket, 1000)",
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  writeFileSync(process.env.DURE_TEST_FRONTEND_PROBE_FAIL, "fail\\n");
});
process.once("disconnect", () => {
  if (!activated) process.exit(1);
});
const server = createServer((request, response) => {
  const respond = () => {
    const wrongOnce = existsSync(process.env.DURE_TEST_WRONG_GENERATION_ONCE);
    if (wrongOnce) unlinkSync(process.env.DURE_TEST_WRONG_GENERATION_ONCE);
    const reportedGeneration =
      existsSync(process.env.DURE_TEST_WRONG_GENERATION) ||
      existsSync(process.env.DURE_TEST_FRONTEND_PROBE_FAIL) ||
      wrongOnce
        ? "f".repeat(64)
        : generation;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      schemaVersion: 1,
      protocolVersion: 1,
      type: "frontend_ready",
      channel,
      generation: reportedGeneration,
      backendRuntimeFingerprint: starts === 0 && process.env.DURE_TEST_LEGACY_FRONTEND === "1"
        ? undefined : backendRuntimeFingerprint,
      nodeDependencyFingerprint,
    }));
  };
  if (cleanupTrap) {
    cleanupHelper.send({ type: "hold_probe" }, request.socket);
    return;
  } else if (
    existsSync(process.env.DURE_TEST_APP_CLEANUP_TRAP) &&
    existsSync(process.env.DURE_TEST_FRONTEND_PROBE_FAIL)
  ) {
    const waitForAppCleanupRelease = () => {
      if (existsSync(process.env.DURE_TEST_APP_CLEANUP_TRAP)) {
        setTimeout(waitForAppCleanupRelease, 10);
        return;
      }
      respond();
    };
    waitForAppCleanupRelease();
  } else if (existsSync(process.env.DURE_TEST_FRONTEND_PROBE_DELAY)) {
    setTimeout(respond, 300);
  } else if (
    existsSync(process.env.DURE_TEST_APP_CLEANUP_TRAP) ||
    existsSync(process.env.DURE_TEST_FRONTEND_PROBE_FAIL)
  ) {
    setTimeout(respond, 100);
  } else {
    respond();
  }
});
server.once("error", (error) => {
  appendFileSync(
    process.env.DURE_TEST_FRONTEND_EVENTS,
    JSON.stringify({ type: "failed", pid: process.pid, generation, channel, code: error.code }) + "\\n",
  );
  const reportFailure = () => {
    if (
      error.code === "EADDRINUSE" &&
      existsSync(process.env.DURE_TEST_PORT_CONFLICT_HOLD)
    ) {
      setTimeout(reportFailure, 10);
      return;
    }
    if (error.code === "EADDRINUSE" && typeof process.send === "function") {
      process.send({
        schemaVersion: 1,
        protocolVersion: 1,
        type: "frontend_unavailable",
        reason: "port_conflict",
        channel,
        generation,
      });
    }
    process.exit(8);
  };
  reportFailure();
});
server.listen(port, host, () => {
  appendFileSync(
    process.env.DURE_TEST_FRONTEND_EVENTS,
    JSON.stringify({ type: "ready", pid: process.pid, generation, channel }) + "\\n",
  );
  if (typeof process.send === "function") {
    process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel, generation });
  }
});
const stop = (signal) => {
  appendFileSync(
    process.env.DURE_TEST_FRONTEND_EVENTS,
    JSON.stringify({ type: "stopped", pid: process.pid, signal }) + "\\n",
  );
  if (existsSync(process.env.DURE_TEST_WRONG_GENERATION)) {
    unlinkSync(process.env.DURE_TEST_WRONG_GENERATION);
  }
  if (cleanupTrap) process.exit(7);
  server.close(() => process.exit(0));
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGHUP", () => stop("SIGHUP"));
`,
  );
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expect(initialized.status, initialized.stderr).toBe(0);
  return realpathSync(root);
}

function installFakeTauriCli(root) {
  writeFixtureTauriCli(
    root,
    `const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write("tauri-cli fixture\\n");
  process.exit(0);
}
if (args[0] !== "dev") process.exit(22);
const configIndex = args.indexOf("--config");
const config = JSON.parse(args[configIndex + 1]);
const appStarts = existsSync(process.env.DURE_TEST_APP_EVENTS)
  ? readFileSync(process.env.DURE_TEST_APP_EVENTS, "utf8")
      .trim()
      .split("\\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "started").length
  : 0;
appendFileSync(
  process.env.DURE_TEST_APP_EVENTS,
  JSON.stringify({ type: "started", pid: process.pid, start: appStarts }) + "\\n",
);
if (config.build.beforeDevCommand !== null) {
  const frontend = spawn(
    process.execPath,
    [join(process.cwd(), "scripts/run-dev-frontend.mjs"), "--host", process.env.HEBBIAN_DEV_HOST ?? "localhost", "--port", process.env.DURE_DEV_PORT],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DURE_DEV_FRONTEND_GENERATION: "a".repeat(64),
      },
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
  frontend.on("message", () => {});
  frontend.once("exit", (code, signal) => {
    if (code !== 0 || signal) process.exit(code ?? 1);
  });
}
const cleanupTrap = existsSync(process.env.DURE_TEST_APP_CLEANUP_TRAP) &&
  Number(readFileSync(process.env.DURE_TEST_APP_CLEANUP_TRAP, "utf8")) === appStarts;
if (cleanupTrap) {
  const helper = spawn(
    process.execPath,
    [
      "-e",
      "const { appendFileSync } = require('node:fs'); process.on('SIGHUP', () => {}); process.once('SIGTERM', () => process.exit(0)); appendFileSync(process.env.DURE_TEST_APP_EVENTS, JSON.stringify({ type: 'group_helper', owner: 'app', pid: process.pid }) + String.fromCharCode(10)); setInterval(() => {}, 1000)",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(process.env.DURE_TEST_FRONTEND_PROBE_FAIL, "fail\\n");
  setInterval(() => {}, 1_000);
} else {
  const stop = (signal) => {
    appendFileSync(
      process.env.DURE_TEST_APP_EVENTS,
      JSON.stringify({ type: "stopped", pid: process.pid, signal }) + "\\n",
    );
    process.exit(0);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGHUP", () => stop("SIGHUP"));
  setInterval(() => {}, 1_000);
}
`,
  );
}

function requestRunnerStop(runner) {
  if (runner.child.exitCode === null && runner.child.signalCode === null) {
    runner.child.kill("SIGTERM");
  }
}

async function boundedRunnerOutcome(outcome, runner, label, timeoutMs = 5_000) {
  let timeout;
  try {
    return await Promise.race([
      outcome,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                `fixture runner did not ${label}: ${JSON.stringify(runner.output())}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function spawnFixtureRunner(worktreeRoot, environment) {
  const child = spawn(process.execPath, [runnerPath], {
    cwd: worktreeRoot,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixtureProcesses.registerSpawn(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const completed = new Promise((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  const runner = {
    child,
    completed,
    exited,
    output: () => ({ stdout, stderr }),
  };
  runningRunners.push(runner);
  return runner;
}

async function createRunningFixture(instance, { legacyFrontend = false } = {}) {
  const worktreeRoot = createFixtureRepository();
  installFakeTauriCli(worktreeRoot);
  const home = mkdtempSync(join(tmpdir(), "dure-frontend-authority-home-"));
  temporaryRoots.push(home);
  const frontendEvents = join(home, "frontend-events.jsonl");
  const frontendStartCount = join(home, "frontend-start-count");
  const appEvents = join(home, "app-events.jsonl");
  const appCleanupTrap = join(home, "app-cleanup-trap");
  const failCandidate = join(home, "fail-candidate");
  const frontendCleanupTrap = join(home, "frontend-cleanup-trap");
  const frontendProbeDelay = join(home, "frontend-probe-delay");
  const frontendProbeFail = join(home, "frontend-probe-fail");
  const portConflictHold = join(home, "port-conflict-hold");
  const wrongGeneration = join(home, "wrong-generation");
  const wrongGenerationOnce = join(home, "wrong-generation-once");
  const port = await unusedPort();
  const identity = worktreeDevIdentity(worktreeRoot, instance);
  const environment = {
    ...process.env,
    HOME: home,
    DURE_TEST_HEADROOM_MODE: "allow",
    DURE_TEST_LEGACY_FRONTEND: legacyFrontend ? "1" : "0",
    DURE_DEV_PORT: String(port),
    HEBBIAN_DEV_INSTANCE: instance,
    DURE_TEST_FRONTEND_EVENTS: frontendEvents,
    DURE_TEST_FRONTEND_START_COUNT: frontendStartCount,
    DURE_TEST_APP_EVENTS: appEvents,
    DURE_TEST_APP_CLEANUP_TRAP: appCleanupTrap,
    DURE_TEST_FAIL_CANDIDATE: failCandidate,
    DURE_TEST_FRONTEND_CLEANUP_TRAP: frontendCleanupTrap,
    DURE_TEST_FRONTEND_PROBE_DELAY: frontendProbeDelay,
    DURE_TEST_FRONTEND_PROBE_FAIL: frontendProbeFail,
    DURE_TEST_PORT_CONFLICT_HOLD: portConflictHold,
    DURE_TEST_WRONG_GENERATION: wrongGeneration,
    DURE_TEST_WRONG_GENERATION_ONCE: wrongGenerationOnce,
  };
  delete environment.HEBBIAN_DEV_PORT;
  const descriptorPath = join(
    appControlDirectory(home, identity.channel),
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  fixtureProcesses.registerDescriptor(descriptorPath);
  const runner = spawnFixtureRunner(worktreeRoot, environment);
  let initialDescriptor;
  try {
    initialDescriptor = await waitFor(() => {
      if (!existsSync(descriptorPath)) return null;
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return descriptor.state === "ready" &&
        appStarts(appEvents).length === 1 &&
        jsonLines(frontendEvents).some((event) => event.type === "ready")
        ? descriptor
        : null;
    });
  } catch (error) {
    throw new Error(
      `${error.message}; runner output: ${JSON.stringify(runner.output())}`,
    );
  }
  const [incumbentFrontend] = jsonLines(frontendEvents).filter(
    (event) => event.type === "ready",
  );
  const incumbentFrontendIdentity = processIdentity(incumbentFrontend.pid);
  expect(incumbentFrontendIdentity).toBeTruthy();
  return {
    appCleanupTrap,
    appEvents,
    descriptorPath,
    environment,
    failCandidate,
    frontendCleanupTrap,
    frontendEvents,
    frontendProbeDelay,
    frontendProbeFail,
    portConflictHold,
    port,
    home,
    identity,
    incumbentFrontend,
    incumbentFrontendIdentity,
    initialDescriptor,
    runner,
    worktreeRoot,
    wrongGeneration,
    wrongGenerationOnce,
  };
}

function requestFixtureRestart(fixture) {
  return requestDevLaunchRestart({
    root: fixture.worktreeRoot,
    channel: fixture.identity.channel,
    home: fixture.home,
    timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
  }).catch((error) => {
    error.message += `; fixture evidence: ${JSON.stringify({
      output: fixture.runner.output(),
      frontend: jsonLines(fixture.frontendEvents),
      app: jsonLines(fixture.appEvents),
    })}`;
    throw error;
  });
}

afterEach(async () => {
  const runners = runningRunners.splice(0).reverse();
  const roots = temporaryRoots.splice(0);
  await runDevLaunchFixtureCleanup([
    ...runners.map((runner) => () => requestRunnerStop(runner)),
    ...runners.map((runner) => () =>
      boundedRunnerOutcome(runner.completed, runner, "close")
    ),
    () => fixtureProcesses.retireAll(),
    ...roots.map((root) => () =>
      rmSync(root, { recursive: true, force: true })
    ),
  ]);
});

it("preserves the incumbent app and frontend when a candidate frontend fails before readiness", async () => {
  const fixture = await createRunningFixture("frontend-red");
  const {
    appEvents,
    descriptorPath,
    failCandidate,
    frontendEvents,
    incumbentFrontend,
    incumbentFrontendIdentity,
    initialDescriptor,
    wrongGeneration,
  } = fixture;

  writeFileSync(failCandidate, "fail\n", { mode: 0o600 });
  writeFileSync(wrongGeneration, "wrong\n", { mode: 0o600 });
  let restartFailure;
  try {
    await requestFixtureRestart(fixture);
  } catch (error) {
    restartFailure = error;
  }

  await waitFor(() =>
    jsonLines(frontendEvents).some((event) => event.type === "failed"),
  );
  const descriptorAfterFailure = existsSync(descriptorPath)
    ? JSON.parse(readFileSync(descriptorPath, "utf8"))
    : null;
  expect({
    destructiveBoundaryCrossed: restartFailure?.destructiveBoundaryCrossed,
    descriptorPreserved: descriptorAfterFailure !== null,
    descriptorState: descriptorAfterFailure?.state,
    launchDescriptorPreserved:
      descriptorAfterFailure?.launch !== undefined &&
      JSON.stringify(descriptorAfterFailure.launch) ===
        JSON.stringify(initialDescriptor.launch),
    appPreserved:
      processIdentity(initialDescriptor.launch.pid) ===
      initialDescriptor.launch.processIdentity,
    frontendPreserved:
      processIdentity(incumbentFrontend.pid) === incumbentFrontendIdentity,
    appStarts: appStarts(appEvents).length,
  }).toEqual({
    destructiveBoundaryCrossed: false,
    descriptorPreserved: true,
    descriptorState: "ready",
    launchDescriptorPreserved: true,
    appPreserved: true,
    frontendPreserved: true,
    appStarts: 1,
  });
});

it("preserves the incumbent when a ready app candidate exits during frontend proof", async () => {
  const fixture = await createRunningFixture("app-ready-exit");
  writeFileSync(fixture.frontendProbeDelay, "delay\n", { mode: 0o600 });
  const restart = requestFixtureRestart(fixture).then(
    (receipt) => ({ receipt }),
    (error) => ({ error }),
  );
  const preparing = await waitFor(() => {
    const descriptor = JSON.parse(
      readFileSync(fixture.descriptorPath, "utf8"),
    );
    return descriptor.candidateLaunch ? descriptor : null;
  });
  const candidateIdentity = processIdentity(preparing.candidateLaunch.pid);
  expect(candidateIdentity).toBe(preparing.candidateLaunch.processIdentity);
  process.kill(preparing.candidateLaunch.pid, "SIGTERM");
  await waitFor(
    () => processIdentity(preparing.candidateLaunch.pid) === null,
  );

  const result = await restart;
  expect(result.error).toMatchObject({ destructiveBoundaryCrossed: false });
  const restored = JSON.parse(
    readFileSync(fixture.descriptorPath, "utf8"),
  );
  expect(restored).toMatchObject({
    state: "ready",
    launch: fixture.initialDescriptor.launch,
    frontend: fixture.initialDescriptor.frontend,
  });
  expect(restored.candidateLaunch).toBeUndefined();
  expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBe(
    fixture.initialDescriptor.launch.processIdentity,
  );
  expect(appStarts(fixture.appEvents)).toHaveLength(1);
  expect(
    jsonLines(fixture.appEvents).filter((event) => event.type === "stopped"),
  ).toHaveLength(0);
});

it.runIf(process.platform !== "win32")(
  "cleans an activated frontend group when its leader exits first",
  async () => {
    const fixture = await createRunningFixture("frontend-cleanup");
    process.kill(fixture.initialDescriptor.frontend.pid, "SIGTERM");
    await waitFor(
      () =>
        processIdentity(fixture.initialDescriptor.frontend.pid) === null &&
        processIdentity(
          fixture.initialDescriptor.frontend.processGroup.witness.pid,
        ) === null &&
        !processGroupAlive(
          fixture.initialDescriptor.frontend.processGroup.id,
        ),
    );
    writeFileSync(fixture.frontendCleanupTrap, "1\n", { mode: 0o600 });

    const restart = requestFixtureRestart(fixture).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const helper = await waitFor(() =>
      jsonLines(fixture.frontendEvents).find(
        (event) => event.type === "group_helper" && event.owner === "frontend",
      ),
    );
    const helperIdentity = processIdentity(helper.pid);
    expect(helperIdentity).toBeTruthy();
    const trappedCandidate = jsonLines(fixture.frontendEvents).find(
      (event) =>
        event.type === "started" &&
        event.pid !== fixture.incumbentFrontend.pid,
    );
    expect(trappedCandidate).toBeTruthy();
    expect(processGroupId(helper.pid)).toBe(trappedCandidate.pid);
    process.kill(trappedCandidate.pid, "SIGKILL");
    await waitFor(() => processIdentity(trappedCandidate.pid) === null);

    const { error: restartFailure } = await restart;
    expect(restartFailure).toMatchObject({
      destructiveBoundaryCrossed: false,
      message: expect.stringContaining("lost exact readiness during activation"),
    });
    await waitFor(
      () =>
        processIdentity(helper.pid) === null &&
        !processGroupAlive(trappedCandidate.pid),
    );
    expect(helperIdentity).toBeTruthy();
    expect(fixture.runner.child.exitCode).toBeNull();
    const retained = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
    expect(retained).toMatchObject({
      state: "preparing",
      launch: fixture.initialDescriptor.launch,
      frontend: fixture.initialDescriptor.frontend,
    });
    expect(retained.candidateFrontend).toBeUndefined();

    unlinkSync(fixture.frontendCleanupTrap);
    unlinkSync(fixture.frontendProbeFail);
    await requestFixtureRestart(fixture);
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
      return descriptor.state === "ready" ? descriptor : null;
    });
    expect(recovered.candidateFrontend).toBeUndefined();
    expect(processGroupAlive(fixture.initialDescriptor.frontend.pid)).toBe(false);
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
  },
);

it.runIf(process.platform !== "win32")(
  "cleans an activated app group when its leader exits first",
  async () => {
    const fixture = await createRunningFixture("app-cleanup");
    writeFileSync(fixture.appCleanupTrap, "1\n", { mode: 0o600 });

    const restart = requestFixtureRestart(fixture).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const helper = await waitFor(() =>
      jsonLines(fixture.appEvents).find(
        (event) => event.type === "group_helper" && event.owner === "app",
      ),
    );
    const helperIdentity = processIdentity(helper.pid);
    expect(helperIdentity).toBeTruthy();
    try {
      const trappedCandidate = await waitFor(() =>
        appStarts(fixture.appEvents).find((event) => event.start === 1),
      );
      const trappedIdentity = processIdentity(trappedCandidate.pid);
      expect(trappedIdentity).toBeTruthy();
      expect(processIdentity(trappedCandidate.pid)).toBe(trappedIdentity);
      expect(processGroupId(helper.pid)).toBe(trappedCandidate.pid);
      process.kill(trappedCandidate.pid, "SIGKILL");
      await waitFor(() => processIdentity(trappedCandidate.pid) === null);
      unlinkSync(fixture.appCleanupTrap);

      const { error: restartFailure } = await restart;
      expect(restartFailure).toMatchObject({ destructiveBoundaryCrossed: true });
      await expect(
        boundedRunnerOutcome(fixture.runner.exited, fixture.runner, "exit"),
      ).resolves.toMatchObject({ code: 1 });
      await waitFor(
        () =>
          processIdentity(helper.pid) === null &&
          !processGroupAlive(trappedCandidate.pid),
      );
      expect(helperIdentity).toBeTruthy();
      await waitFor(() => !existsSync(fixture.descriptorPath));

      unlinkSync(fixture.frontendProbeFail);
      spawnFixtureRunner(fixture.worktreeRoot, fixture.environment);
      const recovered = await waitFor(() => {
        const descriptor = JSON.parse(
          readFileSync(fixture.descriptorPath, "utf8"),
        );
        return descriptor.state === "ready" ? descriptor : null;
      });
      expect(recovered.candidateLaunch).toBeUndefined();
      expect(processIdentity(recovered.launch.pid)).toBe(
        recovered.launch.processIdentity,
      );
    } finally {
      if (existsSync(fixture.appCleanupTrap)) {
        unlinkSync(fixture.appCleanupTrap);
      }
      if (existsSync(fixture.frontendProbeFail)) {
        unlinkSync(fixture.frontendProbeFail);
      }
    }
  },
);

it("converges on the exact incumbent after strict-port conflict and one re-probe", async () => {
  const fixture = await createRunningFixture("frontend-converge");
  writeFileSync(fixture.wrongGeneration, "wrong\n", { mode: 0o600 });
  writeFileSync(fixture.portConflictHold, "hold\n", { mode: 0o600 });

  const restart = requestFixtureRestart(fixture);
  await waitFor(() =>
    jsonLines(fixture.frontendEvents).some(
      (event) => event.type === "failed" && event.code === "EADDRINUSE",
    ),
  );
  unlinkSync(fixture.wrongGeneration);
  unlinkSync(fixture.portConflictHold);
  const receipt = await restart;
  const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
  const frontendEvents = jsonLines(fixture.frontendEvents);

  expect(receipt).toMatchObject({
    previousFrontend: fixture.initialDescriptor.frontend,
    frontend: fixture.initialDescriptor.frontend,
  });
  expect(descriptor.frontend).toEqual(fixture.initialDescriptor.frontend);
  expect(descriptor.launch.generation).not.toBe(
    fixture.initialDescriptor.launch.generation,
  );
  expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBeNull();
  expect(processIdentity(descriptor.launch.pid)).toBe(
    descriptor.launch.processIdentity,
  );
  expect(processIdentity(descriptor.frontend.pid)).toBe(
    descriptor.frontend.processIdentity,
  );
  expect(frontendEvents.filter((event) => event.type === "ready")).toHaveLength(
    1,
  );
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
  expect(appStarts(fixture.appEvents)).toHaveLength(2);
});

it("replaces the exact persistently mismatched frontend before app retirement", async () => {
  const fixture = await createRunningFixture("frontend-mismatch");
  writeFileSync(fixture.wrongGeneration, "wrong\n", { mode: 0o600 });

  const receipt = await requestFixtureRestart(fixture);
  const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));

  expect(receipt.previousFrontend).toEqual(fixture.initialDescriptor.frontend);
  expect(receipt.frontend).toEqual(descriptor.frontend);
  expect(descriptor.frontend.generation).not.toBe(
    fixture.initialDescriptor.frontend.generation,
  );
  expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
  expect(processIdentity(descriptor.frontend.pid)).toBe(
    descriptor.frontend.processIdentity,
  );
  expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBeNull();
  expect(processIdentity(descriptor.launch.pid)).toBe(
    descriptor.launch.processIdentity,
  );
  expect(
    jsonLines(fixture.frontendEvents).filter(
      (event) => event.type === "ready",
    ),
  ).toHaveLength(2);
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
  expect(appStarts(fixture.appEvents)).toHaveLength(2);
});

it.each([false, true])("refreshes a ready frontend after runtime artifact staging (legacy=%s)", async (legacyFrontend) => {
  const fixture = await createRunningFixture("frontend-artifact", { legacyFrontend });
  const observe = async () => {
    const response = await fetch(`http://localhost:${fixture.port}/__dure_dev_frontend_authority`);
    expect(response.ok).toBe(true);
    return response.json();
  };
  const before = await observe();
  expect(before.backendRuntimeFingerprint).toBe(legacyFrontend
    ? undefined : computeBackendRuntimeFingerprint(fixture.worktreeRoot));
  writeFileSync(join(fixture.worktreeRoot, "src-tauri/binaries/hmux-runtime-fixture"), "runtime-v2");
  const expected = computeBackendRuntimeFingerprint(fixture.worktreeRoot);
  expect(expected).not.toBe(before.backendRuntimeFingerprint);
  expect(await observe()).toEqual(before);

  const receipt = await requestFixtureRestart(fixture);
  expect((await observe()).backendRuntimeFingerprint).toBe(expected);
  expect(receipt.previousFrontend).toEqual(fixture.initialDescriptor.frontend);
  expect(receipt.frontend.generation).not.toBe(fixture.initialDescriptor.frontend.generation);
  expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
  expect(processIdentity(receipt.frontend.pid)).toBe(receipt.frontend.processIdentity);
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
});

it.each(["runtime", "dependency"])("preserves the live pair when prepared %s inputs cannot be read", async (kind) => {
  const fixture = await createRunningFixture("frontend-inputs");
  if (kind === "runtime") {
    writeFileSync(join(fixture.worktreeRoot, "scripts/backend-runtime-inputs.txt"), "missing-input\n");
  } else {
    writeFileSync(join(fixture.worktreeRoot, "pnpm-lock.yaml"), "unprepared dependencies\n");
  }
  await expect(requestFixtureRestart(fixture)).rejects.toThrow(kind === "runtime" ? "matched no files" : "different pnpm-lock");
  const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
  expect(descriptor.frontend).toEqual(fixture.initialDescriptor.frontend);
  expect(descriptor.launch).toEqual(fixture.initialDescriptor.launch);
  expect(processIdentity(descriptor.frontend.pid)).toBe(descriptor.frontend.processIdentity);
  expect(processIdentity(descriptor.launch.pid)).toBe(descriptor.launch.processIdentity);
  expect(jsonLines(fixture.frontendEvents).filter(event => event.type === "started")).toHaveLength(1);
  expect(appStarts(fixture.appEvents)).toHaveLength(1);
});

it("replaces the retained dependency optimizer when only the installed lock graph changes", async () => {
  const fixture = await createRunningFixture("frontend-deps");
  const backend = computeBackendRuntimeFingerprint(fixture.worktreeRoot);
  const observe = async () => (await fetch(`http://localhost:${fixture.port}/__dure_dev_frontend_authority`)).json();
  const before = await observe();
  const lock = "lockfileVersion: '9.0'\npackages:\n  fixture-dependency@2: {}\n";
  writeFixtureNodeDependencies(fixture.worktreeRoot, lock);
  expect(computeBackendRuntimeFingerprint(fixture.worktreeRoot)).toBe(backend);
  expect(await observe()).toEqual(before);

  const receipt = await requestFixtureRestart(fixture);
  expect(receipt.previousFrontend).toEqual(fixture.initialDescriptor.frontend);
  expect(receipt.frontend.generation).not.toBe(fixture.initialDescriptor.frontend.generation);
  expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
  expect(processIdentity(receipt.frontend.pid)).toBe(receipt.frontend.processIdentity);
  expect((await observe()).nodeDependencyFingerprint).toBe(requireCurrentNodeDependencyInstall(fixture.worktreeRoot).fingerprint);
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
});

it("retains a retired frontend identity when convergence fails and succeeds on the next request", async () => {
  const fixture = await createRunningFixture("frontend-retry");
  writeFileSync(fixture.wrongGeneration, "wrong\n", { mode: 0o600 });
  writeFileSync(fixture.failCandidate, "2\n", { mode: 0o600 });

  let firstFailure;
  try {
    await requestFixtureRestart(fixture);
  } catch (error) {
    firstFailure = error;
  }
  expect(firstFailure).toMatchObject({ destructiveBoundaryCrossed: false });
  const failed = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
  expect(failed).toMatchObject({
    state: "preparing",
    launch: fixture.initialDescriptor.launch,
    frontend: fixture.initialDescriptor.frontend,
  });
  expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
  expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBe(
    fixture.initialDescriptor.launch.processIdentity,
  );
  expect(appStarts(fixture.appEvents)).toHaveLength(1);

  unlinkSync(fixture.failCandidate);
  const recovered = await requestFixtureRestart(fixture);
  expect(recovered.frontend.generation).not.toBe(
    fixture.initialDescriptor.frontend.generation,
  );
  expect(processIdentity(recovered.frontend.pid)).toBe(
    recovered.frontend.processIdentity,
  );
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
});

it("fails closed on an unrelated port owner and converges after it leaves", async () => {
  const fixture = await createRunningFixture("frontend-decoy");
  process.kill(fixture.initialDescriptor.frontend.pid, "SIGTERM");
  await waitFor(
    () => processIdentity(fixture.initialDescriptor.frontend.pid) === null,
  );
  const listener = createServer((_request, response) => response.end("decoy"));
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(Number(fixture.environment.DURE_DEV_PORT), "localhost", resolve);
  });
  try {
    let failure;
    try {
      await requestFixtureRestart(fixture);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ destructiveBoundaryCrossed: false });
    expect(listener.listening).toBe(true);
    expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBe(
      fixture.initialDescriptor.launch.processIdentity,
    );
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }

  const receipt = await requestFixtureRestart(fixture);
  expect(receipt.frontend.generation).not.toBe(
    fixture.initialDescriptor.frontend.generation,
  );
  expect(processIdentity(receipt.frontend.pid)).toBe(
    receipt.frontend.processIdentity,
  );
});

it("prepares a crashed frontend for ordinary parent reload and then reuses it", async () => {
  const fixture = await createRunningFixture("frontend-recover");
  const incumbentPid = fixture.initialDescriptor.frontend.pid;
  process.kill(incumbentPid, "SIGTERM");
  await waitFor(() => {
    if (processIdentity(incumbentPid) !== null) return false;
    const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
    return descriptor.state === "preparing" ? descriptor : null;
  });

  await expect(
    prepareDevLaunchCheckout({
      root: fixture.worktreeRoot,
      channel: fixture.identity.channel,
      home: fixture.home,
      port: fixture.port,
      parentStrategy: "exec_handoff",
      allowColdBootstrap: true,
      timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
    }),
  ).resolves.toMatchObject({
    admitted: true,
    recoveryTransition: {
      kind: "child_restart",
      state: DEV_CHAIN_RESTART_STATE.RESTARTED,
    },
  });
  const afterRecovery = JSON.parse(
    readFileSync(fixture.descriptorPath, "utf8"),
  );
  expect(afterRecovery.state).toBe("ready");
  expect(afterRecovery.frontend.generation).not.toBe(
    fixture.initialDescriptor.frontend.generation,
  );
  expect(processIdentity(afterRecovery.frontend.pid)).toBe(
    afterRecovery.frontend.processIdentity,
  );

  const reused = await requestFixtureRestart(fixture);
  const afterReuse = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
  expect(reused.previousFrontend).toEqual(afterRecovery.frontend);
  expect(reused.frontend).toEqual(afterRecovery.frontend);
  expect(afterReuse.frontend).toEqual(afterRecovery.frontend);
  expect(
    jsonLines(fixture.frontendEvents).filter(
      (event) => event.type === "ready",
    ),
  ).toHaveLength(2);
  await waitFor(() => appStarts(fixture.appEvents).length === 3);
  expect(appStarts(fixture.appEvents)).toHaveLength(3);
});

it("accepts a concurrent frontend repair without restarting its successor", async () => {
  const fixture = await createRunningFixture("frontend-race");
  process.kill(fixture.initialDescriptor.frontend.pid, "SIGTERM");
  await waitFor(() => {
    const descriptor = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
    return descriptor.state === "preparing" ? descriptor : null;
  });

  let concurrentReceipt;
  await expect(
    prepareDevLaunchCheckout(
      {
        root: fixture.worktreeRoot,
        channel: fixture.identity.channel,
        home: fixture.home,
        port: fixture.port,
        parentStrategy: "exec_handoff",
        allowColdBootstrap: true,
        timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
      },
      {
        observeRestart: async (options) => {
          const observed = await observeDevLaunchRestartAuthority(options);
          concurrentReceipt = await requestFixtureRestart(fixture);
          return observed;
        },
      },
    ),
  ).resolves.toMatchObject({
    admitted: true,
    recoveryTransition: {
      kind: "child_restart",
      destructiveBoundaryCrossed: false,
    },
  });

  const preserved = JSON.parse(
    readFileSync(fixture.descriptorPath, "utf8"),
  );
  expect(preserved.launch).toEqual(concurrentReceipt.launch);
  expect(preserved.frontend).toEqual(concurrentReceipt.frontend);
  await waitFor(() => appStarts(fixture.appEvents).length === 2);
  expect(appStarts(fixture.appEvents)).toHaveLength(2);
  expect(
    jsonLines(fixture.frontendEvents).filter(
      (event) => event.type === "ready",
    ),
  ).toHaveLength(2);
});

it("keeps an explicit frontend readiness miss out of lifecycle state", async () => {
  const fixture = await createRunningFixture("frontend-observe");
  writeFileSync(fixture.wrongGeneration, "wrong\n", { mode: 0o600 });

  await expect(
    observeDevLaunchParentGeneration({
      root: fixture.worktreeRoot,
      channel: fixture.identity.channel,
      home: fixture.home,
      sourceGeneration: fixture.initialDescriptor.sourceGeneration,
      timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
    }),
  ).rejects.toThrow("activated parent endpoint does not serve");
  const preserved = JSON.parse(
    readFileSync(fixture.descriptorPath, "utf8"),
  );
  expect(preserved).toMatchObject({
    state: "ready",
    launch: fixture.initialDescriptor.launch,
    frontend: fixture.initialDescriptor.frontend,
  });
  expect(processIdentity(preserved.launch.pid)).toBe(
    preserved.launch.processIdentity,
  );
  expect(processIdentity(preserved.frontend.pid)).toBe(
    preserved.frontend.processIdentity,
  );
  expect(appStarts(fixture.appEvents)).toHaveLength(1);
  expect(
    jsonLines(fixture.frontendEvents).filter(
      (event) => event.type === "ready",
    ),
  ).toHaveLength(1);

  unlinkSync(fixture.wrongGeneration);
  const recovered = await observeDevLaunchParentGeneration({
    root: fixture.worktreeRoot,
    channel: fixture.identity.channel,
    home: fixture.home,
    sourceGeneration: fixture.initialDescriptor.sourceGeneration,
    timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
  });
  expect(recovered.launch).toEqual(fixture.initialDescriptor.launch);
  expect(recovered.frontend).toEqual(fixture.initialDescriptor.frontend);
  expect(
    jsonLines(fixture.frontendEvents).filter(
      (event) => event.type === "ready",
    ),
  ).toHaveLength(1);
});

it.runIf(process.platform !== "win32")(
  "adopts the exact app and frontend after supervisor SIGKILL",
  async () => {
    const fixture = await createRunningFixture("frontend-adopt");
    const previousSupervisor = fixture.initialDescriptor.supervisor;
    fixture.runner.child.kill("SIGKILL");
    await expect(fixture.runner.exited).resolves.toMatchObject({
      code: null,
      signal: "SIGKILL",
    });
    expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBe(
      fixture.initialDescriptor.launch.processIdentity,
    );
    expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBe(
      fixture.initialDescriptor.frontend.processIdentity,
    );

    const successor = spawnFixtureRunner(
      fixture.worktreeRoot,
      fixture.environment,
    );
    const adopted = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !== previousSupervisor.generation
        ? descriptor
        : null;
    });
    expect(adopted.launch).toEqual(fixture.initialDescriptor.launch);
    expect(adopted.frontend).toEqual(fixture.initialDescriptor.frontend);
    expect(
      existsSync(
        recoveryClaimPath(
          fixture.descriptorPath,
          fixture.initialDescriptor.supervisor.generation,
        ),
      ),
    ).toBe(false);
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "ready",
      ),
    ).toHaveLength(1);

    writeFileSync(fixture.failCandidate, "fail\n", { mode: 0o600 });
    writeFileSync(fixture.wrongGeneration, "wrong\n", { mode: 0o600 });
    let diagnosedFailure;
    try {
      await requestFixtureRestart(fixture);
    } catch (error) {
      diagnosedFailure = new Error(
        `${error.message}; successor stderr: ${successor.output().stderr}`,
      );
    }
    expect(diagnosedFailure?.message).toMatch(
      /frontend failed before readiness.*successor stderr:/,
    );
    unlinkSync(fixture.failCandidate);
    unlinkSync(fixture.wrongGeneration);

    const receipt = await requestFixtureRestart(fixture);
    expect(receipt.previousFrontend).toEqual(adopted.frontend);
    expect(receipt.frontend).toEqual(adopted.frontend);
    await waitFor(() => appStarts(fixture.appEvents).length === 2);
  },
);

it.runIf(process.platform !== "win32")(
  "replaces an exact stale frontend that no longer serves its generation",
  async () => {
    const fixture = await createRunningFixture("stale-mismatch");
    writeFileSync(fixture.wrongGenerationOnce, "wrong-once\n", {
      mode: 0o600,
    });
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;

    const successor = spawnFixtureRunner(
      fixture.worktreeRoot,
      fixture.environment,
    );
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          fixture.initialDescriptor.supervisor.generation
        ? descriptor
        : null;
    });

    expect(recovered.launch).toEqual(fixture.initialDescriptor.launch);
    expect(recovered.frontend.generation).not.toBe(
      fixture.initialDescriptor.frontend.generation,
    );
    expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "ready",
      ),
    ).toHaveLength(2);

  },
);

it.runIf(process.platform !== "win32")(
  "projects adopted frontend failure before a requested recovery",
  async () => {
    const fixture = await createRunningFixture("frontend-watch");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    spawnFixtureRunner(fixture.worktreeRoot, fixture.environment);
    const adopted = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          fixture.initialDescriptor.supervisor.generation
        ? descriptor
        : null;
    });

    process.kill(adopted.frontend.pid, "SIGTERM");
    await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "preparing" ? descriptor : null;
    });
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "ready",
      ),
    ).toHaveLength(1);
    expect(appStarts(fixture.appEvents)).toHaveLength(1);

    const receipt = await requestFixtureRestart(fixture);
    const recovered = JSON.parse(
      readFileSync(fixture.descriptorPath, "utf8"),
    );
    expect(receipt.previousFrontend).toEqual(adopted.frontend);
    expect(recovered.frontend.generation).not.toBe(
      adopted.frontend.generation,
    );
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
  },
);

it.runIf(process.platform !== "win32")(
  "removes ready authority when an adopted app exits",
  async () => {
    const fixture = await createRunningFixture("app-watch");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    const successor = spawnFixtureRunner(
      fixture.worktreeRoot,
      fixture.environment,
    );
    const adopted = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          fixture.initialDescriptor.supervisor.generation
        ? descriptor
        : null;
    });

    process.kill(adopted.launch.pid, "SIGTERM");
    await waitFor(() => {
      if (!existsSync(fixture.descriptorPath)) return true;
      return (
        JSON.parse(readFileSync(fixture.descriptorPath, "utf8")).state !==
        "ready"
      );
    });
    await expect(successor.exited).resolves.toMatchObject({ code: 1 });
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
  },
);

it.runIf(process.platform !== "win32")(
  "retains a crash-before-publication claim and fails closed without signals",
  async () => {
    const fixture = await createRunningFixture("frontend-preclaim");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    const before = readFileSync(fixture.descriptorPath, "utf8");
    const claimPath = recoveryClaimPath(
      fixture.descriptorPath,
      fixture.initialDescriptor.supervisor.generation,
    );
    linkSync(fixture.descriptorPath, claimPath);
    const descriptorStat = lstatSync(fixture.descriptorPath);
    const claimStat = lstatSync(claimPath);
    expect({ dev: claimStat.dev, ino: claimStat.ino }).toEqual({
      dev: descriptorStat.dev,
      ino: descriptorStat.ino,
    });

    const refused = spawnFixtureRunner(
      fixture.worktreeRoot,
      fixture.environment,
    );
    await expect(refused.exited).resolves.toMatchObject({
      code: 1,
      signal: null,
    });
    expect(readFileSync(fixture.descriptorPath, "utf8")).toBe(before);
    expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBe(
      fixture.initialDescriptor.launch.processIdentity,
    );
    expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBe(
      fixture.initialDescriptor.frontend.processIdentity,
    );
    expect(
      jsonLines(fixture.appEvents).filter((event) => event.type === "stopped"),
    ).toHaveLength(0);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "stopped",
      ),
    ).toHaveLength(0);

    unlinkSync(claimPath);
    spawnFixtureRunner(fixture.worktreeRoot, fixture.environment);
    await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          fixture.initialDescriptor.supervisor.generation;
    });
  },
);

it.runIf(process.platform !== "win32")(
  "reclaims after an actual claimant crashes immediately after publication",
  async () => {
    const fixture = await createRunningFixture("frontend-postclaim");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    const claimPath = recoveryClaimPath(
      fixture.descriptorPath,
      fixture.initialDescriptor.supervisor.generation,
    );
    const claimantScript = join(fixture.home, "postclaim-worker.mjs");
    const claimantPublished = join(fixture.home, "claimant-published");
    const supervisorModule = pathToFileURL(
      fileURLToPath(new URL("./lib/dev-launch-supervisor.mjs", import.meta.url)),
    ).href;
    const processIdentityModule = pathToFileURL(
      fileURLToPath(new URL("./lib/process-identity.mjs", import.meta.url)),
    ).href;
    const durableFileModule = pathToFileURL(
      fileURLToPath(new URL("./lib/durable-file.mjs", import.meta.url)),
    ).href;
    writeFileSync(
      claimantScript,
      `import { writeFileSync } from "node:fs";
import { reclaimStaleDescriptor } from ${JSON.stringify(supervisorModule)};
import { processIdentity } from ${JSON.stringify(processIdentityModule)};
import { writeAtomicFile } from ${JSON.stringify(durableFileModule)};

const [home, worktreeRoot, channel, descriptorPath, origin, marker] = process.argv.slice(2);
const generation = "d".repeat(64);
const supervisor = {
  pid: process.pid,
  processIdentity: processIdentity(process.pid),
  generation,
};
await reclaimStaleDescriptor({
  home,
  worktreeRoot,
  channel,
  frontendAuthority: {
    async probe(identity) {
      const response = await fetch(new URL("/__dure_dev_frontend_authority", origin));
      const value = await response.json();
      return response.ok &&
        value.schemaVersion === 1 &&
        value.protocolVersion === 1 &&
        value.type === "frontend_ready" &&
        value.channel === channel &&
        value.generation === identity.generation;
    },
  },
  publishClaimant({ launch, candidateLaunch, frontend, candidateFrontend, socketPath }) {
    writeAtomicFile(
      descriptorPath,
      JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath,
        capability: "c".repeat(64),
        capabilities: [
          "child_restart",
          "frontend_authority_v1",
          ${JSON.stringify(DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY)},
        ],
        supervisor,
        launch,
        ...(candidateLaunch ? { candidateLaunch } : {}),
        frontend,
        ...(candidateFrontend ? { candidateFrontend } : {}),
        publishedAtMs: Date.now(),
      }) + "\\n",
    );
    writeFileSync(marker, "published\\n");
    process.kill(process.pid, "SIGKILL");
  },
});
`,
      { mode: 0o600 },
    );
    const claimant = spawn(
      process.execPath,
      [
        claimantScript,
        fixture.home,
        fixture.worktreeRoot,
        fixture.identity.channel,
        fixture.descriptorPath,
        `http://localhost:${fixture.environment.DURE_DEV_PORT}`,
        claimantPublished,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let claimantStderr = "";
    claimant.stderr.setEncoding("utf8");
    claimant.stderr.on("data", (chunk) => {
      claimantStderr += chunk;
    });
    const claimantOutcome = await new Promise((resolve, reject) => {
      claimant.once("error", reject);
      claimant.once("exit", (code, signal) => resolve({ code, signal }));
    });
    expect(claimantOutcome, claimantStderr).toEqual({
      code: null,
      signal: "SIGKILL",
    });
    expect(existsSync(claimantPublished)).toBe(true);
    expect(existsSync(claimPath)).toBe(true);
    const crashedDescriptor = JSON.parse(
      readFileSync(fixture.descriptorPath, "utf8"),
    );
    expect(crashedDescriptor.supervisor.pid).toBe(claimant.pid);
    expect(crashedDescriptor.launch).toEqual(fixture.initialDescriptor.launch);
    expect(crashedDescriptor.frontend).toEqual(
      fixture.initialDescriptor.frontend,
    );

    const successors = [
      spawnFixtureRunner(fixture.worktreeRoot, fixture.environment),
      spawnFixtureRunner(fixture.worktreeRoot, fixture.environment),
    ];
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          crashedDescriptor.supervisor.generation &&
        successors.some(
          ({ child }) => child.pid === descriptor.supervisor.pid,
        )
        ? descriptor
        : null;
    });
    const loser = successors.find(
      ({ child }) => child.pid !== recovered.supervisor.pid,
    );
    await expect(loser.exited).resolves.toMatchObject({ code: 1, signal: null });
    expect(existsSync(claimPath)).toBe(true);
    expect(
      existsSync(
        recoveryClaimPath(
          fixture.descriptorPath,
          crashedDescriptor.supervisor.generation,
        ),
      ),
    ).toBe(false);
    expect(recovered.launch).toEqual(fixture.initialDescriptor.launch);
    expect(recovered.frontend).toEqual(fixture.initialDescriptor.frontend);
    expect(
      jsonLines(fixture.appEvents).filter((event) => event.type === "stopped"),
    ).toHaveLength(0);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "stopped",
      ),
    ).toHaveLength(0);
  },
);

it.runIf(process.platform !== "win32")(
  "cold-stops an exact legacy launch before establishing frontend authority",
  async () => {
    const fixture = await createRunningFixture("frontend-legacy");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    await retireExactFixtureGroup(fixture.initialDescriptor.frontend);
    await retireExactFixtureGroup(fixture.initialDescriptor.launch);
    const legacyLaunch = await spawnLegacyFixtureLaunch(
      fixture.worktreeRoot,
      fixture.initialDescriptor.launch.generation,
    );
    const legacyDescriptor = {
      ...fixture.initialDescriptor,
      launch: legacyLaunch,
    };
    delete legacyDescriptor.frontend;
    delete legacyDescriptor.protocolVersion;
    writeAtomicFile(
      fixture.descriptorPath,
      `${JSON.stringify({
        ...legacyDescriptor,
        capabilities: ["child_restart"],
        publishedAtMs: Date.now(),
      })}\n`,
    );

    spawnFixtureRunner(fixture.worktreeRoot, fixture.environment);
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" && descriptor.frontend
        ? descriptor
        : null;
    });
    expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBeNull();
    expect(processIdentity(legacyLaunch.pid)).toBeNull();
    expect(recovered.launch.generation).not.toBe(
      fixture.initialDescriptor.launch.generation,
    );
    expect(processIdentity(recovered.launch.pid)).toBe(
      recovered.launch.processIdentity,
    );
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
    await waitFor(() => appStarts(fixture.appEvents).length === 2);
    expect(appStarts(fixture.appEvents)).toHaveLength(2);
  },
);

it.runIf(process.platform !== "win32")(
  "finishes a legacy cold-stop after claimant publication and crash",
  async () => {
    const fixture = await createRunningFixture("legacy-claimant");
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;
    await retireExactFixtureGroup(fixture.initialDescriptor.frontend);
    await retireExactFixtureGroup(fixture.initialDescriptor.launch);
    const legacyLaunch = await spawnLegacyFixtureLaunch(
      fixture.worktreeRoot,
      fixture.initialDescriptor.launch.generation,
    );
    const legacyDescriptor = {
      ...fixture.initialDescriptor,
      launch: legacyLaunch,
    };
    delete legacyDescriptor.frontend;
    delete legacyDescriptor.protocolVersion;
    writeAtomicFile(
      fixture.descriptorPath,
      `${JSON.stringify({
        ...legacyDescriptor,
        capabilities: ["child_restart"],
        publishedAtMs: Date.now(),
      })}\n`,
    );
    const claimPath = recoveryClaimPath(
      fixture.descriptorPath,
      fixture.initialDescriptor.supervisor.generation,
    );
    linkSync(fixture.descriptorPath, claimPath);
    const claimant = spawn(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 100)"],
      { stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      claimant.once("spawn", resolve);
      claimant.once("error", reject);
    });
    const claimantProcessIdentity = processIdentity(claimant.pid);
    expect(claimantProcessIdentity).toBeTruthy();
    await new Promise((resolve) => claimant.once("exit", resolve));
    const claimantGeneration = "e".repeat(64);
    writeAtomicFile(
      fixture.descriptorPath,
      `${JSON.stringify({
        ...fixture.initialDescriptor,
        state: "preparing",
        socketPath: socketPathFor(
          fixture.worktreeRoot,
          fixture.identity.channel,
          claimantGeneration,
        ),
        supervisor: {
          pid: claimant.pid,
          processIdentity: claimantProcessIdentity,
          generation: claimantGeneration,
        },
        launch: null,
        candidateLaunch: legacyLaunch,
        frontend: null,
        capabilities: fixture.initialDescriptor.capabilities.filter(
          (capability) =>
            capability !== DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ),
        publishedAtMs: Date.now(),
      })}\n`,
    );

    spawnFixtureRunner(fixture.worktreeRoot, fixture.environment);
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !== claimantGeneration
        ? descriptor
        : null;
    });
    expect(existsSync(claimPath)).toBe(true);
    expect(
      existsSync(recoveryClaimPath(fixture.descriptorPath, claimantGeneration)),
    ).toBe(false);
    expect(processIdentity(fixture.initialDescriptor.launch.pid)).toBeNull();
    expect(processIdentity(legacyLaunch.pid)).toBeNull();
    expect(recovered.launch.generation).not.toBe(
      fixture.initialDescriptor.launch.generation,
    );
    expect(processIdentity(recovered.launch.pid)).toBe(
      recovered.launch.processIdentity,
    );
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
    await waitFor(() => appStarts(fixture.appEvents).length === 2);
    expect(appStarts(fixture.appEvents)).toHaveLength(2);
  },
);

it.runIf(process.platform !== "win32")(
  "fails closed when the adjacent hard-link claim cannot cross the filesystem boundary",
  () => {
    const root = mkdtempSync(join(tmpdir(), "dure-frontend-claim-exdev-"));
    temporaryRoots.push(root);
    const descriptorPath = join(root, "descriptor.json");
    const supervisorGeneration = "a".repeat(64);
    const source = '{"authority":"stale"}\n';
    writeFileSync(descriptorPath, source, { mode: 0o600 });
    const snapshot = {
      pathname: descriptorPath,
      source,
      stat: lstatSync(descriptorPath),
      value: { supervisor: { generation: supervisorGeneration } },
    };
    const crossDevice = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });

    expect(() =>
      claimStaleDescriptor(snapshot, {
        linkDescriptor() {
          throw crossDevice;
        },
      }),
    ).toThrow(crossDevice);
    expect(readFileSync(descriptorPath, "utf8")).toBe(source);
    expect(
      existsSync(recoveryClaimPath(descriptorPath, supervisorGeneration)),
    ).toBe(false);
  },
);

it.runIf(process.platform !== "win32")(
  "removes a delayed loser's exact token after the winner publishes and releases",
  () => {
    const root = mkdtempSync(join(tmpdir(), "dure-frontend-delayed-claim-"));
    temporaryRoots.push(root);
    const descriptorPath = join(root, "descriptor.json");
    const supervisorGeneration = "b".repeat(64);
    const claimPath = recoveryClaimPath(
      descriptorPath,
      supervisorGeneration,
    );
    const staleSource = '{"authority":"stale"}\n';
    writeFileSync(descriptorPath, staleSource, { mode: 0o600 });
    const staleSnapshot = {
      pathname: descriptorPath,
      source: staleSource,
      stat: lstatSync(descriptorPath),
      value: { supervisor: { generation: supervisorGeneration } },
    };

    claimStaleDescriptor(staleSnapshot);
    const publishedSource = '{"authority":"winner"}\n';
    writeAtomicFile(descriptorPath, publishedSource);
    unlinkSync(claimPath);

    expect(() => claimStaleDescriptor(staleSnapshot)).toThrowError(
      /^dev launch supervisor descriptor changed during stale recovery$/,
    );
    expect(existsSync(claimPath)).toBe(false);
    expect(readFileSync(descriptorPath, "utf8")).toBe(publishedSource);
  },
);

it.runIf(process.platform !== "win32")(
  "admits one hard-link claimant after a published claimant crashes and two successors reach the CAS boundary",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dure-frontend-claim-race-"));
    temporaryRoots.push(root);
    const descriptorPath = join(root, "descriptor.json");
    const predecessorGeneration = "e".repeat(64);
    const supervisorGeneration = "f".repeat(64);
    const predecessorClaimPath = recoveryClaimPath(
      descriptorPath,
      predecessorGeneration,
    );
    const claimPath = recoveryClaimPath(
      descriptorPath,
      supervisorGeneration,
    );
    const releasePath = join(root, "release");
    const finishPath = join(root, "finish");
    const workerPath = join(root, "claim-worker.mjs");
    const resultPrefix = join(root, "result");
    const predecessorSource = '{"authority":"predecessor"}\n';
    writeFileSync(descriptorPath, predecessorSource, { mode: 0o600 });
    const predecessorSnapshot = {
      pathname: descriptorPath,
      source: predecessorSource,
      stat: lstatSync(descriptorPath),
      value: { supervisor: { generation: predecessorGeneration } },
    };
    claimStaleDescriptor(predecessorSnapshot);
    const publishedSource = '{"authority":"published-claimant"}\n';
    writeAtomicFile(descriptorPath, publishedSource);
    writeFileSync(
      workerPath,
      `import { existsSync, linkSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { claimStaleDescriptor } from ${JSON.stringify(
        pathToFileURL(
          fileURLToPath(
            new URL("./lib/dev-launch-supervisor.mjs", import.meta.url),
          ),
        ).href,
      )};

const [descriptorPath, releasePath, finishPath, resultPrefix] = process.argv.slice(2);
const pause = new Int32Array(new SharedArrayBuffer(4));
const waitForFile = (pathname) => {
  const deadline = Date.now() + 5_000;
  while (!existsSync(pathname)) {
    if (Date.now() >= deadline) throw new Error("claim worker barrier timed out");
    Atomics.wait(pause, 0, 0, 10);
  }
};
const snapshot = {
  pathname: descriptorPath,
  source: readFileSync(descriptorPath, "utf8"),
  stat: lstatSync(descriptorPath),
  value: { supervisor: { generation: ${JSON.stringify(supervisorGeneration)} } },
};
try {
  claimStaleDescriptor(snapshot, {
    linkDescriptor(source, target) {
      writeFileSync(\`\${resultPrefix}.\${process.pid}.link-ready\`, "ready\\n");
      waitForFile(releasePath);
      linkSync(source, target);
    },
  });
  writeFileSync(\`\${resultPrefix}.\${process.pid}.json\`, JSON.stringify({ outcome: "claimed" }));
  waitForFile(finishPath);
} catch (error) {
  writeFileSync(
    \`\${resultPrefix}.\${process.pid}.json\`,
    JSON.stringify({ outcome: "rejected", message: error.message }),
  );
}
`,
      { mode: 0o600 },
    );

    const workers = [0, 1].map(() =>
      spawn(
        process.execPath,
        [workerPath, descriptorPath, releasePath, finishPath, resultPrefix],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    );
    const completed = workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          let stderr = "";
          worker.stderr.setEncoding("utf8");
          worker.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          worker.once("error", reject);
          worker.once("close", (code, signal) =>
            resolve({ code, signal, stderr }),
          );
        }),
    );
    try {
      await waitFor(() =>
        workers.every((worker) =>
          existsSync(`${resultPrefix}.${worker.pid}.link-ready`),
        ),
      );
      writeFileSync(releasePath, "release\n", { mode: 0o600 });
      const results = await waitFor(() => {
        const paths = workers.map(
          (worker) => `${resultPrefix}.${worker.pid}.json`,
        );
        return paths.every(existsSync)
          ? paths.map((pathname) => JSON.parse(readFileSync(pathname, "utf8")))
          : null;
      });
      expect(results.filter(({ outcome }) => outcome === "claimed")).toHaveLength(1);
      expect(results.filter(({ outcome }) => outcome === "rejected")).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/stopped before claimant publication/),
        }),
      ]);
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(predecessorClaimPath)).toBe(true);
      expect(readFileSync(predecessorClaimPath, "utf8")).toBe(
        predecessorSource,
      );
      expect(readFileSync(descriptorPath, "utf8")).toBe(publishedSource);
      const descriptorStat = lstatSync(descriptorPath);
      const claimStat = lstatSync(claimPath);
      expect({ dev: claimStat.dev, ino: claimStat.ino }).toEqual({
        dev: descriptorStat.dev,
        ino: descriptorStat.ino,
      });
    } finally {
      writeFileSync(finishPath, "finish\n", { mode: 0o600 });
      const outcomes = await Promise.all(completed);
      for (const outcome of outcomes) {
        expect(outcome, outcome.stderr).toMatchObject({ code: 0, signal: null });
      }
      if (existsSync(claimPath)) unlinkSync(claimPath);
      if (existsSync(predecessorClaimPath)) unlinkSync(predecessorClaimPath);
    }
  },
);

it.runIf(process.platform !== "win32")(
  "admits only one of two stale-recovery contenders without signaling the live generation",
  async () => {
    const fixture = await createRunningFixture("frontend-contenders");
    fixture.runner.child.kill("SIGKILL");
    await expect(fixture.runner.exited).resolves.toMatchObject({
      code: null,
      signal: "SIGKILL",
    });

    const contenders = [
      spawnFixtureRunner(fixture.worktreeRoot, fixture.environment),
      spawnFixtureRunner(fixture.worktreeRoot, fixture.environment),
    ];
    const winner = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        contenders.some(({ child }) => child.pid === descriptor.supervisor.pid)
        ? descriptor
        : null;
    });
    const loser = contenders.find(
      ({ child }) => child.pid !== winner.supervisor.pid,
    );
    await expect(loser.exited).resolves.toMatchObject({ code: 1, signal: null });

    expect(winner.launch).toEqual(fixture.initialDescriptor.launch);
    expect(winner.frontend).toEqual(fixture.initialDescriptor.frontend);
    expect(processIdentity(winner.launch.pid)).toBe(
      winner.launch.processIdentity,
    );
    expect(processIdentity(winner.frontend.pid)).toBe(
      winner.frontend.processIdentity,
    );
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
    expect(
      jsonLines(fixture.appEvents).filter((event) => event.type === "stopped"),
    ).toHaveLength(0);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "stopped",
      ),
    ).toHaveLength(0);
  },
);

it.runIf(process.platform !== "win32")(
  "replaces a stale preparing frontend instead of adopting an unactivated candidate",
  async () => {
    const fixture = await createRunningFixture("frontend-prep-crash");
    writeFileSync(
      fixture.descriptorPath,
      `${JSON.stringify({
        ...fixture.initialDescriptor,
        state: "preparing",
        frontend: null,
        candidateFrontend: fixture.initialDescriptor.frontend,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    fixture.runner.child.kill("SIGKILL");
    await fixture.runner.exited;

    const successor = spawnFixtureRunner(
      fixture.worktreeRoot,
      fixture.environment,
    );
    const recovered = await waitFor(() => {
      const descriptor = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      return descriptor.state === "ready" &&
        descriptor.supervisor.generation !==
          fixture.initialDescriptor.supervisor.generation
        ? descriptor
        : null;
    });
    expect(recovered.launch).toEqual(fixture.initialDescriptor.launch);
    expect(recovered.frontend.generation).not.toBe(
      fixture.initialDescriptor.frontend.generation,
    );
    expect(processIdentity(fixture.initialDescriptor.frontend.pid)).toBeNull();
    expect(processIdentity(recovered.frontend.pid)).toBe(
      recovered.frontend.processIdentity,
    );
    expect(appStarts(fixture.appEvents)).toHaveLength(1);
    expect(
      jsonLines(fixture.frontendEvents).filter(
        (event) => event.type === "ready",
      ),
    ).toHaveLength(2);
    requestRunnerStop(successor);
    const successorOutcome = await boundedRunnerOutcome(
      successor.completed,
      successor,
      "close after adopted cleanup",
    );
    expect(successorOutcome, JSON.stringify(successor.output())).toMatchObject({
      code: 1,
      signal: null,
    });
    const cleanupEvidence = {
      successorPid: successor.child.pid,
      appIdentity: processIdentity(fixture.initialDescriptor.launch.pid),
      descriptor: existsSync(fixture.descriptorPath)
        ? JSON.parse(readFileSync(fixture.descriptorPath, "utf8"))
        : null,
      output: successor.output(),
    };
    if (cleanupEvidence.appIdentity || cleanupEvidence.descriptor) {
      throw new Error(`adopted cleanup failed: ${JSON.stringify(cleanupEvidence)}`);
    }
  },
);
