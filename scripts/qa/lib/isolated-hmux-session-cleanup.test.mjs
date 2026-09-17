import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  assertIsolatedCleanupBoundary,
  collectIsolatedHmuxCleanupTargets,
  processOwnershipGuard,
  reapIsolatedHmuxSessions,
} from "./isolated-hmux-session-cleanup.mjs";

const temporaryDirectories = [];

function fixture(prefix = "dure-hmux-cleanup-test-") {
  const stateRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), prefix),
  );
  temporaryDirectories.push(stateRoot);
  const discoveryRoot = path.join(stateRoot, "hmux-discovery");
  fs.mkdirSync(discoveryRoot, { mode: 0o700 });
  const hmuxCli = path.join(stateRoot, "hmux");
  const hmuxRuntime = path.join(stateRoot, "hmux-runtime");
  fs.writeFileSync(hmuxCli, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  fs.writeFileSync(hmuxRuntime, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  return { discoveryRoot, hmuxCli, hmuxRuntime, stateRoot };
}

function manifestEnvelope({
  hostInstanceId = "host-1",
  lifecycle = "ready",
  sessionClass = "standalone",
  terminalEpoch = "terminal-1",
} = {}) {
  const common = {
    host_instance_id: hostInstanceId,
    host_process: {
      process_id: 21001,
      start_marker: "macos-proc-start:1700000000:111",
    },
    lifetime: {
      channel_epoch: 1,
      runner_instance: "runner-1",
      runner_principal: "local-user",
      session_id: "session-1",
      workspace_id: "workspace-1",
    },
    session_class: sessionClass,
  };
  const providerProcess = {
    process_id: 21002,
    start_marker: "macos-proc-start:1700000000:222",
  };
  const fence = {
    channel_epoch: "1",
    host_instance_id: hostInstanceId,
    runner_instance: "runner-1",
    runner_principal: "local-user",
    session_id: "session-1",
    terminal_epoch: terminalEpoch,
    workspace_id: "workspace-1",
  };
  if (lifecycle === "starting") {
    return {
      lifecycle,
      manifest: { common, starting_unix_ms: 1 },
    };
  }
  if (lifecycle === "exited") {
    return {
      lifecycle,
      manifest: {
        capability_token: "token",
        common,
        endpoint: { address: "/tmp/host.sock", kind: "unix_socket" },
        exited_unix_ms: 3,
        tombstone: {
          created_unix_ms: 3,
          exit: {
            exit_code: 0,
            platform_status: null,
            reason: "provider_exited",
          },
          exit_kind: "normal",
          fence,
          provider_process: providerProcess,
        },
      },
    };
  }
  return {
    lifecycle,
    manifest: {
      capability_token: "token",
      common,
      endpoint: { address: "/tmp/host.sock", kind: "unix_socket" },
      provider_process: providerProcess,
      ready_output_seq: 1,
      ready_unix_ms: 2,
      terminal_epoch: terminalEpoch,
    },
  };
}

function writeManifest(discoveryRoot, envelope) {
  const directory = path.join(
    discoveryRoot,
    "workspace-1",
    "session-1",
  );
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "manifest.json");
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return file;
}

function commandResult(payload) {
  return {
    pid: 1,
    signal: null,
    status: 0,
    stderr: "",
    stdout: JSON.stringify(payload),
  };
}

const allowOwnedProcesses = {
  assertOwned() {},
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("isolated Hmux session cleanup", () => {
  test("accepts a legacy Hebbian QA root during migration", () => {
    const context = fixture("hebbian-hmux-cleanup-test-");

    expect(
      assertIsolatedCleanupBoundary(
        context.stateRoot,
        context.discoveryRoot,
      ).stateRoot,
    ).toBe(context.stateRoot);
  });

  test("binds live manifest processes to the QA ownership ledger generation", () => {
    const context = fixture();
    const descriptorPath = path.join(
      context.stateRoot,
      "app-process-group.json",
    );
    fs.writeFileSync(descriptorPath, "{}\n", { mode: 0o600 });
    const boundary = assertIsolatedCleanupBoundary(
      context.stateRoot,
      context.discoveryRoot,
    );
    const descriptor = { descriptorPath };
    const process = {
      process_id: 21_001,
      start_marker: "manifest-generation",
    };
    const processIdentity =
      "kernel-start-v3:macos:01234567-89ab-cdef-0123-456789abcdef:111";
    const reusedIdentity =
      "kernel-start-v3:macos:01234567-89ab-cdef-0123-456789abcdef:222";
    const pointObservation = (members) => ({
      members,
      scope: { kind: "point", requestedPids: [21_001] },
      status: "complete",
    });
    const owners = [{ descriptorPath, supervisorPid: 20_001 }];
    const exactLedger = [
      { kernelStartMarker: processIdentity, pid: 21_001 },
    ];
    const guardWith = (observeMembers, ledger = exactLedger) =>
      processOwnershipGuard(boundary, owners, {
        isLive: () => {
          throw new Error("legacy liveness authority was used");
        },
        observeMembers,
        readGroup: () => descriptor,
        readLedger: () => ledger,
        readTable: () => {
          throw new Error("legacy process table was opened");
        },
      });
    const observedMember = (state = "live", identity = processIdentity) => ({
      groupId: 21_001,
      pid: 21_001,
      processIdentity: identity,
      state,
    });
    let observations = 0;
    const guard = guardWith(() => {
      observations += 1;
      return pointObservation([observedMember()]);
    });

    expect(() => guard.assertOwned(process, "live")).not.toThrow();
    expect(observations).toBe(1);
    expect(guard.assertOwned(process, "absent")).toBeUndefined();
    expect(observations).toBe(1);
    expect(() =>
      guard.assertOwned({ ...process, process_id: 99_001 }, "live"),
    ).toThrow("not owned by this QA run");

    expect(() =>
      guardWith(() =>
        pointObservation([observedMember("stopped")]),
      ).assertOwned(process, "live"),
    ).not.toThrow();
    const reused = guardWith(() =>
      pointObservation([observedMember("live", reusedIdentity)]),
    );
    expect(() => reused.assertOwned(process, "live")).toThrow(
      "not the live generation owned by this QA run",
    );

    const departed = guardWith(() => pointObservation([]));
    expect(departed.assertOwned(process, "live")).toBe("departed");
    const zombie = guardWith(() =>
      pointObservation([observedMember("zombie")]),
    );
    expect(zombie.assertOwned(process, "live")).toBe("departed");

    const incomplete = guardWith(() => ({
      reason: "fixture",
      status: "incomplete",
    }));
    expect(() => incomplete.assertOwned(process, "live")).toThrow(
      "identity observation is incomplete",
    );

    const legacyLedger = [
      { kernelStartMarker: "kernel-start-v1:linux:111", pid: 21_001 },
    ];
    expect(
      guardWith(() => pointObservation([]), legacyLedger).assertOwned(
        process,
        "live",
      ),
    ).toBe("departed");
    expect(() =>
      guardWith(
        () =>
          pointObservation([
            observedMember("live", "linux:fixture-boot:111"),
          ]),
        legacyLedger,
      ).assertOwned(process, "live"),
    ).toThrow("legacy Linux process generation");
  });

  test.each(["standalone", "managed"])(
    "terminates a %s session through its complete Hmux fence",
    async (sessionClass) => {
      const context = fixture();
      const manifest = writeManifest(
        context.discoveryRoot,
        manifestEnvelope({ sessionClass }),
      );
      const invocations = [];
      let terminated = false;
      const spawnSync = (_command, args) => {
        invocations.push(args);
        if (args.includes("kill")) {
          terminated = true;
          fs.writeFileSync(
            manifest,
            `${JSON.stringify(
              manifestEnvelope({ lifecycle: "exited", sessionClass }),
            )}\n`,
          );
          return commandResult({
            ok: true,
            sessionClass,
            sessionId: "session-1",
            sessionName: null,
          });
        }
        const pid = Number(args.at(-2));
        const marker = args.at(-1);
        return commandResult({
          process: { process_id: pid, start_marker: marker },
          schemaVersion: 1,
          status: terminated ? "absent" : "live",
        });
      };

      const result = await reapIsolatedHmuxSessions(
        { ...context, waitMs: 500 },
        {
          ownershipGuard: allowOwnedProcesses,
          sleep: async () => {},
          spawnSync,
        },
      );

      expect(result.terminatedSessions).toBe(1);
      expect(result.schema).toBe("dure-qa-hmux-reap/v1");
      const stateRootStat = fs.lstatSync(context.stateRoot);
      expect(result.stateRootIdentity).toEqual({
        device: String(stateRootStat.dev),
        inode: String(stateRootStat.ino),
      });
      const kill = invocations.find((args) => args.includes("kill"));
      expect(kill).toBeDefined();
      expect(kill).toContain("--workspace");
      expect(kill).toContain("workspace-1");
      expect(kill).toContain("--expected-fence-json");
      expect(
        JSON.parse(kill[kill.indexOf("--expected-fence-json") + 1]),
      ).toEqual({
        channel_epoch: "1",
        host_instance_id: "host-1",
        runner_instance: "runner-1",
        runner_principal: "local-user",
        session_id: "session-1",
        terminal_epoch: "terminal-1",
        workspace_id: "workspace-1",
      });
      expect(invocations.every((args) => !args.includes("SIGKILL"))).toBe(true);
    },
  );

  test("accepts a legacy numeric tombstone fence but emits canonical string fences", () => {
    const context = fixture();
    const envelope = manifestEnvelope({ lifecycle: "exited" });
    envelope.manifest.tombstone.fence.channel_epoch = 1;
    writeManifest(context.discoveryRoot, envelope);

    const [target] = collectIsolatedHmuxCleanupTargets(
      context.discoveryRoot,
    );

    expect(target.fence.channel_epoch).toBe("1");
  });

  test("fails closed with a pre-capability Hmux CLI", async () => {
    const context = fixture();
    const manifest = writeManifest(
      context.discoveryRoot,
      manifestEnvelope({ sessionClass: "managed" }),
    );
    const invocations = [];

    await expect(
      reapIsolatedHmuxSessions(
        { ...context, waitMs: 500 },
        {
          ownershipGuard: allowOwnedProcesses,
          spawnSync(_command, args) {
            invocations.push(args);
            return {
              error: undefined,
              pid: 1,
              signal: null,
              status: 2,
              stderr: "unknown option --workspace",
              stdout: "",
            };
          },
        },
      ),
    ).rejects.toThrow("command exited 2");

    expect(JSON.parse(fs.readFileSync(manifest, "utf8")).lifecycle).toBe(
      "ready",
    );
    expect(fs.lstatSync(context.stateRoot).isDirectory()).toBe(true);
    expect(invocations.every((args) => !args.includes("SIGKILL"))).toBe(true);
  });

  test("waits without signaling for an exited Host generation to finish its grace period", async () => {
    const context = fixture();
    writeManifest(
      context.discoveryRoot,
      manifestEnvelope({ lifecycle: "exited" }),
    );
    const invocations = [];
    let hostProbes = 0;

    const result = await reapIsolatedHmuxSessions(
      { ...context, waitMs: 500 },
      {
        ownershipGuard: {
          assertOwned() {
            throw new Error(
              "an exited tombstone must only be observed, never signaled",
            );
          },
        },
        sleep: async () => {},
        spawnSync(_command, args) {
          invocations.push(args);
          const pid = Number(args.at(-2));
          const marker = args.at(-1);
          const isHost = pid === 21_001;
          if (isHost) hostProbes += 1;
          return commandResult({
            process: { process_id: pid, start_marker: marker },
            schemaVersion: 1,
            status: isHost && hostProbes === 1 ? "live" : "absent",
          });
        },
      },
    );

    expect(hostProbes).toBeGreaterThan(1);
    expect(result.terminatedSessions).toBe(0);
    expect(invocations.some((args) => args.includes("kill"))).toBe(false);
  });

  test("re-observes a departed ownership race before terminating a ready session", async () => {
    const context = fixture();
    const manifest = writeManifest(
      context.discoveryRoot,
      manifestEnvelope(),
    );
    const invocations = [];
    let ownershipChecks = 0;
    let ownershipChecksAtKill = 0;
    let terminated = false;

    const result = await reapIsolatedHmuxSessions(
      { ...context, waitMs: 500 },
      {
        ownershipGuard: {
          assertOwned() {
            ownershipChecks += 1;
            return ownershipChecks === 1 ? "departed" : undefined;
          },
        },
        sleep: async () => {},
        spawnSync(_command, args) {
          invocations.push(args);
          if (args.includes("kill")) {
            ownershipChecksAtKill = ownershipChecks;
            terminated = true;
            fs.writeFileSync(
              manifest,
              `${JSON.stringify(
                manifestEnvelope({ lifecycle: "exited" }),
              )}\n`,
            );
            return commandResult({
              ok: true,
              sessionClass: "standalone",
              sessionId: "session-1",
              sessionName: null,
            });
          }
          const pid = Number(args.at(-2));
          const marker = args.at(-1);
          return commandResult({
            process: { process_id: pid, start_marker: marker },
            schemaVersion: 1,
            status: terminated ? "absent" : "live",
          });
        },
      },
    );

    expect(result.terminatedSessions).toBe(1);
    expect(ownershipChecksAtKill).toBe(4);
    expect(invocations.filter((args) => args.includes("kill"))).toHaveLength(
      1,
    );
  });

  test("preserves an exited session whose exact Host generation outlives the deadline", async () => {
    const context = fixture();
    writeManifest(
      context.discoveryRoot,
      manifestEnvelope({ lifecycle: "exited" }),
    );
    const invocations = [];

    await expect(
      reapIsolatedHmuxSessions(
        { ...context, waitMs: 0 },
        {
          ownershipGuard: {
            assertOwned() {
              throw new Error(
                "an exited tombstone must only be observed, never signaled",
              );
            },
          },
          spawnSync(_command, args) {
            invocations.push(args);
            const pid = Number(args.at(-2));
            const marker = args.at(-1);
            return commandResult({
              process: { process_id: pid, start_marker: marker },
              schemaVersion: 1,
              status: pid === 21_001 ? "live" : "absent",
            });
          },
        },
      ),
    ).rejects.toThrow("did not become quiescent");

    expect(invocations.some((args) => args.includes("kill"))).toBe(false);
  });

  test("refuses a copied foreign manifest before session termination", async () => {
    const context = fixture();
    writeManifest(
      context.discoveryRoot,
      manifestEnvelope({ sessionClass: "managed" }),
    );
    const invocations = [];

    await expect(
      reapIsolatedHmuxSessions(
        { ...context, waitMs: 500 },
        {
          ownershipGuard: {
            assertOwned(process) {
              throw new Error(`foreign process ${process.process_id}`);
            },
          },
          spawnSync(_command, args) {
            invocations.push(args);
            const pid = Number(args.at(-2));
            const marker = args.at(-1);
            return commandResult({
              process: { process_id: pid, start_marker: marker },
              schemaVersion: 1,
              status: "live",
            });
          },
        },
      ),
    ).rejects.toThrow("foreign process 21001");

    expect(invocations.some((args) => args.includes("kill"))).toBe(false);
  });

  test.each(["starting", "ready"])(
    "requires ownership for an absent %s manifest process",
    async (lifecycle) => {
      const context = fixture();
      writeManifest(
        context.discoveryRoot,
        manifestEnvelope({ lifecycle }),
      );
      const invocations = [];

      await expect(
        reapIsolatedHmuxSessions(
          { ...context, waitMs: 0 },
          {
            ownershipGuard: {
              assertOwned(process) {
                throw new Error(`foreign process ${process.process_id}`);
              },
            },
            spawnSync(_command, args) {
              invocations.push(args);
              const pid = Number(args.at(-2));
              const marker = args.at(-1);
              return commandResult({
                process: { process_id: pid, start_marker: marker },
                schemaVersion: 1,
                status: "absent",
              });
            },
          },
        ),
      ).rejects.toThrow("foreign process 21001");

      expect(invocations.some((args) => args.includes("kill"))).toBe(false);
    },
  );

  test("refuses a starting Host that remains live instead of signaling its pid", async () => {
    const context = fixture();
    writeManifest(
      context.discoveryRoot,
      manifestEnvelope({ lifecycle: "starting" }),
    );
    const invocations = [];

    await expect(
      reapIsolatedHmuxSessions(
        { ...context, waitMs: 0 },
        {
          ownershipGuard: allowOwnedProcesses,
          spawnSync(_command, args) {
            invocations.push(args);
            const pid = Number(args.at(-2));
            const marker = args.at(-1);
            return commandResult({
              process: { process_id: pid, start_marker: marker },
              schemaVersion: 1,
              status: "live",
            });
          },
        },
      ),
    ).rejects.toThrow("did not become quiescent");

    expect(invocations.some((args) => args.includes("kill"))).toBe(false);
  });

  test("rejects a mismatched state root before invoking Hmux", async () => {
    const context = fixture();
    const foreign = fixture();
    let invoked = false;

    expect(() =>
      assertIsolatedCleanupBoundary(
        context.stateRoot,
        foreign.discoveryRoot,
      ),
    ).toThrow("authorized QA child");
    await expect(
      reapIsolatedHmuxSessions(
        {
          ...context,
          discoveryRoot: foreign.discoveryRoot,
          waitMs: 0,
        },
        {
          spawnSync() {
            invoked = true;
          },
        },
      ),
    ).rejects.toThrow("authorized QA child");
    expect(invoked).toBe(false);
  });

  test("rejects an incomplete Host cleanup receipt", () => {
    const context = fixture();
    const envelope = manifestEnvelope({ lifecycle: "exited" });
    envelope.manifest.tombstone.exit.reason =
      "provider_exited; process_session_cleanup_incomplete";
    writeManifest(context.discoveryRoot, envelope);

    expect(() =>
      collectIsolatedHmuxCleanupTargets(context.discoveryRoot),
    ).toThrow("incomplete provider process cleanup");
  });

  test.each(["01", "-1", 1.5, "not-an-epoch"])(
    "rejects malformed tombstone channel epoch %j",
    (channelEpoch) => {
      const context = fixture();
      const envelope = manifestEnvelope({ lifecycle: "exited" });
      envelope.manifest.tombstone.fence.channel_epoch = channelEpoch;
      writeManifest(context.discoveryRoot, envelope);

      expect(() =>
        collectIsolatedHmuxCleanupTargets(context.discoveryRoot),
      ).toThrow("does not match its manifest: channel_epoch");
    },
  );

  test("does not follow manifest symlinks outside the isolated root", () => {
    const context = fixture();
    const foreign = fixture();
    writeManifest(foreign.discoveryRoot, manifestEnvelope());
    fs.symlinkSync(
      foreign.discoveryRoot,
      path.join(context.discoveryRoot, "foreign"),
    );

    expect(
      collectIsolatedHmuxCleanupTargets(context.discoveryRoot),
    ).toEqual([]);
  });
});
