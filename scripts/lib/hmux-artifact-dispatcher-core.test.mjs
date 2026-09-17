import { describe, expect, test } from "vitest";
import {
  ARTIFACT_CI_FAILURE_CONCLUSION,
  ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
  ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS,
  ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX,
  artifactCiFailureEvidence,
  artifactCiProductProofAvailability,
  artifactCiProofUnavailableEvidence,
  artifactCiReadiness,
  artifactAdmissionMetrics,
  artifactRunnerSnapshot,
  buildArtifactRequestRef,
  buildArtifactResultRef,
  buildArtifactRunnerObservationRef,
  parseArtifactRunnerObservationRef,
  planArtifactDispatch,
  planOfflineArtifactRecovery,
} from "./hmux-artifact-dispatcher-core.mjs";

const HOUR = 60 * 60 * 1_000;
const BASE_NOW = Date.parse("2026-08-03T00:00:00.000Z");

function request({
  enqueuedAt = BASE_NOW - 5_000,
  sourceEvent = "push",
  sourceSha = "a".repeat(40),
  triggerRunId = "100",
  triggerRunAttempt = "1",
} = {}) {
  return {
    ref: buildArtifactRequestRef({
      enqueuedAt,
      sourceEvent,
      triggerRunId,
      triggerRunAttempt,
    }),
    sha: sourceSha,
  };
}

function run(
  entry,
  {
    conclusion = null,
    createdAt = BASE_NOW - 1_000,
    id = 500,
    status = conclusion === null ? "in_progress" : "completed",
  } = {},
) {
  return {
    conclusion,
    created_at: new Date(createdAt).toISOString(),
    event: "workflow_dispatch",
    head_branch: entry.ref.replace("refs/heads/", ""),
    head_sha: entry.sha,
    id,
    path: ".github/workflows/hmux-linux-artifacts.yml",
    run_attempt: 1,
    status,
  };
}

function runnerSnapshot({
  busy = true,
  now = BASE_NOW,
  progressAt = BASE_NOW - 10 * 60_000,
  runnerId = 23,
  status = "offline",
} = {}) {
  return artifactRunnerSnapshot({
    job: {
      id: 700,
      runner_id: runnerId,
      started_at: new Date(progressAt - 60_000).toISOString(),
      status: "in_progress",
      steps: [
        {
          completed_at: null,
          started_at: new Date(progressAt).toISOString(),
          status: "in_progress",
        },
      ],
    },
    now,
    runner: { busy, id: runnerId, name: "MacBook-Pro-2-hebbian", status },
    runAttempt: 2,
    runId: 600,
  });
}

function runnerObservation({
  observedAt,
  progressAt = BASE_NOW - 10 * 60_000,
  runnerId = 23,
  state = "offline_busy",
} = {}) {
  return {
    ref: buildArtifactRunnerObservationRef({
      ...runnerSnapshot({ now: observedAt, progressAt, runnerId }),
      requestRef: request().ref,
      state,
    }),
    sha: "a".repeat(40),
  };
}

describe("Hmux artifact dispatch planning", () => {
  test("keeps FIFO with an explicit one-run lane", () => {
    const first = request({ enqueuedAt: BASE_NOW - 10_000, triggerRunId: "1" });
    const second = request({
      enqueuedAt: BASE_NOW - 5_000,
      sourceSha: "b".repeat(40),
      triggerRunId: "2",
    });

    const blocked = planArtifactDispatch({
      now: BASE_NOW,
      requests: [second, first],
      runs: [run(first)],
    });
    expect(blocked).toMatchObject({ action: "wait", activeRunIds: [500], laneLimit: 1 });

    const ready = planArtifactDispatch({
      now: BASE_NOW,
      requests: [second, first],
      runs: [run(first, { conclusion: "success" })],
    });
    expect(ready.action).toBe("dispatch");
    expect(ready.request.ref).toBe(second.ref);
  });

  test("coalesces duplicate source/event requests instead of dispatching twice", () => {
    const first = request({ triggerRunId: "10" });
    const duplicate = request({
      enqueuedAt: BASE_NOW - 1_000,
      triggerRunId: "11",
    });
    const ready = planArtifactDispatch({
      now: BASE_NOW,
      requests: [duplicate, first],
      runs: [],
    });
    expect(ready).toMatchObject({
      action: "dispatch",
      coalescedRequestCount: 1,
      request: { ref: first.ref },
    });

    const completed = planArtifactDispatch({
      now: BASE_NOW,
      requests: [first, duplicate],
      runs: [run(first, { conclusion: "success" })],
    });

    expect(completed).toMatchObject({
      action: "idle",
      coalescedRequestCount: 1,
    });
  });

  test("retries a canceled run but treats a product failure as terminal", () => {
    const canceled = request({ triggerRunId: "20" });
    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [canceled],
        runs: [run(canceled, { conclusion: "cancelled" })],
      }),
    ).toMatchObject({ action: "dispatch", dispatchAttempt: 2 });

    const failed = request({ sourceSha: "b".repeat(40), triggerRunId: "21" });
    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [failed],
        runs: [run(failed, { conclusion: "failure" })],
      }),
    ).toMatchObject({ action: "idle", terminalRequestCount: 1 });
  });

  test("bounds automatic retries after repeated canceled attempts", () => {
    const retried = request({ triggerRunId: "22" });
    const canceledRuns = [1, 2, 3].map((id) =>
      run(retried, { conclusion: "cancelled", id: 500 + id }),
    );

    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [retried],
        runs: canceledRuns,
      }),
    ).toMatchObject({ action: "idle", terminalRequestCount: 1 });
  });

  test("is restart-safe and cancels a stale lane token before successor dispatch", () => {
    const stale = request({ enqueuedAt: BASE_NOW - 6 * HOUR, triggerRunId: "30" });
    const successor = request({
      sourceSha: "b".repeat(40),
      triggerRunId: "31",
    });
    const input = {
      now: BASE_NOW,
      requests: [stale, successor],
      runs: [run(stale, { createdAt: BASE_NOW - 5 * HOUR, id: 700 })],
    };

    const beforeRestart = planArtifactDispatch(input);
    const afterRestart = planArtifactDispatch(structuredClone(input));
    expect(afterRestart).toEqual(beforeRestart);
    expect(afterRestart).toMatchObject({ action: "cancel-stale", cancelRunIds: [700] });
  });

  test("retains terminal proof after workflow run history ages out", () => {
    const completed = request({ triggerRunId: "35" });
    const result = {
      ref: buildArtifactResultRef({
        conclusion: "success",
        requestRef: completed.ref,
        runAttempt: 1,
        runId: 800,
      }),
      sha: completed.sha,
    };

    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [completed],
        results: [result],
        runs: [],
      }),
    ).toMatchObject({ action: "idle", terminalRequestCount: 1 });
  });

  test("treats a versioned exact CI-failure result as terminal without an artifact run", () => {
    const blocked = request({ triggerRunId: "36" });
    const result = {
      ref: buildArtifactResultRef({
        conclusion: ARTIFACT_CI_FAILURE_CONCLUSION,
        requestRef: blocked.ref,
        runAttempt: 2,
        runId: 801,
      }),
      sha: blocked.sha,
    };

    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [blocked],
        results: [result],
        runs: [],
      }),
    ).toMatchObject({ action: "idle", terminalRequestCount: 1 });
  });

  test("treats unavailable legacy CI product proof as an exact terminal result", () => {
    const blocked = request({ triggerRunId: "37" });
    const result = {
      ref: buildArtifactResultRef({
        conclusion: ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
        requestRef: blocked.ref,
        runAttempt: 1,
        runId: 803,
      }),
      sha: blocked.sha,
    };

    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [blocked],
        results: [result],
        runs: [],
      }),
    ).toMatchObject({ action: "idle", terminalRequestCount: 1 });
  });

  test("allows a later request generation after an exact CI-failure result", () => {
    const blocked = request({ triggerRunId: "36" });
    const retry = request({
      enqueuedAt: BASE_NOW - 1_000,
      triggerRunAttempt: "2",
      triggerRunId: "36",
    });
    const result = {
      ref: buildArtifactResultRef({
        conclusion: ARTIFACT_CI_FAILURE_CONCLUSION,
        requestRef: blocked.ref,
        runAttempt: 1,
        runId: 802,
      }),
      sha: blocked.sha,
    };

    expect(
      planArtifactDispatch({
        now: BASE_NOW,
        requests: [blocked, retry],
        results: [result],
        runs: [],
      }),
    ).toMatchObject({
      action: "dispatch",
      coalescedRequestCount: 1,
      request: { ref: retry.ref },
    });
  });

  test("does not let an out-of-order newer completion erase an older request", () => {
    const older = request({ enqueuedAt: BASE_NOW - 10_000, triggerRunId: "40" });
    const newer = request({
      enqueuedAt: BASE_NOW - 5_000,
      sourceSha: "b".repeat(40),
      triggerRunId: "41",
    });
    const planned = planArtifactDispatch({
      now: BASE_NOW,
      requests: [newer, older],
      runs: [run(newer, { conclusion: "success", id: 900 })],
    });

    expect(planned.action).toBe("dispatch");
    expect(planned.request.ref).toBe(older.ref);
  });
});

describe("Hmux artifact runner observations", () => {
  test("round-trips an immutable exact run, job, runner, and progress identity", () => {
    const ref = buildArtifactRunnerObservationRef({
      ...runnerSnapshot(),
      requestRef: request().ref,
    });

    expect(ref).toContain(ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX);
    expect(parseArtifactRunnerObservationRef(ref, "a".repeat(40))).toMatchObject({
      jobId: 700,
      observedAt: BASE_NOW,
      progressAt: BASE_NOW - 10 * 60_000,
      runAttempt: 2,
      runId: 600,
      runnerId: 23,
      state: "offline_busy",
    });
  });

  test("requires two separated durable offline observations of one unchanged identity", () => {
    const firstAt = BASE_NOW - ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS;
    expect(
      planOfflineArtifactRecovery({
        activeRuns: [{ id: 600, runAttempt: 2, sha: "a".repeat(40) }],
        observations: [
          runnerObservation({ observedAt: BASE_NOW }),
          runnerObservation({ observedAt: firstAt }),
        ],
      }),
    ).toMatchObject({
      action: "force-cancel-offline",
      jobId: 700,
      runAttempt: 2,
      runId: 600,
      runnerId: 23,
    });
  });

  test("fails closed across recovery, progress, runner, interval, and run changes", () => {
    const firstAt = BASE_NOW - ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS;
    const first = runnerObservation({ observedAt: firstAt });
    const second = runnerObservation({ observedAt: BASE_NOW });
    const activeRuns = [{ id: 600, runAttempt: 2, sha: "a".repeat(40) }];
    const wait = (observations, runs = activeRuns) =>
      expect(
        planOfflineArtifactRecovery({ activeRuns: runs, observations }),
      ).toMatchObject({ action: "wait-offline-observation" });

    wait([second]);
    wait([first, runnerObservation({ observedAt: BASE_NOW, state: "healthy" })]);
    wait([
      first,
      runnerObservation({
        observedAt: BASE_NOW,
        progressAt: BASE_NOW - 60_000,
      }),
    ]);
    wait([first, runnerObservation({ observedAt: BASE_NOW, runnerId: 24 })]);
    wait([
      runnerObservation({ observedAt: BASE_NOW - 1_000 }),
      runnerObservation({ observedAt: BASE_NOW }),
    ]);
    wait([first, second], [
      { id: 601, runAttempt: 2, sha: "a".repeat(40) },
    ]);
  });

  test("classifies only the exact busy offline runner and rejects stale job input", () => {
    expect(runnerSnapshot()).toMatchObject({
      jobId: 700,
      runnerId: 23,
      state: "offline_busy",
    });
    expect(runnerSnapshot({ busy: false })).toMatchObject({ state: "healthy" });
    expect(runnerSnapshot({ status: "online" })).toMatchObject({
      state: "healthy",
    });
    expect(() =>
      artifactRunnerSnapshot({
        job: {
          id: 700,
          runner_id: 23,
          started_at: "2026-08-03T00:00:00.000Z",
          status: "completed",
          steps: [],
        },
        now: BASE_NOW,
        runner: { busy: true, id: 23, name: "runner", status: "offline" },
        runAttempt: 2,
        runId: 600,
      }),
    ).toThrow("active artifact job");
  });
});

describe("Hmux artifact admission diagnostics", () => {
  test("keeps artifact work behind exact-source product CI", () => {
    const sha = "a".repeat(40);
    expect(artifactCiReadiness({ runs: [], sourceSha: sha })).toEqual({
      state: "pending",
    });
    expect(
      artifactCiReadiness({
        runs: [{ conclusion: null, head_sha: sha, id: 10, status: "in_progress" }],
        sourceSha: sha,
      }),
    ).toEqual({ runIds: [10], state: "running" });
    expect(
      artifactCiReadiness({
        runs: [{ conclusion: "success", head_sha: sha, id: 11, status: "completed" }],
        sourceSha: sha,
      }),
    ).toEqual({ runId: 11, state: "ready" });
    expect(
      artifactCiReadiness({
        runs: [{ conclusion: "failure", head_sha: sha, id: 12, status: "completed" }],
        sourceSha: sha,
      }),
    ).toEqual({
      conclusion: "failure",
      runAttempt: 1,
      runId: 12,
      state: "blocked",
    });
    expect(
      artifactCiReadiness({
        runs: [
          { conclusion: "success", head_sha: sha, id: 13, status: "completed" },
          {
            conclusion: null,
            head_sha: "b".repeat(40),
            id: 14,
            status: "queued",
          },
        ],
        sourceSha: sha,
      }),
    ).toEqual({ runIds: [14], state: "running" });
  });

  test("binds modern requests to one exact CI run attempt across reruns", () => {
    const sha = "a".repeat(40);
    const attempts = [
      {
        conclusion: "failure",
        head_sha: sha,
        id: 12,
        run_attempt: 1,
        status: "completed",
      },
      {
        conclusion: "success",
        head_sha: sha,
        id: 12,
        run_attempt: 2,
        status: "completed",
      },
    ];
    expect(
      artifactCiReadiness({
        requiredRunAttempt: 1,
        requiredRunId: 12,
        runs: attempts,
        sourceSha: sha,
      }),
    ).toEqual({
      conclusion: "failure",
      runAttempt: 1,
      runId: 12,
      state: "blocked",
    });
    expect(
      artifactCiReadiness({
        requiredRunAttempt: 2,
        requiredRunId: 12,
        runs: attempts,
        sourceSha: sha,
      }),
    ).toEqual({ runId: 12, state: "ready" });
    expect(
      artifactCiReadiness({
        requiredRunAttempt: 1,
        requiredRunId: 12,
        runs: [
          attempts[0],
          {
            conclusion: null,
            head_sha: sha,
            id: 12,
            run_attempt: 2,
            status: "in_progress",
          },
        ],
        sourceSha: sha,
      }),
    ).toEqual({ runIds: [12], state: "running" });
  });

  test("binds CI-failure evidence to the reobserved exact run generation", () => {
    const blocked = request();
    const observed = {
      conclusion: "failure",
      head_sha: blocked.sha,
      id: 12,
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      status: "completed",
    };
    const evidence = artifactCiFailureEvidence({
      conclusion: "failure",
      observed,
      requestRef: blocked.ref,
      requestSha: blocked.sha,
      runAttempt: 2,
      runId: 12,
    });
    expect(evidence).toMatchObject({
      conclusion: "failure",
      runAttempt: 2,
      runId: 12,
      sha: blocked.sha,
    });
    expect(evidence.ref).toContain("/ci_failed/12-2");

    for (const changed of [
      { ...observed, run_attempt: 3, status: "in_progress" },
      { ...observed, head_sha: "b".repeat(40) },
      { ...observed, path: ".github/workflows/other.yml" },
      { ...observed, conclusion: "success" },
    ]) {
      expect(() =>
        artifactCiFailureEvidence({
          conclusion: "failure",
          observed: changed,
          requestRef: blocked.ref,
          requestSha: blocked.sha,
          runAttempt: 2,
          runId: 12,
        }),
      ).toThrow("current GitHub authority");
    }
    expect(() =>
      artifactCiFailureEvidence({
        conclusion: "cancelled",
        observed: { ...observed, conclusion: "cancelled" },
        requestRef: blocked.ref,
        requestSha: blocked.sha,
        runAttempt: 2,
        runId: 12,
      }),
    ).toThrow("not terminal red");
  });

  test("distinguishes visible legacy product proof from an aged-out exact proof", () => {
    const sourceSha = "a".repeat(40);
    const exact = {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: sourceSha,
      id: 12,
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      status: "completed",
      updated_at: new Date(BASE_NOW - 10 * 60_000).toISOString(),
    };
    const artifact = {
      expired: false,
      id: 99,
      name: "ci-product-verification-receipt-v3",
      workflow_run: { head_sha: sourceSha, id: 12 },
    };

    expect(
      artifactCiProductProofAvailability({
        artifacts: [],
        exactArtifacts: [artifact],
        exactRuns: [exact],
        observedAt: BASE_NOW,
        sourceSha,
        visibleRuns: [],
      }),
    ).toEqual({ runAttempt: 2, runId: 12, state: "unavailable" });
    expect(
      artifactCiProductProofAvailability({
        artifacts: [artifact],
        exactArtifacts: [artifact],
        exactRuns: [exact],
        observedAt: BASE_NOW,
        sourceSha,
        visibleRuns: [exact],
      }),
    ).toEqual({ artifactId: 99, runAttempt: 2, runId: 12, state: "ready" });
    expect(
      artifactCiProductProofAvailability({
        artifacts: [artifact],
        exactArtifacts: [],
        exactRuns: [{ ...exact, conclusion: null, status: "in_progress" }],
        observedAt: BASE_NOW,
        sourceSha,
        visibleRuns: [exact],
      }),
    ).toEqual({ runIds: [12], state: "running" });
    expect(
      artifactCiProductProofAvailability({
        artifacts: [],
        exactArtifacts: [],
        exactRuns: [exact],
        observedAt: BASE_NOW,
        sourceSha,
        visibleRuns: [],
      }),
    ).toEqual({ state: "pending" });
    expect(
      artifactCiProductProofAvailability({
        artifacts: [],
        exactArtifacts: [artifact],
        exactRuns: [
          { ...exact, updated_at: new Date(BASE_NOW).toISOString() },
        ],
        observedAt: BASE_NOW + 1_000,
        sourceSha,
        visibleRuns: [],
      }),
    ).toEqual({ runAttempt: 2, runId: 12, state: "pending" });
  });

  test("binds proof-unavailable evidence to one exact successful push attempt", () => {
    const blocked = request();
    const observed = {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: blocked.sha,
      id: 12,
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      status: "completed",
    };
    const evidence = artifactCiProofUnavailableEvidence({
      observed,
      requestRef: blocked.ref,
      requestSha: blocked.sha,
      runAttempt: 2,
      runId: 12,
    });
    expect(evidence).toMatchObject({ runAttempt: 2, runId: 12, sha: blocked.sha });
    expect(evidence.ref).toContain("/ci_proof_unavailable/12-2");

    for (const changed of [
      { ...observed, event: "workflow_dispatch" },
      { ...observed, head_branch: "not-main" },
      { ...observed, status: "in_progress" },
      { ...observed, conclusion: "failure" },
    ]) {
      expect(() =>
        artifactCiProofUnavailableEvidence({
          observed: changed,
          requestRef: blocked.ref,
          requestSha: blocked.sha,
          runAttempt: 2,
          runId: 12,
        }),
      ).toThrow("current GitHub authority");
    }
  });

  test("reports queue age, dispatch latency, and runner wait independently", () => {
    expect(
      artifactAdmissionMetrics({
        admissionStartedAt: BASE_NOW,
        dispatchedAt: BASE_NOW - 500,
        dispatcherStartedAt: BASE_NOW - 800,
        enqueuedAt: BASE_NOW - 5_000,
      }),
    ).toEqual({
      dispatchLatencyMs: 300,
      queueAgeMs: 4_200,
      runnerWaitMs: 500,
    });
  });
});
