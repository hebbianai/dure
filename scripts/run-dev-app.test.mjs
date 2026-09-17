import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appControlDirectory,
  resolveDevServer,
  worktreeDevIdentity,
} from "./lib/app-channel.mjs";
import {
  DEV_SERVER_PROFILE_FILE,
  persistDevServerProfile,
  selectDevServerProfile,
} from "./lib/dev-server-profile.mjs";
import { devParentSourceGeneration } from "./lib/dev-launch-impact.mjs";
import {
  createDevLaunchFixtureRegistry,
  FIXTURE_LIFECYCLE_TIMEOUT_MS,
  processGroupWitnessReadySource,
  writeFixtureBackendRuntime,
  writeFixtureNodeDependencies,
  writeFixtureTauriCli,
} from "./lib/dev-launch-test-support.mjs";
import {
  DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  redactDevLaunchCapability,
} from "./lib/dev-launch-contract.mjs";
import { observeDevLaunchParentAuthority } from "./lib/dev-launch-client.mjs";
import { processIdentity } from "./lib/process-identity.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const productionRunnerPath = fileURLToPath(
  new URL("./run-dev-app.mjs", import.meta.url),
);
const runnerPath = fileURLToPath(
  new URL("./fixtures/run-dev-app-fixture.mjs", import.meta.url),
);
const temporaryRoots = [];
const fixtureProcesses = createDevLaunchFixtureRegistry();
const FAKE_TAURI_FIXTURE_TIMEOUT_MS = FIXTURE_LIFECYCLE_TIMEOUT_MS;
const fakeTauriReadinessExitSource = `
  const readinessTimeoutMs = Number(process.env.DURE_TEST_READY_TIMEOUT_MS);
  if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0) {
    process.stderr.write("fake Tauri readiness timeout is invalid\\n");
    process.exit(125);
  }
  const deadline = setTimeout(() => {
    process.stderr.write("fake Tauri readiness timed out\\n");
    process.exit(124);
  }, readinessTimeoutMs);
  const timer = setInterval(() => {
    if (!existsSync(process.env.DURE_TEST_DESCRIPTOR)) return;
    try {
      const descriptor = JSON.parse(
        readFileSync(process.env.DURE_TEST_DESCRIPTOR, "utf8"),
      );
      if (descriptor.state !== "ready") return;
      clearTimeout(deadline);
      clearInterval(timer);
      process.exit(0);
    } catch {}
  }, 10);
`;
let runnerHome;

beforeEach(() => {
  runnerHome = mkdtempSync(join(tmpdir(), "dure-dev-runner-"));
  temporaryRoots.push(runnerHome);
});

afterEach(async () => {
  try {
    await fixtureProcesses.retireAll();
  } finally {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function registerFixtureDescriptor(channel) {
  const descriptorPath = join(
    appControlDirectory(runnerHome, channel),
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  fixtureProcesses.registerDescriptor(descriptorPath);
  return descriptorPath;
}

function runnerEnv(extra = {}) {
  const env = {
    ...process.env,
    HOME: runnerHome,
    DURE_TEST_HEADROOM_MODE: "allow",
  };
  delete env.HEBBIAN_DEV_HOST;
  delete env.DURE_DEV_PORT;
  delete env.HEBBIAN_DEV_PORT;
  delete env.HEBBIAN_DEV_INSTANCE;
  delete env.HMUX_SESSION_ID;
  delete env.HMUX_WORKSPACE_ID;
  return {
    ...env,
    ...extra,
  };
}

function printPlan(env = {}) {
  const result = spawnSync(process.execPath, [runnerPath, "--print-config"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: runnerEnv(env),
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
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
        reject(new Error("fixture observation timed out"));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

function spawnEntrypoint(entrypoint, env, cwd = repoRoot, spawnOptions = {}) {
  const child = spawn(process.execPath, [entrypoint], {
    cwd,
    env: runnerEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
    ...spawnOptions,
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
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolve({ code, signal, stdout, stderr }),
    );
  });
  return { child, completed };
}

function spawnRunner(env, cwd = repoRoot) {
  return spawnEntrypoint(runnerPath, env, cwd);
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
    throw new Error("test listener did not allocate a TCP port");
  }
  await new Promise((resolve) => listener.close(resolve));
  return address.port;
}

function isolatedRunnerRepository() {
  const root = mkdtempSync(join(tmpdir(), "dure-dev-runner-repo-"));
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
      identifier: "dev.dure.fixture",
      build: {},
      app: { windows: [{ title: "Dure" }] },
    })}\n`,
  );
  for (const [name, label] of [
    ["node-dependency-preflight.mjs", "node-preflight"],
    ["stage-mobile-runtime.mjs", "mobile-runtime"],
    ["guard-dev-channel.mjs", "channel-guard"],
    ["agent-tools-fixture.mjs", "agent-tools"],
  ]) {
    writeFileSync(
      join(root, "scripts", name),
      `import { appendFileSync } from "node:fs";
if (process.env.DURE_TEST_HEADROOM_EVENTS) {
  appendFileSync(process.env.DURE_TEST_HEADROOM_EVENTS, ${JSON.stringify(`${label}\n`)});
}
`,
      { mode: 0o600 },
    );
  }
  writeFileSync(
    join(root, "scripts", "prepare-agent-tools.sh"),
    `#!/bin/sh\nexec "${process.execPath}" "${join(root, "scripts", "agent-tools-fixture.mjs")}"\n`,
  );
  writeFileSync(
    join(root, "scripts", "run-dev-launch-child.mjs"),
    `import { appendFileSync } from "node:fs";
if (process.argv[2] !== "--check") process.exit(1);
if (process.env.DURE_TEST_EVENTS) {
  appendFileSync(process.env.DURE_TEST_EVENTS, "launch admission\\n");
}
`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, "scripts", "run-dev-frontend.mjs"),
    `import { createServer } from "node:http";
import { computeBackendRuntimeFingerprint } from ${JSON.stringify(new URL("./lib/backend-runtime-fingerprint.mjs", import.meta.url).href)};
import { requireCurrentNodeDependencyInstall } from ${JSON.stringify(new URL("./node-dependency-preflight.mjs", import.meta.url).href)};

const args = process.argv.slice(2);
if (args.includes("--check")) process.exit(0);
const backendRuntimeFingerprint = computeBackendRuntimeFingerprint(process.cwd());
const nodeDependencyFingerprint = requireCurrentNodeDependencyInstall(process.cwd()).fingerprint;
const value = (name) => args[args.indexOf(name) + 1];
const host = value("--host");
const port = Number(value("--port"));
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
const channel = process.env.DURE_APP_CHANNEL;
${processGroupWitnessReadySource("channel", "generation")}
let activated = false;
process.once("message", async (message) => {
  if (message.type !== "frontend_activate") process.exit(9);
  await groupWitness.retain();
  activated = true;
  process.send({ schemaVersion: 1, type: "frontend_activated", channel, generation });
});
process.once("disconnect", () => {
  if (!activated) process.exit(1);
});
const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    schemaVersion: 1,
    protocolVersion: 1,
    type: "frontend_ready",
    channel,
    generation,
    backendRuntimeFingerprint,
    nodeDependencyFingerprint,
  }));
});
server.once("error", (error) => {
  console.error("fixture frontend: " + (error.code ?? error.message));
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
  process.exit(1);
});
server.listen(port, host, () => {
  process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel, generation });
});
const stop = () => server.close(() => process.exit(0));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
`,
    { mode: 0o600 },
  );
  const initialized = spawnSync("git", ["init", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  if (initialized.status !== 0) {
    throw new Error(
      `could not initialize fixture repository: ${initialized.stderr}`,
    );
  }
  return root;
}

describe("app:dev launcher origin continuity", () => {
  it("executes the canonical entrypoint directly", () => {
    const result = spawnSync(
      process.execPath,
      [productionRunnerPath, "--print-config"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: runnerEnv(),
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).config.build.devUrl).toMatch(
      /^http:\/\/localhost:/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "keeps the exact supervisor alive after the invoking process group exits",
    async () => {
      const worktreeRoot = realpathSync(isolatedRunnerRepository());
      writeFixtureTauriCli(
        worktreeRoot,
        `const args = process.argv.slice(2);
if (args[0] === "--version") process.exit(0);
if (args[0] !== "dev") process.exit(19);
const stop = () => process.exit(0);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("SIGHUP", stop);
setInterval(() => {}, 1_000);
`,
      );
      const instance = "detached-owner";
      const channel = worktreeDevIdentity(worktreeRoot, instance).channel;
      const descriptorPath = registerFixtureDescriptor(channel);
      const logPath = join(
        appControlDirectory(runnerHome, channel),
        "dev-launch.log",
      );
      const launcher = spawnEntrypoint(
        runnerPath,
        {
          DURE_DEV_PORT: String(await unusedPort()),
          HEBBIAN_DEV_INSTANCE: instance,
          DURE_TEST_DETACHED: "1",
        },
        worktreeRoot,
        { detached: true },
      );

      const ready = await Promise.race([
        waitFor(() => {
          if (!existsSync(descriptorPath)) return null;
          const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
          return descriptor.state === "ready" ? descriptor : null;
        }, FAKE_TAURI_FIXTURE_TIMEOUT_MS),
        launcher.completed.then((result) => {
          throw new Error(
            `launcher exited before readiness: ${JSON.stringify(result)}; ` +
              `log: ${existsSync(logPath) ? readFileSync(logPath, "utf8") : "missing"}`,
          );
        }),
      ]);
      try {
        process.kill(-launcher.child.pid, "SIGHUP");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      await launcher.completed;

      const observed = await observeDevLaunchParentAuthority({
        home: runnerHome,
        root: worktreeRoot,
        channel,
        requireParentReloadAuthority: true,
        requireFrontendAuthority: true,
        timeoutMs: 1_000,
      });
      expect(observed.supervisor.pid).toBe(ready.supervisor.pid);
      expect(observed.supervisor.pid).not.toBe(launcher.child.pid);
    },
  );

  it("preflights target prerequisites without retiring the exact active handoff", () => {
    const worktreeRoot = realpathSync(isolatedRunnerRepository());
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-preflight-bin-"));
    temporaryRoots.push(fakeBin);
    const eventsPath = join(fakeBin, "events.txt");
    writeFixtureTauriCli(
      worktreeRoot,
      `const { appendFileSync } = require("node:fs");
if (process.argv.slice(2).join(" ") !== "--version") process.exit(64);
appendFileSync(process.env.DURE_TEST_EVENTS, "tauri --version\\n");
`,
    );
    const channel = worktreeDevIdentity(worktreeRoot).channel;
    const identity = (pid, processIdentity, generation) => ({
      pid,
      processIdentity,
      generation: generation.repeat(64),
    });
    const sourceGeneration = devParentSourceGeneration(
      worktreeRoot,
      process.platform,
      { sourceRoot: repoRoot },
    );
    const capability = "e".repeat(64);
    const supervisor = identity(
      process.pid,
      processIdentity(process.pid),
      "b",
    );
    const launch = identity(20, "child", "c");
    const controlDirectory = appControlDirectory(runnerHome, channel);
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(controlDirectory, DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: 2,
        state: "ready",
        worktreeRoot,
        channel,
        socketPath: join(runnerHome, "preflight.sock"),
        capability,
        capabilities: ["child_restart", "parent_reload"],
        sourceGeneration: "f".repeat(64),
        supervisor,
        launch,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    const payload = {
      sourceGeneration,
      worktreeRoot,
      channel,
      controlDirectory,
      handoff: {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
        type: "parent_handoff",
        requestId: "a".repeat(64),
        worktreeRoot,
        channel,
        capability: redactDevLaunchCapability(capability),
        previousSupervisor: supervisor,
        previousLaunch: launch,
        targetSupervisorGeneration: "d".repeat(64),
        targetSourceGeneration: sourceGeneration,
        phase: "exec_pending",
        committedAtMs: Date.now(),
      },
    };
    const runPreflight = (value) =>
      spawnSync(
        process.execPath,
        [runnerPath, "--parent-reload-preflight", JSON.stringify(value)],
        {
          cwd: worktreeRoot,
          encoding: "utf8",
          env: runnerEnv({
            DURE_TEST_EVENTS: eventsPath,
            DURE_TEST_HEADROOM_EVENTS: eventsPath,
            PATH: `${fakeBin}:${process.env.PATH}`,
          }),
        },
      );

    const valid = runPreflight(payload);
    expect(valid.status, valid.stderr).toBe(0);
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
      "headroom",
      "launch admission",
      "channel-guard",
      "node-preflight",
      ...(process.platform === "darwin" ? ["mobile-runtime"] : []),
      ...(process.platform === "win32" ? [] : ["agent-tools"]),
      "tauri --version",
    ]);
    const mismatchedHandoff = runPreflight({
      ...payload,
      handoff: {
        ...payload.handoff,
        previousLaunch: identity(21, "other-child", "c"),
      },
    });
    expect(mismatchedHandoff.status).toBe(1);
    expect(mismatchedHandoff.stderr).toMatch(/cannot resume the exact active/);
    expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toHaveLength(
      process.platform === "win32" ? 5 : process.platform === "darwin" ? 7 : 6,
    );
    const mismatched = runPreflight({ ...payload, channel: `${channel}-other` });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toMatch(/changed the loaded source or launch identity/);
  });

  it.skipIf(process.platform === "win32")(
    "reports agent tool preparation failure before starting the frontend or app",
    () => {
      const worktreeRoot = isolatedRunnerRepository();
      const eventsPath = join(worktreeRoot, "events.txt");
      const channel = worktreeDevIdentity(realpathSync(worktreeRoot)).channel;
      const descriptorPath = registerFixtureDescriptor(channel);
      writeFileSync(
        join(worktreeRoot, "scripts", "prepare-agent-tools.sh"),
        "#!/bin/sh\necho 'fixture agent tools unavailable' >&2\nexit 23\n",
      );
      writeFixtureTauriCli(worktreeRoot, "throw new Error('app must not launch');\n");
      const result = spawnSync(process.execPath, [runnerPath], {
        cwd: worktreeRoot,
        encoding: "utf8",
        env: runnerEnv({ DURE_TEST_HEADROOM_EVENTS: eventsPath }),
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture agent tools unavailable");
      expect(result.stderr).not.toContain("app must not launch");
      expect(readFileSync(eventsPath, "utf8").trim().split("\n")).toEqual([
        "headroom", "channel-guard", "node-preflight",
        ...(process.platform === "darwin" ? ["mobile-runtime"] : []),
      ]);
      expect(existsSync(descriptorPath)).toBe(false);
    },
  );

  it("refuses low headroom before any launch prerequisite", () => {
    const worktreeRoot = isolatedRunnerRepository();
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-low-headroom-bin-"));
    temporaryRoots.push(fakeBin);
    const eventsPath = join(fakeBin, "events.txt");
    const instance = "low-headroom";
    const channel = worktreeDevIdentity(
      realpathSync(worktreeRoot),
      instance,
    ).channel;
    const descriptorPath = registerFixtureDescriptor(channel);
    const hmuxProviderIdentity = {
      sessionId: "standalone_low_headroom",
      workspaceId: "workspace_low_headroom",
    };
    const launch = () =>
      spawnSync(process.execPath, [runnerPath], {
        cwd: worktreeRoot,
        encoding: "utf8",
        env: runnerEnv({
          DURE_DEV_PORT: "19427",
          DURE_TEST_HEADROOM_EVENTS: eventsPath,
          DURE_TEST_HEADROOM_MODE: "refuse",
          HEBBIAN_DEV_INSTANCE: instance,
          HMUX_SESSION_ID: hmuxProviderIdentity.sessionId,
          HMUX_WORKSPACE_ID: hmuxProviderIdentity.workspaceId,
        }),
      });

    const result = launch();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fixture low headroom");
    expect(readFileSync(eventsPath, "utf8")).toBe("headroom\n");
    const firstFailure = JSON.parse(readFileSync(descriptorPath, "utf8"));
    expect(firstFailure).toMatchObject({
      state: "preparing",
      worktreeRoot: realpathSync(worktreeRoot),
      channel,
      sourceGeneration: devParentSourceGeneration(
        realpathSync(worktreeRoot),
        process.platform,
        { sourceRoot: repoRoot },
      ),
      startupFailure: {
        type: "startup_failure",
        hmux: hmuxProviderIdentity,
        reason: "fixture low headroom",
      },
    });

    const retry = launch();
    expect(retry.status).toBe(1);
    const retriedFailure = JSON.parse(readFileSync(descriptorPath, "utf8"));
    expect(retriedFailure).toMatchObject({
      state: "preparing",
      startupFailure: {
        type: "startup_failure",
        hmux: hmuxProviderIdentity,
        reason: "fixture low headroom",
      },
    });
    expect(retriedFailure.supervisor.generation).not.toBe(
      firstFailure.supervisor.generation,
    );
  });

  it("starts the local app without invoking remote bundle staging", async () => {
    const fixtureRoot = isolatedRunnerRepository();
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-local-start-bin-"));
    temporaryRoots.push(fakeBin);
    const remoteStagePath = join(fakeBin, "remote-stage-started");
    const appStartedPath = join(fakeBin, "app-started");
    const appStopPath = join(fakeBin, "app-stop");
    const instance = "local-start";
    const channel = worktreeDevIdentity(
      realpathSync(fixtureRoot),
      instance,
    ).channel;
    const descriptorPath = registerFixtureDescriptor(channel);
    const corepack = join(fakeBin, "corepack");
    writeFileSync(
      corepack,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "pnpm" && args[1] === "remote-tools:stage:dev") {
  writeFileSync(process.env.DURE_TEST_REMOTE_STAGE, "started\\n");
  process.exit(91);
} else {
  process.exit(19);
}
`,
      { mode: 0o700 },
    );
    writeFixtureTauriCli(
      fixtureRoot,
      `const { existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.exit(0);
} else if (args[0] === "dev") {
  writeFileSync(process.env.DURE_TEST_APP_STARTED, "started\\n");
  const timer = setInterval(() => {
    if (!existsSync(process.env.DURE_TEST_APP_STOP)) return;
    clearInterval(timer);
    process.exit(0);
  }, 10);
} else {
  process.exit(19);
}
`,
    );

    const runner = spawnRunner(
      {
        DURE_DEV_PORT: String(await unusedPort()),
        DURE_TEST_REMOTE_STAGE: remoteStagePath,
        DURE_TEST_APP_STARTED: appStartedPath,
        DURE_TEST_APP_STOP: appStopPath,
        HEBBIAN_DEV_INSTANCE: instance,
        PATH: `${fakeBin}:${process.env.PATH}`,
      },
      fixtureRoot,
    );
    let result;
    try {
      await waitFor(() => existsSync(appStartedPath));
      await waitFor(() => {
        if (!existsSync(descriptorPath)) return false;
        return JSON.parse(readFileSync(descriptorPath, "utf8")).state ===
          "ready";
      });
      expect(existsSync(remoteStagePath)).toBe(false);
    } finally {
      if (existsSync(appStartedPath)) {
        writeFileSync(appStopPath, "stop\n", { mode: 0o600 });
      }
      result = await runner.completed;
    }
    expect(result.code, result.stderr).toBe(0);
  });

  it("admits one owner before any same-channel launch preparation", async () => {
    const fixtureRoot = isolatedRunnerRepository();
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-owner-bin-"));
    temporaryRoots.push(fakeBin);
    const eventsPath = join(fakeBin, "events.txt");
    const stageStartedPath = join(fakeBin, "stage-started");
    const releasePath = join(fakeBin, "release");
    const appStartedPath = join(fakeBin, "app-started");
    const appStopPath = join(fakeBin, "app-stop");
    const channel = worktreeDevIdentity(
      realpathSync(fixtureRoot),
      "single-owner",
    ).channel;
    const descriptorPath = join(
      appControlDirectory(runnerHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    writeFixtureTauriCli(
      fixtureRoot,
      `const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  appendFileSync(process.env.DURE_TEST_EVENTS, "prepare\\n");
  writeFileSync(process.env.DURE_TEST_STAGE_STARTED, "started\\n");
  const timer = setInterval(() => {
    if (!existsSync(process.env.DURE_TEST_RELEASE)) return;
    clearInterval(timer);
    process.exit(0);
  }, 10);
} else if (args[0] === "dev") {
  appendFileSync(process.env.DURE_TEST_EVENTS, "launch\\n");
  writeFileSync(process.env.DURE_TEST_APP_STARTED, "started\\n");
  const timer = setInterval(() => {
    if (!existsSync(process.env.DURE_TEST_APP_STOP)) return;
    clearInterval(timer);
    process.exit(0);
  }, 10);
} else {
  process.exit(19);
}
`,
    );

    const env = {
      DURE_DEV_PORT: String(await unusedPort()),
      DURE_TEST_EVENTS: eventsPath,
      DURE_TEST_STAGE_STARTED: stageStartedPath,
      DURE_TEST_RELEASE: releasePath,
      DURE_TEST_APP_STARTED: appStartedPath,
      DURE_TEST_APP_STOP: appStopPath,
      HEBBIAN_DEV_INSTANCE: "single-owner",
    };
    const runners = [
      spawnRunner(env, fixtureRoot),
      spawnRunner(env, fixtureRoot),
    ];
    let admission;
    let results;
    try {
      await waitFor(() => existsSync(stageStartedPath));
      admission = await Promise.race([
        ...runners.map(({ completed }, index) =>
          completed.then((result) => ({ type: "closed", index, result })),
        ),
        waitFor(() => readFileSync(eventsPath, "utf8") === "prepare\nprepare\n").then(
          () => ({ type: "duplicate" }),
        ),
      ]);
    } finally {
      writeFileSync(releasePath, "release\n", { mode: 0o600 });
      await waitFor(() => existsSync(appStartedPath));
      await waitFor(() => {
        if (!existsSync(descriptorPath)) return false;
        return JSON.parse(readFileSync(descriptorPath, "utf8")).state ===
          "ready";
      });
      writeFileSync(appStopPath, "stop\n", { mode: 0o600 });
      results = await Promise.all(runners.map(({ completed }) => completed));
    }
    const owners = results.filter(({ code }) => code === 0);
    const rejectedLaunches = results.filter(({ code }) => code !== 0);
    expect(admission.type).toBe("closed");
    expect(owners, JSON.stringify(results)).toHaveLength(1);
    expect(rejectedLaunches).toHaveLength(1);
    const [owner] = owners;
    const [rejected] = rejectedLaunches;
    expect(rejected.code, rejected.stderr).toBe(1);
    expect(rejected.stderr).toMatch(/already active|still live/);
    expect(rejected.stderr).not.toMatch(/already in use/);
    expect(rejected.stdout).not.toMatch(/^Starting /m);
    expect(owner.code, owner.stderr).toBe(0);
    expect(owner.stdout.match(/^Starting /gm)).toHaveLength(1);
    expect(readFileSync(eventsPath, "utf8")).toBe("prepare\nlaunch\n");
  });

  it("keeps a hosting pane's Hmux root out of the canonical dev catalog", async () => {
    const fixtureRoot = realpathSync(isolatedRunnerRepository());
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-hmux-root-bin-"));
    temporaryRoots.push(fakeBin);
    const capturePath = join(fakeBin, "environment.txt");
    writeFixtureTauriCli(
      fixtureRoot,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dev") {
  writeFileSync(process.env.DURE_TEST_CAPTURE_ENV, [
    \`HMUX_DISCOVERY_ROOT=\${process.env.HMUX_DISCOVERY_ROOT ?? ""}\`,
    \`DURE_HOME=\${process.env.DURE_HOME ?? ""}\`,
    \`HOME=\${process.env.HOME ?? ""}\`,
  ].join("\\n") + "\\n");
${fakeTauriReadinessExitSource}
} else {
  process.exit(0);
}
`,
    );

    const port = await unusedPort();

    const canonicalDureHome = join(runnerHome, ".dure");
    for (const [instance, inheritedRoot] of [
      ["channel-a", join(runnerHome, "hosting-pane-catalog-a")],
      ["channel-b", join(runnerHome, "hosting-pane-catalog-b")],
    ]) {
      const channel = worktreeDevIdentity(fixtureRoot, instance).channel;
      const descriptorPath = registerFixtureDescriptor(channel);
      const result = spawnSync(process.execPath, [runnerPath], {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: runnerEnv({
          DURE_HOME: canonicalDureHome,
          DURE_TEST_CAPTURE_ENV: capturePath,
          DURE_TEST_DESCRIPTOR: descriptorPath,
          DURE_TEST_READY_TIMEOUT_MS: String(
            Math.floor(FAKE_TAURI_FIXTURE_TIMEOUT_MS / 2),
          ),
          HEBBIAN_DEV_INSTANCE: instance,
          DURE_DEV_PORT: String(port),
          HMUX_DISCOVERY_ROOT: inheritedRoot,
        }),
        killSignal: "SIGKILL",
        timeout: FAKE_TAURI_FIXTURE_TIMEOUT_MS,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(capturePath, "utf8").trim().split("\n")).toEqual([
        "HMUX_DISCOVERY_ROOT=",
        `DURE_HOME=${canonicalDureHome}`,
        `HOME=${runnerHome}`,
      ]);
    }

    const portableDureHome = join(runnerHome, "portable-dure-home");
    const portableHmuxRoot = join(runnerHome, "portable-hmux-root");
    const portableChannel = worktreeDevIdentity(fixtureRoot, "portable").channel;
    const portableDescriptorPath = registerFixtureDescriptor(portableChannel);
    const portable = spawnSync(process.execPath, [runnerPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: runnerEnv({
        DURE_HOME: portableDureHome,
        DURE_TEST_CAPTURE_ENV: capturePath,
        DURE_TEST_DESCRIPTOR: portableDescriptorPath,
        DURE_TEST_READY_TIMEOUT_MS: String(
          Math.floor(FAKE_TAURI_FIXTURE_TIMEOUT_MS / 2),
        ),
        HEBBIAN_DEV_INSTANCE: "portable",
        DURE_DEV_PORT: String(port),
        HMUX_DISCOVERY_ROOT: portableHmuxRoot,
      }),
      killSignal: "SIGKILL",
      timeout: FAKE_TAURI_FIXTURE_TIMEOUT_MS,
    });
    expect(portable.status, portable.stderr).toBe(0);
    expect(readFileSync(capturePath, "utf8").trim().split("\n")).toEqual([
      `HMUX_DISCOVERY_ROOT=${portableHmuxRoot}`,
      `DURE_HOME=${portableDureHome}`,
      `HOME=${runnerHome}`,
    ]);
  });

  it("launches Tauri with only the canonical Dure channel names", async () => {
    const fixtureRoot = realpathSync(isolatedRunnerRepository());
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-launch-bin-"));
    temporaryRoots.push(fakeBin);
    const capturePath = join(fakeBin, "environment.txt");
    writeFixtureTauriCli(
      fixtureRoot,
      `const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dev") {
  writeFileSync(process.env.DURE_TEST_CAPTURE_ENV, [
    \`DURE_APP_CHANNEL=\${process.env.DURE_APP_CHANNEL ?? ""}\`,
    \`VITE_DURE_APP_CHANNEL=\${process.env.VITE_DURE_APP_CHANNEL ?? ""}\`,
    \`HEBBIAN_APP_CHANNEL=\${process.env.HEBBIAN_APP_CHANNEL ?? ""}\`,
    \`VITE_HEBBIAN_APP_CHANNEL=\${process.env.VITE_HEBBIAN_APP_CHANNEL ?? ""}\`,
    \`DURE_DEV_PORT=\${process.env.DURE_DEV_PORT ?? ""}\`,
    \`HEBBIAN_DEV_PORT=\${process.env.HEBBIAN_DEV_PORT ?? ""}\`,
  ].join("\\n") + "\\n");
${fakeTauriReadinessExitSource}
} else {
  process.exit(0);
}
`,
    );

    const port = await unusedPort();
    const canonicalDureHome = join(runnerHome, ".dure");
    const channel = worktreeDevIdentity(fixtureRoot).channel;
    const descriptorPath = registerFixtureDescriptor(channel);

    const result = spawnSync(process.execPath, [runnerPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: runnerEnv({
        DURE_APP_CHANNEL: "dev-inherited-dure-decoy",
        HEBBIAN_APP_CHANNEL: "dev-inherited-hebbian-decoy",
        VITE_DURE_APP_CHANNEL: "dev-inherited-vite-dure-decoy",
        VITE_HEBBIAN_APP_CHANNEL: "dev-inherited-vite-hebbian-decoy",
        HEBBIAN_DEV_PORT: "15438",
        DURE_HOME: canonicalDureHome,
        DURE_TEST_CAPTURE_ENV: capturePath,
        DURE_TEST_DESCRIPTOR: descriptorPath,
        DURE_TEST_READY_TIMEOUT_MS: String(
          Math.floor(FAKE_TAURI_FIXTURE_TIMEOUT_MS / 2),
        ),
        DURE_DEV_PORT: String(port),
      }),
      killSignal: "SIGKILL",
      timeout: FAKE_TAURI_FIXTURE_TIMEOUT_MS,
    });

    expect(result.status, result.stderr).toBe(0);
    const environment = Object.fromEntries(
      readFileSync(capturePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(environment).toEqual({
      DURE_APP_CHANNEL: channel,
      VITE_DURE_APP_CHANNEL: channel,
      HEBBIAN_APP_CHANNEL: "",
      VITE_HEBBIAN_APP_CHANNEL: "",
      DURE_DEV_PORT: String(port),
      HEBBIAN_DEV_PORT: "",
    });
  });

  it("bounds fake Tauri when its readiness descriptor never appears", async () => {
    const fixtureRoot = realpathSync(isolatedRunnerRepository());
    const fakeBin = mkdtempSync(join(tmpdir(), "dure-dev-bounded-tauri-bin-"));
    temporaryRoots.push(fakeBin);
    const fakeCli = writeFixtureTauriCli(
      fixtureRoot,
      `const { existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dev") {
${fakeTauriReadinessExitSource}
} else {
  process.exit(0);
}
`,
    );
    const result = spawnSync(process.execPath, [fakeCli, "dev"], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: runnerEnv({
        DURE_TEST_DESCRIPTOR: join(fakeBin, "never-ready.json"),
        DURE_TEST_READY_TIMEOUT_MS: "100",
      }),
      killSignal: "SIGKILL",
      timeout: FAKE_TAURI_FIXTURE_TIMEOUT_MS,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(124);
    expect(result.stderr).toContain("fake Tauri readiness timed out");
  });

  it("keeps the channel-pinned origin instead of inheriting another worktree's port", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-origin-"));
    temporaryRoots.push(home);
    const worktreeRoot = realpathSync(repoRoot);
    const channel = worktreeDevIdentity(worktreeRoot).channel;
    const controlDirectory = appControlDirectory(home, channel);
    mkdirSync(controlDirectory, { recursive: true });
    writeFileSync(
      join(controlDirectory, DEV_SERVER_PROFILE_FILE),
      `${JSON.stringify({
        schemaVersion: 1,
        channel,
        worktreeRoot,
        host: "localhost",
        port: 1437,
      })}\n`,
      { mode: 0o600 },
    );

    const plan = printPlan({
      HOME: home,
      // This is inherited from the daily-driver worktree, not an origin choice
      // for the channel above.
      DURE_DEV_PORT: "1420",
    });

    expect(plan.devServer).toEqual({
      host: "localhost",
      port: 1437,
      origin: "http://localhost:1437",
      source: "channel-profile",
    });
  });

  it("persists the first available origin as immutable channel authority", () => {
    const home = mkdtempSync(join(tmpdir(), "dure-dev-origin-"));
    temporaryRoots.push(home);
    const worktreeRoot = realpathSync(repoRoot);
    const channel = worktreeDevIdentity(worktreeRoot).channel;
    const selected = resolveDevServer(worktreeRoot, "1437");

    expect(
      persistDevServerProfile({
        home,
        channel,
        worktreeRoot,
        devServer: selected,
      }),
    ).toMatchObject({ port: 1437, source: "channel-profile" });
    expect(
      selectDevServerProfile({
        home,
        channel,
        worktreeRoot,
        portOverride: "1420",
      }),
    ).toMatchObject({ port: 1437, source: "channel-profile" });
    expect(() =>
      persistDevServerProfile({
        home,
        channel,
        worktreeRoot,
        devServer: resolveDevServer(worktreeRoot, "1420"),
      }),
    ).toThrow("already pinned to http://localhost:1437");
  });

  it("fails closed instead of replacing an unreadable channel profile", () => {
    const worktreeRoot = realpathSync(repoRoot);
    const channel = worktreeDevIdentity(worktreeRoot).channel;
    const controlDirectory = appControlDirectory(runnerHome, channel);
    mkdirSync(controlDirectory, { recursive: true });
    writeFileSync(join(controlDirectory, DEV_SERVER_PROFILE_FILE), "{}\n", {
      mode: 0o600,
    });

    const result = spawnSync(process.execPath, [runnerPath, "--print-config"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: runnerEnv({ DURE_DEV_PORT: "1420" }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid development server profile");
    expect(result.stderr).toContain("unsupported schemaVersion");
  });

  it("prints the same WebView origin across repeated launches", () => {
    const first = printPlan();
    const second = printPlan();

    expect(second.identity).toEqual(first.identity);
    expect(second.devServer).toEqual(first.devServer);
    expect(second.config.build.devUrl).toBe(first.devServer.origin);
    expect(first.devServer.source).toBe("worktree-hash");
    expect(first.macosDevBundle).toEqual({
      enabled: process.platform === "darwin",
      key: first.identity.channel,
      identifier: first.config.identifier,
    });
  });

  it("uses only the canonical DURE dev port without changing channel identity", () => {
    const canonical = printPlan({
      DURE_DEV_PORT: "15437",
      HEBBIAN_DEV_PORT: "1420",
    });
    const defaultPlan = printPlan();
    const legacyOnly = printPlan({ HEBBIAN_DEV_PORT: "15438" });

    expect(canonical.devServer).toEqual({
      host: "localhost",
      port: 15437,
      origin: "http://localhost:15437",
      source: "environment",
    });
    expect(canonical.identity).toEqual(defaultPlan.identity);
    expect(legacyOnly.devServer).toEqual(defaultPlan.devServer);
    expect(legacyOnly.identity).toEqual(defaultPlan.identity);
  });

  it("keeps an explicit canonical origin stable", () => {
    const first = printPlan({ DURE_DEV_PORT: "1420" });
    const second = printPlan({ DURE_DEV_PORT: "1420" });

    expect(first.devServer).toEqual({
      host: "localhost",
      port: 1420,
      origin: "http://localhost:1420",
      source: "environment",
    });
    expect(second.devServer).toEqual(first.devServer);
  });

  it("can retain a previous isolated 127.0.0.1 origin explicitly", () => {
    const plan = printPlan({
      HEBBIAN_DEV_HOST: "127.0.0.1",
      DURE_DEV_PORT: "54201",
    });

    expect(plan.devServer.origin).toBe("http://127.0.0.1:54201");
    expect(plan.config.build.devUrl).toBe(plan.devServer.origin);
    expect(plan.config.build.beforeDevCommand).toBeNull();
  });

  it("uses a distinct persistent WebView profile for an explicit QA instance", () => {
    const ordinary = printPlan({ DURE_DEV_PORT: "54201" });
    const first = printPlan({
      HEBBIAN_DEV_INSTANCE: "onboarding-a",
      DURE_DEV_PORT: "54201",
    });
    const second = printPlan({
      HEBBIAN_DEV_INSTANCE: "onboarding-a",
      DURE_DEV_PORT: "54201",
    });
    const other = printPlan({
      HEBBIAN_DEV_INSTANCE: "onboarding-b",
      DURE_DEV_PORT: "54202",
    });

    expect(first.identity).toEqual(second.identity);
    expect(first.identity.identifier).not.toBe(ordinary.identity.identifier);
    expect(first.identity.identifier).not.toBe(other.identity.identifier);
    expect(first.macosDevBundle.identifier).toBe(
      `io.hebbian.ade.dev.${first.identity.hash}`,
    );
    expect(first.macosDevBundle.identifier).not.toBe(
      other.macosDevBundle.identifier,
    );
    expect(first.identity.channel).not.toBe(other.identity.channel);
    expect(first.webviewStore.dataStoreIdentifier).toEqual(
      second.webviewStore.dataStoreIdentifier,
    );
    expect(first.webviewStore.dataStoreIdentifier).not.toEqual(
      other.webviewStore.dataStoreIdentifier,
    );
    expect(first.config.app.windows[0].dataDirectory).toBe(
      second.config.app.windows[0].dataDirectory,
    );
    expect(first.config.app.windows[0].dataDirectory).not.toBe(
      other.config.app.windows[0].dataDirectory,
    );
    expect(ordinary.webviewStore).toBeUndefined();
    expect(ordinary.config.app.windows[0]).not.toHaveProperty("dataDirectory");
  });

  it("rejects an unsafe QA instance before launching", () => {
    const result = spawnSync(process.execPath, [runnerPath, "--print-config"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: runnerEnv({ HEBBIAN_DEV_INSTANCE: "../shared" }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HEBBIAN_DEV_INSTANCE");
  });

  it("fails closed when an unrelated listener owns the selected origin", async () => {
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "localhost", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      listener.close();
      throw new Error("test listener did not allocate a TCP port");
    }

    try {
      const worktreeRoot = isolatedRunnerRepository();
      writeFixtureTauriCli(
        worktreeRoot,
        `if (process.argv[2] !== "--version") process.exit(64);
`,
      );
      const result = spawnSync(process.execPath, [runnerPath], {
        cwd: worktreeRoot,
        encoding: "utf8",
        env: runnerEnv({
          DURE_DEV_PORT: String(address.port),
        }),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture frontend: EADDRINUSE");
      expect(result.stderr).toContain("failed before readiness");
      expect(listener.listening).toBe(true);
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  });
});
