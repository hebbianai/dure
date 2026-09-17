import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  backgroundCpuPriorityCommand,
  enterBackgroundCpuPriority,
} from "./background-cpu-priority.mjs";

describe("background CPU priority", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "keeps background disk work at its owner's priority",
    () => {
      const policyUrl = new URL("./background-cpu-priority.mjs", import.meta.url).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { spawnSync } from "node:child_process";
        import { getPriority } from "node:os";
        import { backgroundCpuPriorityCommand, enterBackgroundCpuPriority } from ${JSON.stringify(policyUrl)};
        const initial = getPriority();
        enterBackgroundCpuPriority();
        const owner = getPriority();
        const command = backgroundCpuPriorityCommand(process.execPath, [
          "--input-type=module", "--eval",
          'import { getPriority } from "node:os"; console.log(getPriority());',
        ]);
        const child = spawnSync(command.command, command.args, {encoding: "utf8"});
        if (child.status !== 0) throw new Error(child.stderr);
        const leaf = Number(child.stdout.trim());
        console.log(JSON.stringify({initial, owner, leaf}));
      `], {encoding: "utf8"});
      expect(result.status, result.stderr).toBe(0);
      const receipt = JSON.parse(result.stdout);
      expect(receipt.owner).toBe(Math.max(receipt.initial, 15));
      expect(receipt.leaf).toBe(receipt.owner);
    },
  );

  it("applies Darwin background scheduling before lowering niceness", () => {
    expect(
      backgroundCpuPriorityCommand("corepack", ["pnpm", "agent-tools:prepare"], {
        platform: "darwin",
        readPriority: () => 0,
      }),
    ).toEqual({
      command: "/usr/sbin/taskpolicy",
      args: [
        "-b",
        "/usr/bin/nice",
        "-n",
        "15",
        "corepack",
        "pnpm",
        "agent-tools:prepare",
      ],
    });
  });

  it("lowers Linux command niceness without a Darwin policy wrapper", () => {
    expect(
      backgroundCpuPriorityCommand("corepack", ["pnpm", "agent-tools:prepare"], {
        platform: "linux",
        readPriority: () => 0,
      }),
    ).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", "15", "corepack", "pnpm", "agent-tools:prepare"],
    });
  });

  it("keeps unsupported platforms unchanged", () => {
    const args = ["pnpm", "agent-tools:prepare"];
    const readPriority = vi.fn();
    const writePriority = vi.fn();

    expect(
      backgroundCpuPriorityCommand("corepack", args, { platform: "win32", readPriority }),
    ).toEqual({ command: "corepack", args });
    expect(
      enterBackgroundCpuPriority({
        platform: "win32",
        readPriority,
        writePriority,
      }),
    ).toBeNull();
    expect(readPriority).not.toHaveBeenCalled();
    expect(writePriority).not.toHaveBeenCalled();
  });

  it.each([0, 10, 15, 18, 19, 20])(
    "does not compound an inherited niceness of %i",
    (inheritedPriority) => {
      const command = backgroundCpuPriorityCommand("fixture", [], {
        platform: "linux",
        readPriority: () => inheritedPriority,
      });
      expect(command.args).toEqual([
        "-n", String(Math.max(0, 15 - inheritedPriority)), "fixture",
      ]);
      let priority = inheritedPriority;
      const enter = () => enterBackgroundCpuPriority({
        platform: "linux",
        readPriority: () => priority,
        writePriority: (value) => { priority = value; },
      });
      enter();
      enter();
      expect(priority).toBe(Math.max(15, inheritedPriority));
    },
  );

  it("converges POSIX owners to background priority without raising inherited priority", () => {
    const writePriority = vi.fn();

    expect(
      enterBackgroundCpuPriority({
        platform: "darwin",
        readPriority: () => 10,
        writePriority,
      }),
    ).toEqual({ previousPriority: 10, priority: 15 });
    expect(writePriority).toHaveBeenCalledWith(15);

    writePriority.mockClear();
    expect(
      enterBackgroundCpuPriority({
        platform: "linux",
        readPriority: () => 19,
        writePriority,
      }),
    ).toEqual({ previousPriority: 19, priority: 19 });
    expect(writePriority).not.toHaveBeenCalled();
  });
});
