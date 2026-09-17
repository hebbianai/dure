import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { processMemberSnapshots } from "../../lib/process-identity.mjs";
import {
  authorizeIsolatedRootRetirement,
} from "./isolated-root-retirement.mjs";
import {
  findHmuxTestDiscoveryRoots,
  planManifestProcessRetirement,
  reapHmuxTestState,
} from "./hmux-test-state-cleanup.mjs";
import { observeExactProcessGeneration } from "./owned-process-group.mjs";
import { captureOwnedProcessSnapshot } from "./owned-process-snapshot.mjs";

const temporaryDirectories = [];

function replacementKernelMarker(processIdentity) {
  const macos = processIdentity.match(
    /^(kernel-start-v3:macos:[^:]+:)(\d+)$/u,
  );
  if (macos) return `${macos[1]}${BigInt(macos[2]) + 1n}`;
  const linux = processIdentity.match(
    /^(?:kernel-start-v2:)?linux:([^:]+):(\d+)$/u,
  );
  if (linux) {
    return `kernel-start-v2:linux:${linux[1]}:${BigInt(linux[2]) + 1n}`;
  }
  throw new Error("unsupported fixture process identity");
}

function persistedKernelMarker(processIdentity) {
  if (processIdentity.startsWith("kernel-start-v3:macos:")) {
    return processIdentity;
  }
  const linux = processIdentity.match(/^linux:([^:]+):(\d+)$/u);
  if (linux) return `kernel-start-v2:linux:${linux[1]}:${linux[2]}`;
  throw new Error("unsupported fixture process identity");
}

function historicalOwnedGenerations(count, excludedPids = new Set()) {
  const records = [];
  for (let index = 0; records.length < count; index += 1) {
    const pid = 80_000 + index;
    if (excludedPids.has(pid)) continue;
    records.push({
      kernelStartMarker:
        `kernel-start-v3:macos:00000000-0000-0000-0000-000000000001:${index + 1}`,
      pid,
    });
  }
  return records;
}

function userIdentityCensus(relations) {
  return {
    relations,
    scope: {
      effectiveUid: process.geteuid?.(),
      evidence: "closed_enumeration",
      kind: "user_identity_census",
    },
    status: "complete",
  };
}

async function detachedGroup() {
  const observationRoot = fs.mkdtempSync(
    path.join(fs.realpathSync("/tmp"), "dure-hmux-generation-fixture."),
  );
  temporaryDirectories.push(observationRoot);
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 300000)"],
    { detached: true, stdio: "ignore" },
  );
  const closed = new Promise((resolve) => {
    child.once("close", (status, signal) => resolve({ signal, status }));
  });
  let record;
  for (let attempt = 0; attempt < 100 && !record; attempt += 1) {
    record = observeExactProcessGeneration(child.pid);
    if (!record) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(record).toBeDefined();
  const observation = processMemberSnapshots([child.pid]);
  expect(observation.status).toBe("complete");
  expect(observation.members).toHaveLength(1);
  expect(observation.members[0].sessionId).toBe(child.pid);
  const observedStart = Date.parse(
    `${record.startMarker.slice("ps-lstart-v1:".length)} UTC`,
  );
  expect(Number.isFinite(observedStart)).toBe(true);
  return {
    child,
    closed,
    member: observation.members[0],
    owned: {
      groupId: record.groupId,
      kernelStartMarker: persistedKernelMarker(
        observation.members[0].processIdentity,
      ),
      parentPid: record.parentPid,
      pid: record.pid,
      sessionId: record.sessionId,
      startMarker: record.startMarker,
    },
    protocolStartMarker: `${child.pid}-${observedStart}`,
  };
}

async function stopDetachedGroup(group) {
  if (group.child.exitCode === null && group.child.signalCode === null) {
    group.child.kill("SIGKILL");
  }
  return group.closed;
}

function writeSessionManifest(
  discoveryRoot,
  { hostProcess, lifecycle, providerProcess, terminalEpoch },
) {
  const common = {
    host_instance_id: "host-1",
    host_process: hostProcess,
    lifetime: {
      channel_epoch: 1,
      runner_instance: "runner-1",
      runner_principal: "local-user",
      session_id: "session-1",
      workspace_id: "workspace-1",
    },
    session_class: "standalone",
  };
  fs.writeFileSync(
    path.join(discoveryRoot, "w_workspace/s_session/manifest.json"),
    `${JSON.stringify({
      lifecycle,
      manifest: providerProcess
        ? {
            common,
            provider_process: providerProcess,
            terminal_epoch: terminalEpoch,
          }
        : { common },
    })}\n`,
    { mode: 0o600 },
  );
}

function processProof(group) {
  return {
    process_id: group.child.pid,
    start_marker: group.protocolStartMarker,
  };
}

function writeStartingManifest(context, group) {
  writeSessionManifest(context.discoveryRoot, {
    hostProcess: processProof(group),
    lifecycle: "starting",
  });
}

function writeReadyManifest(context, host, provider) {
  writeSessionManifest(context.discoveryRoot, {
    hostProcess: processProof(host),
    lifecycle: "ready",
    providerProcess: processProof(provider),
    terminalEpoch: "terminal-1",
  });
}

function fixture() {
  const stateRoot = fs.mkdtempSync(
    path.join(fs.realpathSync("/tmp"), "dure-hmux-test."),
  );
  temporaryDirectories.push(stateRoot);
  fs.chmodSync(stateRoot, 0o700);
  fs.writeFileSync(
    path.join(stateRoot, "hmux-test-owner-v2.json"),
    `${JSON.stringify({
      guardianProcess: {
        kernelStartMarker: "fixture-kernel-generation",
        pid: process.pid,
        startMarker: "fixture-process-generation",
      },
      schema: "dure-hmux-test-owner/v2",
      worktreeRoot: fs.realpathSync(process.cwd()),
    })}\n`,
    { mode: 0o600 },
  );
  const discoveryRoot = path.join(stateRoot, "tmp/fixture/discovery");
  const sessionDirectory = path.join(discoveryRoot, "w_workspace", "s_session");
  fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  writeSessionManifest(discoveryRoot, {
    hostProcess: {
      process_id: 21_001,
      start_marker: "macos-proc-start:1700000000:111",
    },
    lifecycle: "ready",
    providerProcess: {
      process_id: 21_002,
      start_marker: "macos-proc-start:1700000000:222",
    },
    terminalEpoch: "terminal-1",
  });
  const state = path.join(stateRoot, "fake-state");
  const invocations = path.join(stateRoot, "fake-invocations");
  const nativeLiveness = path.join(stateRoot, "fake-native-liveness");
  const hmuxCli = path.join(stateRoot, "hmux");
  fs.writeFileSync(
    hmuxCli,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      `const state = ${JSON.stringify(state)};`,
      `const invocations = ${JSON.stringify(invocations)};`,
      `const nativeLiveness = ${JSON.stringify(nativeLiveness)};`,
      "const args = process.argv.slice(2);",
      'if (args.includes("kill")) {',
      '  fs.writeFileSync(state, "retired\\n");',
      '  fs.writeFileSync(invocations, JSON.stringify(args) + "\\n");',
      '  process.stdout.write(JSON.stringify({ok:true,sessionClass:"standalone",sessionId:"session-1"}));',
      "} else {",
      "  const pid = Number(args.at(-2));",
      "  const marker = args.at(-1);",
      "  let live = true;",
      '  if (fs.existsSync(nativeLiveness)) { try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") live = false; else throw error; } }',
      '  process.stdout.write(JSON.stringify({schemaVersion:1,status:fs.existsSync(state)||!live?"absent":"live",process:{process_id:pid,start_marker:marker}}));',
      "}",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const hmuxRuntime = path.join(stateRoot, "hmux-runtime");
  fs.writeFileSync(hmuxRuntime, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  return {
    discoveryRoot,
    expectedStateRootIdentity: authorizeIsolatedRootRetirement(
      stateRoot,
      fs.realpathSync("/tmp"),
    ),
    hmuxCli,
    hmuxRuntime,
    invocations,
    nativeLiveness,
    ownedProcesses: [],
    state,
    stateRoot,
  };
}

async function reapFixture(context) {
  const ownedProcessSnapshot = await captureOwnedProcessSnapshot(
    context.ownedProcesses,
    {
      observeIdentities: context.observeProcessIdentities,
      platform: context.platform,
    },
  );
  return reapHmuxTestState({ ...context, ownedProcessSnapshot });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("Hmux test state cleanup", () => {
  test("discovers only canonical manifests under its owner-only root", () => {
    const context = fixture();
    const backup = path.join(context.stateRoot, "tmp/source-session-backup");
    fs.mkdirSync(backup, { recursive: true });
    fs.copyFileSync(
      path.join(
        context.discoveryRoot,
        "w_workspace/s_session/manifest.json",
      ),
      path.join(backup, "manifest.json"),
    );

    expect(findHmuxTestDiscoveryRoots(context.stateRoot)).toEqual([
      context.discoveryRoot,
    ]);
  });

  test("discovers the complete root when fixture state exceeds one scan buffer", () => {
    const context = fixture();
    const files = path.join(context.stateRoot, "fixture-files");
    fs.mkdirSync(files);
    for (let index = 0; index < 5_320; index += 1) {
      fs.writeFileSync(path.join(files, `${index}.json`), "{}\n");
    }
    // A second real manifest in the large directory must not be skipped along
    // with Git/fixture data, nor lost when a traversal returns a partial result.
    const other = path.join(files, "discovery");
    fs.mkdirSync(path.join(other, "w_other/s_other"), { recursive: true });
    fs.copyFileSync(
      path.join(context.discoveryRoot, "w_workspace/s_session/manifest.json"),
      path.join(other, "w_other/s_other/manifest.json"),
    );

    expect(findHmuxTestDiscoveryRoots(context.stateRoot)).toEqual(
      [context.discoveryRoot, other].sort(),
    );
  });

  test("refuses incomplete discovery when the cleanup deadline has expired", () => {
    const context = fixture();
    expect(() => findHmuxTestDiscoveryRoots(context.stateRoot, {
      deadline: performance.now() - 1,
    })).toThrow("state scan deadline exceeded");
    expect(fs.existsSync(context.state)).toBe(false);
    expect(fs.existsSync(context.invocations)).toBe(false);
  });

  test("closes every directory and refuses partial roots after scan expiry", () => {
    const context = fixture();
    const open = fs.opendirSync.bind(fs);
    const streams = [];
    let expired = false;
    vi.spyOn(performance, "now").mockImplementation(() => expired ? 101 : 99);
    vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
      const directory = open(...args);
      const read = directory.readSync.bind(directory);
      let foundManifest = false;
      vi.spyOn(directory, "readSync").mockImplementation(() => {
        const entry = read();
        // Let the scanner consume a valid manifest, then expire its next read.
        if (foundManifest) expired = true;
        foundManifest ||= entry?.name === "manifest.json";
        return entry;
      });
      streams.push(vi.spyOn(directory, "closeSync"));
      return directory;
    });

    expect(() => findHmuxTestDiscoveryRoots(context.stateRoot, {
      deadline: 100,
    })).toThrow("state scan deadline exceeded");
    expect(streams.length).toBeGreaterThan(1);
    for (const close of streams) expect(close).toHaveBeenCalledOnce();
    expect(fs.existsSync(context.state)).toBe(false);
    expect(fs.existsSync(context.invocations)).toBe(false);
  });

  test("shares the reaper deadline before it can terminate any session", async () => {
    const context = fixture();
    await expect(reapFixture({ ...context, waitMs: 0 })).rejects.toThrow(
      "state scan deadline exceeded",
    );
    expect(fs.existsSync(context.state)).toBe(false);
    expect(fs.existsSync(context.invocations)).toBe(false);
  });

  test("terminates a Ready session through its complete fence", async () => {
    const context = fixture();

    const receipt = await reapFixture(context);

    expect(receipt).toEqual({
      observedProcesses: 2,
      observedSessions: 1,
      schema: "dure-hmux-test-reap/v1",
    });
    const invocation = JSON.parse(
      fs.readFileSync(context.invocations, "utf8"),
    );
    expect(invocation).toContain("kill");
    const fence = JSON.parse(
      invocation[invocation.indexOf("--expected-fence-json") + 1],
    );
    expect(fence).toEqual({
      channel_epoch: "1",
      host_instance_id: "host-1",
      runner_instance: "runner-1",
      runner_principal: "local-user",
      session_id: "session-1",
      terminal_epoch: "terminal-1",
      workspace_id: "workspace-1",
    });
  });

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "refuses direct group retirement after same-marker PID reuse",
    async () => {
      const context = fixture();
      const group = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [
          {
            ...group.owned,
            kernelStartMarker: replacementKernelMarker(
              group.owned.kernelStartMarker,
            ),
          },
        ];
        context.observeProcessMembers = async (request) => ({
          members: [group.member],
          scope: { kind: "point", requestedPids: request.pids },
          status: "complete",
        });
        writeStartingManifest(context, group);

        await expect(
          reapFixture(context),
        ).rejects.toThrow(
          "manifest Host process-group leader changed after ownership publication",
        );
        expect(group.child.exitCode).toBeNull();
        expect(group.child.signalCode).toBeNull();
      } finally {
        await stopDetachedGroup(group);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "takes Starting Host session membership from one exact point observation",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      const sessionGroup = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [host.owned, sessionGroup.owned];
        let observationCalls = 0;
        context.observeProcessMembers = async (request) => {
          observationCalls += 1;
          expect(request).toEqual({
            kind: "point",
            pids: [host.member.pid, sessionGroup.member.pid].sort(
              (left, right) => left - right,
            ),
          });
          return {
            members: [
              { ...sessionGroup.member, sessionId: host.member.pid },
              { ...host.member, sessionId: host.member.pid },
            ],
            scope: { kind: "point", requestedPids: request.pids },
            status: "complete",
          };
        };
        writeStartingManifest(context, host);

        await expect(reapFixture(context)).resolves.toEqual({
          observedProcesses: 1,
          observedSessions: 1,
          schema: "dure-hmux-test-reap/v1",
        });
        expect(observationCalls).toBe(1);
        await expect(host.closed).resolves.toMatchObject({ signal: "SIGKILL" });
        await expect(sessionGroup.closed).resolves.toMatchObject({
          signal: "SIGKILL",
        });
      } finally {
        await Promise.all([
          stopDetachedGroup(host),
          stopDetachedGroup(sessionGroup),
        ]);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "narrows a 4,076-entry stale ledger by current-user identity before observing a Starting Host",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [
          ...historicalOwnedGenerations(4_075, new Set([host.owned.pid])),
          host.owned,
        ];
        let identityCensusCalls = 0;
        context.platform = "darwin";
        context.observeProcessIdentities = async () => {
          identityCensusCalls += 1;
          return userIdentityCensus([
            {
              pid: host.owned.pid,
              processIdentity: host.member.processIdentity,
            },
          ]);
        };
        context.observeProcessMembers = async (request) => {
          expect(request).toEqual({
            kind: "point",
            pids: [host.member.pid],
          });
          return {
            members: [{ ...host.member, sessionId: host.member.pid }],
            scope: { kind: "point", requestedPids: request.pids },
            status: "complete",
          };
        };
        writeStartingManifest(context, host);

        await expect(reapFixture(context)).resolves.toEqual({
          observedProcesses: 1,
          observedSessions: 1,
          schema: "dure-hmux-test-reap/v1",
        });
        expect(identityCensusCalls).toBe(2);
        await expect(host.closed).resolves.toMatchObject({ signal: "SIGKILL" });
      } finally {
        await stopDetachedGroup(host);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "refuses a Starting Host retirement when its user identity census is incomplete",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [host.owned];
        context.platform = "darwin";
        context.observeProcessIdentities = async () => ({
          reason: "process_identity_observation_timeout",
          status: "incomplete",
        });
        context.observeProcessMembers = async () => {
          throw new Error("metadata observation must not run");
        };
        writeStartingManifest(context, host);

        await expect(reapFixture(context)).rejects.toThrow(
          "owned_process_identity_snapshot_unavailable",
        );
        expect(host.child.exitCode).toBeNull();
        expect(host.child.signalCode).toBeNull();
      } finally {
        await stopDetachedGroup(host);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "reuses one exact observation for a stopped Ready Host",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      const provider = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [provider.owned, host.owned];
        let observationCalls = 0;
        context.observeProcessMembers = async (request) => {
          observationCalls += 1;
          return {
            members: [
              { ...provider.member, sessionId: host.member.pid },
              {
                ...host.member,
                sessionId: host.member.pid,
                state: "stopped",
              },
            ],
            scope: { kind: "point", requestedPids: request.pids },
            status: "complete",
          };
        };
        writeReadyManifest(context, host, provider);

        await expect(reapFixture(context)).resolves.toEqual({
          observedProcesses: 2,
          observedSessions: 1,
          schema: "dure-hmux-test-reap/v1",
        });
        expect(observationCalls).toBe(1);
        expect(fs.existsSync(context.invocations)).toBe(false);
        expect(fs.existsSync(context.state)).toBe(false);
        await expect(provider.closed).resolves.toMatchObject({
          signal: "SIGKILL",
        });
        await expect(host.closed).resolves.toMatchObject({ signal: "SIGKILL" });
      } finally {
        await Promise.all([
          stopDetachedGroup(provider),
          stopDetachedGroup(host),
        ]);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "plans provider, Host, and remaining session groups once in that order",
    async () => {
      const groups = await Promise.all([
        detachedGroup(),
        detachedGroup(),
        detachedGroup(),
      ]);
      const [remaining, host, provider] = groups.sort(
        (left, right) => left.child.pid - right.child.pid,
      );
      try {
        const observation = {
          members: [provider.member, host.member, remaining.member].map(
            (member) => ({ ...member, sessionId: host.member.pid }),
          ),
          status: "complete",
        };
        const processSnapshot = await captureOwnedProcessSnapshot([
          host.owned,
          remaining.owned,
          provider.owned,
        ], { platform: "linux" });
        const plan = planManifestProcessRetirement(
          {
            hostProcess: {
              process_id: host.child.pid,
              start_marker: host.protocolStartMarker,
            },
            providerProcess: {
              process_id: provider.child.pid,
              start_marker: provider.protocolStartMarker,
            },
          },
          processSnapshot,
          observation,
        );

        expect(plan.map(({ pid }) => pid)).toEqual([
          provider.child.pid,
          host.child.pid,
          remaining.child.pid,
        ]);
      } finally {
        await Promise.all(groups.map(stopDetachedGroup));
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "validates every session group before retiring any process",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      const unanchored = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [host.owned, unanchored.owned];
        context.observeProcessMembers = async (request) => ({
          members: [
            { ...host.member, sessionId: host.member.pid },
            {
              ...unanchored.member,
              groupId: unanchored.member.pid + 1,
              sessionId: host.member.pid,
            },
          ],
          scope: { kind: "point", requestedPids: request.pids },
          status: "complete",
        });
        writeStartingManifest(context, host);

        await expect(reapFixture(context)).rejects.toThrow(
          `manifest Host session retained an unanchored group ${unanchored.member.pid + 1}`,
        );
        expect(host.child.exitCode).toBeNull();
        expect(host.child.signalCode).toBeNull();
        expect(unanchored.child.exitCode).toBeNull();
        expect(unanchored.child.signalCode).toBeNull();
      } finally {
        await Promise.all([
          stopDetachedGroup(host),
          stopDetachedGroup(unanchored),
        ]);
      }
    },
  );

  test.runIf(["darwin", "linux"].includes(process.platform))(
    "refuses incomplete session membership before retiring the Host",
    async () => {
      const context = fixture();
      const host = await detachedGroup();
      try {
        fs.writeFileSync(context.nativeLiveness, "native\n", { mode: 0o600 });
        context.ownedProcesses = [host.owned];
        context.observeProcessMembers = async (request) => ({
          reason: "fixture_incomplete",
          scope: { kind: "point", requestedPids: request.pids },
          status: "incomplete",
        });
        writeStartingManifest(context, host);

        await expect(reapFixture(context)).rejects.toThrow(
          "owned process observation is incomplete: fixture_incomplete",
        );
        expect(host.child.exitCode).toBeNull();
        expect(host.child.signalCode).toBeNull();
      } finally {
        await stopDetachedGroup(host);
      }
    },
  );

  test("refuses a replacement root before invoking Hmux or mutating its state", async () => {
    const context = fixture();
    const original = `${context.stateRoot}.original`;
    temporaryDirectories.push(original);
    fs.renameSync(context.stateRoot, original);
    fs.cpSync(original, context.stateRoot, { recursive: true });
    const sentinel = path.join(context.stateRoot, "replacement.txt");
    fs.writeFileSync(sentinel, "replacement\n", { mode: 0o600 });

    await expect(reapFixture(context)).rejects.toThrow(
      "state root generation changed after authorization",
    );
    expect(fs.existsSync(context.invocations)).toBe(false);
    expect(fs.existsSync(context.state)).toBe(false);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("replacement\n");
    expect(fs.existsSync(original)).toBe(true);
  });

  test("refuses a group-readable state root", () => {
    const context = fixture();
    fs.chmodSync(context.stateRoot, 0o750);

    expect(() => findHmuxTestDiscoveryRoots(context.stateRoot)).toThrow(
      "outside the owner-only test boundary",
    );
  });

  test("completely inspects deeply nested fixture data, including session manifests", () => {
    const context = fixture();
    let directory = path.join(context.stateRoot, "deep");
    for (let depth = 0; depth < 11; depth += 1) {
      fs.mkdirSync(directory, { recursive: true });
      directory = path.join(directory, `level-${depth}`);
    }

    const nestedDiscovery = path.join(directory, "discovery");
    fs.mkdirSync(path.join(nestedDiscovery, "w_nested/s_nested"), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(context.discoveryRoot, "w_workspace/s_session/manifest.json"),
      path.join(nestedDiscovery, "w_nested/s_nested/manifest.json"),
    );
    expect(findHmuxTestDiscoveryRoots(context.stateRoot)).toEqual(
      [context.discoveryRoot, nestedDiscovery].sort(),
    );
    expect(fs.existsSync(context.invocations)).toBe(false);
  });
});
