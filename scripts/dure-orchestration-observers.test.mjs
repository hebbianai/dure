import { describe, expect, test } from "vitest";
import {
  observeGithubDureOrchestration,
  observeLocalDureOrchestrationHost,
} from "./lib/dure-orchestration-observers.mjs";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function run({
  conclusion = null,
  createdAt = "2026-08-03T11:59:00.000Z",
  databaseId = 1,
  status = "queued",
  updatedAt = createdAt,
} = {}) {
  return {
    conclusion,
    createdAt,
    databaseId,
    event: "schedule",
    headSha: "a".repeat(40),
    startedAt: createdAt,
    status,
    updatedAt,
    url: `https://example.test/runs/${databaseId}`,
  };
}

describe("Dure orchestration observers", () => {
  test("summarizes the main CI workflow", async () => {
    const execute = async (_command, args, options) => {
      expect(options.env).not.toHaveProperty("GIT_DIR");
      const workflow = args[args.indexOf("--workflow") + 1];
      expect(workflow).toBe("ci.yml");
      return JSON.stringify([
        run({ createdAt: "2026-08-03T11:40:00.000Z", databaseId: 5 }),
        run({ databaseId: 4, status: "in_progress" }),
      ]);
    };
    const observed = await observeGithubDureOrchestration({
      environment: { GIT_DIR: "/wrong/repository" },
      execute,
      nowMs: NOW,
    });
    expect(observed).toMatchObject({
      available: true,
      ci: {
        inProgressRuns: 1,
        oldestQueuedAgeMs: 20 * 60 * 1_000,
        queuedRuns: 1,
      },
    });
    expect(observed).not.toHaveProperty("coordinator");
  });

  test("turns GitHub deadline failure into a typed unavailable source", async () => {
    const observed = await observeGithubDureOrchestration({
      execute: async () => {
        throw Object.assign(new Error("deadline exceeded"), { code: "ETIMEDOUT" });
      },
      nowMs: NOW,
    });
    expect(observed).toMatchObject({
      available: false,
      error: {
        code: "github_snapshot_unavailable",
        source: "github_actions",
      },
      state: "unavailable",
    });
  });

  test("retries a truncated successful GitHub response within the original budget", async () => {
    const attempts = new Map();
    const execute = async (_command, args, options) => {
      const workflow = args[args.indexOf("--workflow") + 1];
      const attempt = (attempts.get(workflow) ?? 0) + 1;
      attempts.set(workflow, attempt);
      expect(options.timeout).toBeGreaterThan(0);
      if (workflow === "ci.yml" && attempt === 1) return '[{"databaseId":';
      return JSON.stringify([run({ databaseId: 8 })]);
    };
    const observed = await observeGithubDureOrchestration({
      execute,
      nowMs: NOW,
      timeoutMs: 1_000,
    });
    expect(observed).toMatchObject({
      available: true,
      ci: { queuedRuns: 1 },
    });
    expect(attempts).toEqual(new Map([["ci.yml", 2]]));
  });

  test("resolves the repository root and counts Git-prunable worktrees read-only", () => {
    const calls = [];
    const observed = observeLocalDureOrchestrationHost({
      cwd: "/repo/linked",
      environment: { GIT_DIR: "/wrong/repository" },
      execute: (command, args, options) => {
        expect(command).toBe("git");
        expect(options.env).not.toHaveProperty("GIT_DIR");
        calls.push(args);
        if (args.includes("rev-parse")) {
          expect(args).toEqual([
            "-C",
            "/repo/linked",
            "rev-parse",
            "--show-toplevel",
          ]);
          return "/repo\n";
        }
        expect(args.slice(0, 2)).toEqual(["-C", "/repo"]);
        return (
          "worktree /repo\0HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\0branch refs/heads/main\0\0" +
          "worktree /missing\0HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\0detached\0prunable gitdir file points to non-existent location\0\0"
        );
      },
      nowMs: NOW,
    });
    expect(observed).toMatchObject({
      available: true,
      worktrees: {
        orphanRegistrations: 1,
        total: 2,
      },
    });
    expect(observed).not.toHaveProperty("verificationAdmission");
    expect(calls).toHaveLength(2);
  });
});
