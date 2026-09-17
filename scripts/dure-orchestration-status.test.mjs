import { describe, expect, test, vi } from "vitest";
import {
  collectDureOrchestrationStatus,
  runDureOrchestrationStatusCommand,
} from "./dure-orchestration-status.mjs";
import { evaluateDureOrchestrationHealth } from "./lib/dure-orchestration-health-core.mjs";

const NOW = Date.parse("2026-08-03T12:00:00.000Z");

function github({ oldestQueuedAgeMs = null } = {}) {
  return {
    available: true,
    state: "ready",
    observedAt: new Date(NOW).toISOString(),
    observedAtMs: NOW,
    sourceAgeMs: 0,
    ci: {
      state: "ready",
      observedAtMs: NOW,
      sourceAgeMs: 0,
      inProgressRuns: 0,
      oldestQueuedAgeMs,
      queuedRuns: oldestQueuedAgeMs === null ? 0 : 1,
    },
  };
}

function host() {
  return {
    available: true,
    state: "ready",
    observedAt: new Date(NOW).toISOString(),
    observedAtMs: NOW,
    sourceAgeMs: 0,
    worktrees: {
      state: "ready",
      observedAtMs: NOW,
      sourceAgeMs: 0,
      orphanRegistrations: 0,
      total: 1,
    },
  };
}

describe("Dure orchestration status model", () => {
  test("reports healthy CI and host state without a landing source", async () => {
    const report = await collectDureOrchestrationStatus({
      now: () => NOW,
      observeGithub: github,
      observeHost: host,
    });
    expect(report).toMatchObject({
      partial: false,
      status: "healthy",
      github: { available: true, ci: { queuedRuns: 0 } },
      host: { available: true },
    });
    expect(report).not.toHaveProperty("landing");
    expect(report.github).not.toHaveProperty("coordinator");
  });

  test("marks an aged GitHub CI queue unhealthy", () => {
    const health = evaluateDureOrchestrationHealth(
      { github: github({ oldestQueuedAgeMs: 31 * 60 * 1_000 }), host: host() },
      { nowMs: NOW },
    );
    expect(health.verdict).toBe("unhealthy");
    expect(health.reasons).toContainEqual(
      expect.objectContaining({ code: "github_ci_queue_stale" }),
    );
  });

  test("returns a typed partial snapshot when the CI observer times out", async () => {
    const report = await collectDureOrchestrationStatus({
      now: () => NOW,
      observeGithub: () => ({
        available: false,
        state: "unavailable",
        error: {
          code: "github_snapshot_unavailable",
          message: "deadline exceeded",
          source: "github_actions",
        },
        observedAtMs: NOW,
        sourceAgeMs: 0,
      }),
      observeHost: host,
    });
    expect(report).toMatchObject({
      partial: true,
      status: "unknown",
      github: { available: false },
    });
  });

  test("health mode preserves the model verdict exit code", async () => {
    const output = [];
    const exitCode = await runDureOrchestrationStatusCommand({
      args: ["--mode", "health", "--json"],
      collect: vi.fn(() => ({
        health: { reasons: [], verdict: "degraded" },
        status: "degraded",
      })),
      output: (source) => output.push(source),
    });
    expect(exitCode).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ status: "degraded" });
  });
});
