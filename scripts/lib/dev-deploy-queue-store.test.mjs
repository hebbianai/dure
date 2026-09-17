import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueDevDeploy } from "./dev-deploy-queue.mjs";
import { DevDeployQueueStore } from "./dev-deploy-queue-store.mjs";

let home;
let stores;
const TARGET_HEAD = "a".repeat(40);
const EXECUTOR_GENERATION = "b".repeat(64);
const MACOS_BOOT = "00000000-0000-0000-0000-000000000001";

function macosIdentity(uniqueId, bootSession = MACOS_BOOT) {
  return `kernel-start-v3:macos:${bootSession}:${uniqueId}`;
}

function legacyProcessLiveness(owner, alive, identity) {
  if (!owner || !alive(owner.pid)) return "stale";
  const observed = identity(owner.pid);
  if (!observed) return "unknown";
  return observed === owner.processIdentity ? "active" : "stale";
}

function openStore(options = {}) {
  const store = new DevDeployQueueStore({ homeDirectory: home, ...options });
  stores.push(store);
  return store;
}

function request(existing = null) {
  return enqueueDevDeploy({
    existing,
    worktree: "/tmp/dure-live",
    attemptArgs: ["--live-worktree", "/tmp/dure-live"],
    transaction: {
      schemaVersion: 1,
      targetHead: TARGET_HEAD,
      targetAuthority: "origin/main",
      executor: {
        generation: EXECUTOR_GENERATION,
        entrypoint:
          `/tmp/executors-v1/${EXECUTOR_GENERATION}/scripts/deploy-dev-app.mjs`,
      },
    },
    executionEnvironment: { HOME: "/tmp/home", PATH: "/usr/bin" },
    receipt: { action: "defer", targetHead: TARGET_HEAD },
    nowMs: 1_000,
    maxWaitMs: 60_000,
    pollMs: 5_000,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "deploy-queue-store-"));
  stores = [];
});

afterEach(() => {
  for (const store of stores.reverse()) store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("DevDeployQueueStore", () => {
  it("atomically persists owner-only state", () => {
    const store = openStore();
    store.mutate(() => request());
    expect(store.read().request.observed.targetHead).toBe(TARGET_HEAD);
    expect(lstatSync(store.paths.directory).mode & 0o777).toBe(0o700);
    expect(lstatSync(store.paths.state).mode & 0o777).toBe(0o600);
    expect(lstatSync(store.paths.database).mode & 0o777).toBe(0o600);
  });

  it("admits only one live runner lease", () => {
    const store = openStore();
    const first = store.acquireRunner(EXECUTOR_GENERATION);
    expect(first.pid).toBe(process.pid);
    expect(first.executorGeneration).toBe(EXECUTOR_GENERATION);
    expect(store.activeRunnerFor(EXECUTOR_GENERATION)).toEqual(first);
    expect(store.acquireRunner()).toBeNull();
    store.releaseRunner(first);
    expect(store.acquireRunner()).not.toBeNull();
  });

  it("accepts a legacy lease but not as the requested executor generation", () => {
    const store = openStore();
    const legacy = store.acquireRunner();

    expect(store.activeRunner()).toEqual(legacy);
    expect(store.activeRunnerFor(EXECUTOR_GENERATION)).toBeNull();
    expect(store.acquireRunner(EXECUTOR_GENERATION)).toBeNull();

    store.releaseRunner(legacy);
    expect(
      store.acquireRunner(EXECUTOR_GENERATION)?.executorGeneration,
    ).toBe(EXECUTOR_GENERATION);
  });

  it("keeps an exact runner generation behind the legacy macOS status alias", () => {
    const exactIdentity = macosIdentity("4100");
    const store = openStore({ identity: () => exactIdentity });

    const lease = store.acquireRunner();

    expect(lease).toMatchObject({
      processIdentity: "kernel-start-v2:macos:4100",
      processGeneration: {
        schemaVersion: 1,
        processIdentity: exactIdentity,
      },
    });
    expect(
      legacyProcessLiveness(
        lease,
        () => true,
        () => "kernel-start-v2:macos:4100",
      ),
    ).toBe("active");
    expect(store.runnerLeaseObservation()).toMatchObject({
      liveness: "active",
      owner: { token: lease.token },
    });
  });

  it("reclaims a runner lease whose owner is dead", () => {
    const original = openStore({ identity: () => "original-start" });
    const first = original.acquireRunner();
    const replacement = openStore({ alive: () => false });
    const lease = replacement.acquireRunner();
    expect(lease.pid).toBe(process.pid);
    expect(lease.token).not.toBe(first.token);
  });

  it("reclaims a reused pid whose process start identity changed", () => {
    const original = openStore({ identity: () => macosIdentity("4200") });
    const first = original.acquireRunner();
    const replacement = openStore({
      alive: () => true,
      identity: () => macosIdentity("4201"),
    });
    const lease = replacement.acquireRunner();
    expect(lease.processGeneration.processIdentity).toBe(macosIdentity("4201"));
    expect(lease.token).not.toBe(first.token);
  });

  it("does not reclaim a live lease when identity observation is unknown", () => {
    const original = openStore({ identity: () => macosIdentity("4300") });
    const first = original.acquireRunner();
    let identityCalls = 0;
    const observer = openStore({
      alive: () => true,
      identity: () => {
        identityCalls += 1;
        return identityCalls === 1 ? macosIdentity("4301") : null;
      },
    });
    expect(observer.acquireRunner()).toBeNull();
    expect(observer.workerLiveness(first)).toBe("unknown");
  });

  it("does not reinterpret a legacy macOS generation as stale", () => {
    const observer = openStore({
      alive: () => true,
      identity: () => macosIdentity("4350"),
    });
    const legacyWorker = {
      pid: process.pid,
      startedAtMs: 1,
      processIdentity: "kernel-start-v2:macos:4350",
    };

    expect(observer.workerLiveness(legacyWorker)).toBe("incompatible");
    expect(observer.workerAlive(legacyWorker)).toBe(true);
  });

  it("protects a live lease whose canonical identity schema is unsupported", () => {
    const original = openStore({ identity: () => macosIdentity("4400") });
    const first = original.acquireRunner();
    original.close();
    const unsupported = {
      ...first,
      processGeneration: {
        schemaVersion: 2,
        processIdentity: "future-process-generation:4400",
      },
    };
    const database = new DatabaseSync(original.paths.database);
    database
      .prepare("UPDATE runner_lease SET owner_json = ? WHERE singleton = 1")
      .run(JSON.stringify(unsupported));
    database.close();

    const observer = openStore({
      alive: () => true,
      identity: () => macosIdentity("4400"),
    });
    expect(observer.runnerLeaseObservation()).toMatchObject({
      liveness: "incompatible",
      owner: { token: first.token },
    });
    expect(observer.acquireRunner()).toBeNull();
  });

  it("observes lease liveness before entering the SQLite writer transaction", () => {
    const original = openStore({ identity: () => macosIdentity("4500") });
    original.acquireRunner();
    const contender = openStore();
    let identityCalls = 0;
    const replacement = openStore({
      alive: () => true,
      identity: () => {
        identityCalls += 1;
        if (identityCalls === 1) return macosIdentity("4501");
        contender.mutate((current) => request(current));
        return macosIdentity("4502");
      },
    });

    expect(replacement.acquireRunner()).not.toBeNull();
    expect(contender.read().generation).toBe(1);
  });

  it("rejects symlinked or non-owner state instead of following it", () => {
    const store = openStore();
    store.mutate(() => request());
    rmSync(store.paths.state);
    const target = join(home, "target.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, store.paths.state);
    expect(() => store.read()).toThrow(/unsafe/);
    rmSync(store.paths.state);
    writeFileSync(store.paths.state, "{}\n", { mode: 0o600 });
    chmodSync(store.paths.state, 0o644);
    expect(() => store.read()).toThrow(/owner-only/);
  });
});
