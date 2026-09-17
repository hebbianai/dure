import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createConnection, Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appControlDirectory } from "./app-channel.mjs";
import {
  DEV_LAUNCH_CHILD_GENERATION_ENV,
  DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
  DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
  DEV_LAUNCH_PARENT_HANDOFF_ENV,
  DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  RESTART_STATUS_REQUEST_TIMEOUT_MS,
  exactDescriptor,
  parentGenerationProbeRequest,
  redactDevLaunchCapability,
} from "./dev-launch-contract.mjs";
import {
  ensureDevLaunchParentGeneration,
  observeDevLaunchParentGeneration,
  requestDevLaunchParentReload,
  requestDevLaunchRestart,
} from "./dev-launch-client.mjs";
import {
  preflightDevLaunchParentResume,
  reclaimStaleDescriptor,
  superviseDevLaunch as superviseDevLaunchProduction,
} from "./dev-launch-supervisor.mjs";
import {
  FIXTURE_LIFECYCLE_TIMEOUT_MS,
  createDevLaunchFixtureRegistry,
  processGroupWitnessModuleUrl,
  processGroupWitnessReadySource,
  sendDevLaunchFixtureFrame as sendFrame,
  simulatedLinuxProcessBoundaryEnvironment,
  startConvergentDevLaunchParentFixture,
  startDevLaunchEndpointFixture as startFixtureSupervisor,
  startManagedDevLaunchFixture,
  waitForFileContent,
  waitForJsonFile,
} from "./dev-launch-test-support.mjs";
import {
  observeProcessMembers,
  processIdentity,
} from "./process-identity.mjs";
import {
  observeOwnedProcessGroup,
  signalExactProcess,
  signalOwnedProcessGroup,
} from "./process-group-authority.mjs";
import { assertHeadroom } from "./build-storage-admission.mjs";

const temporaryRoots = [];
const fixtureProcesses = createDevLaunchFixtureRegistry();
const execFileAsync = promisify(execFile);

async function spawnRetainedGroupLeader(scriptPath, generation) {
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ownership = fixtureProcesses.registerSpawn(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const authorityReady = new Promise((resolve) => child.once("message", resolve));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const ready = await authorityReady;
  const { witnessPid } = ready;
  const witnessIdentity = await waitFor(() => processIdentity(witnessPid));
  const leaderIdentity = await waitFor(() => processIdentity(child.pid));
  const identity = {
    pid: child.pid,
    processIdentity: leaderIdentity,
    generation,
    processGroup: {
      kind: "posix_process_group_v1",
      id: child.pid,
      witness: {
        pid: witnessPid,
        processIdentity: witnessIdentity,
      },
    },
  };
  ownership.bind(identity);
  return {
    child,
    exited,
    identity,
    ready,
  };
}

async function spawnRetainedGroupWithMember(
  fixtureRoot,
  filename,
  generation,
) {
  const scriptPath = join(fixtureRoot, filename);
  writeFileSync(
    scriptPath,
    `import { spawn } from "node:child_process";
import { spawnProcessGroupWitness } from ${JSON.stringify(processGroupWitnessModuleUrl)};
const witness = await spawnProcessGroupWitness();
const member = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
await new Promise((resolve, reject) => {
  member.once("message", resolve);
  member.once("error", reject);
});
await witness.retain();
process.send({ witnessPid: witness.pid, memberPid: member.pid });
process.once("message", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  return spawnRetainedGroupLeader(scriptPath, generation);
}

async function spawnRetiredGroup(fixtureRoot, filename, generation) {
  const scriptPath = join(fixtureRoot, filename);
  writeFileSync(
    scriptPath,
    `import { spawnProcessGroupWitness } from ${JSON.stringify(processGroupWitnessModuleUrl)};
const witness = await spawnProcessGroupWitness();
await witness.retain();
process.send({ witnessPid: witness.pid });
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  const group = await spawnRetainedGroupLeader(scriptPath, generation);
  await fixtureProcesses.retireIdentity(group.identity);
  await group.exited;
  return group.identity;
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "dure-launch-supervisor-"));
  temporaryRoots.push(root);
  return root;
}

function writeControlledExitScript(
  scriptPath,
  {
    onStart = "",
    onExit = "",
    onTerm = "process.exit(0);",
    exitCode = 0,
  } = {},
) {
  writeFileSync(
    scriptPath,
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
${onStart}
process.once("SIGTERM", () => {
  ${onTerm}
});
const timer = setInterval(() => {
  if (!existsSync(process.argv[2])) return;
  clearInterval(timer);
  ${onExit}
  process.exit(${exitCode});
}, 20);
`,
    { mode: 0o600 },
  );
}

function waitFor(predicate, timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await predicate();
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
    void poll();
  });
}

function startManagedLaunchFixture(options) {
  return startManagedDevLaunchFixture({
    ...options,
    fixtureProcesses,
    superviseDevLaunch: superviseDevLaunchProduction,
  });
}

function superviseManagedDevLaunch(options) {
  return startManagedLaunchFixture(options).outcome;
}

function nextProcessMessage(child, type) {
  return new Promise((resolve) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

function controlledFrontendProbe() {
  let pending = null;
  return {
    armFalse() {
      let release;
      let started;
      let finish;
      const releasePromise = new Promise((resolve) => {
        release = resolve;
      });
      const startedPromise = new Promise((resolve) => {
        started = resolve;
      });
      const finishedPromise = new Promise((resolve) => {
        finish = resolve;
      });
      pending = { claimed: false, finish, releasePromise, started };
      return {
        release,
        started: startedPromise,
        finished: finishedPromise,
      };
    },
    async probe(identity) {
      const deferred = pending;
      if (deferred && !deferred.claimed) {
        deferred.claimed = true;
        deferred.started();
        await deferred.releasePromise;
        deferred.finish();
        return false;
      }
      return processIdentity(identity.pid) === identity.processIdentity;
    },
  };
}

async function startFrontendEpochFixture(
  instance,
  {
    preflightParent = async () => {},
    reloadParent = () => {},
    retainFrontendDescendant = false,
  } = {},
) {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const appScript = join(fixtureRoot, "epoch-app.mjs");
  const appStarted = join(fixtureRoot, "epoch-app-started");
  const frontendScript = join(fixtureRoot, "epoch-frontend.mjs");
  const channel = `dev-supervisor-${instance}-1234567890`;
  const sourceGeneration = "9".repeat(64);
  const controlDirectory = appControlDirectory(fixtureHome, channel);
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  chmodSync(controlDirectory, 0o700);
  writeFileSync(
    appScript,
    `import { writeFileSync } from "node:fs";
process.once("SIGTERM", () => process.exit(0));
process.once("SIGHUP", () => process.exit(0));
writeFileSync(process.argv[2], String(process.pid) + "\\n");
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  writeFileSync(
    frontendScript,
    `${retainFrontendDescendant
      ? `import { spawn } from "node:child_process";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], { stdio: "ignore" });
descendant.unref();
`
      : ""}const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
const channel = process.argv[2];
${processGroupWitnessReadySource("channel", "generation")}
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel, generation });
process.once("message", async () => {
  await groupWitness.retain();
  process.send({ schemaVersion: 1, type: "frontend_activated", channel, generation });
});
process.once("SIGTERM", () => process.exit(0));
process.once("SIGHUP", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  const probe = controlledFrontendProbe();
  const managed = startManagedLaunchFixture({
    home: fixtureHome,
    worktreeRoot,
    channel,
    command: process.execPath,
    args: [appScript, appStarted],
    spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    frontend: {
      command: process.execPath,
      args: [frontendScript, channel],
      spawnOptions: {
        cwd: fixtureRoot,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
      probe: probe.probe,
    },
    sourceGeneration,
    preflightParent,
    reloadParent,
  });
  const descriptor = await managed.observeDescriptor((value) =>
    value.state === "ready" ? value : null,
  );
  await managed.observeFile(appStarted, (value) =>
    value.trim() === String(descriptor.launch.pid),
  );
  return {
    ...managed,
    appStarted,
    channel,
    descriptor,
    fixtureHome,
    probe,
    sourceGeneration,
    worktreeRoot,
  };
}

function launchGenerationProjection(identity) {
  return {
    pid: identity.pid,
    processIdentity: identity.processIdentity,
    generation: identity.generation,
  };
}

function sendFrameWithoutReading(socketPath, value) {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    connection.once("connect", () => {
      connection.write(`${JSON.stringify(value)}\n`, () => resolve(connection));
    });
    connection.once("error", reject);
  });
}

async function sendFrameFromExternalProcess(socketPath, value, timeoutMs) {
  const source = `
import { sendDevLaunchFixtureFrame } from ${JSON.stringify(new URL("./dev-launch-test-support.mjs", import.meta.url).href)};
const [socketPath, serializedFrame, timeoutMs] = process.argv.slice(1);
const response = await sendDevLaunchFixtureFrame(
  socketPath,
  JSON.parse(serializedFrame),
  { timeoutMs: Number(timeoutMs) },
);
process.stdout.write(JSON.stringify(response));
`;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      source,
      socketPath,
      JSON.stringify(value),
      String(timeoutMs),
    ],
    { timeout: FIXTURE_LIFECYCLE_TIMEOUT_MS },
  );
  return JSON.parse(stdout);
}

function acknowledgeRestart(
  socketPath,
  authority,
  requestId = authority.requestId,
) {
  return sendFrame(socketPath, {
    ...authority,
    type: "restart_ack",
    requestId,
  });
}

function activatedParentDescriptor({
  fixture,
  worktreeRoot,
  channel,
  request,
  previousSupervisor,
  previousLaunch,
  launch,
  supervisor = {
    ...previousSupervisor,
    generation: request.targetSupervisorGeneration,
  },
}) {
  return {
    schemaVersion: 1,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "ready",
    worktreeRoot,
    channel,
    socketPath: fixture.socketPath,
    capability: fixture.capability,
    capabilities: ["child_restart", "parent_reload"],
    sourceGeneration: request.targetSourceGeneration,
    supervisor,
    launch,
    activation: {
      type: "parent_reload",
      requestId: request.requestId,
      previousSupervisor,
      previousLaunch,
      sourceGeneration: request.targetSourceGeneration,
      launch,
      activatedAtMs: Date.now(),
    },
    publishedAtMs: Date.now(),
  };
}

function committedParentHandoffFixture({
  fixtureRoot,
  fixtureHome,
  worktreeRoot,
  channel,
  previousFrontend,
  previousLaunch: previousLaunchOverride,
  processGroupAuthority = false,
  targetSourceGeneration = "4".repeat(64),
}) {
  const controlDirectory = appControlDirectory(fixtureHome, channel);
  const descriptorPath = join(
    controlDirectory,
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  chmodSync(controlDirectory, 0o700);
  const previousSupervisor = {
    pid: process.pid,
    processIdentity: processIdentity(process.pid),
    generation: "1".repeat(64),
  };
  const previousLaunch = previousLaunchOverride ?? {
    pid: 1234,
    processIdentity: "previous-launch",
    generation: "2".repeat(64),
  };
  const capability = "3".repeat(64);
  const handoff = {
    schemaVersion: 1,
    protocolVersion: DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
    type: "parent_handoff",
    requestId: "5".repeat(64),
    worktreeRoot,
    channel,
    capability: redactDevLaunchCapability(capability),
    previousSupervisor,
    previousLaunch,
    ...(previousFrontend ? { previousFrontend } : {}),
    targetSupervisorGeneration: "6".repeat(64),
    targetSourceGeneration,
    phase: "exec_pending",
    committedAtMs: Date.now(),
  };
  writeFileSync(
    descriptorPath,
    `${JSON.stringify({
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      state: "handoff",
      worktreeRoot,
      channel,
      socketPath: join(fixtureRoot, "retired.sock"),
      capability,
      capabilities: [
        "child_restart",
        "parent_reload",
        ...(processGroupAuthority
          ? [DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY]
          : []),
        ...(previousFrontend
          ? [DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY]
          : []),
      ],
      sourceGeneration: "7".repeat(64),
      supervisor: previousSupervisor,
      launch: null,
      ...(previousFrontend ? { frontend: previousFrontend } : {}),
      handoff,
      publishedAtMs: Date.now(),
    })}\n`,
    { mode: 0o600 },
  );
  return {
    descriptorPath,
    handoff,
    previousFrontend,
    previousSupervisor,
    targetSourceGeneration,
  };
}

it.each([
  ["supervisor", "launch"],
  ["supervisor", "frontend"],
  ["supervisor", "candidateLaunch"],
  ["supervisor", "candidateFrontend"],
  ["launch", "frontend"],
  ["launch", "candidateLaunch"],
  ["launch", "candidateFrontend"],
  ["frontend", "candidateLaunch"],
  ["frontend", "candidateFrontend"],
  ["candidateLaunch", "candidateFrontend"],
])(
  "rejects one OS process occupying the %s and %s descriptor roles",
  (leftRole, rightRole) => {
    const worktreeRoot = "/fixture/worktree";
    const channel = "dev-supervisor-role-alias-1234567890";
    const descriptor = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      state: "preparing",
      worktreeRoot,
      channel,
      socketPath: "/fixture/supervisor.sock",
      capability: "e".repeat(64),
      capabilities: [
        "child_restart",
        DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      ],
      supervisor: {
        pid: 100,
        processIdentity: "supervisor-process",
        generation: "0".repeat(64),
      },
      launch: {
        pid: 101,
        processIdentity: "app-process",
        generation: "1".repeat(64),
      },
      frontend: {
        pid: 102,
        processIdentity: "frontend-process",
        generation: "2".repeat(64),
      },
      candidateLaunch: {
        pid: 103,
        processIdentity: "candidate-app-process",
        generation: "3".repeat(64),
      },
      candidateFrontend: {
        pid: 104,
        processIdentity: "candidate-frontend-process",
        generation: "4".repeat(64),
      },
      publishedAtMs: Date.now(),
    };
    descriptor[rightRole] = {
      ...descriptor[rightRole],
      pid: descriptor[leftRole].pid,
      processIdentity: descriptor[leftRole].processIdentity,
    };

    expect(() =>
      exactDescriptor(descriptor, { channel, worktreeRoot }),
    ).toThrow(/process identity occupies multiple roles/);
  },
);

it("rejects process-group capability when a preparing identity lacks authority", () => {
  const worktreeRoot = "/fixture/worktree";
  const channel = "dev-supervisor-missing-group-1234567890";
  expect(() =>
    exactDescriptor(
      {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: "/fixture/supervisor.sock",
        capability: "e".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 100,
          processIdentity: "supervisor-process",
          generation: "0".repeat(64),
        },
        launch: null,
        candidateLaunch: {
          pid: 101,
          processIdentity: "candidate-app-process",
          generation: "1".repeat(64),
        },
        publishedAtMs: Date.now(),
      },
      { channel, worktreeRoot },
    ),
  ).toThrow(/process group authority is missing/);
});

it("rejects process-group capability on an empty preparing descriptor", () => {
  const worktreeRoot = "/fixture/worktree";
  const channel = "dev-supervisor-empty-group-1234567890";
  expect(() =>
    exactDescriptor(
      {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: "/fixture/supervisor.sock",
        capability: "e".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 100,
          processIdentity: "supervisor-process",
          generation: "0".repeat(64),
        },
        launch: null,
        publishedAtMs: Date.now(),
      },
      { channel, worktreeRoot },
    ),
  ).toThrow(/process group authority is missing/);
});

it("rejects a typed preparing identity without its derived capability", () => {
  const worktreeRoot = "/fixture/worktree";
  const channel = "dev-supervisor-missing-capability-1234567890";
  expect(() =>
    exactDescriptor(
      {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: "/fixture/supervisor.sock",
        capability: "e".repeat(64),
        capabilities: ["child_restart"],
        supervisor: {
          pid: 100,
          processIdentity: "supervisor-process",
          generation: "0".repeat(64),
        },
        launch: {
          pid: 101,
          processIdentity: "app-process",
          generation: "1".repeat(64),
          processGroup: {
            kind: "posix_process_group_v1",
            id: 101,
            witness: {
              pid: 102,
              processIdentity: "app-witness-process",
            },
          },
        },
        publishedAtMs: Date.now(),
      },
      { channel, worktreeRoot },
    ),
  ).toThrow(/process group capability is missing/);
});

it("rejects a witness aliasing another descriptor process", () => {
  const worktreeRoot = "/fixture/worktree";
  const channel = "dev-supervisor-witness-alias-1234567890";
  const descriptor = {
    schemaVersion: 1,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    state: "preparing",
    worktreeRoot,
    channel,
    socketPath: "/fixture/supervisor.sock",
    capability: "e".repeat(64),
    capabilities: [
      "child_restart",
      DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
      DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
    ],
    supervisor: {
      pid: 100,
      processIdentity: "supervisor-process",
      generation: "0".repeat(64),
    },
    launch: {
      pid: 101,
      processIdentity: "app-process",
      generation: "1".repeat(64),
      processGroup: {
        kind: "posix_process_group_v1",
        id: 101,
        witness: { pid: 100, processIdentity: "supervisor-process" },
      },
    },
    frontend: {
      pid: 102,
      processIdentity: "frontend-process",
      generation: "2".repeat(64),
      processGroup: {
        kind: "posix_process_group_v1",
        id: 102,
        witness: { pid: 103, processIdentity: "shared-witness" },
      },
    },
    publishedAtMs: Date.now(),
  };
  expect(() =>
    exactDescriptor(descriptor, { channel, worktreeRoot }),
  ).toThrow(/process identity occupies multiple roles/);

  descriptor.launch.processGroup.witness = {
    pid: 103,
    processIdentity: "shared-witness",
  };
  expect(() =>
    exactDescriptor(descriptor, { channel, worktreeRoot }),
  ).toThrow(/process identity occupies multiple roles/);
});

it("rejects a parent handoff whose witness identity changed", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const channel = "dev-supervisor-handoff-witness-change-1234567890";
  const previousLaunch = {
    pid: 201,
    processIdentity: "previous-launch",
    generation: "2".repeat(64),
    processGroup: {
      kind: "posix_process_group_v1",
      id: 201,
      witness: { pid: 202, processIdentity: "previous-witness" },
    },
  };
  const { handoff, targetSourceGeneration } = committedParentHandoffFixture({
    fixtureHome,
    fixtureRoot,
    worktreeRoot,
    channel,
    previousLaunch,
    processGroupAuthority: true,
  });
  const changed = {
    ...handoff,
    previousLaunch: {
      ...handoff.previousLaunch,
      processGroup: {
        ...handoff.previousLaunch.processGroup,
        witness: {
          ...handoff.previousLaunch.processGroup.witness,
          processIdentity: "changed-witness",
        },
      },
    },
  };
  await expect(
    preflightDevLaunchParentResume({
      home: fixtureHome,
      worktreeRoot,
      channel,
      sourceGeneration: targetSourceGeneration,
      handoff: changed,
    }),
  ).rejects.toThrow(/cannot resume the exact active supervisor handoff/);
});

it("rejects a handoff app sharing the admitted frontend OS identity", () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const channel = "dev-supervisor-handoff-alias-1234567890";
  const previousFrontend = {
    pid: 201,
    processIdentity: "handoff-frontend-process",
    generation: "8".repeat(64),
  };
  const { descriptorPath } = committedParentHandoffFixture({
    fixtureRoot,
    fixtureHome,
    worktreeRoot,
    channel,
    previousFrontend,
  });
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  descriptor.handoff.previousLaunch = {
    ...descriptor.handoff.previousLaunch,
    pid: previousFrontend.pid,
    processIdentity: previousFrontend.processIdentity,
  };

  expect(() =>
    exactDescriptor(descriptor, { channel, worktreeRoot }),
  ).toThrow(/process identity occupies multiple roles/);
});

it("rejects a protocol-v2 parent handoff before target preflight", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const channel = "dev-supervisor-v2-handoff-1234567890";
  const { descriptorPath, handoff, targetSourceGeneration } =
    committedParentHandoffFixture({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
    });
  const before = readFileSync(descriptorPath, "utf8");

  await expect(
    preflightDevLaunchParentResume({
      home: fixtureHome,
      worktreeRoot,
      channel,
      sourceGeneration: targetSourceGeneration,
      handoff: { ...handoff, protocolVersion: 2 },
    }),
  ).rejects.toThrow(/parent handoff/);
  expect(readFileSync(descriptorPath, "utf8")).toBe(before);
});

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "rejects a preparing parent preflight unless its candidate is the current exact process",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-preparing-candidate-1234567890";
    const controller = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    const controllerOwnership = fixtureProcesses.registerSpawn(controller);
    await new Promise((resolve, reject) => {
      controller.once("spawn", resolve);
      controller.once("error", reject);
    });
    const previousSupervisor = controllerOwnership.bind({
      pid: controller.pid,
      processIdentity: await waitFor(() => processIdentity(controller.pid)),
      generation: "1".repeat(64),
    });
    const { descriptorPath, handoff, targetSourceGeneration } =
      committedParentHandoffFixture({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
      });
    const exactHandoff = { ...handoff, previousSupervisor };
    const originalDescriptor = JSON.parse(
      readFileSync(descriptorPath, "utf8"),
    );
    const candidateGeneration = "8".repeat(64);
    const currentCandidate = {
      pid: process.pid,
      processIdentity: processIdentity(process.pid),
      generation: candidateGeneration,
    };
    const writePreparingDescriptor = (candidateLaunch) => {
      writeFileSync(
        descriptorPath,
        `${JSON.stringify({
          ...originalDescriptor,
          state: "preparing",
          supervisor: previousSupervisor,
          launch: exactHandoff.previousLaunch,
          candidateLaunch,
          handoff: undefined,
        })}\n`,
        { mode: 0o600 },
      );
    };
    const preflight = async (generation) => {
      const previousGeneration =
        process.env[DEV_LAUNCH_CHILD_GENERATION_ENV];
      try {
        if (generation === undefined) {
          delete process.env[DEV_LAUNCH_CHILD_GENERATION_ENV];
        } else {
          process.env[DEV_LAUNCH_CHILD_GENERATION_ENV] = generation;
        }
        return await preflightDevLaunchParentResume({
          home: fixtureHome,
          worktreeRoot,
          channel,
          sourceGeneration: targetSourceGeneration,
          handoff: exactHandoff,
        });
      } finally {
        if (previousGeneration === undefined) {
          delete process.env[DEV_LAUNCH_CHILD_GENERATION_ENV];
        } else {
          process.env[DEV_LAUNCH_CHILD_GENERATION_ENV] = previousGeneration;
        }
      }
    };
    const invalidCandidates = [
      ["missing candidate", undefined, candidateGeneration],
      [
        "another pid",
        { ...currentCandidate, pid: process.pid + 1_000_000 },
        candidateGeneration,
      ],
      [
        "another process identity",
        { ...currentCandidate, processIdentity: "another-process" },
        candidateGeneration,
      ],
      ["another generation", currentCandidate, "9".repeat(64)],
      ["missing generation", currentCandidate, undefined],
    ];

    for (const [label, candidate, generation] of invalidCandidates) {
      writePreparingDescriptor(candidate);
      await expect(preflight(generation), label).rejects.toThrow(
        /cannot resume the exact active supervisor handoff/,
      );
    }

    writePreparingDescriptor(currentCandidate);
    await expect(preflight(candidateGeneration)).resolves.toEqual(exactHandoff);
  },
);

it.runIf(process.platform !== "win32")(
  "reuses a protocol-compatible frontend across parent source handoff",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-frontend-handoff-1234567890";
    const appScript = join(fixtureRoot, "handoff-app.mjs");
    const frontendScript = join(fixtureRoot, "handoff-frontend.mjs");
    const stopFile = join(fixtureRoot, "handoff-app-stop");
    writeFileSync(
      appScript,
      `import { existsSync } from "node:fs";
const timer = setInterval(() => {
  if (!existsSync(process.argv[2])) return;
  clearInterval(timer);
  process.exit(0);
}, 20);
process.once("SIGTERM", () => process.exit(0));
`,
      { mode: 0o600 },
    );
    writeFileSync(
      frontendScript,
      `const { spawnProcessGroupWitness } = await import(${JSON.stringify(processGroupWitnessModuleUrl)});
const witness = await spawnProcessGroupWitness();
await witness.retain();
process.send({ witnessPid: witness.pid });
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const frontend = await spawnRetainedGroupLeader(
      frontendScript,
      "8".repeat(64),
    );
    const frontendIdentity = frontend.identity;
    expect(frontendIdentity.processIdentity).toBeTruthy();
    const retired = await spawnRetainedGroupLeader(
      frontendScript,
      "2".repeat(64),
    );
    const retiredIdentity = retired.identity;
    await signalOwnedProcessGroup(retiredIdentity, "SIGTERM");
    await retired.exited;
    await waitFor(
      () => processIdentity(retiredIdentity.processGroup.witness.pid) === null,
    );
    const { descriptorPath, handoff, targetSourceGeneration } =
      committedParentHandoffFixture({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        previousFrontend: frontendIdentity,
        previousLaunch: retiredIdentity,
        processGroupAuthority: true,
      });

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [appScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: join(fixtureRoot, "incompatible-frontend-command"),
        args: [],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async (identity) =>
          identity.generation === frontendIdentity.generation &&
          processIdentity(identity.pid) === identity.processIdentity,
      },
      sourceGeneration: targetSourceGeneration,
      parentHandoff: handoff,
      preflightParent: async () => {},
      reloadParent: () => {},
    });
    const activated = await waitFor(() => {
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return descriptor.state === "ready" ? descriptor : null;
    });
    expect(activated.frontend).toEqual(frontendIdentity);
    expect(activated.activation).toMatchObject({
      previousFrontend: frontendIdentity,
      frontend: frontendIdentity,
      sourceGeneration: targetSourceGeneration,
    });
    expect(processIdentity(frontend.child.pid)).toBe(
      frontendIdentity.processIdentity,
    );

    await signalExactProcess(frontendIdentity, "SIGTERM");
    await frontend.exited;
    await waitFor(() => {
      const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return descriptor.state === "preparing" ? descriptor : null;
    });

    writeFileSync(stopFile, "stop\n");
    await expect(supervised).resolves.toMatchObject({ code: 0, signal: null });
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "rejects inherited frontend cleanup without a readiness authority",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-frontend-handoff-guard-1234567890";
    const frontend = await spawnRetainedGroupWithMember(
      fixtureRoot,
      "guarded-handoff-frontend.mjs",
      "8".repeat(64),
    );
    const previousLaunch = await spawnRetiredGroup(
      fixtureRoot,
      "retired-handoff-launch.mjs",
      "2".repeat(64),
    );
    const { descriptorPath, handoff, targetSourceGeneration } =
      committedParentHandoffFixture({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        previousFrontend: frontend.identity,
        previousLaunch,
        processGroupAuthority: true,
      });
    const before = readFileSync(descriptorPath, "utf8");
    const attempt = () =>
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        sourceGeneration: targetSourceGeneration,
        parentHandoff: handoff,
      });

    try {
      await expect(attempt()).rejects.toThrow(
        /parent handoff retains a live frontend without a compatible readiness authority/,
      );
      expect(readFileSync(descriptorPath, "utf8")).toBe(before);

      frontend.child.send({ type: "exit" });
      await frontend.exited;
      await waitFor(() => processIdentity(frontend.identity.pid) === null);
      expect(await observeOwnedProcessGroup(frontend.identity)).toMatchObject({
        state: "owned",
        leaderCurrent: false,
        witnessCurrent: true,
      });
      await expect(attempt()).rejects.toThrow(
        /parent handoff retains a live frontend without a compatible readiness authority/,
      );
      expect(readFileSync(descriptorPath, "utf8")).toBe(before);
    } finally {
      await fixtureProcesses.retireIdentity(frontend.identity);
    }
  },
);

it("admits frontend activation after nested witness control and IPC scheduling", async () => {
  const fixtureRoot = temporaryRoot();
  const frontendScript = join(fixtureRoot, "delayed-frontend.mjs");
  const frontendPidFile = join(fixtureRoot, "delayed-frontend-pid");
  const activationMarker = join(fixtureRoot, "frontend-activated");
  const appMarker = join(fixtureRoot, "app-started");
  const appScript = join(fixtureRoot, "activation-app.mjs");
  const stopFile = join(fixtureRoot, "activation-app-stop");
  const fixtureHome = join(fixtureRoot, "home");
  const channel = "dev-supervisor-nested-activation-1234567890";
  writeFileSync(
    frontendScript,
    `import { writeFileSync } from "node:fs";
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[3]", "generation")}
writeFileSync(process.argv[2], String(process.pid));
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel: process.argv[3], generation });
process.once("message", async () => {
  await groupWitness.retain();
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  writeFileSync(process.argv[4], "activated");
  process.send({ schemaVersion: 1, type: "frontend_activated", channel: process.argv[3], generation });
});
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );

  writeControlledExitScript(appScript, {
    onStart: `if (!existsSync(${JSON.stringify(activationMarker)})) process.exit(1);
writeFileSync(${JSON.stringify(appMarker)}, "started");`,
  });
  const supervised = superviseManagedDevLaunch({
    home: fixtureHome,
    worktreeRoot: join(fixtureRoot, "worktree"),
    channel,
    command: process.execPath,
    args: [appScript, stopFile],
    spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    frontend: {
      command: process.execPath,
      args: [frontendScript, frontendPidFile, channel, activationMarker],
      spawnOptions: {
        cwd: fixtureRoot,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
      probe: async (identity) =>
        processIdentity(identity.pid) === identity.processIdentity,
    },
  });
  try {
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    await waitFor(() =>
      JSON.parse(readFileSync(descriptorPath, "utf8")).state === "ready",
    );
    expect(readFileSync(appMarker, "utf8")).toBe("started");
  } finally {
    writeFileSync(stopFile, "stop\n");
    await expect(supervised).resolves.toMatchObject({ code: 0, signal: null });
  }
  expect(processIdentity(Number(readFileSync(frontendPidFile, "utf8")))).toBeNull();
});

it("bounds a silent frontend activation and exact-cleans the candidate", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const frontendScript = join(fixtureRoot, "silent-frontend.mjs");
  const frontendPidFile = join(fixtureRoot, "silent-frontend-pid");
  const appScript = join(fixtureRoot, "silent-frontend-app.mjs");
  const appMarker = join(fixtureRoot, "silent-frontend-app-started");
  const channel = "dev-supervisor-silent-frontend-1234567890";
  const activationTiming = join(fixtureRoot, "silent-activation-timing.json");
  writeFileSync(
    frontendScript,
    `import { writeFileSync } from "node:fs";
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[3]", "generation")}
writeFileSync(process.argv[2], String(process.pid));
process.send({
  schemaVersion: 1,
  protocolVersion: 1,
  type: "frontend_ready",
  channel: process.argv[3],
  generation,
});
let activationStartedAt;
process.on("message", (frame) => {
  if (frame.type === "frontend_activate") activationStartedAt = Date.now();
});
process.once("SIGTERM", () => {
  writeFileSync(process.argv[4], JSON.stringify({ activationStartedAt, stoppedAt: Date.now() }));
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  writeFileSync(
    appScript,
    `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], "started");
`,
    { mode: 0o600 },
  );

  await expect(
    superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [appScript, appMarker],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: process.execPath,
        args: [frontendScript, frontendPidFile, channel, activationTiming],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async () => false,
      },
    }),
  ).rejects.toThrow(/activation acknowledgement timed out/);
  const { activationStartedAt, stoppedAt } = JSON.parse(readFileSync(activationTiming, "utf8"));
  expect(Number.isSafeInteger(activationStartedAt)).toBe(true);
  expect(stoppedAt - activationStartedAt).toBeGreaterThanOrEqual(900);
  expect(stoppedAt - activationStartedAt).toBeLessThan(3_000);
  expect(existsSync(appMarker)).toBe(false);
  expect(processIdentity(Number(readFileSync(frontendPidFile, "utf8")))).toBeNull();
});

it("re-proves frontend readiness after activation acknowledgement", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const frontendScript = join(fixtureRoot, "acknowledging-frontend.mjs");
  const frontendPidFile = join(fixtureRoot, "acknowledging-frontend-pid");
  const appMarker = join(fixtureRoot, "acknowledging-frontend-app-started");
  const channel = "dev-supervisor-frontend-reproof-1234567890";
  writeFileSync(
    frontendScript,
    `import { writeFileSync } from "node:fs";
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[3]", "generation")}
writeFileSync(process.argv[2], String(process.pid));
process.send({
  schemaVersion: 1,
  protocolVersion: 1,
  type: "frontend_ready",
  channel: process.argv[3],
  generation,
});
process.once("message", async () => {
  await groupWitness.retain();
  process.send({
    schemaVersion: 1,
    type: "frontend_activated",
    channel: process.argv[3],
    generation,
  });
});
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );

  await expect(
    superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(appMarker)}, "started")`],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: process.execPath,
        args: [frontendScript, frontendPidFile, channel],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async () => false,
      },
    }),
  ).rejects.toThrow(/lost exact readiness during activation/);
  expect(existsSync(appMarker)).toBe(false);
  expect(processIdentity(Number(readFileSync(frontendPidFile, "utf8")))).toBeNull();
});

it("refuses app activation when the admitted frontend exits during retirement", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const frontendScript = join(fixtureRoot, "transition-frontend.mjs");
  const frontendPidFile = join(fixtureRoot, "transition-frontend-pid");
  const retirementMarker = join(fixtureRoot, "transition-retiring");
  const retirementRelease = join(fixtureRoot, "transition-retirement-release");
  const frontendExitMarker = join(fixtureRoot, "transition-frontend-exited");
  const appScript = join(fixtureRoot, "transition-app.mjs");
  const launchesFile = join(fixtureRoot, "transition-launches");
  const channel = "dev-supervisor-frontend-transition-1234567890";
  writeFileSync(
    frontendScript,
    `import { existsSync, writeFileSync } from "node:fs";
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[4]", "generation")}
writeFileSync(process.argv[2], String(process.pid));
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel: process.argv[4], generation });
process.once("message", async () => {
  await groupWitness.retain();
  process.send({ schemaVersion: 1, type: "frontend_activated", channel: process.argv[4], generation });
});
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  writeFileSync(process.argv[5], "exited\\n");
  process.exit(7);
}, 5);
process.once("SIGTERM", () => process.exit(0));
`,
    { mode: 0o600 },
  );
  writeFileSync(
    appScript,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.once("SIGTERM", () => {
  writeFileSync(process.argv[3], "retiring\\n");
  const timer = setInterval(() => {
    if (!existsSync(process.argv[4])) return;
    clearInterval(timer);
    process.exit(0);
  }, 20);
});
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  const descriptorPath = join(
    appControlDirectory(fixtureHome, channel),
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const supervised = superviseManagedDevLaunch({
    home: fixtureHome,
    worktreeRoot,
    channel,
    command: process.execPath,
    args: [appScript, launchesFile, retirementMarker, retirementRelease],
    fixtureReleasePaths: [retirementRelease],
    spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    frontend: {
      command: process.execPath,
      args: [
        frontendScript,
        frontendPidFile,
        retirementMarker,
        channel,
        frontendExitMarker,
      ],
      spawnOptions: {
        cwd: fixtureRoot,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
      probe: async (identity) =>
        processIdentity(identity.pid) === identity.processIdentity,
    },
  });
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(descriptorPath, "utf8")).state === "ready";
    } catch {
      return false;
    }
  });

  const restarting = requestDevLaunchRestart({
    home: fixtureHome,
    root: worktreeRoot,
    channel,
    timeoutMs: 5_000,
  });
  await waitFor(() => existsSync(frontendExitMarker));
  writeFileSync(retirementRelease, "release\n", { mode: 0o600 });
  await expect(restarting).rejects.toMatchObject({
    destructiveBoundaryCrossed: true,
  });
  await expect(supervised).resolves.toMatchObject({ code: 1, signal: null });
  expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(1);
  expect(processIdentity(Number(readFileSync(frontendPidFile, "utf8")))).toBeNull();
});

it("refuses ready publication when an activated app exits during frontend proof", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const frontendScript = join(fixtureRoot, "commit-frontend.mjs");
  const appScript = join(fixtureRoot, "commit-app.mjs");
  const appPidFile = join(fixtureRoot, "commit-app-pid");
  const appExitMarker = join(fixtureRoot, "commit-app-exit");
  const channel = "dev-supervisor-app-commit-1234567890";
  writeFileSync(
    frontendScript,
    `const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[2]", "generation")}
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel: process.argv[2], generation });
process.once("message", async () => {
  await groupWitness.retain();
  process.send({ schemaVersion: 1, type: "frontend_activated", channel: process.argv[2], generation });
});
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  writeControlledExitScript(
    appScript,
    {
      onStart: 'writeFileSync(process.argv[3], String(process.pid));',
    },
  );
  let probeCount = 0;

  await expect(
    superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [appScript, appExitMarker, appPidFile],
      fixtureReleasePaths: [appExitMarker],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: process.execPath,
        args: [frontendScript, channel],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async () => {
          probeCount += 1;
          if (probeCount === 3) {
            writeFileSync(appExitMarker, "exit\n", { mode: 0o600 });
            await waitFor(
              () =>
                processIdentity(Number(readFileSync(appPidFile, "utf8"))) ===
                null,
            );
          }
          return true;
        },
      },
    }),
  ).rejects.toThrow(/exited before authority commit/);
  expect(probeCount).toBeGreaterThanOrEqual(3);
  expect(processIdentity(Number(readFileSync(appPidFile, "utf8")))).toBeNull();
});

it.runIf(process.platform !== "win32")(
  "retains legacy authority without signaling when a dead leader leaves a live group",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const leaderScript = join(fixtureRoot, "group-leader.mjs");
    const descendantPidFile = join(fixtureRoot, "group-descendant-pid");
    const channel = "dev-supervisor-live-group-1234567890";
    writeFileSync(
      leaderScript,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);
descendant.once("spawn", () => {
  writeFileSync(process.argv[2], String(descendant.pid));
  descendant.unref();
  process.exit(0);
});
`,
      { mode: 0o600 },
    );
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    const leader = spawn(
      process.execPath,
      [leaderScript, descendantPidFile],
      { cwd: fixtureRoot, detached: true, stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      leader.once("spawn", resolve);
      leader.once("error", reject);
    });
    const leaderIdentity = processIdentity(leader.pid);
    expect(leaderIdentity).toBeTruthy();
    await new Promise((resolve) => leader.once("exit", resolve));
    const descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
    const descendantIdentity = processIdentity(descendantPid);
    expect(descendantIdentity).toBeTruthy();
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "f".repeat(64),
        capabilities: ["child_restart"],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "e".repeat(64),
        },
        launch: {
          pid: leader.pid,
          processIdentity: leaderIdentity,
          generation: "d".repeat(64),
        },
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: [leaderScript, descendantPidFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      }),
    ).rejects.toThrow(/live process group without exact signal authority/);
    expect(processIdentity(descendantPid)).toBe(descendantIdentity);

    process.kill(descendantPid, "SIGTERM");
    await waitFor(() => processIdentity(descendantPid) === null);
  },
);

it.runIf(process.platform !== "win32")(
  "does not signal a reused PID process group without exact leader identity",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-reused-group-1234567890";
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    const decoy = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { detached: true, stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      decoy.once("spawn", resolve);
      decoy.once("error", reject);
    });
    const decoyIdentity = processIdentity(decoy.pid);
    expect(decoyIdentity).toBeTruthy();
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "a".repeat(64),
        capabilities: ["child_restart"],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "b".repeat(64),
        },
        launch: {
          pid: decoy.pid,
          processIdentity: "reused-process-identity",
          generation: "c".repeat(64),
        },
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1_000)"],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      }),
    ).rejects.toThrow(/live process group without exact signal authority/);
    expect(processIdentity(decoy.pid)).toBe(decoyIdentity);

    decoy.kill("SIGTERM");
    await new Promise((resolve) => decoy.once("exit", resolve));
  },
);

it.runIf(process.platform !== "win32")(
  "recovers a dead launch leader through its exact durable group witness",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const leaderScript = join(fixtureRoot, "witnessed-group-leader.mjs");
    const memberPidFile = join(fixtureRoot, "witnessed-group-member-pid");
    const leaderExitMarker = join(fixtureRoot, "witnessed-group-leader-exit");
    const childScript = join(fixtureRoot, "witnessed-group-replacement.mjs");
    const stopFile = join(fixtureRoot, "witnessed-group-replacement-stop");
    const channel = "dev-supervisor-witnessed-group-1234567890";
    writeControlledExitScript(childScript);
    writeFileSync(
      leaderScript,
      `import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const member = spawn(
  process.execPath,
  ["-e", "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);
member.once("spawn", () => writeFileSync(process.argv[2], String(member.pid)));
process.once("SIGTERM", () => {
  member.kill("SIGTERM");
  process.exit(0);
});
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 20);
`,
      { mode: 0o600 },
    );
    const leader = spawn(
      process.execPath,
      [leaderScript, memberPidFile, leaderExitMarker],
      {
        cwd: fixtureRoot,
        detached: true,
        stdio: "ignore",
      },
    );
    const leaderOwnership = fixtureProcesses.registerSpawn(leader);
    const leaderExited = new Promise((resolve, reject) => {
      leader.once("error", reject);
      leader.once("exit", resolve);
    });
    const leaderIdentity = await waitFor(() => processIdentity(leader.pid));
    const memberPid = await waitFor(() => {
      if (!existsSync(memberPidFile)) return null;
      const pid = Number(readFileSync(memberPidFile, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    });
    const memberIdentity = await waitFor(() => processIdentity(memberPid));
    const staleLaunch = {
      pid: leader.pid,
      processIdentity: leaderIdentity,
      generation: "c".repeat(64),
      processGroup: {
        kind: "posix_process_group_v1",
        id: leader.pid,
        witness: {
          pid: memberPid,
          processIdentity: memberIdentity,
        },
      },
    };
    leaderOwnership.bind(staleLaunch);

    writeFileSync(leaderExitMarker, "exit\n", { mode: 0o600 });
    await leaderExited;
    await waitFor(() => processIdentity(leader.pid) === null);
    expect(processIdentity(memberPid)).toBe(memberIdentity);

    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "a".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "b".repeat(64),
        },
        launch: staleLaunch,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" ? value : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toMatchObject({
      code: 0,
      signal: null,
    });
    expect(processIdentity(memberPid)).toBeNull();
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "retires a zombie launch leader instead of adopting it as active",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const pidFile = join(fixtureRoot, "zombie-group-pids");
    const leaderRelease = join(fixtureRoot, "zombie-leader-release");
    const shutdownMarker = join(fixtureRoot, "zombie-fixture-shutdown");
    const leaderExiting = join(fixtureRoot, "zombie-leader-exiting");
    const childScript = join(fixtureRoot, "zombie-replacement.mjs");
    const stopFile = join(fixtureRoot, "zombie-replacement-stop");
    const channel = "dev-supervisor-zombie-leader-1234567890";
    writeControlledExitScript(childScript);
    const keeper = spawn(
      "python3",
      [
        "-c",
        `import os,signal,sys,time
signal.signal(signal.SIGCHLD, signal.SIG_DFL)
leader=os.fork()
if leader == 0:
    os.setpgid(0, 0)
    witness=os.fork()
    if witness == 0:
        while not os.path.exists(sys.argv[3]): time.sleep(0.02)
        sys.exit(0)
    with open(sys.argv[1], "w") as output:
        output.write(f"{os.getpid()} {witness}\\n")
    while not os.path.exists(sys.argv[2]) and not os.path.exists(sys.argv[3]): time.sleep(0.02)
    if os.path.exists(sys.argv[3]):
        os.waitpid(witness, 0)
    else:
        with open(sys.argv[4], "w") as output:
            output.write(f"{os.getpid()}\\n")
    os._exit(0)
while not os.path.exists(sys.argv[3]): time.sleep(0.02)
os.waitpid(leader, 0)`,
        pidFile,
        leaderRelease,
        shutdownMarker,
        leaderExiting,
      ],
      { cwd: fixtureRoot, stdio: "ignore" },
    );
    const keeperSettled = new Promise((resolve) => {
      let spawned = false;
      keeper.once("spawn", () => {
        spawned = true;
      });
      keeper.once("error", (error) => {
        if (!spawned) resolve({ error });
      });
      keeper.once("exit", (code, signal) => resolve({ code, signal }));
    });
    fixtureProcesses.registerSpawn(keeper);
    const earlyShutdown = fixtureProcesses.registerCleanup(async () => {
      writeFileSync(shutdownMarker, "shutdown\n", { mode: 0o600 });
      await keeperSettled;
    });
    const [zombiePid, witnessPid] = await waitFor(() => {
      if (!existsSync(pidFile)) return null;
      const pids = readFileSync(pidFile, "utf8")
        .trim()
        .split(/\s+/)
        .map(Number);
      return pids.length === 2 && pids.every((pid) => pid > 0)
        ? pids
        : null;
    });
    const group = await waitForAsync(async () => {
      const observation = await observeProcessMembers({
        kind: "group_census",
        groupId: zombiePid,
      });
      if (observation.status !== "complete") return null;
      const leader = observation.members.find(({ pid }) => pid === zombiePid);
      const witness = observation.members.find(({ pid }) => pid === witnessPid);
      return leader?.state === "live" && witness?.state === "live"
        ? { leader, witness }
        : null;
    });
    const ownedIdentity = {
      pid: zombiePid,
      processIdentity: group.leader.processIdentity,
      generation: "c".repeat(64),
      processGroup: {
        kind: "posix_process_group_v1",
        id: zombiePid,
        witness: {
          pid: witnessPid,
          processIdentity: group.witness.processIdentity,
        },
      },
    };
    fixtureProcesses.registerIdentity(ownedIdentity);
    earlyShutdown.release();
    writeFileSync(leaderRelease, "release\n", { mode: 0o600 });
    await waitForFileContent(
      leaderExiting,
      (contents) => contents.trim() === String(zombiePid),
      FIXTURE_LIFECYCLE_TIMEOUT_MS,
    );
    await waitForAsync(async () => {
      const observation = await observeOwnedProcessGroup(ownedIdentity);
      return observation.state === "owned" &&
          !observation.leaderCurrent &&
          observation.witnessCurrent
        ? observation
        : null;
    });
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "a".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "b".repeat(64),
        },
        launch: ownedIdentity,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [leaderRelease, stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    await fixture.observeDescriptor((descriptor) =>
      descriptor.state === "ready" ? descriptor : null
    );
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(fixture.outcome).resolves.toMatchObject({
      code: 0,
      signal: null,
    });
    expect(processIdentity(witnessPid)).toBeNull();
    await expect(observeOwnedProcessGroup(ownedIdentity)).resolves.toMatchObject({
      state: "retired",
    });
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "projects a ready adopted launch when its exact leader becomes a zombie",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const pidFile = join(fixtureRoot, "adopted-zombie-pids");
    const exitMarker = join(fixtureRoot, "adopted-zombie-exit");
    const witnessRelease = join(fixtureRoot, "adopted-zombie-witness-release");
    const shutdownMarker = join(fixtureRoot, "adopted-zombie-shutdown");
    const leaderExiting = join(fixtureRoot, "adopted-zombie-exiting");
    const channel = "dev-supervisor-adopted-zombie-1234567890";
    const keeper = spawn(
      "python3",
      [
        "-c",
        `import os,signal,sys,time
signal.signal(signal.SIGCHLD, signal.SIG_DFL)
leader=os.fork()
if leader == 0:
    os.setpgid(0, 0)
    witness=os.fork()
    if witness == 0:
        def stop(*_):
            while not os.path.exists(sys.argv[3]) and not os.path.exists(sys.argv[4]): time.sleep(0.02)
            sys.exit(0)
        signal.signal(signal.SIGTERM, stop)
        with open(sys.argv[1], "w") as output:
            output.write(f"{os.getppid()} {os.getpid()}\\n")
        while not os.path.exists(sys.argv[4]): time.sleep(0.02)
        sys.exit(0)
    while not os.path.exists(sys.argv[2]) and not os.path.exists(sys.argv[4]): time.sleep(0.02)
    if os.path.exists(sys.argv[4]):
        os.waitpid(witness, 0)
    else:
        with open(sys.argv[5], "w") as output:
            output.write(f"{os.getpid()}\\n")
    os._exit(0)
while not os.path.exists(sys.argv[4]): time.sleep(0.02)
os.waitpid(leader, 0)`,
        pidFile,
        exitMarker,
        witnessRelease,
        shutdownMarker,
        leaderExiting,
      ],
      { cwd: fixtureRoot, stdio: "ignore" },
    );
    const keeperSettled = new Promise((resolve) => {
      let spawned = false;
      keeper.once("spawn", () => {
        spawned = true;
      });
      keeper.once("error", (error) => {
        if (!spawned) resolve({ error });
      });
      keeper.once("exit", (code, signal) => resolve({ code, signal }));
    });
    fixtureProcesses.registerSpawn(keeper);
    const earlyShutdown = fixtureProcesses.registerCleanup(async () => {
      writeFileSync(shutdownMarker, "shutdown\n", { mode: 0o600 });
      await keeperSettled;
    });
    const [leaderPid, witnessPid] = await waitFor(() => {
      if (!existsSync(pidFile)) return null;
      const pids = readFileSync(pidFile, "utf8")
        .trim()
        .split(/\s+/)
        .map(Number);
      return pids.length === 2 && pids.every((pid) => pid > 0)
        ? pids
        : null;
    });
    const group = await waitForAsync(async () => {
      const observation = await observeProcessMembers({
        kind: "group_census",
        groupId: leaderPid,
      });
      if (observation.status !== "complete") return null;
      const leader = observation.members.find(({ pid }) => pid === leaderPid);
      const witness = observation.members.find(({ pid }) => pid === witnessPid);
      return leader?.state === "live" && witness?.state === "live"
        ? { leader, witness }
        : null;
    });
    const launch = {
      pid: leaderPid,
      processIdentity: group.leader.processIdentity,
      generation: "7".repeat(64),
      processGroup: {
        kind: "posix_process_group_v1",
        id: leaderPid,
        witness: {
          pid: witnessPid,
          processIdentity: group.witness.processIdentity,
        },
      },
    };
    fixtureProcesses.registerIdentity(launch);
    earlyShutdown.release();
    expect(await observeOwnedProcessGroup(launch)).toMatchObject({
      state: "owned",
      leaderCurrent: true,
      witnessCurrent: true,
    });

    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "ready",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "8".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "9".repeat(64),
        },
        launch,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      fixtureReleasePaths: [exitMarker, witnessRelease],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    await fixture.observeDescriptor((descriptor) =>
      descriptor.state === "ready" && descriptor.supervisor.pid === process.pid
        ? descriptor
        : null
    );
    writeFileSync(exitMarker, "exit\n");
    await waitForFileContent(
      leaderExiting,
      (contents) => contents.trim() === String(leaderPid),
      FIXTURE_LIFECYCLE_TIMEOUT_MS,
    );
    await waitForAsync(async () => {
      const observation = await observeOwnedProcessGroup(launch);
      return observation.state === "owned" &&
          !observation.leaderCurrent &&
          observation.witnessCurrent
        ? observation
        : null;
    });
    const projected = await fixture.observeDescriptor((descriptor) =>
      descriptor.state === "preparing" ? descriptor : null
    );
    expect(projected.launch).toEqual(launch);
    writeFileSync(witnessRelease, "release\n", { mode: 0o600 });
    await expect(fixture.outcome).resolves.toEqual({ code: 1, signal: null });
    expect(processIdentity(launch.processGroup.witness.pid)).toBeNull();
    await expect(observeOwnedProcessGroup(launch)).resolves.toMatchObject({
      state: "retired",
    });
  },
);

it.runIf(
  (process.platform === "darwin" || process.platform === "linux") &&
    typeof process.execve === "function",
)(
  "recovers the exact witness after an activated wrapper aborts in execve",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-exec-abort-1234567890";
    const generation = "e".repeat(64);
    const childScript = join(fixtureRoot, "exec-abort-replacement.mjs");
    const stopFile = join(fixtureRoot, "exec-abort-replacement-stop");
    writeControlledExitScript(childScript);
    const wrapperPath = fileURLToPath(
      new URL("../run-dev-launch-child.mjs", import.meta.url),
    );
    const wrapper = spawn(
      process.execPath,
      [
        wrapperPath,
        JSON.stringify({ command: fixtureRoot, args: [] }),
      ],
      {
        cwd: fixtureRoot,
        detached: true,
        env: {
          ...process.env,
          DURE_APP_CHANNEL: channel,
          [DEV_LAUNCH_CHILD_GENERATION_ENV]: generation,
        },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    const ownership = fixtureProcesses.registerSpawn(wrapper);
    const witnessReady = nextProcessMessage(
      wrapper,
      "process_group_witness_ready",
    );
    const candidateReady = nextProcessMessage(
      wrapper,
      "launch_candidate_ready",
    );
    const wrapperExited = new Promise((resolve, reject) => {
      wrapper.once("error", reject);
      wrapper.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const witness = await witnessReady;
    await candidateReady;
    const identity = {
      pid: wrapper.pid,
      processIdentity: await waitFor(() => processIdentity(wrapper.pid)),
      generation,
      processGroup: {
        kind: "posix_process_group_v1",
        id: wrapper.pid,
        witness: {
          pid: witness.pid,
          processIdentity: await waitFor(() => processIdentity(witness.pid)),
        },
      },
    };
    ownership.bind(identity);
    wrapper.send({
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      type: "launch_activate",
      channel,
      generation,
    });
    await expect(wrapperExited).resolves.toEqual({
      code: null,
      signal: "SIGABRT",
    });
    expect(await observeOwnedProcessGroup(identity)).toMatchObject({
      state: "owned",
      leaderCurrent: false,
      witnessCurrent: true,
    });

    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "f".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "1".repeat(64),
        },
        launch: null,
        candidateLaunch: identity,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    fixtureProcesses.registerDescriptor(descriptorPath);

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" ? value : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toMatchObject({
      code: 0,
      signal: null,
    });
    expect(processIdentity(identity.processGroup.witness.pid)).toBeNull();
  },
);

it.runIf(process.platform !== "win32")(
  "leaves a reused process group untouched when its durable witness changed",
  async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const memberPidFile = join(fixtureRoot, "decoy-group-member-pid");
    const decoyScript = join(fixtureRoot, "decoy-group-leader.mjs");
    const channel = "dev-supervisor-reused-witness-1234567890";
    writeFileSync(
      decoyScript,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const member = spawn(
  process.execPath,
  ["-e", "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1_000)"],
  { stdio: "ignore" },
);
member.once("spawn", () => writeFileSync(process.argv[2], String(member.pid)));
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const decoy = spawn(process.execPath, [decoyScript, memberPidFile], {
      cwd: fixtureRoot,
      detached: true,
      stdio: "ignore",
    });
    const decoyExited = new Promise((resolve, reject) => {
      decoy.once("error", reject);
      decoy.once("exit", resolve);
    });
    const decoyIdentity = await waitFor(() => processIdentity(decoy.pid));
    const memberPid = await waitFor(() => {
      if (!existsSync(memberPidFile)) return null;
      const pid = Number(readFileSync(memberPidFile, "utf8"));
      return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    });
    const memberIdentity = await waitFor(() => processIdentity(memberPid));
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "a".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "b".repeat(64),
        },
        launch: {
          pid: decoy.pid,
          processIdentity: "retired-leader-identity",
          generation: "c".repeat(64),
          processGroup: {
            kind: "posix_process_group_v1",
            id: decoy.pid,
            witness: {
              pid: memberPid,
              processIdentity: "retired-witness-identity",
            },
          },
        },
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );

    try {
      const descriptorBefore = readFileSync(descriptorPath);
      const staleLaunch = JSON.parse(descriptorBefore.toString("utf8")).launch;
      await expect(observeOwnedProcessGroup(staleLaunch)).resolves.toMatchObject({
        state: "unproven",
        currentRoles: { leader: false, witness: false },
      });
      await expect(
        superviseManagedDevLaunch({
          home: fixtureHome,
          worktreeRoot,
          channel,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1_000)"],
          spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        }),
      ).rejects.toMatchObject({
        code: "DEV_LAUNCH_OBSERVATION_UNAVAILABLE",
        message:
          "could not observe dev launch launch process group: exact_generation_unproven",
      });
      expect(processIdentity(decoy.pid)).toBe(decoyIdentity);
      expect(processIdentity(memberPid)).toBe(memberIdentity);
      expect(readFileSync(descriptorPath)).toEqual(descriptorBefore);
    } finally {
      if (processIdentity(memberPid) === memberIdentity) {
        process.kill(memberPid, "SIGTERM");
        await waitFor(() => processIdentity(memberPid) === null);
      }
      if (processIdentity(decoy.pid) === decoyIdentity) {
        decoy.kill("SIGTERM");
        await decoyExited;
      }
    }
  },
);

it("rejects parent generation observation while app retirement is in flight", async () => {
  const fixtureRoot = temporaryRoot();
  const fixtureHome = join(fixtureRoot, "home");
  const worktreeRoot = join(fixtureRoot, "worktree");
  const childScript = join(fixtureRoot, "retiring-child.mjs");
  const stopFile = join(fixtureRoot, "retiring-stop");
  const retirementReleaseFile = join(fixtureRoot, "retiring-release");
  const channel = "dev-supervisor-retiring-probe-1234567890";
  const sourceGeneration = "9".repeat(64);
  writeControlledExitScript(
    childScript,
    {
      onTerm: `const retirementTimer = setInterval(() => {
    if (!existsSync(process.argv[3])) return;
    clearInterval(retirementTimer);
    process.exit(0);
  }, 20);`,
    },
  );
  const descriptorPath = join(
    appControlDirectory(fixtureHome, channel),
    DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
  );
  const supervised = superviseManagedDevLaunch({
    home: fixtureHome,
    worktreeRoot,
    channel,
    command: process.execPath,
    args: [childScript, stopFile, retirementReleaseFile],
    fixtureReleasePaths: [stopFile, retirementReleaseFile],
    spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    sourceGeneration,
    preflightParent: async () => {},
    reloadParent: () => {},
  });
  await waitFor(() => {
    try {
      return JSON.parse(readFileSync(descriptorPath, "utf8")).state === "ready";
    } catch {
      return false;
    }
  });

  const restarting = requestDevLaunchRestart({
    home: fixtureHome,
    root: worktreeRoot,
    channel,
    timeoutMs: 5_000,
  });
  await waitFor(() =>
    JSON.parse(readFileSync(descriptorPath, "utf8")).state === "preparing",
  );
  await expect(
    observeDevLaunchParentGeneration({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      sourceGeneration,
      timeoutMs: 1_000,
    }),
  ).rejects.toMatchObject({ code: DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED });
  writeFileSync(retirementReleaseFile, "release\n", { mode: 0o600 });
  await restarting;

  writeFileSync(stopFile, "stop\n");
  await expect(supervised).resolves.toMatchObject({ code: 0, signal: null });
});

it("rejects a stale parent probe without demoting a committed restart", async () => {
  const fixture = await startFrontendEpochFixture("stale-parent-probe");
  const deferred = fixture.probe.armFalse();
  const observed = sendFrame(
    fixture.descriptor.socketPath,
    parentGenerationProbeRequest(fixture.descriptor),
  );
  await deferred.started;

  const receipt = await requestDevLaunchRestart({
    home: fixture.fixtureHome,
    root: fixture.worktreeRoot,
    channel: fixture.channel,
    timeoutMs: 5_000,
  });
  const committed = JSON.parse(readFileSync(fixture.descriptorPath, "utf8"));
  expect(committed).toMatchObject({
    state: "ready",
    launch: receipt.launch,
    frontend: fixture.descriptor.frontend,
  });

  deferred.release();
  await expect(observed).resolves.toMatchObject({
    type: "parent_generation_rejected",
    reason: expect.stringContaining("changed during proof"),
  });
  expect(JSON.parse(readFileSync(fixture.descriptorPath, "utf8"))).toEqual(
    committed,
  );

  await fixture.observeFile(
    fixture.appStarted,
    (value) => value.trim() === String(committed.launch.pid),
  );
  await expect(fixture.dispose()).resolves.toMatchObject({ code: 0 });
});

it("keeps ready authority after a transient frontend readiness miss", async () => {
  const fixture = await startFrontendEpochFixture("transient-frontend-probe");
  try {
    const deferred = fixture.probe.armFalse();
    const observed = observeDevLaunchParentGeneration({
      home: fixture.fixtureHome,
      root: fixture.worktreeRoot,
      channel: fixture.channel,
      sourceGeneration: fixture.sourceGeneration,
      timeoutMs: 5_000,
    });
    await deferred.started;
    deferred.release();

    await expect(observed).rejects.toThrow(
      "activated parent endpoint does not serve the target generation",
    );
    await deferred.finished;
    expect(JSON.parse(readFileSync(fixture.descriptorPath, "utf8"))).toEqual(
      fixture.descriptor,
    );
    await expect(
      observeDevLaunchParentGeneration({
        home: fixture.fixtureHome,
        root: fixture.worktreeRoot,
        channel: fixture.channel,
        sourceGeneration: fixture.sourceGeneration,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      type: "parent_generation_receipt",
      sourceGeneration: fixture.sourceGeneration,
      supervisor: fixture.descriptor.supervisor,
      launch: fixture.descriptor.launch,
    });
  } finally {
    await expect(fixture.dispose()).resolves.toMatchObject({ code: 0 });
  }
});

it("keeps the admitted predecessor ready after a non-destructive parent failure", async () => {
  const fixture = await startFrontendEpochFixture(
    "parent-preflight-failure",
    {
      preflightParent: async () => {
        throw new Error("fixture parent preflight failed");
      },
    },
  );
  try {
    const deferred = fixture.probe.armFalse();
    void deferred.started.then(deferred.release);
    const reload = requestDevLaunchParentReload({
      home: fixture.fixtureHome,
      root: fixture.worktreeRoot,
      channel: fixture.channel,
      sourceGeneration: "a".repeat(64),
      timeoutMs: 5_000,
    });

    await expect(reload).rejects.toThrow("fixture parent preflight failed");
    const restored = JSON.parse(
      readFileSync(fixture.descriptorPath, "utf8"),
    );
    expect(restored).toMatchObject({
      state: "ready",
      launch: fixture.descriptor.launch,
      frontend: fixture.descriptor.frontend,
    });
    await expect(
      observeDevLaunchParentGeneration({
        home: fixture.fixtureHome,
        root: fixture.worktreeRoot,
        channel: fixture.channel,
        sourceGeneration: fixture.sourceGeneration,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("activated parent endpoint does not serve");
    await deferred.finished;
    expect(JSON.parse(readFileSync(fixture.descriptorPath, "utf8"))).toMatchObject(
      { state: "ready" },
    );
    await expect(
      observeDevLaunchParentGeneration({
        home: fixture.fixtureHome,
        root: fixture.worktreeRoot,
        channel: fixture.channel,
        sourceGeneration: fixture.sourceGeneration,
        timeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({
      type: "parent_generation_receipt",
      launch: fixture.descriptor.launch,
      frontend: fixture.descriptor.frontend,
    });
  } finally {
    await expect(fixture.dispose()).resolves.toMatchObject({ code: 0 });
  }
});

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "demotes ready authority when the exact frontend exits",
  async () => {
    const fixture = await startFrontendEpochFixture("frontend-exit");
    try {
      process.kill(fixture.descriptor.frontend.pid, "SIGTERM");
      await expect(
        fixture.observeDescriptor((value) =>
          value.state === "preparing" ? value : null,
        ),
      ).resolves.toMatchObject({
        state: "preparing",
        launch: fixture.descriptor.launch,
        frontend: fixture.descriptor.frontend,
      });
    } finally {
      await expect(fixture.dispose()).resolves.toMatchObject({ code: 0 });
    }
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "serves one restart status frame within one second while a dead frontend leader retains its exact witness",
  async () => {
    const fixture = await startFrontendEpochFixture(
      "dead-frontend-control-status",
      { retainFrontendDescendant: true },
    );
    const previousFrontend = fixture.descriptor.frontend;
    const deferred = fixture.probe.armFalse();
    const observation = observeDevLaunchParentGeneration({
      home: fixture.fixtureHome,
      root: fixture.worktreeRoot,
      channel: fixture.channel,
      sourceGeneration: fixture.sourceGeneration,
      timeoutMs: 5_000,
    });
    await deferred.started;

    await signalExactProcess(previousFrontend, "SIGTERM");
    await waitFor(() => processIdentity(previousFrontend.pid) === null);
    expect(await observeOwnedProcessGroup(previousFrontend)).toMatchObject({
      state: "owned",
      leaderCurrent: false,
      witnessCurrent: true,
    });

    const requestId = "d".repeat(64);
    const authority = {
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot: fixture.worktreeRoot,
      channel: fixture.channel,
      capability: fixture.descriptor.capability,
      supervisor: fixture.descriptor.supervisor,
    };
    const restartRequest = {
      ...authority,
      type: "restart",
      expectedLaunch: launchGenerationProjection(fixture.descriptor.launch),
      expectedFrontend: launchGenerationProjection(previousFrontend),
    };
    let committed;
    try {
      await expect(sendFrame(
        fixture.descriptor.socketPath,
        restartRequest,
      )).resolves.toMatchObject({
        type: "restart_admitted",
        requestId,
      });
      const firstStatus = await sendFrame(
        fixture.descriptor.socketPath,
        { ...authority, type: "restart_status" },
        { timeoutMs: 1_000 },
      );
      expect(["restart_pending", "restart_receipt"]).toContain(
        firstStatus.type,
      );
      deferred.release();
      await deferred.finished;
      await expect(observation).rejects.toThrow(
        "activated parent endpoint does not serve the target generation",
      );
      if (firstStatus.type === "restart_pending") {
        committed = await fixture.observeDescriptor((descriptor) =>
          descriptor.state === "ready" &&
            descriptor.launch.generation !== fixture.descriptor.launch.generation
            ? descriptor
            : null
        );
      }
      const receipt = firstStatus.type === "restart_receipt"
        ? firstStatus
        : await sendFrame(
            fixture.descriptor.socketPath,
            { ...authority, type: "restart_status" },
            { timeoutMs: 1_000 },
          );
      expect(receipt.type).toBe("restart_receipt");
      committed ??= JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      );
      expect(receipt.frontend).toEqual(committed.frontend);
      expect(committed.frontend.generation).not.toBe(
        previousFrontend.generation,
      );
      expect(
        processIdentity(previousFrontend.processGroup.witness.pid),
      ).toBeNull();
      await expect(
        sendFrame(fixture.descriptor.socketPath, restartRequest),
      ).resolves.toMatchObject({ type: "restart_receipt", requestId });
      await expect(
        acknowledgeRestart(fixture.descriptor.socketPath, authority),
      ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    } finally {
      deferred.release();
      await observation.catch(() => {});
      await fixture.dispose();
    }
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux")(
  "accepts legacy v2 generation projections for parent probe and reload",
  async () => {
    let rejectPreflight;
    let preflightStarted;
    const started = new Promise((resolve) => {
      preflightStarted = resolve;
    });
    const fixture = await startFrontendEpochFixture(
      "legacy-v2-parent-generation",
      {
        preflightParent: () => {
          preflightStarted();
          return new Promise((_, reject) => {
            rejectPreflight = reject;
          });
        },
      },
    );
    const expectedLaunch = launchGenerationProjection(
      fixture.descriptor.launch,
    );
    const expectedFrontend = launchGenerationProjection(
      fixture.descriptor.frontend,
    );
    try {
      await expect(
        sendFrame(fixture.descriptor.socketPath, {
          ...parentGenerationProbeRequest(fixture.descriptor),
          expectedLaunch,
          expectedFrontend,
        }),
      ).resolves.toMatchObject({
        type: "parent_generation",
        launch: fixture.descriptor.launch,
        frontend: fixture.descriptor.frontend,
      });

      const requestId = "e".repeat(64);
      await expect(
        sendFrame(fixture.descriptor.socketPath, {
          schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          type: "parent_reload",
          requestId,
          worktreeRoot: fixture.worktreeRoot,
          channel: fixture.channel,
          capability: fixture.descriptor.capability,
          expectedSupervisor: fixture.descriptor.supervisor,
          expectedLaunch,
          expectedFrontend,
          targetSupervisorGeneration: "f".repeat(64),
          targetSourceGeneration: "8".repeat(64),
        }),
      ).resolves.toMatchObject({ type: "parent_reload_admitted", requestId });
      await started;
      rejectPreflight(new Error("fixture preflight stopped"));
      const failed = await fixture.observeDescriptor(
        (descriptor) =>
          descriptor.state === "ready" &&
            descriptor.parentReloadFailure?.requestId === requestId
            ? descriptor
            : null,
      );
      expect(failed.launch).toEqual(fixture.descriptor.launch);
    } finally {
      rejectPreflight?.(new Error("fixture cleanup"));
      await fixture.dispose();
    }
  },
);

function sendParentGeneration(connection, descriptor, overrides = {}) {
  connection.end(
    `${JSON.stringify({
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      type: "parent_generation",
      worktreeRoot: descriptor.worktreeRoot,
      channel: descriptor.channel,
      supervisor: descriptor.supervisor,
      launch: descriptor.launch,
      sourceGeneration: descriptor.sourceGeneration,
      ...overrides,
    })}\n`,
  );
}

async function waitForAsync(
  predicate,
  timeoutMs = FIXTURE_LIFECYCLE_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("fixture observation timed out");
}

afterEach(async () => {
  await fixtureProcesses.retireAll();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("superviseDevLaunch", () => {
  it.runIf(
    process.platform !== "win32" && typeof process.execve === "function",
  )(
    "rejects unsupported Linux before descriptor recovery mutation",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-linux-admission-1234567890";
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      const descriptorPath = join(
        controlDirectory,
        DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
      );
      const resultPath = join(fixtureRoot, "admission-result.json");
      const driverPath = join(fixtureRoot, "admission-driver.mjs");
      const wrapperPath = fileURLToPath(
        new URL("../run-dev-launch-child.mjs", import.meta.url),
      );
      const expectedCapability = "1".repeat(64);
      const staleSupervisorGeneration = "2".repeat(64);
      const descriptorSource = `${JSON.stringify({
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "preparing",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: expectedCapability,
        capabilities: ["child_restart"],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "linux:test-boot:2147483000",
          generation: staleSupervisorGeneration,
        },
        launch: null,
        candidateLaunch: {
          pid: 2_147_483_001,
          processIdentity: "linux:test-boot:2147483001",
          generation: "3".repeat(64),
        },
        publishedAtMs: Date.now(),
      })}\n`;
      mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 });
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
      chmodSync(controlDirectory, 0o700);
      writeFileSync(descriptorPath, descriptorSource, { mode: 0o600 });
      const descriptorStat = lstatSync(descriptorPath);
      writeFileSync(
        driverPath,
        `import { writeFileSync } from "node:fs";
import { superviseDevLaunch } from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};

const [home, worktreeRoot, channel, wrapperPath, resultPath] = process.argv.slice(2);
try {
  await superviseDevLaunch({
    home,
    worktreeRoot,
    channel,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    prepareLaunch: {
      command: process.execPath,
      args: [wrapperPath, "--check"],
      spawnOptions: { cwd: worktreeRoot, env: process.env, stdio: "ignore" },
    },
  });
  writeFileSync(resultPath, JSON.stringify({ admitted: true }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({
    admitted: false,
    code: error.code ?? null,
    message: error.message,
  }));
}
`,
        { mode: 0o600 },
      );

      await execFileAsync(
        process.execPath,
        [
          driverPath,
          fixtureHome,
          worktreeRoot,
          channel,
          wrapperPath,
          resultPath,
        ],
        {
          env: simulatedLinuxProcessBoundaryEnvironment({
            root: fixtureRoot,
            mode: "missing-apis",
          }),
          timeout: FIXTURE_LIFECYCLE_TIMEOUT_MS,
        },
      );

      expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({
        admitted: false,
        code: "DEV_PROCESS_GROUP_UNSUPPORTED",
      });
      expect(readFileSync(descriptorPath, "utf8")).toBe(descriptorSource);
      expect(lstatSync(descriptorPath)).toMatchObject({
        dev: descriptorStat.dev,
        ino: descriptorStat.ino,
      });
      expect(
        existsSync(
          `${descriptorPath}.claim-${staleSupervisorGeneration}`,
        ),
      ).toBe(false);
    },
  );

  it("requires an explicit cold bootstrap for a legacy v1 parent", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-legacy-parent-1234567890";
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      protocolVersion: null,
      onRequest() {
        throw new Error("legacy parent reload must not cross IPC");
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "f".repeat(64),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
      destructiveBoundaryCrossed: false,
    });
    expect(fixture.requests).toEqual([]);
    await fixture.close();
  });

  it("requires a cold bootstrap when exec handoff is not advertised", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-no-exec-parent-1234567890";
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart"],
      sourceGeneration: "e".repeat(64),
      onRequest({ request, connection, supervisor, launch }) {
        if (request.type !== "parent_generation_probe") {
          throw new Error("unsupported parent reload must not cross IPC");
        }
        connection.end(
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            type: "parent_generation",
            worktreeRoot,
            channel,
            supervisor,
            launch,
            sourceGeneration: "e".repeat(64),
          })}\n`,
        );
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "f".repeat(64),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
      destructiveBoundaryCrossed: false,
    });
    expect(fixture.requests).toEqual([]);
    await expect(
      observeDevLaunchParentGeneration({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "e".repeat(64),
        requireParentReloadAuthority: true,
        requireFrontendAuthority: true,
      }),
    ).rejects.toMatchObject({
      code: DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED,
      destructiveBoundaryCrossed: false,
    });
    expect(fixture.requests).toEqual([]);
    await expect(
      observeDevLaunchParentGeneration({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "e".repeat(64),
      }),
    ).resolves.toMatchObject({
      type: "parent_generation_receipt",
      sourceGeneration: "e".repeat(64),
      supervisor: fixture.supervisor,
      launch: fixture.launch,
    });
    await fixture.close();
  });

  it("ensures an exact active parent without issuing a handoff", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-ensure-exact-1234567890";
    const sourceGeneration = "e".repeat(64);
    const fixture = await startConvergentDevLaunchParentFixture({
      fixtureRoot,
      home: fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration,
    });

    await expect(
      ensureDevLaunchParentGeneration({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration,
      }),
    ).resolves.toMatchObject({
      outcome: "already_active",
      parentGeneration: { sourceGeneration },
    });
    expect(fixture.requests.map(({ type }) => type)).toEqual([
      "parent_generation_probe",
    ]);
    await fixture.close();
  });

  it("ensures a different parent generation with one handoff", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-ensure-handoff-1234567890";
    const sourceGeneration = "2".repeat(64);
    const fixture = await startConvergentDevLaunchParentFixture({
      fixtureRoot,
      home: fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: "1".repeat(64),
    });

    await expect(
      ensureDevLaunchParentGeneration({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration,
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      outcome: "activated",
      parentGeneration: { sourceGeneration },
      activation: { type: "parent_reload_receipt", sourceGeneration },
    });
    expect(fixture.requests.map(({ type }) => type)).toEqual([
      "parent_generation_probe",
      "parent_reload",
      "parent_generation_probe",
    ]);
    await fixture.close();
  });

  it.each([
    {
      name: "a delayed ready descriptor",
      fixtureOptions: { concurrentActivationDelayMs: 75 },
      requestTypes: [
        "parent_generation_probe",
        "parent_reload",
        "parent_generation_probe",
      ],
    },
    {
      name: "descriptor turnover during the target probe",
      fixtureOptions: {
        concurrentActivationDelayMs: 0,
        turnoverDuringConvergenceProbe: true,
      },
      requestTypes: [
        "parent_generation_probe",
        "parent_reload",
        "parent_generation_probe",
        "parent_generation_probe",
      ],
    },
  ])("converges when another writer wins through $name", async ({
    fixtureOptions,
    requestTypes,
  }) => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-ensure-race-1234567890";
    const sourceGeneration = "4".repeat(64);
    const fixture = await startConvergentDevLaunchParentFixture({
      fixtureRoot,
      home: fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: "3".repeat(64),
      ...fixtureOptions,
    });
    try {
      await expect(
        ensureDevLaunchParentGeneration({
          home: fixtureHome,
          root: worktreeRoot,
          channel,
          sourceGeneration,
          timeoutMs: 2_000,
        }),
      ).resolves.toMatchObject({
        outcome: "already_active",
        parentGeneration: { sourceGeneration },
      });
      expect(fixture.requests.map(({ type }) => type)).toEqual(requestTypes);
    } finally {
      await fixture.close();
    }
  });

  it("recovers exact parent activation when exec loses the admission response", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-response-loss-1234567890";
    const previousSource = "1".repeat(64);
    const targetSource = "2".repeat(64);
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    let descriptorStateAtAdmissionClose = null;
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: previousSource,
      onRequest({ request, connection, supervisor, launch, replacement }) {
        if (request.type === "parent_generation_probe") {
          const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
          sendParentGeneration(connection, descriptor);
          return;
        }
        const successor = {
          ...supervisor,
          generation: request.targetSupervisorGeneration,
        };
        const preparing = {
          schemaVersion: 1,
          protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
          state: "preparing",
          worktreeRoot,
          channel,
          socketPath: fixture.socketPath,
          capability: fixture.capability,
          capabilities: ["child_restart", "parent_reload"],
          sourceGeneration: request.targetSourceGeneration,
          supervisor: successor,
          launch: null,
          activation: {
            type: "parent_reload",
            requestId: request.requestId,
            previousSupervisor: supervisor,
            previousLaunch: launch,
            sourceGeneration: request.targetSourceGeneration,
          },
          publishedAtMs: Date.now(),
        };
        writeFileSync(
          descriptorPath,
          `${JSON.stringify(preparing)}\n`,
          { mode: 0o600 },
        );
        const ready = {
          ...preparing,
          state: "ready",
          launch: replacement,
          activation: {
            ...preparing.activation,
            launch: replacement,
            activatedAtMs: Date.now(),
          },
          publishedAtMs: Date.now(),
        };
        connection.once("close", () => {
          descriptorStateAtAdmissionClose = JSON.parse(
            readFileSync(descriptorPath, "utf8"),
          ).state;
          writeFileSync(
            descriptorPath,
            `${JSON.stringify(ready)}\n`,
            { mode: 0o600 },
          );
        });
        connection.destroy();
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: targetSource,
        timeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({
      type: "parent_reload_receipt",
      previousSupervisor: fixture.supervisor,
      sourceGeneration: targetSource,
    });
    expect(descriptorStateAtAdmissionClose).toBe("preparing");
    expect(fixture.requests.map(({ type }) => type)).toEqual([
      "parent_reload",
      "parent_generation_probe",
    ]);
    await fixture.close();
  });

  it("rejects a changed child generation after a lost parent response", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-child-race-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: "1".repeat(64),
      onRequest({ connection, supervisor, replacement }) {
        connection.destroy();
        writeFileSync(
          descriptorPath,
          `${JSON.stringify({
            schemaVersion: 1,
            protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
            state: "ready",
            worktreeRoot,
            channel,
            socketPath: fixture.socketPath,
            capability: fixture.capability,
            capabilities: ["child_restart", "parent_reload"],
            sourceGeneration: "1".repeat(64),
            supervisor,
            launch: replacement,
            publishedAtMs: Date.now(),
          })}\n`,
          { mode: 0o600 },
        );
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "2".repeat(64),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/unrelated generation/),
      destructiveBoundaryCrossed: true,
    });
    await fixture.close();
  });

  it("fails promptly when the exec successor dies after committing handoff", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-dead-handoff-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const predecessor = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    await new Promise((resolve, reject) => {
      predecessor.once("spawn", resolve);
      predecessor.once("error", reject);
    });
    const exited = new Promise((resolve) => predecessor.once("exit", resolve));
    const supervisorIdentity = {
      pid: predecessor.pid,
      processIdentity: processIdentity(predecessor.pid),
      generation: "a".repeat(64),
    };
    expect(supervisorIdentity.processIdentity).toBeTruthy();
    let fixture;
    try {
      fixture = await startFixtureSupervisor({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        capabilities: ["child_restart", "parent_reload"],
        sourceGeneration: "1".repeat(64),
        supervisorIdentity,
        onRequest({ request, connection, supervisor, launch }) {
          connection.destroy();
          const handoff = {
            schemaVersion: 1,
            protocolVersion: DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
            type: "parent_handoff",
            requestId: request.requestId,
            worktreeRoot,
            channel,
            capability: redactDevLaunchCapability(fixture.capability),
            previousSupervisor: supervisor,
            previousLaunch: launch,
            targetSupervisorGeneration: request.targetSupervisorGeneration,
            targetSourceGeneration: request.targetSourceGeneration,
            phase: "exec_pending",
            committedAtMs: Date.now(),
          };
          writeFileSync(
            descriptorPath,
            `${JSON.stringify({
              schemaVersion: 1,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              state: "handoff",
              worktreeRoot,
              channel,
              socketPath: fixture.socketPath,
              capability: fixture.capability,
              capabilities: ["child_restart", "parent_reload"],
              sourceGeneration: "1".repeat(64),
              supervisor,
              launch: null,
              handoff,
              publishedAtMs: Date.now(),
            })}\n`,
            { mode: 0o600 },
          );
          predecessor.kill("SIGKILL");
        },
      });

      const startedAt = Date.now();
      await expect(
        requestDevLaunchParentReload({
          home: fixtureHome,
          root: worktreeRoot,
          channel,
          sourceGeneration: "2".repeat(64),
          timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
        }),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/successor exited after committed handoff/),
        destructiveBoundaryCrossed: true,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_500);
    } finally {
      if (predecessor.exitCode === null && predecessor.signalCode === null) {
        predecessor.kill("SIGKILL");
      }
      await exited;
      await fixture?.close();
    }
  });

  it("preserves an exact failure envelope when successor startup fails", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-successor-failure-1234567890";
    const {
      descriptorPath,
      handoff,
      previousSupervisor,
      targetSourceGeneration,
    } = committedParentHandoffFixture({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
    });

    await expect(
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: join(fixtureRoot, "missing-launch-command"),
        sourceGeneration: targetSourceGeneration,
        parentHandoff: handoff,
        preflightParent: async () => {},
        reloadParent: () => {},
      }),
    ).rejects.toThrow(/candidate exited.*before readiness/);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({
      state: "preparing",
      sourceGeneration: targetSourceGeneration,
      supervisor: {
        pid: process.pid,
        processIdentity: previousSupervisor.processIdentity,
        generation: handoff.targetSupervisorGeneration,
      },
      parentReloadFailure: {
        type: "parent_reload_failure",
        requestId: handoff.requestId,
        targetSupervisorGeneration: handoff.targetSupervisorGeneration,
        targetSourceGeneration,
        destructiveBoundaryCrossed: true,
      },
    });
  });

  it("publishes inherited handoff failure when the successor is signaled", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-successor-signal-1234567890";
    const preparationScript = join(fixtureRoot, "successor-preparation.mjs");
    const preparationStarted = join(fixtureRoot, "successor-preparation-started");
    const preparationMemberPidFile = join(
      fixtureRoot,
      "successor-preparation-member-pid",
    );
    writeFileSync(
      preparationScript,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const member = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
await new Promise((resolve, reject) => {
  member.once("message", resolve);
  member.once("error", reject);
});
writeFileSync(process.argv[2], "started\\n");
writeFileSync(process.argv[3], String(member.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const { descriptorPath, handoff, targetSourceGeneration } =
      committedParentHandoffFixture({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
      });
    const previousSignalListeners = new Set(process.listeners("SIGTERM"));
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [preparationScript, preparationStarted],
      prepareLaunch: {
        command: process.execPath,
        args: [
          preparationScript,
          preparationStarted,
          preparationMemberPidFile,
        ],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: targetSourceGeneration,
      parentHandoff: handoff,
      preflightParent: async () => {},
      reloadParent: () => {},
    });
    await waitFor(() => existsSync(preparationStarted));
    const preparationMemberPid = await waitFor(() => {
      if (!existsSync(preparationMemberPidFile)) return null;
      const pid = Number(readFileSync(preparationMemberPidFile, "utf8"));
      return processIdentity(pid) ? pid : null;
    });
    fixtureProcesses.registerIdentity({
      pid: preparationMemberPid,
      processIdentity: processIdentity(preparationMemberPid),
    });
    const signalListener = process
      .listeners("SIGTERM")
      .find((listener) => !previousSignalListeners.has(listener));
    expect(signalListener).toBeTypeOf("function");
    signalListener();

    await expect(supervised).resolves.toMatchObject({
      code: 1,
      signal: null,
      error: { message: expect.stringContaining("SIGTERM before activation") },
    });
    expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toMatchObject({
      state: "preparing",
      launch: null,
      parentReloadFailure: {
        requestId: handoff.requestId,
        targetSupervisorGeneration: handoff.targetSupervisorGeneration,
        targetSourceGeneration,
        destructiveBoundaryCrossed: true,
        reason: expect.stringContaining("SIGTERM before activation"),
      },
    });
    expect(processIdentity(preparationMemberPid)).toBeNull();
  });

  it("keeps inherited failure when final frontend proof resumes after signal", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-successor-final-proof-1234567890";
    const appScript = join(fixtureRoot, "successor-final-app.mjs");
    const frontendScript = join(fixtureRoot, "successor-final-frontend.mjs");
    writeFileSync(
      appScript,
      `process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    writeFileSync(
      frontendScript,
      `const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
const channel = process.argv[2];
${processGroupWitnessReadySource("channel", "generation")}
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel, generation });
process.once("message", async () => {
  await groupWitness.retain();
  process.send({ schemaVersion: 1, type: "frontend_activated", channel, generation });
});
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const { descriptorPath, handoff, targetSourceGeneration } =
      committedParentHandoffFixture({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
      });
    let probeCount = 0;
    let releaseFinalProof;
    let observeFinalProof;
    const finalProofStarted = new Promise((resolve) => {
      observeFinalProof = resolve;
    });
    const finalProofRelease = new Promise((resolve) => {
      releaseFinalProof = resolve;
    });
    const previousSignalListeners = new Set(process.listeners("SIGTERM"));
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [appScript],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: process.execPath,
        args: [frontendScript, channel],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async (identity) => {
          probeCount += 1;
          if (probeCount === 4) {
            observeFinalProof();
            await finalProofRelease;
          }
          return processIdentity(identity.pid) === identity.processIdentity;
        },
      },
      sourceGeneration: targetSourceGeneration,
      parentHandoff: handoff,
      preflightParent: async () => {},
      reloadParent: () => {},
    });
    await finalProofStarted;
    const signalListener = process
      .listeners("SIGTERM")
      .find((listener) => !previousSignalListeners.has(listener));
    expect(signalListener).toBeTypeOf("function");
    signalListener();
    const failed = JSON.parse(readFileSync(descriptorPath, "utf8"));
    expect(failed).toMatchObject({
      state: "preparing",
      launch: null,
      parentReloadFailure: {
        requestId: handoff.requestId,
        destructiveBoundaryCrossed: true,
        reason: expect.stringContaining("SIGTERM before activation"),
      },
    });

    releaseFinalProof();
    await expect(supervised).resolves.toMatchObject({ code: 1, signal: null });
    expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(failed);
  });

  it("rejects a ready descriptor when its endpoint serves another generation", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-endpoint-mismatch-1234567890";
    const previousSource = "3".repeat(64);
    const targetSource = "4".repeat(64);
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: previousSource,
      onRequest({ request, connection, supervisor, launch, replacement }) {
        if (request.type === "parent_generation_probe") {
          const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
          sendParentGeneration(connection, descriptor, { supervisor });
          return;
        }
        connection.destroy();
        writeFileSync(
          descriptorPath,
          `${JSON.stringify(
            activatedParentDescriptor({
              fixture,
              worktreeRoot,
              channel,
              request,
              previousSupervisor: supervisor,
              previousLaunch: launch,
              launch: replacement,
            }),
          )}\n`,
          { mode: 0o600 },
        );
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: targetSource,
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/endpoint.*target generation/),
      destructiveBoundaryCrossed: true,
    });
    await fixture.close();
  });

  it("rejects a cold-spawned process as an in-process parent cutover", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-parent-process-mismatch-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      capabilities: ["child_restart", "parent_reload"],
      sourceGeneration: "5".repeat(64),
      onRequest({ request, connection, supervisor, launch, replacement }) {
        connection.destroy();
        const coldSpawned = {
          pid: supervisor.pid + 1,
          processIdentity: "another-parent-process",
          generation: request.targetSupervisorGeneration,
        };
        writeFileSync(
          descriptorPath,
          `${JSON.stringify(
            activatedParentDescriptor({
              fixture,
              worktreeRoot,
              channel,
              request,
              previousSupervisor: supervisor,
              previousLaunch: launch,
              launch: replacement,
              supervisor: coldSpawned,
            }),
          )}\n`,
          { mode: 0o600 },
        );
      },
    });

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "6".repeat(64),
        timeoutMs: 2_000,
      }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/unrelated generation/),
      destructiveBoundaryCrossed: true,
    });
    expect(fixture.requests.map(({ type }) => type)).toEqual([
      "parent_reload",
    ]);
    await fixture.close();
  });

  it("restores the captured predecessor when execve throws after retirement", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "rollback-child.mjs");
    const launchesFile = join(fixtureRoot, "rollback-launches.txt");
    const stopFile = join(fixtureRoot, "rollback-stop");
    const channel = "dev-supervisor-parent-rollback-1234567890";
    const previousSource = "3".repeat(64);
    const targetSources = ["4".repeat(64), "5".repeat(64)];
    const observedHandoffs = [];
    writeFileSync(
      childScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
process.on("SIGTERM", () => process.exit(0));
const timer = setInterval(() => {
  if (count <= 1 || !existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 20);
`,
      { mode: 0o600 },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile, stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: previousSource,
      preflightParent: async (_targetSourceGeneration, handoff) => {
        observedHandoffs.push(handoff);
      },
      reloadParent: (handoff) => {
        expect(handoff).toEqual(observedHandoffs.at(-1));
        throw new Error("fixture execve failed");
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const predecessor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() =>
      readFileSync(launchesFile, "utf8").includes(
        `${predecessor.launch.pid}\n`,
      ),
    );
    const sockets = [];
    const connectIdle = async (socketPath) => {
      const socket = createConnection(socketPath);
      sockets.push(socket);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    };
    const socketClosed = (socket) =>
      new Promise((resolve) => socket.once("close", () => resolve("closed")));
    const closedWithin = (closure, timeoutMs) =>
      Promise.race([
        closure,
        new Promise((resolve) =>
          setTimeout(() => resolve("timed-out"), timeoutMs)
        ),
      ]);
    let current = predecessor;
    try {
      for (const [index, targetSource] of targetSources.entries()) {
        const idle = await connectIdle(current.socketPath);
        const idleClosed = socketClosed(idle);
        const reloadFailure = await requestDevLaunchParentReload({
            home: fixtureHome,
            root: worktreeRoot,
            channel,
            sourceGeneration: targetSource,
            timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
          }).then(
            () => null,
            (error) => error,
          );
        expect(reloadFailure).toMatchObject({
          destructiveBoundaryCrossed: true,
        });
        expect(observedHandoffs[index].capability).toBe(
          redactDevLaunchCapability(current.capability),
        );
        expect(observedHandoffs[index].capability).not.toBe(
          current.capability,
        );
        await expect(
          closedWithin(idleClosed, 500),
          `recovery ${index + 1} must close its previous endpoint: ${reloadFailure?.message}`,
        ).resolves.toBe("closed");
        const previousLaunch = current.launch;
        current = await waitFor(() => {
          const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
          return value.state === "ready" &&
              value.parentReloadFailure?.targetSourceGeneration ===
                targetSource &&
              value.parentReloadFailure.recoveredLaunch
            ? value
            : null;
        });
        expect(current).toMatchObject({
          state: "ready",
          supervisor: predecessor.supervisor,
          sourceGeneration: previousSource,
          parentReloadFailure: {
            type: "parent_reload_failure",
            targetSourceGeneration: targetSource,
            destructiveBoundaryCrossed: true,
            recoveredLaunch: current.launch,
          },
        });
        expect(current.launch.generation).not.toBe(
          previousLaunch.generation,
        );
        await waitFor(
          () =>
            readFileSync(launchesFile, "utf8").trim().split("\n").length ===
              index + 2,
        );
      }

      const finalIdle = await connectIdle(current.socketPath);
      const finalIdleClosed = socketClosed(finalIdle);
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await expect(supervised).resolves.toEqual({ code: 0, signal: null });
      await expect(closedWithin(finalIdleClosed, 500)).resolves.toBe("closed");
    } finally {
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      for (const socket of sockets) socket.destroy();
    }
  });

  it("rejects low headroom before child retirement or parent exec", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "headroom-child.mjs");
    const launchesFile = join(fixtureRoot, "headroom-launches.txt");
    const stopFile = join(fixtureRoot, "headroom-child-stop");
    const channel = "dev-supervisor-headroom-1234567890";
    let reloadCalled = false;
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: "3".repeat(64),
      preflightParent: () =>
        assertHeadroom({}, () => ({
          ok: false,
          message: "fixture low headroom",
        })),
      reloadParent: () => {
        reloadCalled = true;
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const predecessor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => existsSync(launchesFile));

    await expect(
      requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "4".repeat(64),
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("fixture low headroom"),
      destructiveBoundaryCrossed: false,
    });
    const unchanged = JSON.parse(readFileSync(descriptorPath, "utf8"));
    expect(unchanged.launch).toEqual(predecessor.launch);
    expect(processIdentity(predecessor.launch.pid)).toBe(
      predecessor.launch.processIdentity,
    );
    expect(reloadCalled).toBe(false);
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(1);
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it.runIf(
    (process.platform === "darwin" || process.platform === "linux") &&
      typeof process.execve === "function",
  )(
    "allows the exact owned parent preflight candidate while its descriptor is preparing",
    async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "owned-parent-preflight-child.mjs");
    const preflightScript = join(
      fixtureRoot,
      "owned-parent-preflight-target.mjs",
    );
    const preflightMarker = join(fixtureRoot, "owned-parent-preflight.json");
    const stopFile = join(fixtureRoot, "owned-parent-preflight-stop");
    const channel = "dev-supervisor-owned-parent-preflight-1234567890";
    const previousSourceGeneration = "3".repeat(64);
    const targetSourceGeneration = "4".repeat(64);
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    let reloadCalled = false;
    writeControlledExitScript(childScript);
    writeFileSync(
      preflightScript,
      `import { readFileSync, writeFileSync } from "node:fs";
import { preflightDevLaunchParentResume } from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};
const [home, worktreeRoot, channel, sourceGeneration, serializedHandoff, marker, descriptorPath] = process.argv.slice(2);
const candidateGeneration = process.env[${JSON.stringify(DEV_LAUNCH_CHILD_GENERATION_ENV)}];
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
await preflightDevLaunchParentResume({
  home,
  worktreeRoot,
  channel,
  sourceGeneration,
  handoff: JSON.parse(serializedHandoff),
});
writeFileSync(marker, JSON.stringify({
  pid: process.pid,
  candidateGeneration,
  descriptorState: descriptor.state,
  candidateLaunch: descriptor.candidateLaunch,
}));
process.exit(23);
`,
      { mode: 0o600 },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: previousSourceGeneration,
      preflightParent: (sourceGeneration, handoff) => ({
        command: process.execPath,
        args: [
          preflightScript,
          fixtureHome,
          worktreeRoot,
          channel,
          sourceGeneration,
          JSON.stringify(handoff),
          preflightMarker,
          descriptorPath,
        ],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        timeoutMs: 5_000,
      }),
      reloadParent: () => {
        reloadCalled = true;
      },
    });

    try {
      const predecessor = await waitFor(() => {
        try {
          const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
          return value.state === "ready" ? value : null;
        } catch {
          return null;
        }
      });
      const failure = await requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: targetSourceGeneration,
        timeoutMs: 5_000,
      }).then(
        () => null,
        (error) => error,
      );

      expect(failure).toMatchObject({
        message: expect.stringContaining("prerequisite exited with code 23"),
        destructiveBoundaryCrossed: false,
      });
      const marker = JSON.parse(readFileSync(preflightMarker, "utf8"));
      expect(marker).toMatchObject({
        pid: expect.any(Number),
        candidateGeneration: expect.stringMatching(/^[a-f0-9]{64}$/),
        descriptorState: "preparing",
        candidateLaunch: {
          pid: expect.any(Number),
          processIdentity: expect.any(String),
          generation: expect.stringMatching(/^[a-f0-9]{64}$/),
          processGroup: {
            witness: {
              pid: expect.any(Number),
              processIdentity: expect.any(String),
            },
          },
        },
      });
      expect(marker.candidateLaunch.pid).toBe(marker.pid);
      expect(marker.candidateLaunch.generation).toBe(
        marker.candidateGeneration,
      );
      const preserved = JSON.parse(readFileSync(descriptorPath, "utf8"));
      expect(preserved.state).toBe("ready");
      expect(preserved.launch).toEqual(predecessor.launch);
      expect(processIdentity(predecessor.launch.pid)).toBe(
        predecessor.launch.processIdentity,
      );
      expect(reloadCalled).toBe(false);
      await waitFor(
        () =>
          processIdentity(marker.candidateLaunch.pid) !==
          marker.candidateLaunch.processIdentity,
      );
      await waitFor(
        () =>
          processIdentity(marker.candidateLaunch.processGroup.witness.pid) !==
          marker.candidateLaunch.processGroup.witness.processIdentity,
      );
    } finally {
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await expect(supervised).resolves.toEqual({ code: 0, signal: null });
    }
    },
  );

  it("cancels the owned parent preflight group on supervisor signal", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "signal-preflight-child.mjs");
    const preflightScript = join(fixtureRoot, "held-parent-preflight.mjs");
    const preflightPids = join(fixtureRoot, "held-parent-preflight-pids.json");
    const channel = "dev-supervisor-preflight-signal-1234567890";
    const descendantScript = join(fixtureRoot, "held-preflight-descendant.mjs");
    const releaseDescendant = join(fixtureRoot, "release-preflight-descendant");
    writeControlledExitScript(descendantScript, {
      onStart: 'process.send("ready");',
      onTerm: "",
    });
    writeFileSync(
      childScript,
      `process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    writeFileSync(
      preflightScript,
      `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, [process.argv[3], process.argv[4]], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
await new Promise((resolve) => descendant.once("message", resolve));
writeFileSync(process.argv[2], JSON.stringify([process.pid, descendant.pid]));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const previousSignalListeners = new Set(process.listeners("SIGTERM"));
    let reloadCalled = false;
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration: "3".repeat(64),
      preflightParent: () => ({
        command: process.execPath,
        args: [preflightScript, preflightPids, descendantScript, releaseDescendant],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        timeoutMs: 5_000,
      }),
      reloadParent: () => {
        reloadCalled = true;
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(descriptorPath, "utf8")).state === "ready";
      } catch {
        return false;
      }
    });
    const reload = requestDevLaunchParentReload({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      sourceGeneration: "4".repeat(64),
      timeoutMs: 2_000,
    });
    const ownedPids = await waitFor(() => {
      try {
        return JSON.parse(readFileSync(preflightPids, "utf8"));
      } catch {
        return null;
      }
    });
    const signalListener = process
      .listeners("SIGTERM")
      .find((listener) => !previousSignalListeners.has(listener));
    expect(signalListener).toBeTypeOf("function");
    signalListener();

    try {
      const rejection = await Promise.race([
        reload.catch((error) => error),
        new Promise((resolve) =>
          setTimeout(() => resolve(new Error("parent reload did not settle")), 1_000),
        ),
      ]);
      expect(rejection).toMatchObject({
        message: expect.stringMatching(/supervisor is stopping/),
        destructiveBoundaryCrossed: false,
        parentReloadRequestId: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const pending = JSON.parse(readFileSync(descriptorPath, "utf8"));
      expect(pending.state).toBe("preparing");
      expect(pending.candidateLaunch.pid).toBe(ownedPids[0]);
      expect(processIdentity(ownedPids[1])).not.toBeNull();
    } finally {
      writeFileSync(releaseDescendant, "release\n");
      await expect(supervised).resolves.toEqual({ code: null, signal: "SIGTERM" });
    }
    expect(reloadCalled).toBe(false);
    for (const pid of ownedPids) {
      await waitFor(() => processIdentity(pid) === null);
    }
  });

  it("admits only one concurrent launcher for an exact worktree channel", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "concurrent-child.mjs");
    const launchesFile = join(fixtureRoot, "concurrent-launches.txt");
    const stopFile = join(fixtureRoot, "concurrent-child-stop");
    const channel = "dev-supervisor-concurrent-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );

    const launch = () =>
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: [childScript, stopFile, launchesFile],
        fixtureReleasePaths: [stopFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      });
    const outcomesPromise = Promise.allSettled([launch(), launch()]);
    await waitFor(() => {
      try {
        const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return descriptor.state === "ready" &&
            readFileSync(launchesFile, "utf8").trim().split("\n").length === 1
          ? descriptor
          : null;
      } catch {
        return null;
      }
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    const outcomes = await outcomesPromise;

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(
      1,
    );
  });

  it("closes accepted idle control connections during owned shutdown", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "idle-control-child.mjs");
    const stopFile = join(fixtureRoot, "idle-control-child-stop");
    const channel = "dev-supervisor-idle-control-1234567890";
    writeControlledExitScript(childScript);

    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const supervised = fixture.outcome;
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(
          readFileSync(
            join(
              appControlDirectory(fixtureHome, channel),
              DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
            ),
            "utf8",
          ),
        );
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    const idle = createConnection(descriptor.socketPath);
    await new Promise((resolve, reject) => {
      idle.once("connect", resolve);
      idle.once("error", reject);
    });

    let endpointTimeout;
    let finalizerTimeout;
    try {
      const endpointClosed = new Promise((resolve, reject) => {
        idle.once("close", () => resolve({ closed: true }));
        idle.once("error", reject);
      });
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      const endpoint = await Promise.race([
        endpointClosed,
        new Promise((resolve) =>
          endpointTimeout = setTimeout(
            () => resolve({ timedOut: true }),
            1_000,
          ),
        ),
      ]);
      expect(endpoint).toEqual({ closed: true });
      const outcome = await Promise.race([
        supervised,
        new Promise((_, reject) =>
          finalizerTimeout = setTimeout(
            () => reject(new Error("owned shutdown did not finalize")),
            FIXTURE_LIFECYCLE_TIMEOUT_MS,
          ),
        ),
      ]);
      expect(outcome).toEqual({ code: 0, signal: null });
    } finally {
      clearTimeout(endpointTimeout);
      clearTimeout(finalizerTimeout);
      idle.destroy();
      await fixture.dispose();
    }
  });

  it("owns launch preparation before admitting a concurrent launcher", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "preparation.mjs");
    const childScript = join(fixtureRoot, "prepared-child.mjs");
    const eventsFile = join(fixtureRoot, "events.txt");
    const releaseFile = join(fixtureRoot, "release");
    const stopFile = join(fixtureRoot, "prepared-child-stop");
    const channel = "dev-supervisor-preparation-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      { onStart: 'appendFileSync(process.argv[3], "launch\\n");' },
    );
    const launch = () =>
      superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: [childScript, stopFile, eventsFile],
        fixtureReleasePaths: [stopFile, releaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        prepareLaunch: {
          command: process.execPath,
          args: [preparationScript, eventsFile, releaseFile],
          spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        },
      });

    const first = launch();
    await waitFor(() => {
      try {
        return readFileSync(eventsFile, "utf8") === "prepare\n";
      } catch {
        return false;
      }
    });
    const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
    expect(descriptor).toMatchObject({ state: "preparing", launch: null });
    await expect(launch()).rejects.toThrow(/already active|still live/);
    expect(readFileSync(eventsFile, "utf8")).toBe("prepare\n");

    writeFileSync(releaseFile, "release\n", { mode: 0o600 });
    await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" ? value : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(first).resolves.toEqual({ code: 0, signal: null });
    expect(readFileSync(eventsFile, "utf8")).toBe("prepare\nlaunch\n");
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "recovers a published long-lived prerequisite without retiring its incumbent",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const appScript = join(fixtureRoot, "prerequisite-crash-app.mjs");
      const preparationScript = join(
        fixtureRoot,
        "prerequisite-crash-preparation.mjs",
      );
      const driverScript = join(fixtureRoot, "prerequisite-crash-driver.mjs");
      const preparationsFile = join(fixtureRoot, "prerequisite-crash-count.txt");
      const preparationPidFile = join(fixtureRoot, "prerequisite-crash-pid.txt");
      const memberPidFile = join(fixtureRoot, "prerequisite-crash-member-pid.txt");
      const stopFile = join(fixtureRoot, "prerequisite-crash-stop");
      const channel = "dev-supervisor-prerequisite-crash-1234567890";
      const descriptorPath = join(
        appControlDirectory(fixtureHome, channel),
        DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
      );
      writeControlledExitScript(appScript);
      writeFileSync(
        preparationScript,
        `import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
const member = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
await new Promise((resolve, reject) => {
  member.once("message", resolve);
  member.once("error", reject);
});
writeFileSync(process.argv[3], String(process.pid));
writeFileSync(process.argv[4], String(member.pid));
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        { mode: 0o600 },
      );
      writeFileSync(
        driverScript,
        `import { superviseDevLaunch } from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};
const [fixtureRoot, fixtureHome, worktreeRoot, channel, appScript, preparationScript, preparationsFile, preparationPidFile, memberPidFile, stopFile, mode] = process.argv.slice(2);
const options = {
  home: fixtureHome,
  worktreeRoot,
  channel,
  command: process.execPath,
  args: [appScript, stopFile],
  spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
};
if (mode === "prepare") {
  options.prepareLaunch = {
    command: process.execPath,
    args: [preparationScript, preparationsFile, preparationPidFile, memberPidFile],
    spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
  };
}
await superviseDevLaunch(options);
`,
        { mode: 0o600 },
      );
      const driver = spawn(
        process.execPath,
        [
          driverScript,
          fixtureRoot,
          fixtureHome,
          worktreeRoot,
          channel,
          appScript,
          preparationScript,
          preparationsFile,
          preparationPidFile,
          memberPidFile,
          stopFile,
          "prepare",
        ],
        { stdio: "ignore" },
      );
      fixtureProcesses.registerSpawn(driver);
      await new Promise((resolve, reject) => {
        driver.once("spawn", resolve);
        driver.once("error", reject);
      });
      const driverExited = new Promise((resolve) => driver.once("exit", resolve));
      fixtureProcesses.registerDescriptor(descriptorPath);
      await waitFor(() =>
        existsSync(appControlDirectory(fixtureHome, channel))
      );
      const incumbent = await waitForJsonFile(
        descriptorPath,
        (value) => value.state === "ready" ? value : null,
        FIXTURE_LIFECYCLE_TIMEOUT_MS,
      );
      const incumbentWitness = incumbent.launch.processGroup.witness;
      fixtureProcesses.registerIdentity(incumbent.launch);
      const restart = requestDevLaunchRestart({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        timeoutMs: 250,
        settlementTimeoutMs: 1_000,
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      const preparationPid = await waitFor(() => {
        if (!existsSync(preparationPidFile)) return null;
        const pid = Number(readFileSync(preparationPidFile, "utf8"));
        return processIdentity(pid) ? pid : null;
      });
      const preparationIdentity = processIdentity(preparationPid);
      fixtureProcesses.registerIdentity({
        pid: preparationPid,
        processIdentity: preparationIdentity,
      });
      const memberPid = await waitFor(() => {
        if (!existsSync(memberPidFile)) return null;
        const pid = Number(readFileSync(memberPidFile, "utf8"));
        return processIdentity(pid) ? pid : null;
      });
      fixtureProcesses.registerIdentity({
        pid: memberPid,
        processIdentity: processIdentity(memberPid),
      });
      const preparing = await waitForJsonFile(
        descriptorPath,
        (value) =>
          value.state === "preparing" && value.candidateLaunch
            ? value
            : null,
        FIXTURE_LIFECYCLE_TIMEOUT_MS,
      );
      expect(preparing.launch).toEqual(incumbent.launch);
      expect(preparing.candidateLaunch).toMatchObject({
        pid: preparationPid,
        processIdentity: preparationIdentity,
        processGroup: { kind: "posix_process_group_v1" },
      });
      const preparationWitness = preparing.candidateLaunch.processGroup.witness;
      fixtureProcesses.registerIdentity(preparing.candidateLaunch);
      expect(
        await observeOwnedProcessGroup(preparing.candidateLaunch),
      ).toMatchObject({
        state: "owned",
        witnessCurrent: true,
      });

      process.kill(driver.pid, "SIGKILL");
      await driverExited;
      expect(processIdentity(incumbent.launch.pid)).toBe(
        incumbent.launch.processIdentity,
      );
      expect(
        await observeOwnedProcessGroup(preparing.candidateLaunch),
      ).toMatchObject({
        state: "owned",
        witnessCurrent: true,
      });

      const recovered = spawn(
        process.execPath,
        [
          driverScript,
          fixtureRoot,
          fixtureHome,
          worktreeRoot,
          channel,
          appScript,
          preparationScript,
          preparationsFile,
          preparationPidFile,
          memberPidFile,
          stopFile,
          "recover",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      fixtureProcesses.registerSpawn(recovered);
      let recoveryStderr = "";
      recovered.stderr.setEncoding("utf8");
      recovered.stderr.on("data", (chunk) => {
        recoveryStderr += chunk;
      });
      await new Promise((resolve, reject) => {
        recovered.once("spawn", resolve);
        recovered.once("error", reject);
      });
      const recoveredExit = new Promise((resolve) =>
        recovered.once("exit", (code, signal) => resolve({ code, signal })),
      );
      try {
        const ready = await Promise.race([
          waitForJsonFile(
            descriptorPath,
            (value) => value.state === "ready" ? value : null,
            FIXTURE_LIFECYCLE_TIMEOUT_MS + 7_000,
          ),
          recoveredExit.then(({ code, signal }) => {
            throw new Error(
              signal
                ? `recovery supervisor exited from ${signal}`
                : `recovery supervisor exited with code ${code}: ${recoveryStderr}`,
            );
          }),
        ]);
        expect(ready.launch).toEqual(incumbent.launch);
        expect(ready.candidateLaunch).toBeUndefined();
        await waitFor(() => processIdentity(preparationPid) === null);
        await waitFor(() => processIdentity(memberPid) === null);
        await waitFor(() => processIdentity(preparationWitness.pid) === null);
      } finally {
        writeFileSync(stopFile, "stop\n", { mode: 0o600 });
        await recoveredExit;
        await restart;
      }
      await waitFor(() => processIdentity(incumbentWitness.pid) === null);
    },
  );

  it("keeps the current launch alive when restart preparation fails", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "restart-preparation.mjs");
    const childScript = join(fixtureRoot, "restart-child.mjs");
    const preparationsFile = join(fixtureRoot, "preparations.txt");
    const launchesFile = join(fixtureRoot, "restart-launches.txt");
    const stopFile = join(fixtureRoot, "restart-child-stop");
    const channel = "dev-supervisor-failed-preparation-1234567890";
    let initialPreparations = 0;
    writeFileSync(
      preparationScript,
      `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
process.exit(count === 1 ? 0 : 7);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareInitialLaunch: () => {
        initialPreparations += 1;
      },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });

    let failure;
    try {
      await requestDevLaunchRestart({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        timeoutMs: 5_000,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure?.message).toContain("prerequisite exited with code 7");
    expect(failure?.destructiveBoundaryCrossed).toBe(false);
    expect(failure?.restartRequestId).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
      descriptor.launch,
    );
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toEqual([
      String(descriptor.launch.pid),
    ]);
    expect(initialPreparations).toBe(1);
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("keeps the exact app and supervisor-owned frontend when candidate preparation fails", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "frontend-preparation.mjs");
    const frontendScript = join(fixtureRoot, "frontend.mjs");
    const childScript = join(fixtureRoot, "frontend-child.mjs");
    const preparationsFile = join(fixtureRoot, "frontend-preparations.txt");
    const frontendsFile = join(fixtureRoot, "frontends.txt");
    const launchesFile = join(fixtureRoot, "frontend-launches.txt");
    const stopFile = join(fixtureRoot, "stop-frontend-fixture");
    const channel = "dev-supervisor-frontend-failure-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
process.exit(count === 1 ? 0 : 7);
`,
      { mode: 0o600 },
    );
    writeFileSync(
      frontendScript,
      `import { appendFileSync } from "node:fs";
const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
${processGroupWitnessReadySource("process.argv[3]", "generation")}
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.send({
  schemaVersion: 1,
  protocolVersion: 1,
  type: "frontend_ready",
  channel: process.argv[3],
  generation,
});
process.once("message", async (message) => {
  await groupWitness.retain();
  process.send({
    schemaVersion: 1,
    type: "frontend_activated",
    channel: process.argv[3],
    generation: message.generation,
  });
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    writeFileSync(
      childScript,
      `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.on("SIGTERM", () => process.exit(0));
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 20);
`,
      { mode: 0o600 },
    );
    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile, stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      frontend: {
        command: process.execPath,
        args: [frontendScript, frontendsFile, channel],
        spawnOptions: {
          cwd: fixtureRoot,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
        probe: async (identity) =>
          processIdentity(identity.pid) === identity.processIdentity,
      },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const supervised = fixture.outcome;
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );

    try {
      const descriptor = await waitFor(() => {
        try {
          const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
          return value.state === "ready" ? value : null;
        } catch {
          return null;
        }
      });
      expect(descriptor.frontend).toMatchObject({
        pid: expect.any(Number),
        processIdentity: expect.any(String),
        generation: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(processIdentity(descriptor.frontend.pid)).toBe(
        descriptor.frontend.processIdentity,
      );

      await expect(
        requestDevLaunchRestart({
          home: fixtureHome,
          root: worktreeRoot,
          channel,
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({
        message: expect.stringContaining("prerequisite exited with code 7"),
        destructiveBoundaryCrossed: false,
      });

      const preserved = JSON.parse(readFileSync(descriptorPath, "utf8"));
      expect(preserved.launch).toEqual(descriptor.launch);
      expect(preserved.frontend).toEqual(descriptor.frontend);
      expect(processIdentity(preserved.launch.pid)).toBe(
        preserved.launch.processIdentity,
      );
      expect(processIdentity(preserved.frontend.pid)).toBe(
        preserved.frontend.processIdentity,
      );
      expect(readFileSync(frontendsFile, "utf8").trim().split("\n")).toEqual([
        String(descriptor.frontend.pid),
      ]);
    } finally {
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await supervised;
    }
  });

  it("waits for the exact restart receipt while admitted preparation continues", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "slow-restart-preparation.mjs");
    const childScript = join(fixtureRoot, "slow-restart-child.mjs");
    const preparationsFile = join(fixtureRoot, "slow-preparations.txt");
    const launchesFile = join(fixtureRoot, "slow-launches.txt");
    const preparationReleaseFile = join(
      fixtureRoot,
      "slow-preparation-release",
    );
    const stopFile = join(fixtureRoot, "slow-launch-stop");
    const channel = "dev-supervisor-slow-preparation-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 20);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile, preparationReleaseFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile, preparationReleaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });

    let requestSettled = false;
    const resultPromise = requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 25,
    }).then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    ).then((result) => {
      requestSettled = true;
      return result;
    });
    await waitFor(
      () =>
        readFileSync(preparationsFile, "utf8").trim().split("\n").length === 2,
    );
    expect(requestSettled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestSettled).toBe(false);
    writeFileSync(preparationReleaseFile, "release\n", { mode: 0o600 });
    const result = await resultPromise;
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    const supervisedOutcome = await supervised;

    expect(result.error).toBeUndefined();
    expect(result.receipt?.previousLaunch).toEqual(descriptor.launch);
    expect(result.receipt?.launch.generation).not.toBe(
      descriptor.launch.generation,
    );
    expect(supervisedOutcome).toEqual({ code: 0, signal: null });
  });

  it("terminalizes an admitted restart when its owned preparation never exits", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "bounded-preparation.mjs");
    const childScript = join(fixtureRoot, "bounded-child.mjs");
    const preparationsFile = join(fixtureRoot, "bounded-preparations.txt");
    const preparationPidFile = join(fixtureRoot, "bounded-preparation-pid.txt");
    const preparationMemberPidFile = join(
      fixtureRoot,
      "bounded-preparation-member-pid.txt",
    );
    const launchesFile = join(fixtureRoot, "bounded-launches.txt");
    const releaseFile = join(fixtureRoot, "bounded-release");
    const stopFile = join(fixtureRoot, "bounded-stop");
    const channel = "dev-supervisor-bounded-preparation-1234567890";
    writeFileSync(
      preparationScript,
      `import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
writeFileSync(process.argv[3], String(process.pid));
const member = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" },
);
await new Promise((resolve, reject) => {
  member.once("spawn", resolve);
  member.once("error", reject);
});
writeFileSync(process.argv[4], String(member.pid));
process.once("SIGTERM", () => process.exit(0));
const timer = setInterval(() => {
  if (!existsSync(process.argv[5])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeFileSync(
      childScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
process.once("SIGTERM", () => process.exit(0));
if (count > 1) setTimeout(() => process.exit(0), 100);
else {
  const timer = setInterval(() => {
    if (!existsSync(process.argv[3])) return;
    clearInterval(timer);
    process.exit(0);
  }, 10);
}
`,
      { mode: 0o600 },
    );

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile, stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [
          preparationScript,
          preparationsFile,
          preparationPidFile,
          preparationMemberPidFile,
          releaseFile,
        ],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
      restartSettlementTimeoutMs: 100,
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    const restart = requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 50,
      settlementTimeoutMs: FIXTURE_LIFECYCLE_TIMEOUT_MS + 7_000,
    });
    const preparationMemberPid = await waitFor(() => {
      if (!existsSync(preparationMemberPidFile)) return null;
      const pid = Number(readFileSync(preparationMemberPidFile, "utf8"));
      return processIdentity(pid) ? pid : null;
    });
    fixtureProcesses.registerIdentity({
      pid: preparationMemberPid,
      processIdentity: processIdentity(preparationMemberPid),
    });

    let observationTimeout;
    try {
      const result = await Promise.race([
        restart.then(
          (receipt) => ({ receipt }),
          (error) => ({ error }),
        ),
        new Promise((resolve) =>
          observationTimeout = setTimeout(
            () => resolve({ observationTimedOut: true }),
            FIXTURE_LIFECYCLE_TIMEOUT_MS + 7_000,
          ),
        ),
      ]);
      expect(result.observationTimedOut).not.toBe(true);
      expect(result.receipt).toBeUndefined();
      expect(result.error).toMatchObject({
        message: expect.stringContaining("settlement deadline expired"),
        restartRequestId: expect.stringMatching(/^[a-f0-9]{64}$/),
        destructiveBoundaryCrossed: false,
      });
      const preparationPid = Number(readFileSync(preparationPidFile, "utf8"));
      expect(processIdentity(preparationPid)).toBeNull();
      expect(processIdentity(preparationMemberPid)).toBeNull();
      expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
        descriptor.launch,
      );
      expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toEqual([
        String(descriptor.launch.pid),
      ]);
    } finally {
      clearTimeout(observationTimeout);
      writeFileSync(releaseFile, "release\n", { mode: 0o600 });
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await restart.catch(() => undefined);
      await supervised;
    }
  });

  it("keeps predecessor exit observable when restart settlement expires at retirement commit", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "commit-deadline-child.mjs");
    const launchesFile = join(fixtureRoot, "commit-deadline-launches.txt");
    const stopFile = join(fixtureRoot, "commit-deadline-stop");
    const channel = "dev-supervisor-commit-deadline-1234567890";
    const settlementTimeoutMs = 1_000;
    writeControlledExitScript(childScript, {
      onStart:
        'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
    });
    const previousSignalListeners = new Set(process.listeners("SIGTERM"));
    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      restartSettlementTimeoutMs: settlementTimeoutMs,
    });
    await fixture.observeDescriptor(
      (value) => value.state === "ready" && value,
    );
    const stopSupervisor = process
      .listeners("SIGTERM")
      .find((listener) => !previousSignalListeners.has(listener));
    const actualNow = Date.now.bind(Date);
    let deadlineChecks = 0;
    let clockOffsetMs = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => {
      const observed = actualNow() + clockOffsetMs;
      if (
        new Error().stack?.includes("requireRestartSettlementDeadline")
      ) {
        deadlineChecks += 1;
        if (deadlineChecks === 2) {
          queueMicrotask(() => {
            clockOffsetMs = settlementTimeoutMs + 1;
          });
        }
      }
      return observed;
    });
    let restartResult;
    let exitObservation;
    try {
      restartResult = await requestDevLaunchRestart({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        timeoutMs: 250,
        settlementTimeoutMs: 5_000,
      }).then(
        (receipt) => ({ receipt }),
        (error) => ({ error }),
      );
      clock.mockRestore();
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      exitObservation = await Promise.race([
        fixture.outcome.then((outcome) => ({ outcome })),
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ observationTimedOut: true }),
            RESTART_STATUS_REQUEST_TIMEOUT_MS,
          ),
        ),
      ]);
      if (exitObservation.observationTimedOut) {
        stopSupervisor?.();
        await fixture.outcome;
      }
    } finally {
      clock.mockRestore();
      if (!exitObservation?.outcome) stopSupervisor?.();
      await fixture.dispose();
    }

    expect(deadlineChecks).toBeGreaterThanOrEqual(3);
    expect(restartResult?.receipt).toBeUndefined();
    expect(restartResult?.error).toMatchObject({
      message: expect.stringContaining("settlement deadline expired"),
      destructiveBoundaryCrossed: false,
    });
    expect(exitObservation).toEqual({ outcome: { code: 0, signal: null } });
  });

  it("uses the admitted restart settlement clock while its response is flushing", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "admission-deadline-child.mjs");
    const stopFile = join(fixtureRoot, "admission-deadline-stop");
    const channel = "dev-supervisor-admission-deadline-1234567890";
    const settlementTimeoutMs = 100;
    writeControlledExitScript(childScript);
    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      restartSettlementTimeoutMs: settlementTimeoutMs,
    });
    const descriptor = await fixture.observeDescriptor(
      (value) => value.state === "ready" && value,
    );
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => actualNow() + clockOffsetMs);
    const socketEnd = Socket.prototype.end;
    let heldAdmission;
    let admissionObserved;
    const admissionHeld = new Promise((resolve) => {
      admissionObserved = resolve;
    });
    const end = vi
      .spyOn(Socket.prototype, "end")
      .mockImplementation(function (...values) {
        let frame;
        try {
          frame = JSON.parse(String(values[0]).trim());
        } catch {}
        if (
          !heldAdmission &&
          frame?.type === "restart_admitted" &&
          frame.channel === channel
        ) {
          heldAdmission = { socket: this, values, released: false };
          admissionObserved();
          return this;
        }
        return Reflect.apply(socketEnd, this, values);
      });
    const restart = requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 250,
      settlementTimeoutMs: 1_000,
    }).then(
      (receipt) => ({ receipt }),
      (error) => ({ error }),
    );
    let restartResult;
    let finalLaunch;
    try {
      await Promise.race([
        admissionHeld,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("restart admission was not observed")),
            RESTART_STATUS_REQUEST_TIMEOUT_MS,
          ),
        ),
      ]);
      await Promise.resolve();
      clockOffsetMs = settlementTimeoutMs + 1;
      Reflect.apply(socketEnd, heldAdmission.socket, heldAdmission.values);
      heldAdmission.released = true;
      restartResult = await restart;
      finalLaunch = JSON.parse(
        readFileSync(fixture.descriptorPath, "utf8"),
      ).launch;
    } finally {
      if (heldAdmission && !heldAdmission.released) {
        Reflect.apply(socketEnd, heldAdmission.socket, heldAdmission.values);
      }
      restartResult = await restart;
      end.mockRestore();
      clock.mockRestore();
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await fixture.outcome;
      await fixture.dispose();
    }

    expect(restartResult?.receipt).toBeUndefined();
    expect(restartResult?.error).toMatchObject({
      message: expect.stringContaining("settlement deadline expired"),
      destructiveBoundaryCrossed: false,
    });
    expect(finalLaunch).toEqual(descriptor.launch);
  });

  it("admits a restart before slow preparation and serves its status by request id", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "slow-preparation.mjs");
    const childScript = join(fixtureRoot, "slow-child.mjs");
    const preparationsFile = join(fixtureRoot, "preparations.txt");
    const launchesFile = join(fixtureRoot, "launches.txt");
    const releaseFile = join(fixtureRoot, "release");
    const retirementReleaseFile = join(fixtureRoot, "retirement-release");
    const stopFile = join(fixtureRoot, "slow-child-stop");
    const channel = "dev-supervisor-status-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart: `appendFileSync(process.argv[3], String(process.pid) + "\\n");
const launchCount = readFileSync(process.argv[3], "utf8").trim().split("\\n").length;`,
        onTerm: `if (launchCount > 1) process.exit(0);
const retirementTimer = setInterval(() => {
  if (!existsSync(process.argv[4])) return;
  clearInterval(retirementTimer);
  process.exit(0);
}, 20);`,
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile, retirementReleaseFile],
      fixtureReleasePaths: [stopFile, releaseFile, retirementReleaseFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile, releaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => {
      try {
        return readFileSync(launchesFile, "utf8").includes(
          `${descriptor.launch.pid}\n`,
        );
      } catch {
        return false;
      }
    });
    const requestId = "a".repeat(64);
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };

    try {
      const admission = await sendFrameFromExternalProcess(
        descriptor.socketPath,
        {
          ...authority,
          type: "restart",
          expectedLaunch: descriptor.launch,
        },
        250,
      );
      expect(admission).toMatchObject({
        type: "restart_admitted",
        requestId,
        previousLaunch: descriptor.launch,
      });
      await expect(
        sendFrame(descriptor.socketPath, {
          ...authority,
          type: "restart_status",
        }),
      ).resolves.toMatchObject({
        type: "restart_pending",
        requestId,
        phase: "preparing",
      });
    } finally {
      writeFileSync(releaseFile, "release\n", { mode: 0o600 });
    }

    await expect(
      waitForAsync(async () => {
        const status = await sendFrame(descriptor.socketPath, {
          ...authority,
          type: "restart_status",
        });
        return status.type === "restart_pending" && status.phase === "retiring"
          ? status
          : null;
      }),
    ).resolves.toMatchObject({ phase: "retiring" });
    writeFileSync(retirementReleaseFile, "release\n", { mode: 0o600 });

    const receipt = await waitForAsync(async () => {
      const status = await sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
      });
      return status.type === "restart_receipt" ? status : null;
    });
    expect(receipt).toMatchObject({
      requestId,
      previousLaunch: descriptor.launch,
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(
      acknowledgeRestart(descriptor.socketPath, authority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("recovers an admitted restart after its response connection resets", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "reset-preparation.mjs");
    const childScript = join(fixtureRoot, "reset-child.mjs");
    const preparationsFile = join(fixtureRoot, "reset-preparations.txt");
    const launchesFile = join(fixtureRoot, "reset-launches.txt");
    const releaseFile = join(fixtureRoot, "reset-release");
    const stopFile = join(fixtureRoot, "reset-stop");
    const channel = "dev-supervisor-reset-recovery-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );
    const fixture = startManagedLaunchFixture({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile, releaseFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile, releaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const supervised = fixture.outcome;
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    const requestId = "9".repeat(64);
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    const lostResponse = await sendFrameWithoutReading(descriptor.socketPath, {
      ...authority,
      type: "restart",
      expectedLaunch: descriptor.launch,
    });
    lostResponse.destroy();
    await waitFor(() => {
      try {
        return readFileSync(preparationsFile, "utf8") === "prepare\nprepare\n";
      } catch {
        return false;
      }
    });
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
      }),
    ).resolves.toMatchObject({
      type: "restart_pending",
      requestId,
      phase: "preparing",
    });
    writeFileSync(releaseFile, "release\n", { mode: 0o600 });
    await fixture.observeDescriptor((value) =>
      value.state === "ready" &&
        value.launch.generation !== descriptor.launch.generation
        ? value
        : null
    );

    const recovered = await sendFrame(descriptor.socketPath, {
      ...authority,
      type: "restart_status",
    });
    expect(recovered).toMatchObject({
      type: "restart_receipt",
      requestId,
      previousLaunch: descriptor.launch,
    });
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart",
        expectedLaunch: descriptor.launch,
      }),
    ).resolves.toEqual(recovered);
    await expect(
      acknowledgeRestart(descriptor.socketPath, authority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    const launches = await fixture.observeFile(
      launchesFile,
      (contents) => {
        const entries = contents.trim().split("\n");
        return entries.length === 2 ? entries : null;
      },
    );
    expect(launches).toHaveLength(2);
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("retains transaction truth when the predecessor exits during preparation", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "predecessor-preparation.mjs");
    const childScript = join(fixtureRoot, "predecessor-child.mjs");
    const preparationsFile = join(fixtureRoot, "predecessor-preparations.txt");
    const launchesFile = join(fixtureRoot, "predecessor-launches.txt");
    const exitFile = join(fixtureRoot, "predecessor-exited");
    const exitTriggerFile = join(fixtureRoot, "predecessor-exit-trigger");
    const releaseFile = join(fixtureRoot, "predecessor-release");
    const channel = "dev-supervisor-predecessor-exit-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count === 1) process.exit(0);
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
        onExit: 'writeFileSync(process.argv[4], "exited\\n");',
        exitCode: 7,
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, exitTriggerFile, launchesFile, exitFile],
      fixtureReleasePaths: [exitTriggerFile, releaseFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile, releaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => readFileSync(launchesFile, "utf8").length > 0);
    const requestId = "7".repeat(64);
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart",
        expectedLaunch: descriptor.launch,
      }),
    ).resolves.toMatchObject({ type: "restart_admitted", requestId });
    await waitFor(() => {
      try {
        return readFileSync(preparationsFile, "utf8") === "prepare\nprepare\n";
      } catch {
        return false;
      }
    });
    writeFileSync(exitTriggerFile, "exit\n", { mode: 0o600 });
    await waitFor(() => existsSync(exitFile));
    expect(existsSync(descriptorPath)).toBe(true);
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
      }),
    ).resolves.toMatchObject({ type: "restart_pending", phase: "preparing" });
    writeFileSync(releaseFile, "release\n", { mode: 0o600 });

    const rejection = await waitForAsync(async () => {
      const status = await sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
      });
      return status.type === "restart_rejected" ? status : null;
    });
    expect(rejection).toMatchObject({
      requestId,
      destructiveBoundaryCrossed: false,
    });
    await expect(
      acknowledgeRestart(descriptor.socketPath, authority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    await expect(supervised).resolves.toEqual({ code: 7, signal: null });
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(
      1,
    );
  });

  it("keeps authority when a successor exits during the next preparation", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const preparationScript = join(fixtureRoot, "successor-exit-preparation.mjs");
    const childScript = join(fixtureRoot, "successor-exit-child.mjs");
    const preparationsFile = join(fixtureRoot, "successor-exit-preparations.txt");
    const launchesFile = join(fixtureRoot, "successor-exit-launches.txt");
    const exitFile = join(fixtureRoot, "successor-exited");
    const exitTriggerFile = join(fixtureRoot, "successor-exit-trigger");
    const releaseFile = join(fixtureRoot, "successor-exit-release");
    const channel = "dev-supervisor-successor-exit-1234567890";
    writeFileSync(
      preparationScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count <= 2) process.exit(0);
const timer = setInterval(() => {
  if (!existsSync(process.argv[3])) return;
  clearInterval(timer);
  process.exit(0);
}, 10);
`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
        onExit: 'writeFileSync(process.argv[4], "exited\\n");',
        exitCode: 7,
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, exitTriggerFile, launchesFile, exitFile],
      fixtureReleasePaths: [exitTriggerFile, releaseFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      prepareLaunch: {
        command: process.execPath,
        args: [preparationScript, preparationsFile, releaseFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    await waitFor(() => {
      try {
        return JSON.parse(readFileSync(descriptorPath, "utf8")).state === "ready";
      } catch {
        return false;
      }
    });
    const firstReceipt = await requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 2_000,
    });
    const descriptor = await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
          value.launch.generation === firstReceipt.launch.generation
        ? value
        : null;
    });
    const requestId = "d".repeat(64);
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart",
        expectedLaunch: descriptor.launch,
      }),
    ).resolves.toMatchObject({ type: "restart_admitted", requestId });
    await waitFor(
      () => readFileSync(preparationsFile, "utf8").trim().split("\n").length === 3,
    );
    writeFileSync(exitTriggerFile, "exit\n", { mode: 0o600 });
    await waitFor(() => existsSync(exitFile));
    await expect(
      sendFrame(
        descriptor.socketPath,
        { ...authority, type: "restart_status" },
        { timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS },
      ),
    ).resolves.toMatchObject({
      type: "restart_pending",
      requestId,
      phase: "preparing",
    });
    expect(existsSync(descriptorPath)).toBe(true);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
      firstReceipt.launch,
    );
    writeFileSync(releaseFile, "release\n", { mode: 0o600 });

    const failure = await waitForAsync(
      async () => {
        const status = await sendFrame(
          descriptor.socketPath,
          { ...authority, type: "restart_status" },
          { timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS },
        );
        return status.type === "restart_rejected" ? status : null;
      },
      FIXTURE_LIFECYCLE_TIMEOUT_MS,
    );
    expect(failure).toMatchObject({
      type: "restart_rejected",
      requestId,
      destructiveBoundaryCrossed: false,
    });
    await expect(
      acknowledgeRestart(descriptor.socketPath, authority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    await expect(supervised).resolves.toEqual({ code: 7, signal: null });
    expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(
      2,
    );
  });

  it.runIf(process.platform !== "win32")(
    "uses the active legacy supervisor as the one-shot authority",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-legacy-active-1234567890";
      const fixture = await startFixtureSupervisor({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        protocolVersion: null,
        onRequest({ request, connection, supervisor, launch, replacement }) {
          connection.end(
            `${JSON.stringify({
              schemaVersion: 1,
              type: "restart_receipt",
              requestId: request.requestId,
              worktreeRoot,
              channel,
              supervisor,
              previousLaunch: launch,
              launch: replacement,
              restartedAtMs: Date.now(),
            })}\n`,
          );
        },
      });

      try {
        await expect(
          requestDevLaunchRestart({
            home: fixtureHome,
            root: worktreeRoot,
            channel,
            timeoutMs: 2_000,
          }),
        ).resolves.toMatchObject({
          previousLaunch: fixture.launch,
          launch: fixture.replacement,
        });
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.requests[0]).not.toHaveProperty("protocolVersion");
        expect(fixture.requests[0].type).toBe("restart");
      } finally {
        await fixture.close();
      }
    },
  );

  it("reclaims a stale descriptor written by the legacy supervisor", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "legacy-reclaim-child.mjs");
    const launchesFile = join(fixtureRoot, "legacy-reclaim-launches.txt");
    const stopFile = join(fixtureRoot, "legacy-reclaim-stop");
    const channel = "dev-supervisor-legacy-stale-1234567890";
    const controlDirectory = appControlDirectory(fixtureHome, channel);
    const descriptorPath = join(
      controlDirectory,
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
    chmodSync(controlDirectory, 0o700);
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: "ready",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "missing-legacy.sock"),
        capability: "e".repeat(64),
        supervisor: {
          pid: 2_000_000_001,
          processIdentity: "stale-supervisor",
          generation: "f".repeat(64),
        },
        launch: {
          pid: 2_000_000_002,
          processIdentity: "stale-launch",
          generation: "1".repeat(64),
        },
      })}\n`,
      { mode: 0o600 },
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
          value.launch?.processIdentity !== "stale-launch"
        ? value
        : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
    expect(readFileSync(launchesFile, "utf8").trim()).toMatch(/^\d+$/);
  });

  it.runIf(process.platform !== "win32")(
    "reconciles a reset admission through the client status path",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-client-reset-1234567890";
      let admittedRequest;
      const fixture = await startFixtureSupervisor({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        onRequest({ request, connection, supervisor, launch, replacement }) {
          if (request.type === "restart") {
            admittedRequest = request;
            connection.destroy();
            return;
          }
          if (request.type === "restart_ack") {
            connection.end(
              `${JSON.stringify({
                schemaVersion: 1,
                protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                type: "restart_acknowledged",
                requestId: request.requestId,
                worktreeRoot,
                channel,
                supervisor,
              })}\n`,
            );
            return;
          }
          connection.end(
            `${JSON.stringify({
              schemaVersion: 1,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              type: "restart_receipt",
              requestId: admittedRequest.requestId,
              worktreeRoot,
              channel,
              supervisor,
              previousLaunch: launch,
              launch: replacement,
              restartedAtMs: Date.now(),
            })}\n`,
          );
        },
      });

      try {
        await expect(
          requestDevLaunchRestart({
            home: fixtureHome,
            root: worktreeRoot,
            channel,
            timeoutMs: 2_000,
          }),
        ).resolves.toMatchObject({
          requestId: expect.stringMatching(/^[a-f0-9]{64}$/),
          previousLaunch: fixture.launch,
          launch: fixture.replacement,
        });
        expect(fixture.requests.map(({ type }) => type)).toEqual([
          "restart",
          "restart_status",
          "restart_ack",
        ]);
        expect(fixture.requests[1].requestId).toBe(
          fixture.requests[0].requestId,
        );
      } finally {
        await fixture.close();
      }
    },
  );

  it("bounds a silent v2 status response", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-silent-status-1234567890";
    const openConnections = new Set();
    let shuttingDown = false;
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      onRequest({ request, connection, supervisor, launch }) {
        if (request.type === "restart") {
          connection.end(
            `${JSON.stringify({
              schemaVersion: 1,
              protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
              type: "restart_admitted",
              requestId: request.requestId,
              worktreeRoot,
              channel,
              supervisor,
              previousLaunch: launch,
            })}\n`,
          );
          return;
        }
        if (shuttingDown) {
          connection.destroy();
          return;
        }
        openConnections.add(connection);
        connection.once("close", () => openConnections.delete(connection));
      },
    });
    const restart = requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 50,
    });

    try {
      const result = await Promise.race([
        restart.then(
          (receipt) => ({ receipt }),
          (error) => ({ error }),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve({ timedOut: true }), 750),
        ),
      ]);
      expect(result.timedOut).not.toBe(true);
      expect(result.error?.message).toContain("lost its authority");
      expect(result.error?.restartRequestId).toMatch(/^[a-f0-9]{64}$/);
      expect(result.error?.destructiveBoundaryCrossed).toBeNull();
    } finally {
      shuttingDown = true;
      for (const connection of openConnections) connection.destroy();
      await fixture.close();
      await restart.catch(() => undefined);
    }
  });

  it("bounds a v2 transaction that keeps reporting pending", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const channel = "dev-supervisor-pending-deadline-1234567890";
    const fixture = await startFixtureSupervisor({
      fixtureRoot,
      fixtureHome,
      worktreeRoot,
      channel,
      onRequest({ request, connection, supervisor, launch }) {
        connection.end(
          `${JSON.stringify(
            request.type === "restart"
              ? {
                  schemaVersion: 1,
                  protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                  type: "restart_admitted",
                  requestId: request.requestId,
                  worktreeRoot,
                  channel,
                  supervisor,
                  previousLaunch: launch,
                }
              : {
                  schemaVersion: 1,
                  protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                  type: "restart_pending",
                  requestId: request.requestId,
                  worktreeRoot,
                  channel,
                  supervisor,
                  previousLaunch: launch,
                  phase: "preparing",
                },
          )}\n`,
        );
      },
    });
    const restart = requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 50,
      settlementTimeoutMs: 100,
    });

    try {
      const result = await Promise.race([
        restart.then(
          (receipt) => ({ receipt }),
          (error) => ({ error }),
        ),
        new Promise((resolve) =>
          setTimeout(() => resolve({ observationTimedOut: true }), 750),
        ),
      ]);
      expect(result.observationTimedOut).not.toBe(true);
      expect(result.error?.message).toContain(
        "settlement deadline expired without a terminal status",
      );
      expect(result.error?.restartRequestId).toBe(
        fixture.requests[0].requestId,
      );
      expect(result.error?.destructiveBoundaryCrossed).toBeNull();
      expect(
        fixture.requests.filter(({ type }) => type === "restart"),
      ).toHaveLength(1);
      expect(
        fixture.requests.filter(({ type }) => type === "restart_status")
          .length,
      ).toBeGreaterThan(0);
    } finally {
      await fixture.close();
      await restart.catch(() => undefined);
    }
  });

  it(
    "stops recovery when the exact live supervisor loses its endpoint",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-endpoint-loss-1234567890";
      let fixture;
      fixture = await startFixtureSupervisor({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        onRequest({ connection }) {
          connection.destroy();
          void fixture.close();
        },
      });

      try {
        let failure;
        try {
          await requestDevLaunchRestart({
            home: fixtureHome,
            root: worktreeRoot,
            channel,
            timeoutMs: 250,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure?.message).toContain("lost its authority");
        expect(failure?.restartRequestId).toMatch(/^[a-f0-9]{64}$/);
        expect(failure?.destructiveBoundaryCrossed).toBeNull();
      } finally {
        await fixture.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves request and retirement evidence for a malformed terminal response",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-malformed-terminal-1234567890";
      let statusCount = 0;
      const fixture = await startFixtureSupervisor({
        fixtureRoot,
        fixtureHome,
        worktreeRoot,
        channel,
        onRequest({ request, connection, supervisor, launch }) {
          if (request.type === "restart") {
            connection.end(
              `${JSON.stringify({
                schemaVersion: 1,
                protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                type: "restart_admitted",
                requestId: request.requestId,
                worktreeRoot,
                channel,
                supervisor,
                previousLaunch: launch,
              })}\n`,
            );
            return;
          }
          statusCount += 1;
          connection.end(
            `${JSON.stringify(
              statusCount === 1
                ? {
                    schemaVersion: 1,
                    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                    type: "restart_pending",
                    requestId: request.requestId,
                    worktreeRoot,
                    channel,
                    supervisor,
                    previousLaunch: launch,
                    phase: "retiring",
                  }
                : {
                    schemaVersion: 1,
                    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
                    type: "restart_receipt",
                    requestId: "f".repeat(64),
                  },
            )}\n`,
          );
        },
      });

      try {
        let failure;
        try {
          await requestDevLaunchRestart({
            home: fixtureHome,
            root: worktreeRoot,
            channel,
            timeoutMs: 2_000,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure?.message).toContain(
          "receipt identity does not match request",
        );
        expect(failure?.restartRequestId).toBe(fixture.requests[0].requestId);
        expect(failure?.destructiveBoundaryCrossed).toBe(true);
      } finally {
        await fixture.close();
      }
    },
  );

  it("makes each replacement the restartable current generation", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "successor-child.mjs");
    const launchesFile = join(fixtureRoot, "successor-launches.txt");
    const stopFile = join(fixtureRoot, "successor-stop");
    const channel = "dev-supervisor-successor-chain-1234567890";
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const first = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => {
      try {
        return readFileSync(launchesFile, "utf8").includes(
          `${first.launch.pid}\n`,
        );
      } catch {
        return false;
      }
    });

    const firstReceipt = await requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 5_000,
    });
    const secondReceipt = await requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 5_000,
    });

    expect(firstReceipt.previousLaunch).toEqual(first.launch);
    expect(secondReceipt.previousLaunch).toEqual(firstReceipt.launch);
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
      secondReceipt.launch,
    );
    expect(
      new Set([
        first.launch.generation,
        firstReceipt.launch.generation,
        secondReceipt.launch.generation,
      ]).size,
    ).toBe(3);
    await waitFor(
      () =>
        readFileSync(launchesFile, "utf8").trim().split("\n").length === 3,
    );
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("retains only the bounded newest restart transactions", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "bounded-child.mjs");
    const launchesFile = join(fixtureRoot, "bounded-launches.txt");
    const channel = "dev-supervisor-bounded-transactions-1234567890";
    writeFileSync(
      childScript,
      `import { appendFileSync } from "node:fs";
process.on("SIGTERM", () => process.exit(0));
appendFileSync(process.argv[2], String(process.pid) + "\\n");
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(
          readFileSync(
            join(
              appControlDirectory(fixtureHome, channel),
              DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
            ),
            "utf8",
          ),
        );
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => {
      try {
        return readFileSync(launchesFile, "utf8").includes(
          `${descriptor.launch.pid}\n`,
        );
      } catch {
        return false;
      }
    });
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    const requestIds = [];
    let expectedLaunch = descriptor.launch;

    for (let index = 0; index < 17; index += 1) {
      const requestId = (index + 1).toString(16).padStart(64, "0");
      requestIds.push(requestId);
      await expect(
        sendFrame(descriptor.socketPath, {
          ...authority,
          type: "restart",
          requestId,
          expectedLaunch,
        }),
      ).resolves.toMatchObject({ type: "restart_admitted", requestId });
      const receipt = await waitForAsync(async () => {
        const status = await sendFrame(descriptor.socketPath, {
          ...authority,
          type: "restart_status",
          requestId,
        });
        return status.type === "restart_receipt" ? status : null;
      });
      await expect(
        acknowledgeRestart(descriptor.socketPath, authority, requestId),
      ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
      expectedLaunch = receipt.launch;
    }

    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
        requestId: requestIds[0],
      }),
    ).resolves.toMatchObject({
      type: "restart_rejected",
      reason: "dev launch restart transaction is unavailable",
    });
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_status",
        requestId: requestIds.at(-1),
      }),
    ).resolves.toMatchObject({
      type: "restart_receipt",
      requestId: requestIds.at(-1),
    });
    await waitFor(() =>
      readFileSync(launchesFile, "utf8").includes(`${expectedLaunch.pid}\n`),
    );
    process.kill(
      process.platform === "win32" ? expectedLaunch.pid : -expectedLaunch.pid,
      "SIGTERM",
    );
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("keeps a receipt observable when the replacement exits before status polling", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "immediate-child.mjs");
    const launchesFile = join(fixtureRoot, "immediate-launches.txt");
    const stopFile = join(fixtureRoot, "immediate-child-stop");
    const channel = "dev-supervisor-immediate-exit-1234567890";
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(
          readFileSync(descriptorPath, "utf8"),
        );
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => {
      try {
        return readFileSync(launchesFile, "utf8").includes(
          `${descriptor.launch.pid}\n`,
        );
      } catch {
        return false;
      }
    });

    const requestId = "9".repeat(64);
    const authority = {
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart",
        expectedLaunch: descriptor.launch,
      }),
    ).resolves.toMatchObject({ type: "restart_admitted", requestId });
    await waitFor(
      () => readFileSync(launchesFile, "utf8").trim().split("\n").length === 2,
    );
    const replacement = await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
          value.launch.generation !== descriptor.launch.generation
        ? value.launch
        : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await waitFor(() => processIdentity(replacement.pid) === null);
    const receipt = await sendFrame(descriptor.socketPath, {
      ...authority,
      type: "restart_status",
    });
    expect(receipt).toMatchObject({ type: "restart_receipt", requestId });
    await expect(
      acknowledgeRestart(descriptor.socketPath, authority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("keeps terminal truth through the permitted recovery delay", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "terminal-reset-child.mjs");
    const launchesFile = join(fixtureRoot, "terminal-reset-launches.txt");
    const stopFile = join(fixtureRoot, "terminal-reset-stop");
    const channel = "dev-supervisor-terminal-reset-1234567890";
    writeFileSync(
      childScript,
      `import { appendFileSync, existsSync, readFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
process.on("SIGTERM", () => process.exit(0));
if (count === 1) setInterval(() => {}, 1_000);
else {
  const timer = setInterval(() => {
    if (!existsSync(process.argv[3])) return;
    clearInterval(timer);
    process.exit(0);
  }, 20);
}
`,
      { mode: 0o600 },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, launchesFile, stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() =>
      readFileSync(launchesFile, "utf8").includes(
        `${descriptor.launch.pid}\n`,
      ),
    );
    const requestId = "6".repeat(64);
    const authority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
    };
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart",
        expectedLaunch: descriptor.launch,
      }),
    ).resolves.toMatchObject({ type: "restart_admitted", requestId });
    await waitFor(
      () => readFileSync(launchesFile, "utf8").trim().split("\n").length === 2,
    );
    const replacement = await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
          value.launch.generation !== descriptor.launch.generation
        ? value.launch
        : null;
    });
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    await waitFor(() => processIdentity(replacement.pid) === null);
    const lostStatus = await sendFrameWithoutReading(descriptor.socketPath, {
      ...authority,
      type: "restart_status",
    });
    lostStatus.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const receipt = await sendFrame(descriptor.socketPath, {
      ...authority,
      type: "restart_status",
    });
    expect(receipt).toMatchObject({
      type: "restart_receipt",
      requestId,
      previousLaunch: descriptor.launch,
    });
    await expect(
      sendFrame(descriptor.socketPath, {
        ...authority,
        type: "restart_ack",
      }),
    ).resolves.toMatchObject({
      type: "restart_acknowledged",
      requestId,
    });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it("does not exec away an unobserved child restart receipt", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "receipt-fence-child.mjs");
    const launchesFile = join(fixtureRoot, "receipt-fence-launches.txt");
    const recoveryMarker = join(fixtureRoot, "receipt-fence-recovery");
    const recoveryStopMarker = join(
      fixtureRoot,
      "receipt-fence-recovery-stop",
    );
    const channel = "dev-supervisor-receipt-fence-1234567890";
    const sourceGeneration = "7".repeat(64);
    writeFileSync(
      childScript,
      `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.on("SIGTERM", () => process.exit(0));
if (existsSync(process.argv[3])) {
  const timer = setInterval(() => {
    if (!existsSync(process.argv[4])) return;
    clearInterval(timer);
    process.exit(0);
  }, 20);
} else {
  setInterval(() => {}, 1_000);
}
`,
      { mode: 0o600 },
    );
    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [
        childScript,
        launchesFile,
        recoveryMarker,
        recoveryStopMarker,
      ],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      sourceGeneration,
      preflightParent: async () => {},
      reloadParent: () => {
        writeFileSync(recoveryMarker, "recover\n");
        throw new Error("fixture execve failed");
      },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const predecessor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() =>
      existsSync(launchesFile) &&
      readFileSync(launchesFile, "utf8").includes(`${predecessor.launch.pid}\n`)
        ? true
        : null,
    );
    const requestId = "8".repeat(64);
    const restartAuthority = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      requestId,
      worktreeRoot,
      channel,
      capability: predecessor.capability,
      supervisor: predecessor.supervisor,
    };
    await expect(
      sendFrame(predecessor.socketPath, {
        ...restartAuthority,
        type: "restart",
        expectedLaunch: predecessor.launch,
      }),
    ).resolves.toMatchObject({ type: "restart_admitted", requestId });
    const replacement = await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
        value.launch.generation !== predecessor.launch.generation
        ? value
        : null;
    });
    await expect(
      sendFrame(replacement.socketPath, {
        ...restartAuthority,
        type: "restart_status",
      }),
    ).resolves.toMatchObject({ type: "restart_receipt", requestId });

    const parentRequest = {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      type: "parent_reload",
      requestId: "9".repeat(64),
      worktreeRoot,
      channel,
      capability: replacement.capability,
      expectedSupervisor: replacement.supervisor,
      expectedLaunch: replacement.launch,
      targetSupervisorGeneration: "a".repeat(64),
      targetSourceGeneration: "b".repeat(64),
    };
    await expect(
      sendFrame(replacement.socketPath, parentRequest),
    ).resolves.toMatchObject({
      type: "parent_reload_rejected",
      reason: "dev launch supervisor is busy",
      destructiveBoundaryCrossed: false,
    });
    await expect(
      acknowledgeRestart(replacement.socketPath, restartAuthority),
    ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
    let parentFailure;
    try {
      await requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: "b".repeat(64),
        timeoutMs: RESTART_STATUS_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      parentFailure = error;
    }
    expect(parentFailure).toMatchObject({ destructiveBoundaryCrossed: true });
    expect(parentFailure?.message).toContain("fixture execve failed");
    const recoveredDescriptor = await waitFor(() => {
      const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
      return value.state === "ready" &&
          value.parentReloadFailure?.recoveredLaunch
        ? value
        : null;
    });
    expect(recoveredDescriptor).toMatchObject({
      state: "ready",
      parentReloadFailure: { recoveredLaunch: recoveredDescriptor.launch },
    });
    expect(recoveredDescriptor.launch.generation).not.toBe(
      replacement.launch.generation,
    );
    await waitForFileContent(
      launchesFile,
      (content) => content.includes(`${recoveredDescriptor.launch.pid}\n`),
      FIXTURE_LIFECYCLE_TIMEOUT_MS,
    );
    expect(readFileSync(launchesFile, "utf8")).toContain(
      `${recoveredDescriptor.launch.pid}\n`,
    );
    expect(readFileSync(launchesFile, "utf8")).toContain(
      `${predecessor.launch.pid}\n`,
    );
    writeFileSync(recoveryStopMarker, "stop\n", { mode: 0o600 });
    await expect(supervised).resolves.toEqual({ code: 0, signal: null });
  });

  it.runIf(process.platform !== "win32")(
    "retains destructive handoff truth when rollback supervisor crashes",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const appScript = join(fixtureRoot, "rollback-crash-app.mjs");
      const frontendScript = join(
        fixtureRoot,
        "rollback-crash-frontend.mjs",
      );
      const driverScript = join(fixtureRoot, "rollback-crash-driver.mjs");
      const rollbackMarker = join(fixtureRoot, "rollback-candidate-published");
      const channel = "dev-supervisor-rollback-crash-1234567890";
      const previousSource = "3".repeat(64);
      const targetSource = "4".repeat(64);
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      const descriptorPath = join(
        controlDirectory,
        DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
      );
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
      chmodSync(controlDirectory, 0o700);
      writeFileSync(
        appScript,
        `process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        { mode: 0o600 },
      );
      writeFileSync(
        frontendScript,
        `const generation = process.env.DURE_DEV_FRONTEND_GENERATION;
const channel = process.argv[2];
${processGroupWitnessReadySource("channel", "generation")}
process.send({ schemaVersion: 1, protocolVersion: 1, type: "frontend_ready", channel, generation });
process.once("message", async () => {
  await groupWitness.retain();
  process.send({ schemaVersion: 1, type: "frontend_activated", channel, generation });
});
process.once("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        { mode: 0o600 },
      );
      writeFileSync(
        driverScript,
        `import { writeFileSync } from "node:fs";
import { processIdentity } from ${JSON.stringify(new URL("./process-identity.mjs", import.meta.url).href)};
import { superviseDevLaunch } from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};

const [fixtureRoot, fixtureHome, worktreeRoot, channel, appScript, frontendScript, rollbackMarker, sourceGeneration] = process.argv.slice(2);
let rollingBack = false;
await superviseDevLaunch({
  home: fixtureHome,
  worktreeRoot,
  channel,
  command: process.execPath,
  args: [appScript],
  spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
  frontend: {
    command: process.execPath,
    args: [frontendScript, channel],
    spawnOptions: {
      cwd: fixtureRoot,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
    probe: async (identity) => {
      if (rollingBack) {
        writeFileSync(rollbackMarker, "published\\n");
        return await new Promise(() => {});
      }
      return processIdentity(identity.pid) === identity.processIdentity;
    },
  },
  sourceGeneration,
  preflightParent: async () => {},
  reloadParent: () => {
    rollingBack = true;
    throw new Error("fixture parent exec returned");
  },
});
`,
        { mode: 0o600 },
      );
      const driver = spawn(
        process.execPath,
        [
          driverScript,
          fixtureRoot,
          fixtureHome,
          worktreeRoot,
          channel,
          appScript,
          frontendScript,
          rollbackMarker,
          previousSource,
        ],
        { stdio: "ignore" },
      );
      fixtureProcesses.registerSpawn(driver);
      await new Promise((resolve, reject) => {
        driver.once("spawn", resolve);
        driver.once("error", reject);
      });
      const driverIdentity = processIdentity(driver.pid);
      expect(driverIdentity).toBeTruthy();
      const driverExited = new Promise((resolve) => driver.once("exit", resolve));
      fixtureProcesses.registerDescriptor(descriptorPath);
      const predecessor = await waitForJsonFile(
        descriptorPath,
        (value) => value.state === "ready" ? value : null,
        RESTART_STATUS_REQUEST_TIMEOUT_MS,
      );
      const reload = requestDevLaunchParentReload({
        home: fixtureHome,
        root: worktreeRoot,
        channel,
        sourceGeneration: targetSource,
        timeoutMs: 5_000,
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await waitForFileContent(
        rollbackMarker,
        (value) => value.trim() === "published",
        RESTART_STATUS_REQUEST_TIMEOUT_MS,
      );
      const rollback = await waitForJsonFile(
        descriptorPath,
        (value) =>
          value.state === "handoff" &&
            value.candidateLaunch &&
            value.parentReloadFailure?.destructiveBoundaryCrossed === true
            ? value
            : null,
        RESTART_STATUS_REQUEST_TIMEOUT_MS,
      );
      expect(processIdentity(driver.pid)).toBe(driverIdentity);
      process.kill(driver.pid, "SIGKILL");
      await driverExited;

      const { error: reloadFailure } = await reload;
      expect(reloadFailure).toMatchObject({
        destructiveBoundaryCrossed: true,
        parentReloadRequestId: rollback.handoff.requestId,
      });
      expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(
        rollback,
      );
      expect(rollback).toMatchObject({
        state: "handoff",
        launch: null,
        capabilities: expect.arrayContaining([
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ]),
        handoff: { previousLaunch: predecessor.launch },
        candidateLaunch: expect.objectContaining({
          processIdentity: expect.any(String),
          processGroup: expect.objectContaining({
            kind: "posix_process_group_v1",
          }),
        }),
        parentReloadFailure: {
          requestId: rollback.handoff.requestId,
          destructiveBoundaryCrossed: true,
        },
      });
      await waitFor(
        () => processIdentity(rollback.candidateLaunch.pid) === null,
      );
      await waitFor(
        () =>
          processIdentity(rollback.candidateLaunch.processGroup.witness.pid) ===
          null,
      );
      if (rollback.frontend) {
        await fixtureProcesses.retireIdentity(rollback.frontend);
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "retains an owned handoff candidate when a claimant crashes after projection",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-owned-handoff-1234567890";
      const candidate = await spawnRetainedGroupWithMember(
        fixtureRoot,
        "owned-handoff-candidate.mjs",
        "8".repeat(64),
      );
      candidate.child.send({ type: "exit" });
      await candidate.exited;
      await waitFor(() => processIdentity(candidate.identity.pid) === null);
      expect(processIdentity(candidate.ready.memberPid)).toBeTruthy();
      expect(await observeOwnedProcessGroup(candidate.identity)).toMatchObject({
        state: "owned",
        leaderCurrent: false,
        witnessCurrent: true,
      });

      const supervisor = {
        pid: 2_147_483_000,
        processIdentity: "stale-supervisor",
        generation: "1".repeat(64),
      };
      const previousLaunch = await spawnRetiredGroup(
        fixtureRoot,
        "retired-owned-handoff-launch.mjs",
        "2".repeat(64),
      );
      const capability = "3".repeat(64);
      const handoff = {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION,
        type: "parent_handoff",
        requestId: "4".repeat(64),
        worktreeRoot,
        channel,
        capability: redactDevLaunchCapability(capability),
        previousSupervisor: supervisor,
        previousLaunch,
        targetSupervisorGeneration: "5".repeat(64),
        targetSourceGeneration: "6".repeat(64),
        phase: "exec_pending",
        committedAtMs: Date.now(),
      };
      const descriptor = {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "handoff",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability,
        capabilities: [
          "child_restart",
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor,
        launch: null,
        candidateLaunch: candidate.identity,
        handoff,
        publishedAtMs: Date.now(),
      };
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      const descriptorPath = join(
        controlDirectory,
        DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
      );
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
      chmodSync(controlDirectory, 0o700);
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
        mode: 0o600,
      });
      fixtureProcesses.registerDescriptor(descriptorPath);

      try {
        let projectedClaimant;
        await expect(
          reclaimStaleDescriptor({
            home: fixtureHome,
            channel,
            worktreeRoot,
            publishClaimant: (claimant) => {
              projectedClaimant = claimant;
              throw new Error("fixture claimant crashed after projection");
            },
          }),
        ).rejects.toThrow(/claimant crashed after projection/);
        expect(projectedClaimant).toMatchObject({
          launch: null,
          candidateLaunch: candidate.identity,
        });
        expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(
          descriptor,
        );
        expect(await observeOwnedProcessGroup(candidate.identity)).toMatchObject({
          state: "owned",
          leaderCurrent: false,
          witnessCurrent: true,
        });
      } finally {
        await fixtureProcesses.retireIdentity(candidate.identity);
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "preserves an owned frontend when recovery lacks its readiness authority",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const channel = "dev-supervisor-owned-frontend-1234567890";
      const frontend = await spawnRetainedGroupWithMember(
        fixtureRoot,
        "owned-frontend.mjs",
        "8".repeat(64),
      );
      const retiredLaunch = await spawnRetainedGroupWithMember(
        fixtureRoot,
        "retired-owned-frontend-launch.mjs",
        "3".repeat(64),
      );
      await fixtureProcesses.retireIdentity(retiredLaunch.identity);
      frontend.child.send({ type: "exit" });
      await frontend.exited;
      await waitFor(() => processIdentity(frontend.identity.pid) === null);
      expect(await observeOwnedProcessGroup(frontend.identity)).toMatchObject({
        state: "owned",
        leaderCurrent: false,
        witnessCurrent: true,
      });

      const descriptor = {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "ready",
        worktreeRoot,
        channel,
        socketPath: join(fixtureRoot, "stale.sock"),
        capability: "1".repeat(64),
        capabilities: [
          "child_restart",
          DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY,
          DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
        ],
        supervisor: {
          pid: 2_147_483_000,
          processIdentity: "stale-supervisor",
          generation: "2".repeat(64),
        },
        launch: retiredLaunch.identity,
        frontend: frontend.identity,
        publishedAtMs: Date.now(),
      };
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      const descriptorPath = join(
        controlDirectory,
        DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
      );
      mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
      chmodSync(controlDirectory, 0o700);
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`, {
        mode: 0o600,
      });
      fixtureProcesses.registerDescriptor(descriptorPath);
      let published = false;

      try {
        await expect(
          reclaimStaleDescriptor({
            home: fixtureHome,
            channel,
            worktreeRoot,
            publishClaimant: () => {
              published = true;
              throw new Error("fixture claimant must not publish");
            },
          }),
        ).rejects.toThrow(/live frontend without a compatible readiness authority/);
        expect(published).toBe(false);
        expect(JSON.parse(readFileSync(descriptorPath, "utf8"))).toEqual(
          descriptor,
        );
        expect(await observeOwnedProcessGroup(frontend.identity)).toMatchObject({
          state: "owned",
          leaderCurrent: false,
          witnessCurrent: true,
        });
      } finally {
        await fixtureProcesses.retireIdentity(frontend.identity);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves the predecessor when replacement readiness fails",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const launcher = join(fixtureRoot, "replaceable-launcher");
      const preparationScript = join(fixtureRoot, "remove-launcher.mjs");
      const childScript = join(fixtureRoot, "post-retirement-child.mjs");
      const preparationsFile = join(fixtureRoot, "post-retirement-preparations.txt");
      const launchesFile = join(fixtureRoot, "post-retirement-launches.txt");
      const channel = "dev-supervisor-post-retirement-failure-1234567890";
      writeFileSync(
        childScript,
        `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        { mode: 0o600 },
      );
      writeFileSync(
        launcher,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(childScript)} ${JSON.stringify(launchesFile)}\n`,
        { mode: 0o700 },
      );
      chmodSync(launcher, 0o700);
      writeFileSync(
        preparationScript,
        `import { appendFileSync, readFileSync, unlinkSync } from "node:fs";
appendFileSync(process.argv[2], "prepare\\n");
const count = readFileSync(process.argv[2], "utf8").trim().split("\\n").length;
if (count > 1) unlinkSync(process.argv[3]);
`,
        { mode: 0o600 },
      );
      const supervised = superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: launcher,
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        prepareLaunch: {
          command: process.execPath,
          args: [preparationScript, preparationsFile, launcher],
          spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
        },
      });
      await waitFor(() => {
        try {
          return JSON.parse(
            readFileSync(
              join(
                appControlDirectory(fixtureHome, channel),
                DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
              ),
              "utf8",
            ),
          ).state === "ready";
        } catch {
          return false;
        }
      });
      await waitFor(
        () =>
          existsSync(launchesFile) &&
          readFileSync(launchesFile, "utf8").trim().split("\n").length === 1,
      );

      let failure;
      try {
        await requestDevLaunchRestart({
          home: fixtureHome,
          root: worktreeRoot,
          channel,
          timeoutMs: 5_000,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure?.destructiveBoundaryCrossed).toBe(false);
      expect(failure?.restartRequestId).toMatch(/^[a-f0-9]{64}$/);
      const descriptor = JSON.parse(
        readFileSync(
          join(
            appControlDirectory(fixtureHome, channel),
            DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
          ),
          "utf8",
        ),
      );
      expect(descriptor.state).toBe("ready");
      expect(processIdentity(descriptor.launch.pid)).toBe(
        descriptor.launch.processIdentity,
      );
      expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(
        1,
      );
      await fixtureProcesses.retireIdentity(descriptor.launch);
      await expect(supervised).resolves.toEqual({ code: 0, signal: null });
    },
  );

  it.runIf(process.platform !== "win32")(
    "retires an unpublished candidate while preserving its predecessor",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const childScript = join(fixtureRoot, "publish-failure-child.mjs");
      const launchesFile = join(fixtureRoot, "publish-failure-launches.txt");
      const stopFile = join(fixtureRoot, "publish-failure-stop");
      const channel = "dev-supervisor-publish-failure-1234567890";
      const controlDirectory = appControlDirectory(fixtureHome, channel);
      writeControlledExitScript(childScript, {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      });
      const supervised = superviseManagedDevLaunch({
        home: fixtureHome,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: [childScript, stopFile, launchesFile],
        spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
      });
      const descriptor = await waitFor(() => {
        try {
          const value = JSON.parse(
            readFileSync(
              join(
                controlDirectory,
                DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
              ),
              "utf8",
            ),
          );
          return value.state === "ready" ? value : null;
        } catch {
          return null;
        }
      });
      await waitFor(() =>
        readFileSync(launchesFile, "utf8").includes(
          `${descriptor.launch.pid}\n`,
        ),
      );
      const requestId = "8".repeat(64);
      const authority = {
        schemaVersion: 1,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        requestId,
        worktreeRoot,
        channel,
        capability: descriptor.capability,
        supervisor: descriptor.supervisor,
      };

      const destructiveSignals = [];
      const actualKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          destructiveSignals.push({ pid, signal });
        }
        return actualKill(pid, signal);
      });
      chmodSync(controlDirectory, 0o500);
      let rejection;
      try {
        await expect(
          sendFrame(descriptor.socketPath, {
            ...authority,
            type: "restart",
            expectedLaunch: descriptor.launch,
          }),
        ).resolves.toMatchObject({ type: "restart_admitted", requestId });
        rejection = await waitForAsync(async () => {
          const status = await sendFrame(descriptor.socketPath, {
            ...authority,
            type: "restart_status",
          });
          return status.type === "restart_rejected" ? status : null;
        });
      } finally {
        kill.mockRestore();
        chmodSync(controlDirectory, 0o700);
      }

      expect(rejection).toMatchObject({
        requestId,
        destructiveBoundaryCrossed: false,
      });
      expect(rejection.reason).toContain("dev launch restart failed");
      await expect(
        acknowledgeRestart(descriptor.socketPath, authority),
      ).resolves.toMatchObject({ type: "restart_acknowledged", requestId });
      expect(processIdentity(descriptor.launch.pid)).toBe(
        descriptor.launch.processIdentity,
      );
      expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toHaveLength(
        1,
      );
      expect(destructiveSignals).toEqual([]);
      writeFileSync(stopFile, "stop\n", { mode: 0o600 });
      await expect(supervised).resolves.toEqual({ code: 0, signal: null });
    },
  );

  it.runIf(process.platform !== "win32")(
    "lets the active restart transaction own a replacement during shutdown",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const childScript = join(fixtureRoot, "signal-race-child.mjs");
      const driverScript = join(fixtureRoot, "signal-race-driver.mjs");
      const launchesFile = join(fixtureRoot, "signal-race-launches.txt");
      const resultFile = join(fixtureRoot, "signal-race-result.json");
      const channel = "dev-supervisor-signal-race-1234567890";
      writeFileSync(
        childScript,
        `import { appendFileSync } from "node:fs";
appendFileSync(process.argv[2], String(process.pid) + "\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
        { mode: 0o600 },
      );
      writeFileSync(
        driverScript,
        `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appControlDirectory } from ${JSON.stringify(
  new URL("./app-channel.mjs", import.meta.url).href,
)};
import {
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
} from ${JSON.stringify(new URL("./dev-launch-contract.mjs", import.meta.url).href)};
import { requestDevLaunchRestart } from ${JSON.stringify(new URL("./dev-launch-client.mjs", import.meta.url).href)};
import { superviseDevLaunch } from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};

const [fixtureRoot, fixtureHome, worktreeRoot, channel, childScript, launchesFile, resultFile] = process.argv.slice(2);
const descriptorPath = join(
  appControlDirectory(fixtureHome, channel),
  DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
);
const waitFor = async (predicate) => {
  const deadline = Date.now() + ${FIXTURE_LIFECYCLE_TIMEOUT_MS};
  do {
    try {
      const value = predicate();
      if (value) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error("driver observation timed out");
};
let spawnCount = 0;
const spawnOptions = {
  get cwd() {
    spawnCount += 1;
    if (spawnCount === 2) process.emit("SIGTERM");
    return fixtureRoot;
  },
  stdio: "ignore",
};
const supervised = superviseDevLaunch({
  home: fixtureHome,
  worktreeRoot,
  channel,
  command: process.execPath,
  args: [childScript, launchesFile],
  spawnOptions,
});
const descriptor = await waitFor(() => {
  if (!existsSync(descriptorPath)) return null;
  const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
  return value.state === "ready" ? value : null;
});
await waitFor(() => readFileSync(launchesFile, "utf8").includes(String(descriptor.launch.pid)));
const restart = requestDevLaunchRestart({
  home: fixtureHome,
  root: worktreeRoot,
  channel,
  timeoutMs: 2_000,
}).then(
  () => ({ succeeded: true }),
  (error) => ({
    succeeded: false,
    destructiveBoundaryCrossed: error.destructiveBoundaryCrossed,
    restartRequestId: error.restartRequestId,
  }),
);
const [supervisedOutcome, restartOutcome] = await Promise.all([supervised, restart]);
writeFileSync(resultFile, JSON.stringify({ supervisedOutcome, restartOutcome }));
`,
        { mode: 0o600 },
      );

      await execFileAsync(
        process.execPath,
        [
          driverScript,
          fixtureRoot,
          fixtureHome,
          worktreeRoot,
          channel,
          childScript,
          launchesFile,
          resultFile,
        ],
        { timeout: FIXTURE_LIFECYCLE_TIMEOUT_MS },
      );
      expect(JSON.parse(readFileSync(resultFile, "utf8"))).toMatchObject({
        supervisedOutcome: { code: null, signal: "SIGTERM" },
        restartOutcome: {
          succeeded: false,
          destructiveBoundaryCrossed: null,
          restartRequestId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      for (const pid of readFileSync(launchesFile, "utf8")
        .trim()
        .split("\n")
        .map(Number)) {
        expect(processIdentity(pid)).toBeNull();
      }
    },
  );

  it.runIf(
    process.platform !== "win32" && typeof process.execve === "function",
  )(
    "cuts over the exact parent generation through preflight and exec handoff",
    async () => {
      const fixtureRoot = temporaryRoot();
      const fixtureHome = join(fixtureRoot, "home");
      const worktreeRoot = join(fixtureRoot, "worktree");
      const driverScript = join(fixtureRoot, "parent-driver.mjs");
      const childScript = join(fixtureRoot, "parent-child.mjs");
      const launchesFile = join(fixtureRoot, "parent-launches.txt");
      const stopFile = join(fixtureRoot, "stop-parent");
      const channel = "dev-supervisor-parent-cutover-1234567890";
      const previousSource = "1".repeat(64);
      const targetSource = "2".repeat(64);
      mkdirSync(worktreeRoot, { recursive: true });
      writeFileSync(
        childScript,
        `import { appendFileSync, existsSync } from "node:fs";
const [source, launchesFile, stopFile] = process.argv.slice(2);
appendFileSync(launchesFile, source + ":" + process.pid + "\\n");
process.on("SIGTERM", () => process.exit(0));
const timer = setInterval(() => {
  if (existsSync(stopFile)) {
    clearInterval(timer);
    process.exit(0);
  }
}, 20);
`,
        { mode: 0o600 },
      );
      const driverSource = (sourceGeneration) => `
import {
  DEV_LAUNCH_CHILD_GENERATION_ENV,
  DEV_LAUNCH_PARENT_HANDOFF_ENV,
  parseDevLaunchParentHandoff,
} from ${JSON.stringify(new URL("./dev-launch-contract.mjs", import.meta.url).href)};
import {
  preflightDevLaunchParentResume,
  superviseDevLaunch,
} from ${JSON.stringify(new URL("./dev-launch-supervisor.mjs", import.meta.url).href)};

const SOURCE_GENERATION = ${JSON.stringify(sourceGeneration)};
const input = process.argv.slice(2);
const preflightIndex = input.indexOf("--preflight");
if (preflightIndex !== -1) {
  await preflightDevLaunchParentResume({
    home: input[0],
    worktreeRoot: input[1],
    channel: input[2],
    sourceGeneration: input[preflightIndex + 1],
    handoff: JSON.parse(input[preflightIndex + 2]),
  });
  process.exit(0);
}
const [home, worktreeRoot, channel, childScript, launchesFile, stopFile] = input;
const serializedHandoff = process.env[DEV_LAUNCH_PARENT_HANDOFF_ENV];
delete process.env[DEV_LAUNCH_PARENT_HANDOFF_ENV];
const parentHandoff = parseDevLaunchParentHandoff(serializedHandoff, {
  channel,
  worktreeRoot,
});
const outcome = await superviseDevLaunch({
  home,
  worktreeRoot,
  channel,
  command: process.execPath,
  args: [childScript, SOURCE_GENERATION, launchesFile, stopFile],
  spawnOptions: { cwd: worktreeRoot, stdio: "ignore" },
  sourceGeneration: SOURCE_GENERATION,
  parentHandoff,
  preflightParent: (targetSourceGeneration, handoff) => ({
    command: process.execPath,
    args: [
      process.argv[1],
      ...process.argv.slice(2),
      "--preflight",
      targetSourceGeneration,
      JSON.stringify(handoff),
    ],
    spawnOptions: { cwd: worktreeRoot, stdio: "ignore" },
  }),
  reloadParent: (handoff) => {
    process.execve(
      process.execPath,
      [process.execPath, process.argv[1], ...process.argv.slice(2)],
      {
        ...process.env,
        [DEV_LAUNCH_PARENT_HANDOFF_ENV]: JSON.stringify(handoff),
      },
    );
  },
});
process.exitCode = outcome.code ?? 1;
`;
      writeFileSync(driverScript, driverSource(previousSource), {
        mode: 0o600,
      });

      const running = execFileAsync(
        process.execPath,
        [
          driverScript,
          fixtureHome,
          worktreeRoot,
          channel,
          childScript,
          launchesFile,
          stopFile,
        ],
        { timeout: FIXTURE_LIFECYCLE_TIMEOUT_MS },
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let driverOutcome;
      try {
        const descriptorPath = join(
          appControlDirectory(fixtureHome, channel),
          DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
        );
        const predecessor = await waitFor(() => {
          try {
            const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
            return value.state === "ready" ? value : null;
          } catch {
            return null;
          }
        });
        expect(predecessor.sourceGeneration).toBe(previousSource);
        await waitForFileContent(
          launchesFile,
          (content) =>
            content.split("\n").includes(
              `${previousSource}:${predecessor.launch.pid}`,
            ),
          FIXTURE_LIFECYCLE_TIMEOUT_MS,
        );

        writeFileSync(driverScript, driverSource(targetSource), {
          mode: 0o600,
        });
        const receipt = await requestDevLaunchParentReload({
          home: fixtureHome,
          root: worktreeRoot,
          channel,
          sourceGeneration: targetSource,
          timeoutMs: 5_000,
        });
        const activated = JSON.parse(readFileSync(descriptorPath, "utf8"));

        expect(receipt).toMatchObject({
          type: "parent_reload_receipt",
          previousSupervisor: predecessor.supervisor,
          previousLaunch: predecessor.launch,
          supervisor: activated.supervisor,
          launch: activated.launch,
          sourceGeneration: targetSource,
        });
        expect(receipt.supervisor.pid).toBe(receipt.previousSupervisor.pid);
        expect(receipt.supervisor.processIdentity).toBe(
          receipt.previousSupervisor.processIdentity,
        );
        expect(receipt.supervisor.generation).not.toBe(
          receipt.previousSupervisor.generation,
        );
        expect(receipt.launch.generation).not.toBe(
          receipt.previousLaunch.generation,
        );
        expect(activated.activation.requestId).toBe(receipt.requestId);
        await waitForFileContent(
          launchesFile,
          (content) =>
            content.split("\n").includes(
              `${targetSource}:${receipt.launch.pid}`,
            ),
          FIXTURE_LIFECYCLE_TIMEOUT_MS,
        );
        expect(readFileSync(launchesFile, "utf8").trim().split("\n")).toEqual([
          expect.stringMatching(new RegExp(`^${previousSource}:\\d+$`)),
          expect.stringMatching(new RegExp(`^${targetSource}:\\d+$`)),
        ]);
      } finally {
        writeFileSync(stopFile, "stop\n", { mode: 0o600 });
        driverOutcome = await running;
      }
      expect(driverOutcome.error).toBeUndefined();
      expect(driverOutcome.value).toBeDefined();
    },
  );

  it("retires only its exact child and publishes a replacement receipt", async () => {
    const fixtureRoot = temporaryRoot();
    const fixtureHome = join(fixtureRoot, "home");
    const worktreeRoot = join(fixtureRoot, "worktree");
    const childScript = join(fixtureRoot, "child.mjs");
    const launchesFile = join(fixtureRoot, "launches.txt");
    const stopFile = join(fixtureRoot, "child-stop");
    const channel = "dev-supervisor-fixture-1234567890";
    writeControlledExitScript(
      childScript,
      {
        onStart:
          'appendFileSync(process.argv[3], String(process.pid) + "\\n");',
      },
    );

    const supervised = superviseManagedDevLaunch({
      home: fixtureHome,
      worktreeRoot,
      channel,
      command: process.execPath,
      args: [childScript, stopFile, launchesFile],
      fixtureReleasePaths: [stopFile],
      spawnOptions: { cwd: fixtureRoot, stdio: "ignore" },
    });
    const descriptorPath = join(
      appControlDirectory(fixtureHome, channel),
      DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE,
    );
    const descriptor = await waitFor(() => {
      try {
        const value = JSON.parse(readFileSync(descriptorPath, "utf8"));
        return value.state === "ready" ? value : null;
      } catch {
        return null;
      }
    });
    await waitFor(() => {
      try {
        return readFileSync(launchesFile, "utf8").includes(
          `${descriptor.launch.pid}\n`,
        );
      } catch {
        return false;
      }
    });
    const rejected = await sendFrame(descriptor.socketPath, {
      schemaVersion: 1,
      type: "restart",
      requestId: "e".repeat(64),
      worktreeRoot,
      channel,
      capability: "f".repeat(64),
      supervisor: descriptor.supervisor,
      expectedLaunch: descriptor.launch,
    });
    expect(rejected).toMatchObject({ type: "restart_rejected" });
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
      descriptor.launch,
    );

    const staleState = await sendFrame(descriptor.socketPath, {
      schemaVersion: 1,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      type: "restart",
      requestId: "d".repeat(64),
      worktreeRoot,
      channel,
      capability: descriptor.capability,
      supervisor: descriptor.supervisor,
      expectedState: "preparing",
      expectedLaunch: descriptor.launch,
    });
    expect(staleState).toMatchObject({
      type: "restart_rejected",
      reason: "dev launch restart request does not match current authority",
      destructiveBoundaryCrossed: false,
    });
    expect(JSON.parse(readFileSync(descriptorPath, "utf8")).launch).toEqual(
      descriptor.launch,
    );

    const receipt = await requestDevLaunchRestart({
      home: fixtureHome,
      root: worktreeRoot,
      channel,
      timeoutMs: 5_000,
    });

    expect(receipt.previousLaunch).toEqual(descriptor.launch);
    expect(receipt.launch.generation).not.toBe(
      receipt.previousLaunch.generation,
    );
    expect(receipt.supervisor).toEqual(descriptor.supervisor);
    writeFileSync(stopFile, "stop\n", { mode: 0o600 });
    expect(await supervised).toEqual({ code: 0, signal: null });
    const launchedPids = readFileSync(launchesFile, "utf8")
      .trim()
      .split("\n")
      .map(Number);
    expect(launchedPids).toEqual([
      receipt.previousLaunch.pid,
      receipt.launch.pid,
    ]);
  });
});
