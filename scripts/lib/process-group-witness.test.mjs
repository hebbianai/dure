import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  boundedDevLaunchFixtureOutcome,
  createDevLaunchFixtureRegistry,
  runDevLaunchFixtureCleanup,
} from "./dev-launch-test-support.mjs";
import {
  DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
} from "./dev-launch-contract.mjs";
import {
  evaluateOwnedProcessGroupSnapshots,
  observeOwnedProcessGroup,
  parseProcessGroupAuthority,
  processGroupSupport,
  requireProcessGroupSupport,
  processGroupWitnessCanRetire,
  signalExactProcess,
  signalOwnedProcessGroup,
  sameProcessGroupAuthority,
} from "./process-group-authority.mjs";
import {
  macosProcessBoundaryCompileArguments,
  processGroupId,
  processGroupMemberStates,
  processMemberFromObservation,
  processMemberSnapshots,
  processIdentity,
  processLivenessFromObservation,
  observeProcessMembers,
} from "./process-identity.mjs";
import { waitForProcessGroupWitnessReadiness } from "./process-group-witness.mjs";

const fixtureRoots = [];
const fixtureProcesses = createDevLaunchFixtureRegistry();
const processGroupAdapterSupported =
  process.platform === "darwin" || process.platform === "linux";

it("allows a transient local witness startup delay beyond one second", async () => {
  const ready = new Promise((resolve) =>
    setTimeout(() => resolve("ready"), 1_100),
  );
  await expect(waitForProcessGroupWitnessReadiness(ready)).resolves.toBe("ready");
});

function waitFor(predicate, timeoutMs = 3_000, label = "process state") {
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
        const detail = typeof label === "function" ? label() : label;
        reject(new Error(`process group witness fixture timed out: ${detail}`));
        return;
      }
      setTimeout(poll, 20);
    };
    void poll();
  });
}

function nextMessage(child) {
  return new Promise((resolve) => child.once("message", resolve));
}

function spawnWitnessFixture({
  isolatedBoundary = false,
  liveMember = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "dure-group-witness-"));
  fixtureRoots.push(root);
  const script = join(root, "fixture.mjs");
  const boundaryTemp = join(root, "tmp");
  if (isolatedBoundary) mkdirSync(boundaryTemp, { mode: 0o700 });
  const helperUrl = pathToFileURL(
    join(import.meta.dirname, "process-group-witness.mjs"),
  ).href;
  writeFileSync(
    script,
    `import { spawn } from "node:child_process";
import { spawnProcessGroupWitness } from ${JSON.stringify(helperUrl)};
const witness = await spawnProcessGroupWitness();
${liveMember ? `const member = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1_000)"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
await new Promise((resolve) => member.once("message", resolve));` : ""}
await witness.retain();
process.send({
  leaderPid: process.pid,
  witnessPid: witness.pid,
  ${liveMember ? "memberPid: member.pid," : ""}
});
process.once("message", () => process.exit(0));
process.once("disconnect", () => process.exit(0));
setInterval(() => {}, 1_000);
`,
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [script], {
    detached: true,
    env: isolatedBoundary
      ? { ...process.env, TMPDIR: boundaryTemp }
      : process.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const ownership = fixtureProcesses.registerSpawn(child);
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    boundaryTemp,
    child,
    exited,
    ownership,
    ready: nextMessage(child),
  };
}

function ownedGroup(ready, leaderIdentity, witnessIdentity) {
  return {
    pid: ready.leaderPid,
    processIdentity: leaderIdentity,
    processGroup: {
      kind: "posix_process_group_v1",
      id: ready.leaderPid,
      witness: {
        pid: ready.witnessPid,
        processIdentity: witnessIdentity,
      },
    },
  };
}

afterEach(async () => {
  const roots = fixtureRoots.splice(0);
  await runDevLaunchFixtureCleanup([
    () => fixtureProcesses.retireAll(),
    ...roots.map((root) => () =>
      rmSync(root, { recursive: true, force: true })
    ),
  ]);
});

it.runIf(processGroupAdapterSupported)(
  "retires a retained witness after its dead leader leaves no live member",
  async () => {
    const fixture = spawnWitnessFixture();
    const ready = await fixture.ready;
    const leaderIdentity = await waitFor(
      () => processIdentity(ready.leaderPid),
      3_000,
      "leader identity",
    );
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    fixture.ownership.bind(
      ownedGroup(ready, leaderIdentity, witnessIdentity),
    );
    expect(processGroupId(ready.witnessPid)).toBe(ready.leaderPid);

    fixture.child.send({ type: "exit" });
    await fixture.exited;
    await waitFor(
      () => processIdentity(ready.leaderPid) === null,
      3_000,
      "leader retirement",
    );
    expect(processIdentity(ready.leaderPid)).not.toBe(leaderIdentity);
    await waitFor(
      () => processIdentity(ready.witnessPid) === null,
      3_000,
      "disconnected witness retirement without live members",
    );
  },
);

it.runIf(processGroupAdapterSupported)(
  "keeps the witness until the last live group member exits",
  async () => {
    const fixture = spawnWitnessFixture({ liveMember: true });
    const ready = await fixture.ready;
    const leaderIdentity = await waitFor(() => processIdentity(ready.leaderPid));
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    const memberIdentity = await waitFor(() => processIdentity(ready.memberPid));
    fixture.ownership.bind(
      ownedGroup(ready, leaderIdentity, witnessIdentity),
    );
    fixture.child.send({ type: "exit" });
    await fixture.exited;
    await waitFor(() => processIdentity(ready.leaderPid) === null);

    const owner = ownedGroup(ready, leaderIdentity, witnessIdentity);
    await signalOwnedProcessGroup(owner, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processIdentity(ready.witnessPid)).toBe(witnessIdentity);
    expect(processIdentity(ready.memberPid)).toBe(memberIdentity);

    await signalOwnedProcessGroup(owner, "SIGKILL");
    await waitFor(() => processIdentity(ready.memberPid) === null);
    await waitFor(() => processIdentity(ready.witnessPid) === null);
  },
);

it.runIf(processGroupAdapterSupported)(
  "retires a retained witness after its IPC owner disconnects and the last live member exits",
  async () => {
    const fixture = spawnWitnessFixture({ liveMember: true });
    const ready = await fixture.ready;
    const leaderIdentity = await waitFor(() => processIdentity(ready.leaderPid));
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    const memberIdentity = await waitFor(() => processIdentity(ready.memberPid));
    fixture.ownership.bind(
      ownedGroup(ready, leaderIdentity, witnessIdentity),
    );

    fixture.child.disconnect();
    await fixture.exited;
    await waitFor(() => processIdentity(ready.leaderPid) === null);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processIdentity(ready.witnessPid)).toBe(witnessIdentity);
    expect(processIdentity(ready.memberPid)).toBe(memberIdentity);

    await signalExactProcess(
      { pid: ready.memberPid, processIdentity: memberIdentity },
      "SIGKILL",
    );
    await waitFor(() => processIdentity(ready.memberPid) === null);
    await waitFor(
      () => processIdentity(ready.witnessPid) === null,
      3_000,
      "disconnected witness retirement",
    );
  },
);

it.runIf(process.platform === "darwin")(
  "retries a transient census rejection after its retained IPC owner disconnects",
  async () => {
    const fixture = spawnWitnessFixture({
      isolatedBoundary: true,
      liveMember: true,
    });
    const ready = await fixture.ready;
    const leaderIdentity = await waitFor(() => processIdentity(ready.leaderPid));
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    const memberIdentity = await waitFor(() => processIdentity(ready.memberPid));
    fixture.ownership.bind(
      ownedGroup(ready, leaderIdentity, witnessIdentity),
    );
    const boundaryDirectory = join(
      fixture.boundaryTemp,
      `dure-process-boundary-${process.getuid()}`,
    );

    chmodSync(boundaryDirectory, 0o777);
    try {
      fixture.child.disconnect();
      await fixture.exited;
      await waitFor(() => processIdentity(ready.leaderPid) === null);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(processIdentity(ready.witnessPid)).toBe(witnessIdentity);
      expect(processIdentity(ready.memberPid)).toBe(memberIdentity);
    } finally {
      chmodSync(boundaryDirectory, 0o700);
    }

    await signalExactProcess(
      { pid: ready.memberPid, processIdentity: memberIdentity },
      "SIGKILL",
    );
    await waitFor(() => processIdentity(ready.memberPid) === null);
    await waitFor(
      () => processIdentity(ready.witnessPid) === null,
      3_000,
      "witness retirement after transient census rejection",
    );
  },
);

it("retires when a complete group census contains only its witness and zombie members", () => {
  expect(
    processGroupWitnessCanRetire(
      {
        status: "complete",
        scope: { kind: "group_census", groupId: 41 },
        members: [
          { pid: 41, state: "live" },
          { pid: 42, state: "zombie" },
        ],
      },
      { groupId: 41, witnessPid: 41 },
    ),
  ).toBe(true);
});

it.runIf(processGroupAdapterSupported)(
  "retires after a native forked descendant is no longer reported live",
  async () => {
    const python = spawn(
      "python3",
      [
        "-c",
        "import os,time; child=os.fork(); (os._exit(0) if child == 0 else (print(child, flush=True), time.sleep(30)))",
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    fixtureProcesses.registerSpawn(python);
    python.stdout.setEncoding("utf8");
    const descendantPid = Number(
      await new Promise((resolve) => python.stdout.once("data", resolve)),
    );
    const observations = await waitFor(async () => {
      const current = await observeProcessMembers({
        kind: "group_census",
        groupId: python.pid,
      });
      if (current.status !== "complete") return null;
      const descendant = current.members.find(
        ({ pid }) => pid === descendantPid,
      );
      return descendant?.state === "live" ? null : current;
    });

    expect(observations.members).not.toContainEqual(
      expect.objectContaining({ pid: descendantPid, state: "live" }),
    );
    expect(processGroupWitnessCanRetire(observations, {
      groupId: python.pid,
      witnessPid: python.pid,
    })).toBe(true);
  },
);

it("keeps authority when member observation is unavailable or still live", () => {
  const authority = { groupId: 41, witnessPid: 41 };
  expect(processGroupWitnessCanRetire(null, authority)).toBe(false);
  expect(
    processGroupWitnessCanRetire(
      { status: "incomplete", reason: "fixture" },
      authority,
    ),
  ).toBe(false);
  expect(
    processGroupWitnessCanRetire({
      status: "complete",
      scope: { kind: "point", requestedPids: [] },
      members: [],
    }, authority),
  ).toBe(false);
  expect(
    processGroupWitnessCanRetire(
      {
        status: "complete",
        scope: { kind: "group_census", groupId: 41 },
        members: [
          { pid: 41, state: "live" },
          { pid: 42, state: "live" },
        ],
      },
      authority,
    ),
  ).toBe(false);
});

it("fails exact process liveness closed for incomplete, wrong-scope, or zombie observations", () => {
  const identity = { pid: 41, processIdentity: "exact" };
  expect(
    processLivenessFromObservation(identity, {
      status: "incomplete",
      reason: "fixture",
    }),
  ).toBe("unknown");
  expect(
    processLivenessFromObservation(identity, {
      status: "complete",
      scope: { kind: "point", requestedPids: [41] },
      members: [{
        pid: 41,
        processIdentity: "exact",
        groupId: 41,
        state: "live",
      }],
    }),
  ).toBe("active");
  expect(
    processLivenessFromObservation(identity, {
      status: "complete",
      scope: { kind: "point", requestedPids: [41] },
      members: [],
    }),
  ).toBe("stale");
  expect(
    processLivenessFromObservation(identity, {
      status: "complete",
      scope: { kind: "group_census", groupId: 41 },
      members: [{
        pid: 41,
        processIdentity: "exact",
        groupId: 41,
        state: "live",
      }],
    }),
  ).toBe("unknown");
  expect(
    processLivenessFromObservation(identity, {
      status: "complete",
      scope: { kind: "point", requestedPids: [41] },
      members: [{
        pid: 41,
        processIdentity: "exact",
        groupId: 41,
        state: "zombie",
      }],
    }),
  ).toBe("stale");
  const batch = {
    status: "complete",
    scope: { kind: "point", requestedPids: [41, 42] },
    members: [
      {
        pid: 41,
        processIdentity: "exact",
        groupId: 41,
        state: "stopped",
      },
      {
        pid: 42,
        processIdentity: "other",
        groupId: 42,
        state: "live",
      },
    ],
  };
  expect(processLivenessFromObservation(identity, batch)).toBe("active");
  expect(processMemberFromObservation(42, batch)).toEqual({
    member: batch.members[1],
    status: "present",
  });
});

it.runIf(processGroupAdapterSupported)(
  "does not discard an unidentified exited leader with a live descendant",
  async () => {
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const { spawn } = require("node:child_process");
const member = spawn(process.execPath, ["-e", "process.once('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { stdio: "ignore" });
member.once("spawn", () => process.send({ memberPid: member.pid }, () => process.exit(0)));`,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    fixtureProcesses.registerSpawn(leader);
    const leaderExited = new Promise((resolve) => leader.once("exit", resolve));
    const { memberPid } = await nextMessage(leader);
    const memberIdentity = await waitFor(() => processIdentity(memberPid));
    fixtureProcesses.registerIdentity({
      pid: memberPid,
      processIdentity: memberIdentity,
    });
    await leaderExited;

    const registry = createDevLaunchFixtureRegistry();
    const unidentifiedLeader = new EventEmitter();
    unidentifiedLeader.pid = leader.pid;
    registry.registerSpawn(unidentifiedLeader);
    unidentifiedLeader.emit("exit", 0, null);

    const failure = await registry.retireAll().catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([
      expect.objectContaining({
        code: "DEV_FIXTURE_PROCESS_IDENTITY_UNAVAILABLE",
        fixtureProcessExited: true,
      }),
    ]);
    expect(processIdentity(memberPid)).toBe(memberIdentity);
  },
);

it.runIf(processGroupAdapterSupported)(
  "continues exact fixture retirement after an earlier cleanup failure",
  async () => {
    const registry = createDevLaunchFixtureRegistry();
    const exact = spawn(
      process.execPath,
      ["-e", "process.send('ready'); setInterval(() => {}, 1000)"],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    fixtureProcesses.registerSpawn(exact);
    await nextMessage(exact);
    const exactIdentity = {
      pid: exact.pid,
      processIdentity: await waitFor(() => processIdentity(exact.pid)),
    };
    registry.registerIdentity(exactIdentity);
    const cleanupFailure = new Error("fixture cleanup rejected");
    cleanupFailure.code = "DEV_FIXTURE_CLEANUP_REJECTED";
    registry.registerCleanup(async () => {
      throw cleanupFailure;
    });
    const unidentified = new EventEmitter();
    unidentified.pid = 2_147_483_646;
    registry.registerSpawn(unidentified);
    unidentified.emit("exit", 0, null);

    const failure = await registry.retireAll().catch((error) => error);

    await waitFor(() => processIdentity(exact.pid) === null);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([
      expect.objectContaining({
        code: "DEV_FIXTURE_CLEANUP_REJECTED",
      }),
      expect.objectContaining({
        code: "DEV_FIXTURE_PROCESS_IDENTITY_UNAVAILABLE",
      }),
    ]);
  },
);

it.runIf(processGroupAdapterSupported)(
  "bounds stalled cleanup obligations before continuing LIFO cleanup and exact retirement",
  { timeout: 1_000 },
  async () => {
    const registry = createDevLaunchFixtureRegistry({ timeoutMs: 25 });
    const exact = spawn(
      process.execPath,
      ["-e", "process.send('ready'); setInterval(() => {}, 1_000)"],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    fixtureProcesses.registerSpawn(exact);
    await nextMessage(exact);
    const exactIdentity = {
      pid: exact.pid,
      processIdentity: await waitFor(() => processIdentity(exact.pid)),
    };
    registry.registerIdentity(exactIdentity);
    const cleanupOrder = [];
    registry.registerCleanup(async () => {
      cleanupOrder.push("first");
    });
    registry.registerCleanup(async () => {
      cleanupOrder.push("stalled");
      await new Promise(() => {});
    });

    const failure = await registry.retireAll().catch((error) => error);

    await waitFor(() => processIdentity(exact.pid) === null);
    expect(cleanupOrder).toEqual(["stalled", "first"]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toEqual([
      expect.objectContaining({
        code: "DEV_LAUNCH_FIXTURE_TIMEOUT",
        message: "dev launch fixture cleanup obligation exceeded 25ms",
      }),
    ]);
  },
);

it.runIf(processGroupAdapterSupported)(
  "retains promoted descriptor authority for a second exact retirement attempt",
  async () => {
    const group = spawnWitnessFixture();
    const ready = await group.ready;
    const leaderIdentity = await waitFor(() =>
      processIdentity(ready.leaderPid)
    );
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    const launch = {
      ...ownedGroup(ready, leaderIdentity, witnessIdentity),
      generation: "e".repeat(64),
    };
    group.ownership.bind(launch);
    const staleLaunch = {
      ...launch,
      processGroup: {
        ...launch.processGroup,
        witness: {
          ...launch.processGroup.witness,
          processIdentity: `${witnessIdentity}-stale`,
        },
      },
    };
    const root = mkdtempSync(join(tmpdir(), "dure-retry-authority-"));
    fixtureRoots.push(root);
    const descriptorPath = join(root, "descriptor.json");
    const channel = "dev-retry-authority-1234567890";
    writeFileSync(
      descriptorPath,
      `${JSON.stringify({
        schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
        protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
        state: "ready",
        worktreeRoot: root,
        channel,
        socketPath: join(root, "supervisor.sock"),
        capability: "a".repeat(64),
        capabilities: [DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY],
        supervisor: {
          pid: 2_147_483_646,
          processIdentity: "unreachable-supervisor",
          generation: "f".repeat(64),
        },
        launch: staleLaunch,
        publishedAtMs: Date.now(),
      })}\n`,
      { mode: 0o600 },
    );
    const registry = createDevLaunchFixtureRegistry();
    const retained = registry.registerIdentity({
      pid: launch.pid,
      processIdentity: launch.processIdentity,
    });
    registry.registerDescriptor(descriptorPath);

    const firstFailure = await registry.retireAll().catch((error) => error);

    expect(firstFailure).toBeInstanceOf(AggregateError);
    expect(firstFailure.errors).toEqual([
      expect.objectContaining({
        code: "DEV_FIXTURE_PROCESS_GROUP_AUTHORITY_UNAVAILABLE",
      }),
    ]);
    expect(retained.identity).toMatchObject(staleLaunch);
    expect(processIdentity(launch.pid)).toBe(launch.processIdentity);
    rmSync(root, { recursive: true, force: true });
    retained.identity = launch;

    await registry.retireAll();

    await waitFor(() => processIdentity(launch.pid) === null);
    await waitFor(() => processIdentity(launch.processGroup.witness.pid) === null);
  },
);

it("runs every fixture teardown phase and reports every failure", async () => {
  const phases = [];
  const retirementFailure = new AggregateError(
    [new Error("retirement rejected")],
    "fixture retirement failed",
  );
  const joinFailure = new Error("child join rejected");

  const failure = await runDevLaunchFixtureCleanup([
    async () => {
      phases.push("retire");
      throw retirementFailure;
    },
    async () => {
      phases.push("join");
      throw joinFailure;
    },
    async () => {
      phases.push("roots");
    },
  ]).catch((error) => error);

  expect(phases).toEqual(["retire", "join", "roots"]);
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure.errors).toEqual([retirementFailure, joinFailure]);
});

it(
  "does not let a stalled child join block later root cleanup",
  { timeout: 1_000 },
  async () => {
    const phases = [];

    const failure = await runDevLaunchFixtureCleanup([
      () =>
        boundedDevLaunchFixtureOutcome(new Promise(() => {}), {
          label: "fixture child join",
          timeoutMs: 10,
        }),
      async () => {
        phases.push("roots");
      },
    ]).catch((error) => error);

    expect(phases).toEqual(["roots"]);
    expect(failure).toMatchObject({
      code: "DEV_LAUNCH_FIXTURE_TIMEOUT",
      message: "fixture child join exceeded 10ms",
    });
  },
);

it.runIf(processGroupAdapterSupported)(
  "retires a descriptor controller before captured and newly published groups",
  async () => {
    const group = spawnWitnessFixture();
    const ready = await group.ready;
    const leaderIdentity = await waitFor(() =>
      processIdentity(ready.leaderPid)
    );
    const witnessIdentity = await waitFor(() =>
      processIdentity(ready.witnessPid)
    );
    const launch = {
      ...ownedGroup(ready, leaderIdentity, witnessIdentity),
      generation: "b".repeat(64),
    };
    group.ownership.bind(launch);
    const replacementGroup = spawnWitnessFixture({ liveMember: true });
    const replacementReady = await replacementGroup.ready;
    const replacementLaunch = {
      ...ownedGroup(
        replacementReady,
        await waitFor(() => processIdentity(replacementReady.leaderPid)),
        await waitFor(() => processIdentity(replacementReady.witnessPid)),
      ),
      generation: "d".repeat(64),
    };

    const root = mkdtempSync(join(tmpdir(), "dure-controller-order-"));
    fixtureRoots.push(root);
    const marker = join(root, "controller-order.txt");
    const descriptorPath = join(root, "descriptor.json");
    const replacementDescriptorPath = join(root, "replacement.json");
    const controllerScript = join(root, "controller.mjs");
    writeFileSync(
      controllerScript,
      `import { readFileSync, writeFileSync } from "node:fs";
process.once("SIGTERM", () => {
  let launchLive = true;
  try { process.kill(Number(process.argv[2]), 0); } catch { launchLive = false; }
  writeFileSync(process.argv[3], launchLive ? "launch-live" : "launch-retired");
  writeFileSync(process.argv[4], readFileSync(process.argv[5]));
  process.exit(0);
});
process.send("ready");
setInterval(() => {}, 1_000);
`,
      { mode: 0o600 },
    );
    const controller = spawn(
      process.execPath,
      [
        controllerScript,
        String(launch.pid),
        marker,
        descriptorPath,
        replacementDescriptorPath,
      ],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    fixtureProcesses.registerSpawn(controller);
    await nextMessage(controller);
    const controllerIdentity = await waitFor(() =>
      processIdentity(controller.pid)
    );
    const channel = "dev-controller-order-1234567890";
    const descriptor = (ownedLaunch) => ({
      schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
      protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
      state: "ready",
      worktreeRoot: root,
      channel,
      socketPath: join(root, "supervisor.sock"),
      capability: "a".repeat(64),
      capabilities: [
        "child_restart",
        DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
      ],
      supervisor: {
        pid: controller.pid,
        processIdentity: controllerIdentity,
        generation: "c".repeat(64),
      },
      launch: ownedLaunch,
      publishedAtMs: Date.now(),
    });
    writeFileSync(
      descriptorPath,
      `${JSON.stringify(descriptor(launch))}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      replacementDescriptorPath,
      `${JSON.stringify(descriptor(replacementLaunch))}\n`,
      { mode: 0o600 },
    );
    fixtureProcesses.registerDescriptor(descriptorPath);

    await fixtureProcesses.retireAll();

    expect(readFileSync(marker, "utf8")).toBe("launch-live");
    expect(processIdentity(controller.pid)).toBeNull();
    expect(processIdentity(launch.processGroup.witness.pid)).toBeNull();
    expect(processIdentity(replacementLaunch.pid)).toBeNull();
    expect(
      processIdentity(replacementLaunch.processGroup.witness.pid),
    ).toBeNull();
    expect(processIdentity(replacementReady.memberPid)).toBeNull();
  },
);

it("retains the native Windows Job and immutable adapter in its authority", () => {
  expect(processGroupSupport("win32")).toEqual({
    supported: true,
    kind: "windows_job_v1",
  });
  expect(requireProcessGroupSupport("win32").supported).toBe(true);
  const job = {
    kind: "windows_job_v1", id: "a".repeat(64), runtimeBuild: "b".repeat(64),
    witness: { pid: 42, processIdentity: "windows:42:1780000000000000" },
  };
  expect(parseProcessGroupAuthority(job, { leaderPid: 41 })).toEqual(job);
  expect(sameProcessGroupAuthority(job, { ...job, runtimeBuild: "c".repeat(64) })).toBe(false);
  expect(() => parseProcessGroupAuthority({ ...job, runtimeBuild: undefined })).toThrow();
});

it.runIf(process.platform === "darwin")(
  "fails a saturated native group census closed",
  () => {
    const root = mkdtempSync(join(tmpdir(), "dure-native-census-capacity-"));
    fixtureRoots.push(root);
    const executable = join(root, "process-boundary");
    const compileArguments = macosProcessBoundaryCompileArguments(executable);
    compileArguments.splice(
      1,
      0,
      "-DDURE_OWNERSHIP_OBSERVER_FAULT_INJECTION=1",
    );
    const compiled = spawnSync("cc", compileArguments, {
      encoding: "utf8",
    });
    expect(compiled.status, compiled.stderr).toBe(0);

    const observed = spawnSync(
      "python3",
      [
        "-c",
        "import os, sys; os.setsid(); os.execv(sys.argv[1], [sys.argv[1], 'observe-group', str(os.getpid())])",
        executable,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DURE_QA_NATIVE_OWNERSHIP_OBSERVER_FAULT:
            "group-census-saturated",
        },
      },
    );
    expect(observed.status, observed.stdout).toBe(8);
  },
);

it("supports only the process-group adapters with conformance coverage", () => {
  expect(processGroupSupport("darwin")).toEqual({
    supported: true,
    kind: "posix_process_group_v1",
  });
  expect(processGroupSupport("linux")).toEqual({
    supported: true,
    kind: "posix_process_group_v1",
  });
  expect(processGroupSupport("freebsd")).toEqual({
    supported: false,
    reason: "process_group_authority_unavailable_for_platform",
  });
});

function pointObservation(owner, {
  callerGroupId = 900,
  leaderIdentity = owner.processIdentity,
  leaderState = "live",
  witnessIdentity = owner.processGroup.witness.processIdentity,
  witnessState = "live",
  includeLeader = true,
  includeWitness = true,
} = {}) {
  const requestedPids = [
    process.pid,
    owner.pid,
    owner.processGroup.witness.pid,
  ].filter((pid, index, pids) => pids.indexOf(pid) === index)
    .sort((left, right) => left - right);
  return {
    status: "complete",
    scope: { kind: "point", requestedPids },
    members: [
      {
        pid: process.pid,
        groupId: callerGroupId,
        state: "live",
        processIdentity: "current-process",
      },
      ...(includeLeader
        ? [{
            pid: owner.pid,
            groupId: owner.processGroup.id,
            state: leaderState,
            processIdentity: leaderIdentity,
          }]
        : []),
      ...(includeWitness
        ? [{
            pid: owner.processGroup.witness.pid,
            groupId: owner.processGroup.id,
            state: witnessState,
            processIdentity: witnessIdentity,
          }]
        : []),
    ],
  };
}

function groupObservation(owner, members) {
  return {
    status: "complete",
    scope: { kind: "group_census", groupId: owner.processGroup.id },
    members,
  };
}

function evaluateOwner(owner, observations) {
  return evaluateOwnedProcessGroupSnapshots(owner, {
    currentPid: process.pid,
    ...observations,
  });
}

it.runIf(processGroupAdapterSupported)(
  "captures identity, state, and process group in one real point snapshot",
  () => {
    const observation = processMemberSnapshots([process.pid]);
    expect(observation).toEqual({
      status: "complete",
      scope: { kind: "point", requestedPids: [process.pid] },
      members: [{
        pid: process.pid,
        parentPid: process.ppid,
        groupId: processGroupId(process.pid),
        sessionId: expect.any(Number),
        state: "live",
        processIdentity: processIdentity(process.pid),
        startedAtUnixSeconds: expect.any(Number),
      }],
    });
  },
);

it("retires zombie-only authority and leaves a live reused witness unproven", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };
  expect(
    evaluateOwner(owner, {
      pointObservation: {
        status: "incomplete",
        reason: "fixture",
      },
    }).state,
  ).toBe("unproven");
  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, {
        leaderState: "zombie",
        witnessState: "zombie",
      }),
      groupObservation: groupObservation(owner, [
          { pid: 41, state: "zombie" },
          { pid: 42, state: "zombie" },
        ]),
      confirmationObservation: groupObservation(owner, [
          { pid: 41, state: "zombie" },
          { pid: 42, state: "zombie" },
        ]),
    }).state,
  ).toBe("retired");
  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, {
        includeLeader: false,
        witnessIdentity: "reused-witness",
      }),
      groupObservation: groupObservation(
        owner,
        [{ pid: 42, state: "live" }],
      ),
    }).state,
  ).toBe("unproven");
  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, { includeWitness: false }),
      groupObservation: groupObservation(
        owner,
        [{ pid: 41, state: "live" }],
      ),
    }).state,
  ).toBe("unproven");
});

it("classifies two exact live members without requesting a group census", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };
  expect(
    evaluateOwner(owner, { pointObservation: pointObservation(owner) }),
  ).toMatchObject({
    state: "owned",
    leaderCurrent: true,
    witnessCurrent: true,
  });
});

it("keeps an exact live witness authoritative after its leader exits", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };

  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, { includeLeader: false }),
    }),
  ).toMatchObject({
    state: "owned",
    proof: "witness",
    leaderCurrent: false,
    witnessCurrent: true,
  });
});

it("fails closed when the observer or its process group aliases authority", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };
  expect(
    evaluateOwner(owner, {
      pointObservation: { status: "incomplete", reason: "fixture" },
    }).state,
  ).toBe("unproven");
  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, { callerGroupId: 41 }),
    }).state,
  ).toBe("unproven");

  const leaderAlias = {
    ...owner,
    pid: process.pid,
    processIdentity: "current",
    processGroup: { ...owner.processGroup, id: process.pid },
  };
  expect(
    evaluateOwner(leaderAlias, {
      pointObservation: { status: "incomplete", reason: "fixture" },
    }).state,
  ).toBe("unproven");

  const witnessAlias = {
    ...owner,
    processGroup: {
      ...owner.processGroup,
      witness: { pid: process.pid, processIdentity: "current" },
    },
  };
  expect(
    evaluateOwner(witnessAlias, {
      pointObservation: { status: "incomplete", reason: "fixture" },
    }).state,
  ).toBe("unproven");
});

it("confirms an apparently empty group before classifying it retired", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };
  const observations = [
    groupObservation(owner, []),
    groupObservation(owner, [{ pid: 43, state: "live" }]),
  ];
  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, {
        includeLeader: false,
        includeWitness: false,
      }),
      groupObservation: observations.shift(),
      confirmationObservation: observations.shift(),
    }).state,
  ).toBe("unproven");
});

it("rejects point and census observations from a different scope", () => {
  const owner = {
    pid: 41,
    processIdentity: "leader",
    processGroup: {
      kind: "posix_process_group_v1",
      id: 41,
      witness: { pid: 42, processIdentity: "witness" },
    },
  };
  const wrongPoint = pointObservation(owner);
  wrongPoint.scope.requestedPids = [process.pid, owner.pid];
  expect(
    evaluateOwner(owner, { pointObservation: wrongPoint }).state,
  ).toBe("unproven");

  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, {
        includeLeader: false,
        includeWitness: false,
      }),
      groupObservation: {
        status: "complete",
        scope: { kind: "point", requestedPids: [] },
        members: [],
      },
      confirmationObservation: groupObservation(owner, []),
    }).state,
  ).toBe("unproven");

  expect(
    evaluateOwner(owner, {
      pointObservation: pointObservation(owner, {
        includeLeader: false,
        includeWitness: false,
      }),
      groupObservation: {
        status: "complete",
        scope: { kind: "group_census", groupId: owner.processGroup.id + 1 },
        members: [],
      },
      confirmationObservation: groupObservation(owner, []),
    }).state,
  ).toBe("unproven");
});
