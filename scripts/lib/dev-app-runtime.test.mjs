import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appRuntimeObservation, awaitAppRuntimeReady } from "./dev-app-runtime.mjs";
import { worktreeDevIdentity } from "./app-channel.mjs";

const TARGET_HEAD = "b".repeat(40);
const TARGET_BUILD = `0.1.4+${TARGET_HEAD.slice(0, 12)}`;
const LAUNCH = {
  pid: 42,
  processIdentity: "launch-42",
  generation: "c".repeat(64),
};

function runningRuntime(overrides = {}) {
  return {
    state: "running",
    channel: "dev-test",
    processId: 84,
    generation: "runtime-generation",
    startedAtUnixMs: 1_020,
    buildId: TARGET_BUILD,
    compatibility: { state: "available", mode: "current" },
    ...overrides,
  };
}

function runtimeHarness(inspect) {
  let currentTime = 1_000;
  return {
    home: "/tmp/dure-app-runtime-test",
    inspect,
    observeParent: vi.fn(async () => ({ launch: LAUNCH })),
    processIdentity: vi.fn(() => "runtime-84"),
    now: () => currentTime,
    wait: vi.fn(async (milliseconds) => {
      currentTime += milliseconds;
    }),
  };
}

describe("dev app runtime readiness", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reads the selected portable app descriptor while keeping supervisor HOME separate", async () => {
    const descriptorPath = "/tmp/portable-app/channels/dev-test/server.json";
    const inspect = vi.fn(async (input) =>
      input.descriptorPath === descriptorPath
        ? runningRuntime()
        : { state: "absent" },
    );
    const runtime = {
      ...runtimeHarness(inspect),
      environment: { DURE_HOME: "/tmp/portable-app" },
    };

    await expect(awaitAppRuntimeReady({
      root: "/repo",
      channel: "dev-test",
      targetHead: TARGET_HEAD,
      expectedBuildId: TARGET_BUILD,
      expectedLaunch: LAUNCH,
      notBeforeMs: 1_000,
      timeoutMs: 50,
      pollMs: 25,
    }, runtime)).resolves.toMatchObject({ state: "ready", pid: 84 });
    expect(runtime.observeParent).toHaveBeenCalledWith(expect.objectContaining({
      home: runtime.home,
    }));
  });

  it("does not let ambient DURE_HOME override an explicit fixture HOME", async () => {
    vi.stubEnv("DURE_HOME", "/live/ambient-app");
    const inspect = vi.fn(async ({ descriptorPath }) =>
      descriptorPath === "/tmp/dure-app-runtime-test/.dure/channels/dev-test/server.json"
        ? runningRuntime()
        : { state: "absent" },
    );
    await expect(awaitAppRuntimeReady({
      root: "/repo",
      channel: "dev-test",
      targetHead: TARGET_HEAD,
      expectedBuildId: TARGET_BUILD,
      expectedLaunch: LAUNCH,
      notBeforeMs: 1_000,
      timeoutMs: 50,
      pollMs: 25,
    }, runtimeHarness(inspect))).resolves.toMatchObject({ state: "ready" });
  });

  it.each([84, 85])("observes only the selected portable descriptor without borrowing default-root metadata (descriptor pid %s)", (descriptorPid) => {
    const home = mkdtempSync(join(tmpdir(), "dure-runtime-home-"));
    const portableHome = join(home, "portable-app");
    const root = "/repo";
    const { channel } = worktreeDevIdentity(root);
    for (const [appHome, buildId, processId] of [
      [join(home, ".dure"), "default-decoy", 84],
      [portableHome, TARGET_BUILD, descriptorPid],
    ]) {
      const directory = join(appHome, "channels", channel);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "server.json"), JSON.stringify({
        processId, buildId, generation: `${buildId}-generation`,
      }));
    }
    try {
      expect(appRuntimeObservation(root, 1_000, {
        home,
        environment: { DURE_HOME: portableHome },
        appPid: () => 84,
        processIdentity: () => "runtime-84",
      })).toEqual({
        pid: 84,
        processIdentity: "runtime-84",
        observedAtMs: 1_000,
        ...(descriptorPid === 84 ? {
          buildId: TARGET_BUILD,
          generation: `${TARGET_BUILD}-generation`,
        } : {}),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("waits through a stale predecessor descriptor for the exact replacement", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(
        runningRuntime({
          buildId: "0.1.4+aaaaaaaaaaaa",
          startedAtUnixMs: 900,
        }),
      )
      .mockResolvedValueOnce(runningRuntime());
    const runtime = runtimeHarness(inspect);

    await expect(
      awaitAppRuntimeReady(
        {
          root: "/repo",
          channel: "dev-test",
          targetHead: TARGET_HEAD,
          expectedBuildId: TARGET_BUILD,
          expectedLaunch: LAUNCH,
          notBeforeMs: 1_000,
          timeoutMs: 100,
          pollMs: 25,
        },
        runtime,
      ),
    ).resolves.toEqual({
      state: "ready",
      channel: "dev-test",
      targetHead: TARGET_HEAD,
      pid: 84,
      processIdentity: "runtime-84",
      buildId: TARGET_BUILD,
      generation: "runtime-generation",
      startedAtUnixMs: 1_020,
      observedAtMs: 1_025,
      launch: LAUNCH,
      compatibility: { state: "available", mode: "current" },
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("returns bounded starting truth when no fresh descriptor arrives", async () => {
    const inspect = vi.fn(async () =>
      runningRuntime({
        buildId: "0.1.4+aaaaaaaaaaaa",
        startedAtUnixMs: 900,
      }),
    );
    const runtime = runtimeHarness(inspect);
    runtime.observeParent.mockImplementation(async ({ timeoutMs }) => {
      if (timeoutMs <= 1) {
        throw new Error("observed dev launch supervisor is not live");
      }
      return { launch: LAUNCH };
    });

    await expect(
      awaitAppRuntimeReady(
        {
          root: "/repo",
          channel: "dev-test",
          targetHead: TARGET_HEAD,
          expectedBuildId: TARGET_BUILD,
          expectedLaunch: LAUNCH,
          notBeforeMs: 1_000,
          timeoutMs: 50,
          pollMs: 25,
        },
        runtime,
      ),
    ).resolves.toMatchObject({
      state: "starting",
      targetHead: TARGET_HEAD,
      launch: LAUNCH,
      reason: "app_runtime_stale_descriptor",
      observedAtMs: 1_050,
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(runtime.processIdentity).not.toHaveBeenCalled();
  });
});
