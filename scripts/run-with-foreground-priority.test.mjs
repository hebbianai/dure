import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  parseForegroundPriorityCommand,
  runWithForegroundPriority,
} from "./run-with-foreground-priority.mjs";

const node = (source) => ["--", process.execPath, "-e", source];
const timeline = {
  label: "release build",
  intervalMs: 30_000,
  baselineNice: 0,
  durationMs: 1_000,
  samples: [{
    atMs: 0, processes: 1, highestNice: 0,
    background: { count: 0, commands: [] }, raisedNice: { count: 0, commands: [] }, cleared: 0,
  }],
};

describe("run-with-foreground-priority", () => {
  it("takes the command after -- and an optional label", () => {
    expect(parseForegroundPriorityCommand(["--label", "release build", "--", "node", "a", "--b"])).toEqual({
      label: "release build", command: "node", args: ["a", "--b"],
    });
    expect(parseForegroundPriorityCommand(["--", "true"])).toEqual({ label: "command", command: "true", args: [] });
    for (const args of [[], ["node"], ["--label", "x", "--"]])
      expect(() => parseForegroundPriorityCommand(args)).toThrow(/usage: run-with-foreground-priority/);
  });

  it("guards the command's own process tree and appends the timeline to the step summary", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-foreground-"));
    try {
      const summary = path.join(root, "summary.md");
      fs.writeFileSync(summary, "earlier step\n");
      const stop = vi.fn(async () => timeline);
      const startGuard = vi.fn(() => ({ stop }));
      const code = await runWithForegroundPriority(["--label", "release build", ...node("process.exit(3)")], {
        environment: { ...process.env, GITHUB_STEP_SUMMARY: summary },
        startGuard,
      });
      expect(code).toBe(3);
      expect(startGuard).toHaveBeenCalledWith({ rootPid: expect.any(Number), label: "release build" });
      expect(startGuard.mock.calls[0][0].rootPid).not.toBe(process.pid);
      expect(stop).toHaveBeenCalledOnce();
      const written = fs.readFileSync(summary, "utf8");
      expect(written.startsWith("earlier step\n### Scheduling priority: release build\n")).toBe(true);
      expect(written).toContain("No background QoS or raised nice was seen.");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a signal exit as a failure and still writes the timeline", async () => {
    const writeSummary = vi.fn();
    await expect(runWithForegroundPriority(node("process.kill(process.pid, 'SIGTERM')"), {
      startGuard: () => ({ stop: async () => timeline }),
      writeSummary,
    })).rejects.toThrow(/exited from signal SIGTERM/);
    expect(writeSummary).toHaveBeenCalledOnce();
  });

  it("fails when the command cannot start", async () => {
    const startGuard = vi.fn();
    await expect(runWithForegroundPriority(["--", path.join(os.tmpdir(), "dure-missing-command")], { startGuard }))
      .rejects.toThrow(/ENOENT/);
    expect(startGuard).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "darwin")("only runs the command where no adapter exists", async () => {
    const writeSummary = vi.fn();
    expect(await runWithForegroundPriority(node("process.exit(0)"), { writeSummary })).toBe(0);
    expect(writeSummary).not.toHaveBeenCalled();
  });

  it("exits with the command's status from the command line", () => {
    const result = spawnSync(process.execPath, [
      "scripts/run-with-foreground-priority.mjs", "--label", "fixture", ...node("process.exit(4)"),
    ], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
    expect(result.status).toBe(4);
    if (process.platform === "darwin") expect(result.stderr).toContain("### Scheduling priority: fixture");
  });
});
