import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createAdmissionDiagnostic,
  createCompletedVerificationDiagnostics,
  deriveGithubQueueDurations,
  parseCompletedVerificationDiagnostics,
  readAdmissionDiagnostic,
  readVerificationProgress,
  writeAdmissionDiagnostic,
  writeVerificationProgress,
} from "./verification-diagnostics.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryPath() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "verification-diagnostics-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "private", "admission.json");
}

const gate = {
  kind: "full",
  pid: 123,
  priority: "local",
  resource: "a".repeat(64),
  worktree: "/tmp/worktree",
};

describe("verification diagnostics", () => {
  test("persists owner-only admission state and replaces it atomically", () => {
    const outputPath = temporaryPath();
    writeAdmissionDiagnostic(
      outputPath,
      createAdmissionDiagnostic({
        blockedBy: { ...gate, pid: 456, state: "unknown" },
        executionMs: null,
        gate,
        phase: "host_resource_wait",
        queueMs: 91,
      }),
    );

    expect(readAdmissionDiagnostic(outputPath)).toMatchObject({
      blockedBy: {
        pid: 456,
        resource: "a".repeat(64),
        state: "unknown",
      },
      blockerKind: "host_resource_wait",
      executionMs: null,
      phase: "host_resource_wait",
      queueMs: 91,
    });
    expect(fs.statSync(outputPath).mode & 0o077).toBe(0);

    writeAdmissionDiagnostic(outputPath, {
      executionMs: 502,
      gate,
      phase: "completed",
      queueMs: 91,
    });
    expect(readAdmissionDiagnostic(outputPath)).toMatchObject({
      blockedBy: null,
      blockerKind: null,
      executionMs: 502,
      phase: "completed",
      queueMs: 91,
    });
  });

  test("keeps legacy diagnostics readable while validating new resource ids", () => {
    const legacyGate = { ...gate };
    delete legacyGate.resource;
    expect(
      createAdmissionDiagnostic({
        executionMs: 1,
        gate: legacyGate,
        phase: "completed",
        queueMs: 0,
      }).gate,
    ).toEqual(legacyGate);
    expect(() =>
      createAdmissionDiagnostic({
        executionMs: 1,
        gate: { ...gate, resource: "mixed-case" },
        phase: "completed",
        queueMs: 0,
      }),
    ).toThrow(/resource/);
  });

  test("persists only canonical prefix progress in an owner-only file", () => {
    const outputPath = temporaryPath().replace("admission.json", "progress.json");
    writeVerificationProgress(outputPath, {
      completedScopes: ["frontend", "desktop"],
      currentScope: "mobile-rust",
      plannedScopes: ["frontend", "desktop", "mobile-rust"],
      updatedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(readVerificationProgress(outputPath)).toEqual({
      completedScopes: ["frontend", "desktop"],
      currentScope: "mobile-rust",
      plannedScopes: ["frontend", "desktop", "mobile-rust"],
      schema: "dure-verification-progress/v1",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    expect(fs.statSync(outputPath).mode & 0o077).toBe(0);
    expect(() =>
      writeVerificationProgress(outputPath, {
        completedScopes: ["desktop"],
        currentScope: "frontend",
        plannedScopes: ["frontend", "desktop"],
      }),
    ).toThrow(/prefix/);
  });

  test("records each queue source without inventing an aggregate", () => {
    const diagnostics = createCompletedVerificationDiagnostics({
      ci: { jobName: "verify", runAttempt: "2", runId: "42" },
      executionMs: 5_000,
      hostResourceWaitMs: 700,
      runnerWaitMs: null,
      unavailable: ["runner_wait_timing_unavailable"],
      workflowConcurrencyMs: 300,
    });

    expect(diagnostics).toMatchObject({
      blockerKind: null,
      executionMs: 5_000,
      phase: "completed",
      phases: [
        { durationMs: 300, phase: "workflow_concurrency" },
        { durationMs: null, phase: "runner_wait" },
        { durationMs: 700, phase: "host_resource_wait" },
        { durationMs: 5_000, phase: "running" },
      ],
      queueMs: null,
    });
    expect(parseCompletedVerificationDiagnostics(diagnostics)).toEqual(
      diagnostics,
    );
  });

  test("rejects a receipt whose aggregate timing disagrees with its phases", () => {
    const diagnostics = createCompletedVerificationDiagnostics({
      ci: { jobName: "verify", runAttempt: "1", runId: "42" },
      executionMs: 400,
      hostResourceWaitMs: 30,
      runnerWaitMs: 20,
      workflowConcurrencyMs: 10,
    });

    expect(() =>
      parseCompletedVerificationDiagnostics({ ...diagnostics, queueMs: 999 }),
    ).toThrow(/aggregate durations/);
  });

  test("derives workflow concurrency and runner wait from ordered API timestamps", () => {
    expect(
      deriveGithubQueueDurations({
        jobCreatedAt: "2026-07-31T00:00:03.500Z",
        jobStartedAt: "2026-07-31T00:00:05.000Z",
        runCreatedAt: "2026-07-31T00:00:00.000Z",
        runStartedAt: "2026-07-31T00:00:03.000Z",
      }),
    ).toEqual({
      runnerWaitMs: 1_500,
      unavailable: [],
      workflowConcurrencyMs: 3_500,
    });
  });

  test("keeps unavailable or regressing API timestamps explicit", () => {
    expect(
      deriveGithubQueueDurations({
        jobCreatedAt: "invalid",
        jobStartedAt: "2026-07-31T00:00:02.000Z",
        runCreatedAt: "invalid",
        runStartedAt: "2026-07-31T00:00:03.000Z",
      }),
    ).toEqual({
      runnerWaitMs: null,
      unavailable: [
        "workflow_concurrency_timing_unavailable",
        "runner_wait_timing_unavailable",
      ],
      workflowConcurrencyMs: null,
    });
  });

  test("does not conceal a regressing job creation boundary", () => {
    expect(
      deriveGithubQueueDurations({
        jobCreatedAt: "2026-07-31T00:00:02.000Z",
        jobStartedAt: "2026-07-31T00:00:05.000Z",
        runCreatedAt: "2026-07-31T00:00:00.000Z",
        runStartedAt: "2026-07-31T00:00:03.000Z",
      }),
    ).toEqual({
      runnerWaitMs: null,
      unavailable: [
        "workflow_concurrency_timing_unavailable",
        "runner_wait_timing_unavailable",
      ],
      workflowConcurrencyMs: null,
    });
  });
});
