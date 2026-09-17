import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  parseBuildStorageCommand,
  runBuildStorageCli,
  runWithBuildStorage,
} from "./run-with-build-storage.mjs";
import { BUILD_STORAGE_RESERVATION_ENV } from "./lib/build-storage-reservation.mjs";
import {
  BUILD_STORAGE_BUDGETS,
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
    });
    expect(() => parseBuildStorageCommand(["mobile", "cargo"])).toThrow(
      "usage:",
    );
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
      label: "frontend build",
      requestedBytes: buildStorageBudget("frontend"),
    });
    expect(run.mock.calls[0][2].env).toMatchObject({
      [BUILD_STORAGE_RESERVATION_ENV]: "fixture-capability",
      PATH: "/bin",
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not reserve a second build on a disposable GitHub-hosted runner", () => {
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
      floorBytes: 0,
      goalBytes: 0,
      label: "full build",
      requestedBytes: buildStorageBudget("full"),
    });
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
