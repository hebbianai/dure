import { describe, expect, it } from "vitest";
import {
  appChannelFromProcessEnvironment,
  dailyDriverSafety,
  isHebbianAppProcess,
  parseProcessRows,
} from "./daily-driver.mjs";

describe("daily-driver process classification", () => {
  it("reads only a valid public app-channel marker from a process environment", () => {
    expect(
      appChannelFromProcessEnvironment(
        "target/debug/dure HOME=/Users/me DURE_APP_CHANNEL=dev-feature-a-a1b2c3d4 HEBBIAN_APP_CHANNEL=dev-legacy-decoy PATH=/bin",
      ),
    ).toBe("dev-feature-a-a1b2c3d4");
    expect(
      appChannelFromProcessEnvironment(
        "target/debug/dure HEBBIAN_APP_CHANNEL=dev-legacy-a1b2c3d4",
      ),
    ).toBe("dev-legacy-a1b2c3d4");
    expect(
      appChannelFromProcessEnvironment(
        "target/debug/dure HEBBIAN_APP_CHANNEL=../stable",
      ),
    ).toBeUndefined();
    expect(
      appChannelFromProcessEnvironment(
        "target/debug/dure DURE_APP_CHANNEL=../stable HEBBIAN_APP_CHANNEL=dev-legacy-a1b2c3d4",
      ),
    ).toBeUndefined();
  });

  it("distinguishes the installed app from a worktree-owned debug app", () => {
    const processes = parseProcessRows(`
      101 1 /Applications/Dure.app/Contents/MacOS/dure
      202 201 target/debug/dure
      203 201 /repo/.worktrees/feature-b/target/debug/agent-ide
      303 1 /usr/bin/sleep 30
    `).filter((process) => isHebbianAppProcess(process.command));
    processes[1].cwd =
      "/Users/me/HebbianIDE/.worktrees/feature-a/src-tauri";
    processes[2].cwd =
      "/Users/me/HebbianIDE/.worktrees/feature-b/src-tauri";
    processes[2].appChannel = "dev-feature-b-a1b2c3d4";

    const safety = dailyDriverSafety(processes, "/Applications/Dure.app");

    expect(safety.stable).toEqual([
      expect.objectContaining({ pid: 101, kind: "stable" }),
    ]);
    expect(safety.unsafeDevelopment).toEqual([
      expect.objectContaining({
        pid: 202,
        kind: "worktree-dev",
        cwd: "/Users/me/HebbianIDE/.worktrees/feature-a/src-tauri",
      }),
    ]);
    expect(safety.isolatedDevelopment).toEqual([
      expect.objectContaining({
        pid: 203,
        kind: "isolated-dev",
        appChannel: "dev-feature-b-a1b2c3d4",
      }),
    ]);
  });

  it("keeps an installed Hebbian binary visible during the migration window", () => {
    const processes = parseProcessRows(`
      101 1 /Applications/Hebbian.app/Contents/MacOS/agent-ide
    `).filter((process) => isHebbianAppProcess(process.command));

    expect(
      dailyDriverSafety(processes, "/Applications/Hebbian.app").stable,
    ).toEqual([expect.objectContaining({ pid: 101, kind: "stable" })]);
  });

  it("classifies a generated Dure.app wrapper as its development channel", () => {
    const command =
      "/repo/.worktrees/feature-a/src-tauri/target/debug/.dure-dev/dev-feature-a-a1b2c3d4/Dure.app/Contents/MacOS/dure";
    const process = {
      pid: 202,
      parentPid: 201,
      command,
      appChannel: "dev-feature-a-a1b2c3d4",
    };

    expect(
      dailyDriverSafety([process], "/Applications/Dure.app")
        .isolatedDevelopment,
    ).toEqual([expect.objectContaining({ pid: 202, kind: "isolated-dev" })]);
  });

  it("does not classify test binaries or unrelated processes as the IDE", () => {
    for (const command of [
      "/tmp/target/debug/deps/agent_ide_lib-123",
      "cargo test dure",
      "/Users/me/.local/bin/dure",
      "dure",
      "/usr/bin/sleep 30",
    ]) {
      expect(isHebbianAppProcess(command)).toBe(false);
    }
  });
});
