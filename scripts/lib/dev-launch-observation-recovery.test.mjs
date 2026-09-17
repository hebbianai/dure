import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { superviseDevLaunch } from "./dev-launch-supervisor.mjs";
import { appControlDirectory } from "./app-channel.mjs";
import { DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY } from "./dev-launch-contract.mjs";
import { processIdentity } from "./process-identity.mjs";
import { observeOwnedProcessGroup } from "./process-group-authority.mjs";
import {
  createDevLaunchFixtureRegistry,
  processGroupWitnessModuleUrl,
  sendDevLaunchFixtureFrame,
  startManagedDevLaunchFixture,
} from "./dev-launch-test-support.mjs";

const fault = vi.hoisted(() => ({ pid: null, observed: null }));
vi.mock("./process-group-authority.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    observeOwnedProcessGroup: async (identity, options) => {
      if (identity.pid === fault.pid) {
        fault.observed?.();
        return { state: "unproven", reason: "fixture_observation_unavailable" };
      }
      return actual.observeOwnedProcessGroup(identity, options);
    },
  };
});

it.runIf(process.platform !== "win32")(
  "retains the control endpoint until an unobservable child can be retired",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dure-launch-observation-"));
    const fixtureProcesses = createDevLaunchFixtureRegistry();
    const stopPath = join(root, "stop");
    const terminatedPath = join(root, "terminated");
    const childPath = join(root, "child.mjs");
    writeFileSync(
      childPath,
      `
import { existsSync, writeFileSync } from "node:fs";
process.on("SIGTERM", () => {
  writeFileSync(process.argv[3], "terminated");
  process.exit(0);
});
setInterval(() => { if (existsSync(process.argv[2])) process.exit(0); }, 20);
`,
      { mode: 0o600 },
    );
    const signalListeners = new Set(process.listeners("SIGTERM"));
    const fixture = startManagedDevLaunchFixture({
      fixtureProcesses,
      superviseDevLaunch,
      home: join(root, "home"),
      worktreeRoot: join(root, "worktree"),
      channel: "dev-observation-recovery-1234567890",
      command: process.execPath,
      args: [childPath, stopPath, terminatedPath],
      fixtureReleasePaths: [stopPath],
      spawnOptions: { cwd: root, stdio: "ignore" },
    });
    try {
      const descriptor = await fixture.observeDescriptor((value) =>
        value.state === "ready" ? value : null,
      );
      const unavailable = new Promise((resolve) => {
        fault.observed = resolve;
      });
      fault.pid = descriptor.launch.pid;
      const stop = process
        .listeners("SIGTERM")
        .find((listener) => !signalListeners.has(listener));
      expect(stop).toBeTypeOf("function");
      const dispatchStop = process
        .rawListeners("SIGTERM")
        .find((listener) => listener === stop || listener.listener === stop);
      dispatchStop();
      await unavailable;
      // Let the failed retirement settle, without making process timing the assertion.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(terminatedPath)).toBe(false);
      expect(existsSync(descriptor.socketPath)).toBe(true);
      expect(fixture.readDescriptor().state).toBe("preparing");
      expect(process.listeners("SIGTERM")).toContain(stop);
      const response = await sendDevLaunchFixtureFrame(
        descriptor.socketPath,
        {
          type: "restart_status",
        },
        { timeoutMs: 1_000 },
      );
      expect(response.type).toBe("restart_rejected");

      fault.pid = null;
      await fixture.outcome;
      expect(existsSync(descriptor.socketPath)).toBe(false);
      expect(existsSync(fixture.descriptorPath)).toBe(false);
      expect(existsSync(terminatedPath)).toBe(true);
    } finally {
      fault.pid = null;
      fault.observed = null;
      try {
        await fixture.dispose();
      } finally {
        await fixtureProcesses.retireAll();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);

it.runIf(process.platform !== "win32")(
  "does not interpret an adopted launch observation failure as an exit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "dure-adopted-observation-"));
    const fixtureProcesses = createDevLaunchFixtureRegistry();
    const home = join(root, "home");
    const worktreeRoot = join(root, "worktree");
    const channel = "dev-adopted-observation-1234567890";
    const stopPath = join(root, "stop");
    const childPath = join(root, "child.mjs");
    writeFileSync(
      childPath,
      `
import { existsSync } from "node:fs";
import { spawnProcessGroupWitness } from ${JSON.stringify(processGroupWitnessModuleUrl)};
const witness = await spawnProcessGroupWitness();
await witness.retain();
process.send({ witnessPid: witness.pid });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => { if (existsSync(process.argv[2])) process.exit(0); }, 20);
`,
      { mode: 0o600 },
    );
    const child = spawn(process.execPath, [childPath, stopPath], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const ownership = fixtureProcesses.registerSpawn(child);
    let fixture;
    try {
      const [{ witnessPid }] = await once(child, "message");
      const launch = {
        pid: child.pid,
        processIdentity: processIdentity(child.pid),
        generation: "1".repeat(64),
        processGroup: {
          kind: "posix_process_group_v1",
          id: child.pid,
          witness: {
            pid: witnessPid,
            processIdentity: processIdentity(witnessPid),
          },
        },
      };
      ownership.bind(launch);
      expect(
        await observeOwnedProcessGroup(launch),
        JSON.stringify(launch),
      ).toMatchObject({ state: "owned" });
      const directory = appControlDirectory(home, channel);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(directory, "dev-launch-supervisor-v1.json"),
        JSON.stringify({
          schemaVersion: 1,
          protocolVersion: 2,
          state: "ready",
          worktreeRoot,
          channel,
          capabilities: [DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY],
          socketPath: join(root, "absent.sock"),
          capability: "2".repeat(64),
          supervisor: {
            pid: 99999999,
            processIdentity: "stale-supervisor",
            generation: "3".repeat(64),
          },
          launch,
          publishedAtMs: Date.now(),
        }),
        { mode: 0o600 },
      );
      fixture = startManagedDevLaunchFixture({
        fixtureProcesses,
        superviseDevLaunch,
        home,
        worktreeRoot,
        channel,
        command: process.execPath,
        args: [childPath, stopPath],
        fixtureReleasePaths: [stopPath],
        spawnOptions: { cwd: root, stdio: "ignore" },
      });
      const descriptor = await Promise.race([
        fixture.observeDescriptor((value) =>
          value.state === "ready" && value.supervisor.pid === process.pid
            ? value
            : null,
        ),
        fixture.outcome.then(() => {
          throw new Error("supervisor ended before adoption");
        }),
      ]);
      expect(descriptor.launch).toEqual(launch);
      let settled = false;
      fixture.outcome.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const unavailable = new Promise((resolve) => {
        fault.observed = resolve;
      });
      fault.pid = launch.pid;
      await unavailable;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(settled).toBe(false);
      expect(existsSync(descriptor.socketPath)).toBe(true);
      expect(fixture.readDescriptor().state).toBe("ready");
      fault.pid = null;
      writeFileSync(stopPath, "stop", { mode: 0o600 });
      await fixture.outcome;
    } finally {
      fault.pid = null;
      fault.observed = null;
      try {
        await fixture?.dispose();
      } finally {
        await fixtureProcesses.retireAll();
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
