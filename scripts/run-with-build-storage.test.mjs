import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  parseBuildStorageCommand,
  runBuildStorageCli,
  runWithBuildStorage,
} from "./run-with-build-storage.mjs";
import { ensureHeadroom } from "./lib/build-storage-admission.mjs";
import { BUILD_STORAGE_RESERVATION_ENV } from "./lib/build-storage-reservation.mjs";
import {
  BUILD_STORAGE_BUDGETS,
  GIB,
  buildStorageBudget,
} from "./lib/disk-space.mjs";

describe("run-with-build-storage", () => {
  it("waits for host resources before storage admission or command launch", async () => {
    const execute = vi.fn(() => 0);
    const waitForResources = vi.fn(async () => {
      throw new Error("fixture memory pressure; admission cancelled");
    });
    await expect(Promise.resolve().then(() => runBuildStorageCli(
      ["full", "--", "fixture"],
      { waitForResources, execute },
    ))).rejects.toThrow("admission cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it.skipIf(
    process.platform !== "darwin" && process.platform !== "linux",
  )("preserves caller priority through admission and descendants", () => {
    const moduleUrl = new URL(
      "./run-with-build-storage.mjs",
      import.meta.url,
    ).href;
    const descendantProbe =
      'import { getPriority } from "node:os"; process.stdout.write(String(getPriority()));';
    const probe = `
import { spawnSync } from "node:child_process";
import { getPriority } from "node:os";
import { runBuildStorageCli, runWithBuildStorage } from ${JSON.stringify(moduleUrl)};
const observations = [];
const status = await runBuildStorageCli(["full", "--", "fixture"], {
  waitForResources: async () => {},
  execute: (arguments_) => runWithBuildStorage(arguments_, {
    admit: () => {
      observations.push({ stage: "admission", priority: getPriority() });
      return { ok: true, reservation: null };
    },
    run: () => {
      observations.push({ stage: "command", priority: getPriority() });
      const child = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", ${JSON.stringify(descendantProbe)}],
        { encoding: "utf8" },
      );
      if (child.status !== 0) throw child.error ?? new Error(child.stderr);
      observations.push({
        stage: "descendant",
        priority: Number(child.stdout.trim()),
      });
      return { status: 0 };
    },
  }),
});
process.stdout.write(JSON.stringify({
  parentPriority: getPriority(process.ppid),
  runnerPriority: getPriority(),
  observations,
  status,
}));
`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", probe],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);

    expect(receipt.status).toBe(0);
    expect(receipt.observations.map(({ stage }) => stage)).toEqual([
      "admission",
      "command",
      "descendant",
    ]);
    const expectedPriority = receipt.parentPriority;
    expect(receipt.runnerPriority).toBe(expectedPriority);
    expect(
      receipt.observations.every(
        ({ priority }) => priority === expectedPriority,
      ),
    ).toBe(true);
  });

  it("admits the mobile web gate on a frontend-sized host while retaining native capacity", () => {
    const { scripts } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    );
    const availableBytes = 12 * 1024 ** 3;
    const admit = vi.fn(({ requestedBytes }) => ({
      ok: requestedBytes <= availableBytes,
      message: "fixture storage capacity exceeded",
      reservation: null,
    }));
    const run = vi.fn(() => ({ status: 0 }));
    const invoke = (scope) =>
      runWithBuildStorage(
        scripts[`verify:push:${scope}`].split(" ").slice(2),
        { admit, run },
      );

    expect(invoke("mobile-web")).toBe(0);
    expect(admit.mock.calls[0][0].requestedBytes).toBe(
      buildStorageBudget("frontend"),
    );
    expect(run.mock.calls[0][1]).toContain(
      "verify:push:mobile-web:implementation",
    );
    expect(() => invoke("mobile-rust")).toThrow("storage capacity exceeded");
    expect(admit.mock.calls[1][0].requestedBytes).toBe(
      buildStorageBudget("mobile"),
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it("parses a shell-free command boundary", () => {
    expect(
      parseBuildStorageCommand(["mobile", "--", "corepack", "pnpm", "gate"]),
    ).toEqual({
      kind: "mobile",
      command: "corepack",
      args: ["pnpm", "gate"],
      waitMs: 0,
    });
    expect(() => parseBuildStorageCommand(["mobile", "cargo"])).toThrow(
      "usage:",
    );
    expect(
      parseBuildStorageCommand(["--wait-minutes", "25", "full", "--", "true"]),
    ).toEqual({ kind: "full", command: "true", args: [], waitMs: 25 * 60_000 });
    for (const minutes of ["-1", "1.5", "x", "1e3", undefined]) {
      expect(() =>
        parseBuildStorageCommand(["--wait-minutes", minutes, "full", "--", "true"]),
      ).toThrow("--wait-minutes takes a whole number of minutes");
    }
    expect(() => parseBuildStorageCommand(["--wait-minutes", "25", "full"])).toThrow("usage:");
  });

  it("re-checks a refused admission until it is admitted within the wait", () => {
    let clock = 0;
    const refusal = { ok: false, message: "full build was not started — fixture shortfall", reservation: null };
    const admit = vi.fn()
      .mockReturnValueOnce(refusal)
      .mockReturnValueOnce(refusal)
      .mockReturnValue({ ok: true, reservation: null });
    const sleep = vi.fn((ms) => { clock += ms; });
    const log = vi.fn();
    const run = vi.fn(() => ({ status: 0 }));
    expect(runWithBuildStorage(["--wait-minutes", "25", "full", "--", "true"], {
      admit, run, sleep, log, now: () => clock,
    })).toBe(0);
    expect(admit).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[60_000], [60_000]]);
    expect(run).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "full build was not started — fixture shortfall",
      "full build: storage not admitted yet; checking again in 60 s (25 min left)",
      "full build: storage not admitted yet; checking again in 60 s (24 min left)",
    ]);
  });

  it("refuses with the last admission's reason once the wait ends", () => {
    let clock = 0;
    const admit = vi.fn(() => ({ ok: false, message: `fixture shortfall at ${clock / 1000} s`, reservation: null }));
    const sleep = vi.fn((ms) => { clock += ms; });
    const run = vi.fn();
    expect(() => runWithBuildStorage(["--wait-minutes", "2", "full", "--", "true"], {
      admit, run, sleep, log: () => {}, now: () => clock,
    })).toThrow("fixture shortfall at 120 s");
    expect(admit).toHaveBeenCalledTimes(3);
    expect(run).not.toHaveBeenCalled();
    // Without a wait the first refusal is final.
    expect(() => runWithBuildStorage(["full", "--", "true"], { admit, run, sleep })).toThrow("fixture shortfall");
    expect(admit).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("advertises every supported budget and accepts the advertised commands", () => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./run-with-build-storage.mjs", import.meta.url))],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const kinds = result.stderr.match(/<([^>]+)>/)?.[1].split("|");
    expect(kinds).toEqual(Object.keys(BUILD_STORAGE_BUDGETS));
    for (const kind of kinds) {
      expect(parseBuildStorageCommand([kind, "--", "fixture"])).toEqual({
        kind,
        command: "fixture",
        args: [],
        waitMs: 0,
      });
    }
  });

  it("routes the Windows Corepack shim through the command interpreter", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    const run = vi.fn(() => ({ status: 0 }));

    try {
      expect(
        runWithBuildStorage(
          ["frontend", "--", "corepack", "pnpm", "build"],
          {
            admit: () => ({ ok: true, reservation: null }),
            environment: { ComSpec: "fixture-cmd.exe" },
            run,
          },
        ),
      ).toBe(0);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect(run.mock.calls[0].slice(0, 2)).toEqual([
      "fixture-cmd.exe",
      ["/d", "/s", "/c", "corepack", "pnpm", "build"],
    ]);
  });

  it("exposes one inherited capability and releases it after the command", () => {
    const release = vi.fn();
    const admit = vi.fn(() => ({
      ok: true,
      reservation: { capability: "fixture-capability", release },
    }));
    const run = vi.fn(() => ({ status: 0 }));
    expect(
      runWithBuildStorage(
        ["frontend", "--", "vite", "build"],
        { admit, run, cwd: "/fixture", environment: { PATH: "/bin" } },
      ),
    ).toBe(0);
    expect(admit).toHaveBeenCalledWith({
      cwd: "/fixture",
      environment: { PATH: "/bin" },
      label: "frontend build",
      buildClass: "frontend",
      requestedBytes: buildStorageBudget("frontend"),
    });
    expect(run.mock.calls[0][2].env).toMatchObject({
      [BUILD_STORAGE_RESERVATION_ENV]: "fixture-capability",
      PATH: "/bin",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("reserves nothing on a disposable GitHub-hosted runner", () => {
    const admit = vi.fn(() => ({ ok: true, reservation: null }));

    expect(
      runWithBuildStorage(["full", "--", "fixture"], {
        admit,
        environment: { RUNNER_ENVIRONMENT: "github-hosted" },
        run: () => ({ status: 0 }),
      }),
    ).toBe(0);
    expect(admit).toHaveBeenCalledWith({
      cwd: process.cwd(),
      environment: { RUNNER_ENVIRONMENT: "github-hosted" },
      floorBytes: 0,
      goalBytes: 0,
      label: "full build",
      buildClass: "full",
      requestedBytes: 0,
    });
  });

  it("admits a hosted full build on less free space than the shared-host budget", () => {
    const run = vi.fn(() => ({ status: 0 }));
    const reserve = vi.fn();
    expect(
      runWithBuildStorage(["full", "--", "fixture"], {
        admit: (options) => ensureHeadroom({
          ...options,
          observeAvailableBytes: () => 46 * GIB,
          reclaimOutputs: vi.fn(),
          reserve,
          log: () => {},
        }),
        environment: { RUNNER_ENVIRONMENT: "github-hosted" },
        run,
      }),
    ).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(reserve).not.toHaveBeenCalled();
    // The same volume on a shared host is refused before the command starts.
    expect(() =>
      runWithBuildStorage(["full", "--", "fixture"], {
        admit: (options) => ensureHeadroom({
          ...options,
          observeAvailableBytes: () => 46 * GIB,
          reclaimOutputs: () => ({ removed: [], removedBytes: 0, availableAfter: 46 * GIB }),
          reserve: () => ({ ok: false, reason: "insufficient_unreserved_space", reservedBytes: 0 }),
          log: () => {},
        }),
        environment: { RUNNER_ENVIRONMENT: "self-hosted" },
        run,
      }),
    ).toThrow("was not started");
    expect(run).toHaveBeenCalledOnce();
  });

  it("releases the reservation when the command fails to launch", () => {
    const release = vi.fn();
    expect(() =>
      runWithBuildStorage(
        ["cli", "--", "cargo", "test"],
        {
          admit: () => ({
            ok: true,
            reservation: { capability: "fixture", release },
          }),
          run: () => ({ error: new Error("spawn failed") }),
        },
      ),
    ).toThrow("spawn failed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("never starts the command when storage admission refuses it", () => {
    const run = vi.fn();
    expect(() =>
      runWithBuildStorage(
        ["frontend", "--", "vite", "build"],
        {
          admit: () => ({
            ok: false,
            message: "fixture build was not started",
            reservation: null,
          }),
          run,
        },
      ),
    ).toThrow("was not started");
    expect(run).not.toHaveBeenCalled();
  });
});
