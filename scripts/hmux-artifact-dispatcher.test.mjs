import { describe, expect, test } from "vitest";
import {
  enqueueArtifactRequest,
  reconcileArtifactPromotions,
  reconcileArtifactRequests,
  recordArtifactCiFailure,
  recordArtifactResult,
  recordArtifactRunnerObservations,
  recoverArtifactResults,
  terminalizeArtifactCiFailures,
  verifyArtifactAdmission,
} from "./hmux-artifact-dispatcher.mjs";
import {
  ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS,
  ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE,
  ARTIFACT_REQUEST_REF_PREFIX,
  ARTIFACT_RESULT_REF_PREFIX,
  buildArtifactRequestRef,
  buildArtifactRunnerObservationRef,
} from "./lib/hmux-artifact-dispatcher-core.mjs";

const REPOSITORY = "hebbianai/dure-internal";
const SHA = "a".repeat(40);
const ENQUEUED = Date.parse("2026-08-03T00:00:00.000Z");

function requestRef() {
  return buildArtifactRequestRef({
    enqueuedAt: ENQUEUED,
    sourceEvent: "push",
    triggerRunAttempt: 1,
    triggerRunId: 100,
  });
}

function triggerRun({
  conclusion = "success",
  id = 100,
  path = ".github/workflows/hmux-linux-artifact-dispatcher.yml",
  runAttempt = 1,
  sha = SHA,
  status = "completed",
} = {}) {
  return {
    conclusion,
    head_sha: sha,
    id,
    path,
    run_attempt: runAttempt,
    status,
  };
}

function pushCiRun({ id = 699, sha = SHA } = {}) {
  return {
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: sha,
    id,
    path: ".github/workflows/ci.yml",
    run_attempt: 1,
    status: "completed",
    updated_at: "2026-08-03T00:00:00.000Z",
  };
}

function productReceiptArtifact({ id = 900, runId = 699, sha = SHA } = {}) {
  return {
    expired: false,
    id,
    name: "ci-product-verification-receipt-v3",
    workflow_run: { head_sha: sha, id: runId },
  };
}

function activeRun() {
  return {
    conclusion: null,
    created_at: new Date(ENQUEUED + 1_000).toISOString(),
    event: "workflow_dispatch",
    head_branch: requestRef().replace("refs/heads/", ""),
    head_sha: SHA,
    id: 600,
    path: ".github/workflows/hmux-linux-artifacts.yml",
    run_attempt: 2,
    status: "in_progress",
  };
}

function activeJob() {
  return {
    id: 700,
    runner_id: 23,
    started_at: new Date(ENQUEUED + 2_000).toISOString(),
    status: "in_progress",
    steps: [
      {
        completed_at: null,
        started_at: new Date(ENQUEUED + 3_000).toISOString(),
        status: "in_progress",
      },
    ],
  };
}

function runnerObservationRef(observedAt) {
  return buildArtifactRunnerObservationRef({
    jobId: 700,
    observedAt,
    progressAt: ENQUEUED + 3_000,
    requestRef: requestRef(),
    runAttempt: 2,
    runId: 600,
    runnerId: 23,
    state: "offline_busy",
  });
}

const REQUEST_REFS = "matching-refs/heads/dure-hmux-artifact-requests";
const RESULT_REFS = "matching-refs/heads/dure-hmux-artifact-results";
const OBSERVATION_REFS = "matching-refs/heads/dure-hmux-artifact-observations";
const DISPATCH_RUNS = "hmux-linux-artifacts.yml/runs?event=workflow_dispatch";

const ends = (suffix) => (call) => call.endpoint.endsWith(suffix);
const postGitRefs = (call) =>
  call.method === "POST" && call.endpoint.endsWith("/git/refs");
const posts = (calls) => calls.filter((call) => call.method === "POST");
const noRuns = () => ({ total_count: 0, workflow_runs: [] });
const requestBranch = () => requestRef().replace("refs/heads/", "");
const requestId = (ref) => ref.slice(ARTIFACT_REQUEST_REF_PREFIX.length);
const runnerInfo = (status) => ({
  busy: true,
  id: 23,
  name: "MacBook-Pro-2-hebbian",
  status,
});
const activeJobsPage = () => ({ jobs: [activeJob()], total_count: 1 });

// One matching-refs page of `{ ref, sha }` entries in the GitHub shape.
const refPage = (entries) => [
  entries.map(({ ref, sha }) => ({ ref, object: { sha } })),
];

// Builds a fake `gh` client from ordered routes. A string matcher hits when
// the endpoint contains it; a function matcher receives the whole call and
// its truthy result is forwarded to the reply. A function reply is invoked
// with `(call, matched)`; any other reply is returned as-is. Unrouted calls
// throw, and every call is appended to `calls` when a log array is given.
function ghRouter(routes, calls) {
  return (call) => {
    calls?.push(call);
    for (const [matcher, reply] of routes) {
      const matched =
        typeof matcher === "function"
          ? matcher(call)
          : call.endpoint.includes(matcher);
      if (!matched) continue;
      return typeof reply === "function" ? reply(call, matched) : reply;
    }
    throw new Error(`unexpected GitHub call: ${call.endpoint}`);
  };
}

// Serves `store` as the RESULT_REFS page and records POSTed refs into it.
function resultStoreRoutes(store) {
  return [
    [RESULT_REFS, () => refPage(store)],
    [
      postGitRefs,
      (call) => {
        store.push({ ref: call.body.ref, sha: call.body.sha });
        return { ref: call.body.ref };
      },
    ],
  ];
}

// Records a hit that the test asserts never happens, then still rejects the
// call as unexpected exactly like the hand-rolled fixtures did.
function trapRoute(suffix, trap) {
  return [
    ends(suffix),
    (call) => {
      trap.hit = true;
      throw new Error(`unexpected GitHub call: ${call.endpoint}`);
    },
  ];
}

const reconcileAt = (gh, offsetMs = 5_000) =>
  reconcileArtifactRequests({
    gh,
    now: () => ENQUEUED + offsetMs,
    repo: REPOSITORY,
  });

// The exact dispatch inputs the dispatcher derives for the base request.
const dispatchInputs = (ref) => ({
  dispatch_attempt: "1",
  dispatched_at: "2026-08-03T00:00:05.300Z",
  dispatcher_started_at: "2026-08-03T00:00:05.000Z",
  enqueued_at: "2026-08-03T00:00:00.000Z",
  request_id: requestId(ref),
  source_event: "push",
  source_sha: SHA,
});

// Replays the revalidated run-610 CI failure against the base request.
const recordCiFailure610 = (gh) =>
  recordArtifactCiFailure({
    ci: {
      conclusion: "failure",
      requestBound: false,
      runAttempt: 2,
      runId: 610,
    },
    gh,
    repo: REPOSITORY,
    request: { ref: requestRef(), sha: SHA },
  });

const observeAtMinutes = (gh, minutes) =>
  recordArtifactRunnerObservations({
    gh,
    now: () => ENQUEUED + minutes * 60_000,
    repo: REPOSITORY,
    runs: [activeRun()],
  });

// The two-observation offline scenario: an aged observation pair past the
// minimum interval, one active dispatch run, and the exact runner 23.
function offlineScenarioGh({ calls, cancelTrap, runnerStatus }) {
  const observations = [
    runnerObservationRef(ENQUEUED + 10 * 60_000),
    runnerObservationRef(
      ENQUEUED + 10 * 60_000 + ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS,
    ),
  ];
  return ghRouter(
    [
      [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
      [RESULT_REFS, () => refPage([])],
      [
        OBSERVATION_REFS,
        () => refPage(observations.map((ref) => ({ ref, sha: SHA }))),
      ],
      [DISPATCH_RUNS, () => ({ total_count: 1, workflow_runs: [activeRun()] })],
      [ends("/actions/runs/600/attempts/2"), () => activeRun()],
      ["/actions/runs/600/attempts/2/jobs", activeJobsPage],
      [ends("/actions/runners/23"), () => runnerInfo(runnerStatus)],
      cancelTrap
        ? trapRoute("/force-cancel", cancelTrap)
        : [ends("/actions/runs/600/force-cancel"), null],
    ],
    calls,
  );
}

// The completed workflow_dispatch artifacts run the promotion tests share.
const promotedArtifactRun = () => ({
  conclusion: "success",
  created_at: "2026-08-03T00:02:00.000Z",
  event: "workflow_dispatch",
  head_branch: requestBranch(),
  head_sha: SHA,
  id: 700,
  path: ".github/workflows/hmux-linux-artifacts.yml",
  run_attempt: 2,
  status: "completed",
});

describe("Hmux artifact GitHub dispatcher adapter", () => {
  test("publishes an idempotent exact-SHA request ref", () => {
    const calls = [];
    let refs = [];
    const gh = ghRouter(
      [
        [
          ends("/actions/runs/100"),
          () => ({ created_at: new Date(ENQUEUED).toISOString() }),
        ],
        [REQUEST_REFS, () => [refs]],
        [
          postGitRefs,
          (call) => {
            refs = [{ ref: call.body.ref, object: { sha: call.body.sha } }];
            return { ref: call.body.ref };
          },
        ],
      ],
      calls,
    );
    const enqueue = () =>
      enqueueArtifactRequest({
        gh,
        repo: REPOSITORY,
        runAttempt: 1,
        runId: 100,
        sourceEvent: "push",
        sourceSha: SHA,
      });

    const first = enqueue();
    const second = enqueue();

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, ref: requestRef(), sha: SHA });
    expect(posts(calls)).toHaveLength(1);
  });

  test("dispatches the FIFO request by immutable branch and exact inputs", () => {
    const calls = [];
    const ref = requestRef();
    const receipt = () => ({ artifacts: [productReceiptArtifact()] });
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref, sha: SHA }])],
        [RESULT_REFS, () => refPage([])],
        [DISPATCH_RUNS, noRuns],
        [ends("/actions/runs/100/attempts/1"), () => triggerRun()],
        [
          "actions/workflows/ci.yml/runs",
          () => ({ workflow_runs: [pushCiRun()] }),
        ],
        ["/actions/runs/699/artifacts?", receipt],
        ["actions/artifacts?name=", receipt],
        [ends("/dispatches"), () => ({ workflow_run_id: 700 })],
      ],
      calls,
    );
    const times = [ENQUEUED + 5_000, ENQUEUED + 5_300, ENQUEUED + 5_340];
    const result = reconcileArtifactRequests({
      gh,
      now: () => times.shift(),
      repo: REPOSITORY,
    });

    expect(result).toMatchObject({
      action: "dispatch",
      dispatchApiLatencyMs: 40,
      workflowRunId: 700,
    });
    const dispatch = calls.find((call) => call.endpoint.endsWith("/dispatches"));
    expect(dispatch.body.ref).toBe(requestBranch());
    expect(dispatch.body.inputs).toEqual(dispatchInputs(ref));
  });

  test("recovers a prior exact-branch run after dispatcher response loss", () => {
    const branch = requestBranch();
    const dispatched = { hit: false };
    const receipt = () => ({
      artifacts: [productReceiptArtifact({ id: 901, runId: 649 })],
    });
    const gh = ghRouter([
      [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
      [RESULT_REFS, () => refPage([])],
      [
        `branch=${encodeURIComponent(branch)}`,
        () => ({
          total_count: 1,
          workflow_runs: [
            {
              conclusion: "success",
              created_at: "2026-08-03T00:00:01.000Z",
              event: "workflow_dispatch",
              head_branch: branch,
              head_sha: SHA,
              id: 650,
              path: ".github/workflows/hmux-linux-artifacts.yml",
              run_attempt: 1,
              status: "completed",
            },
          ],
        }),
      ],
      [DISPATCH_RUNS, noRuns],
      [ends("/actions/runs/100/attempts/1"), () => triggerRun()],
      [
        "actions/workflows/ci.yml/runs",
        () => ({ workflow_runs: [pushCiRun({ id: 649 })] }),
      ],
      ["/actions/runs/649/artifacts?", receipt],
      ["actions/artifacts?name=", receipt],
      trapRoute("/dispatches", dispatched),
    ]);

    expect(reconcileAt(gh)).toMatchObject({
      action: "idle",
      terminalRequestCount: 1,
    });
    expect(dispatched.hit).toBe(false);
  });

  test("keeps the macOS artifact runner behind exact-source CI", () => {
    const dispatched = { hit: false };
    const gh = ghRouter([
      [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
      [RESULT_REFS, () => refPage([])],
      [ends("/actions/runs/100/attempts/1"), () => triggerRun()],
      [
        "actions/workflows/ci.yml/runs",
        () => ({
          workflow_runs: [
            { conclusion: null, head_sha: SHA, id: 600, status: "queued" },
          ],
        }),
      ],
      [DISPATCH_RUNS, noRuns],
      trapRoute("/dispatches", dispatched),
    ]);

    expect(reconcileAt(gh)).toMatchObject({
      action: "wait-priority-ci",
      ci: { runIds: [600], state: "running" },
    });
    expect(dispatched.hit).toBe(false);
  });

  test("recovery terminalizes an exact red CI request before dispatch advances", () => {
    const blockedRef = requestRef();
    const nextRef = buildArtifactRequestRef({
      enqueuedAt: ENQUEUED + 1_000,
      sourceEvent: "push",
      triggerRunAttempt: 2,
      triggerRunId: 100,
    });
    const resultRefs = [];
    const gh = ghRouter([
      [
        REQUEST_REFS,
        () =>
          refPage([
            { ref: blockedRef, sha: SHA },
            { ref: nextRef, sha: SHA },
          ]),
      ],
      ...resultStoreRoutes(resultRefs),
      [
        `branch=${encodeURIComponent(nextRef.replace("refs/heads/", ""))}`,
        noRuns,
      ],
      [DISPATCH_RUNS, noRuns],
      [
        ends("/actions/runs/100/attempts/1"),
        () =>
          triggerRun({
            conclusion: "failure",
            path: ".github/workflows/ci.yml",
          }),
      ],
      [
        ends("/actions/runs/100/attempts/2"),
        () => triggerRun({ path: ".github/workflows/ci.yml", runAttempt: 2 }),
      ],
      ["ci.yml/runs?per_page=100", () => ({ workflow_runs: [] })],
      [ends("/dispatches"), () => ({ workflow_run_id: 700 })],
    ]);

    expect(recoverArtifactResults({ gh, repo: REPOSITORY })).toMatchObject({
      action: "record-ci-failures",
      ciFailureAction: "record-ci-failures",
      ciTerminalizations: [
        {
          conclusion: "failure",
          created: true,
          requestId: requestId(blockedRef),
          runAttempt: 1,
          runId: 100,
        },
      ],
      ciFailureNextAction: "dispatch",
      ciFailureNextCiState: "ready",
      ciFailureNextRequestId: requestId(nextRef),
    });
    expect(reconcileAt(gh)).toMatchObject({
      action: "dispatch",
      request: { ref: nextRef, sha: SHA },
      workflowRunId: 700,
    });
    expect(resultRefs).toEqual([
      {
        ref: `${ARTIFACT_RESULT_REF_PREFIX}${requestId(blockedRef)}/ci_failed/100-1`,
        sha: SHA,
      },
    ]);
  });

  test("recovery terminalizes an aged-out legacy product proof before dispatch advances", () => {
    const blockedRef = requestRef();
    const nextSha = "b".repeat(40);
    const nextRef = buildArtifactRequestRef({
      enqueuedAt: ENQUEUED + 1_000,
      sourceEvent: "push",
      triggerRunAttempt: 1,
      triggerRunId: 200,
    });
    const resultRefs = [];
    const exactProofRun = {
      conclusion: "success",
      event: "push",
      head_branch: "main",
      head_sha: SHA,
      id: 610,
      path: ".github/workflows/ci.yml",
      run_attempt: 2,
      status: "completed",
      updated_at: "2026-08-03T00:00:00.000Z",
    };
    const gh = ghRouter([
      [
        REQUEST_REFS,
        () =>
          refPage([
            { ref: blockedRef, sha: SHA },
            { ref: nextRef, sha: nextSha },
          ]),
      ],
      ...resultStoreRoutes(resultRefs),
      [DISPATCH_RUNS, noRuns],
      [ends("/actions/runs/100/attempts/1"), () => triggerRun()],
      [
        ends("/actions/runs/200/attempts/1"),
        () =>
          triggerRun({
            id: 200,
            path: ".github/workflows/ci.yml",
            sha: nextSha,
          }),
      ],
      [ends("/actions/runs/610/attempts/2"), exactProofRun],
      [`head_sha=${SHA}`, () => ({ workflow_runs: [exactProofRun] })],
      [
        "ci.yml/runs?event=push&branch=main&per_page=100",
        () => ({ workflow_runs: [] }),
      ],
      ["actions/artifacts?name=", () => ({ artifacts: [] })],
      [
        "/actions/runs/610/artifacts?",
        () => ({
          artifacts: [
            productReceiptArtifact({ id: 902, runId: 610, sha: SHA }),
          ],
        }),
      ],
      ["ci.yml/runs?per_page=100", () => ({ workflow_runs: [] })],
      [
        `branch=${encodeURIComponent(nextRef.replace("refs/heads/", ""))}`,
        noRuns,
      ],
      [ends("/dispatches"), () => ({ workflow_run_id: 700 })],
    ]);

    expect(recoverArtifactResults({ gh, repo: REPOSITORY })).toMatchObject({
      action: "record-ci-failures",
      ciTerminalizations: [
        {
          conclusion: "ci_proof_unavailable",
          created: true,
          requestId: requestId(blockedRef),
          runAttempt: 2,
          runId: 610,
        },
      ],
      ciFailureNextAction: "dispatch",
      ciFailureNextCiState: "ready",
      ciFailureNextRequestId: requestId(nextRef),
    });
    expect(reconcileAt(gh)).toMatchObject({
      action: "dispatch",
      request: { ref: nextRef, sha: nextSha },
      workflowRunId: 700,
    });
    expect(resultRefs).toEqual([
      {
        ref: `${ARTIFACT_RESULT_REF_PREFIX}${requestId(blockedRef)}/ci_proof_unavailable/610-2`,
        sha: SHA,
      },
    ]);
  });

  test("records the same revalidated CI failure idempotently", () => {
    const refs = [];
    const calls = [];
    const gh = ghRouter(
      [
        [
          ends("/actions/runs/610"),
          () => ({
            conclusion: "failure",
            head_sha: SHA,
            id: 610,
            path: ".github/workflows/ci.yml",
            run_attempt: 2,
            status: "completed",
          }),
        ],
        ...resultStoreRoutes(refs),
      ],
      calls,
    );

    expect(recordCiFailure610(gh)).toMatchObject({ created: true });
    expect(recordCiFailure610(gh)).toMatchObject({ created: false });
    expect(posts(calls)).toHaveLength(1);
    expect(refs).toHaveLength(1);
  });

  test("writes no terminal ref when a CI rerun changes the observed generation", () => {
    const calls = [];
    const gh = ghRouter(
      [
        [
          ends("/actions/runs/610"),
          () => ({
            conclusion: null,
            head_sha: SHA,
            id: 610,
            path: ".github/workflows/ci.yml",
            run_attempt: 3,
            status: "in_progress",
          }),
        ],
      ],
      calls,
    );

    expect(() => recordCiFailure610(gh)).toThrow("current GitHub authority");
    expect(posts(calls)).toHaveLength(0);
  });

  test("writes no terminal ref when exact CI authority cannot be observed", () => {
    const calls = [];
    const gh = (call) => {
      calls.push(call);
      throw new Error("CI authority unavailable");
    };

    expect(() => recordCiFailure610(gh)).toThrow("CI authority unavailable");
    expect(calls).toHaveLength(1);
    expect(posts(calls)).toHaveLength(0);
  });

  test("fails closed before classification when request trigger authority is unavailable", () => {
    const calls = [];
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
        [RESULT_REFS, () => refPage([])],
        [DISPATCH_RUNS, noRuns],
        [
          ends("/actions/runs/100/attempts/1"),
          () => {
            throw new Error("request trigger unavailable");
          },
        ],
      ],
      calls,
    );

    expect(() =>
      terminalizeArtifactCiFailures({ gh, repo: REPOSITORY }),
    ).toThrow("request trigger unavailable");
    expect(posts(calls)).toHaveLength(0);
  });

  test("bounds CI-failure terminalization work in one reconcile", () => {
    const requests = Array.from(
      { length: ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE + 1 },
      (_, index) => ({
        ref: buildArtifactRequestRef({
          enqueuedAt: ENQUEUED + index,
          sourceEvent: "push",
          triggerRunAttempt: 1,
          triggerRunId: 200 + index,
        }),
        runId: 200 + index,
        sha: (index + 1).toString(16).padStart(40, "0"),
      }),
    );
    const resultRefs = [];
    const calls = [];
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage(requests)],
        ...resultStoreRoutes(resultRefs),
        [DISPATCH_RUNS, noRuns],
        [
          (call) =>
            requests.find(({ runId }) =>
              call.endpoint.endsWith(`/actions/runs/${runId}/attempts/1`),
            ),
          (_call, trigger) =>
            triggerRun({
              conclusion: "failure",
              id: trigger.runId,
              path: ".github/workflows/ci.yml",
              sha: trigger.sha,
            }),
        ],
        [
          (call) =>
            requests.find(({ sha }) =>
              call.endpoint.includes(`ci.yml/runs?head_sha=${sha}`),
            ),
          (_call, exact) => ({
            workflow_runs: [
              {
                conclusion: "failure",
                head_sha: exact.sha,
                id: exact.runId,
                run_attempt: 1,
                status: "completed",
              },
            ],
          }),
        ],
        ["ci.yml/runs?per_page=100", () => ({ workflow_runs: [] })],
        [
          (call) =>
            requests.find(({ runId }) =>
              call.endpoint.endsWith(`/actions/runs/${runId}`),
            ),
          (_call, observed) => ({
            conclusion: "failure",
            head_sha: observed.sha,
            id: observed.runId,
            path: ".github/workflows/ci.yml",
            run_attempt: 1,
            status: "completed",
          }),
        ],
      ],
      calls,
    );

    expect(
      terminalizeArtifactCiFailures({
        gh,
        repo: REPOSITORY,
      }),
    ).toMatchObject({
      action: "ci-terminalization-budget-exhausted",
      nextAction: "dispatch",
      nextCiState: "blocked",
      nextRequestId: requestId(requests.at(-1).ref),
      terminalizations: expect.any(Array),
    });
    expect(resultRefs).toHaveLength(
      ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE,
    );
    expect(posts(calls)).toHaveLength(
      ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE,
    );
  });

  test("keeps an older artifact behind a newer ordinary CI run", () => {
    const dispatched = { hit: false };
    const gh = ghRouter([
      [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
      [RESULT_REFS, () => refPage([])],
      [DISPATCH_RUNS, noRuns],
      [ends("/actions/runs/100/attempts/1"), () => triggerRun()],
      [`head_sha=${SHA}`, () => ({ workflow_runs: [pushCiRun({ id: 610 })] })],
      [
        "ci.yml/runs?per_page=100",
        () => ({
          workflow_runs: [
            {
              conclusion: null,
              head_sha: "b".repeat(40),
              id: 611,
              status: "in_progress",
            },
          ],
        }),
      ],
      trapRoute("/dispatches", dispatched),
    ]);

    expect(reconcileAt(gh)).toMatchObject({
      action: "wait-priority-ci",
      ci: { runIds: [611], state: "running" },
    });
    expect(dispatched.hit).toBe(false);
  });

  test("records an exact immutable busy-offline runner observation", () => {
    const calls = [];
    let observations = [];
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
        [OBSERVATION_REFS, () => [observations]],
        ["/actions/runs/600/attempts/2/jobs", activeJobsPage],
        [ends("/actions/runners/23"), () => runnerInfo("offline")],
        [
          postGitRefs,
          (call) => {
            observations = [
              { ref: call.body.ref, object: { sha: call.body.sha } },
            ];
            return { ref: call.body.ref };
          },
        ],
      ],
      calls,
    );

    expect(observeAtMinutes(gh, 4)).toMatchObject({
      action: "idle-runner-observations",
      createdCount: 0,
    });
    expect(posts(calls)).toHaveLength(0);

    expect(observeAtMinutes(gh, 20)).toMatchObject({
      action: "record-runner-observations",
      createdCount: 1,
      observedRunIds: [600],
    });
    expect(calls.find((call) => call.method === "POST").body.ref).toContain(
      "dure-hmux-artifact-observations/v1/",
    );
  });

  test("fails closed when exact runner authority cannot be observed", () => {
    const calls = [];
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
        [OBSERVATION_REFS, () => refPage([])],
        ["/actions/runs/600/attempts/2/jobs", activeJobsPage],
        [
          ends("/actions/runners/23"),
          () => {
            throw new Error("runner authority unavailable");
          },
        ],
      ],
      calls,
    );

    expect(() => observeAtMinutes(gh, 20)).toThrow(
      "runner authority unavailable",
    );
    expect(posts(calls)).toHaveLength(0);
  });

  test("force-cancels only after two observations and exact live revalidation", () => {
    const calls = [];
    const gh = offlineScenarioGh({ calls, runnerStatus: "offline" });

    expect(reconcileAt(gh, 20 * 60_000)).toMatchObject({
      action: "force-cancel-offline",
      runId: 600,
      runnerId: 23,
    });
    expect(
      calls.filter((call) => call.endpoint.endsWith("/force-cancel")),
    ).toHaveLength(1);
  });

  test("keeps an offline observation harmless after the exact runner reconnects", () => {
    const canceled = { hit: false };
    const gh = offlineScenarioGh({ cancelTrap: canceled, runnerStatus: "online" });

    expect(reconcileAt(gh, 20 * 60_000)).toMatchObject({
      action: "wait-offline-revalidation",
    });
    expect(canceled.hit).toBe(false);
  });

  test("records completion as a durable result ref", () => {
    const gh = ghRouter([
      [
        "/actions/runs/700/attempts/1",
        () => ({
          conclusion: "success",
          event: "workflow_dispatch",
          head_branch: requestBranch(),
          head_sha: SHA,
          path: ".github/workflows/hmux-linux-artifacts.yml",
          status: "completed",
        }),
      ],
      [RESULT_REFS, () => refPage([])],
      [ends("/git/refs"), (call) => ({ ref: call.body.ref })],
    ]);
    const result = recordArtifactResult({
      conclusion: "success",
      gh,
      repo: REPOSITORY,
      runAttempt: 1,
      runId: 700,
    });

    expect(result.ref).toContain("refs/heads/dure-hmux-artifact-results/v1/");
    expect(result.ref).toContain("/success/700-1");
    expect(result.sha).toBe(SHA);
  });

  test("recovers terminal results when workflow_run chaining is suppressed", () => {
    const calls = [];
    const terminal = {
      conclusion: "success",
      created_at: new Date(ENQUEUED + 1_000).toISOString(),
      event: "workflow_dispatch",
      head_branch: requestBranch(),
      head_sha: SHA,
      id: 700,
      path: ".github/workflows/hmux-linux-artifacts.yml",
      run_attempt: 2,
      status: "completed",
    };
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
        [RESULT_REFS, () => refPage([])],
        [DISPATCH_RUNS, () => ({ total_count: 1, workflow_runs: [terminal] })],
        ["/actions/runs/700/attempts/2", terminal],
        [ends("/git/refs"), (call) => ({ ref: call.body.ref })],
      ],
      calls,
    );

    expect(recoverArtifactResults({ gh, repo: REPOSITORY })).toMatchObject({
      action: "record-results",
      createdCount: 1,
      terminalCount: 1,
    });
    expect(
      calls.find((call) => call.endpoint.endsWith("/git/refs")).body.ref,
    ).toContain("/success/700-2");
  });

  test("dispatches one idempotent trusted promotion for an exact green run", () => {
    const calls = [];
    const gh = ghRouter(
      [
        [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
        [
          DISPATCH_RUNS,
          () => ({ total_count: 1, workflow_runs: [promotedArtifactRun()] }),
        ],
        [
          "hmux-release-promotion.yml/runs?per_page=100",
          () => ({ workflow_runs: [] }),
        ],
        [
          ends("hmux-release-promotion.yml/dispatches"),
          () => ({ workflow_run_id: 800 }),
        ],
      ],
      calls,
    );

    expect(reconcileArtifactPromotions({ gh, repo: REPOSITORY })).toEqual({
      action: "dispatch-promotion",
      artifactRunAttempt: 2,
      artifactRunId: 700,
      promotionWorkflowRunId: 800,
    });
    const dispatch = calls.find((call) =>
      call.endpoint.endsWith("hmux-release-promotion.yml/dispatches"),
    );
    expect(dispatch.body).toEqual({
      inputs: { artifact_run_attempt: "2", artifact_run_id: "700" },
      ref: "main",
    });
  });

  test("does not redispatch an already identified promotion", () => {
    const dispatched = { hit: false };
    const gh = ghRouter([
      [REQUEST_REFS, () => refPage([{ ref: requestRef(), sha: SHA }])],
      [
        DISPATCH_RUNS,
        () => ({ total_count: 1, workflow_runs: [promotedArtifactRun()] }),
      ],
      [
        "hmux-release-promotion.yml/runs?per_page=100",
        () => ({
          workflow_runs: [
            { display_title: "Hmux release promotion · 700 · 2" },
          ],
        }),
      ],
      trapRoute("/dispatches", dispatched),
    ]);

    expect(reconcileArtifactPromotions({ gh, repo: REPOSITORY })).toEqual({
      action: "idle-promotion",
      candidateCount: 1,
    });
    expect(dispatched.hit).toBe(false);
  });

  test("admits only a run whose GitHub authority matches its durable ref", () => {
    const ref = requestRef();
    const inputs = dispatchInputs(ref);
    const gh = () => ({
      event: "workflow_dispatch",
      head_branch: requestBranch(),
      head_sha: SHA,
      path: ".github/workflows/hmux-linux-artifacts.yml",
      repository: { full_name: REPOSITORY },
    });
    const admit = (admissionInputs) =>
      verifyArtifactAdmission({
        admissionStartedAt: ENQUEUED + 5_800,
        gh,
        inputs: admissionInputs,
        ref,
        repo: REPOSITORY,
        runId: 700,
        sha: SHA,
      });

    expect(admit(inputs)).toMatchObject({
      metrics: {
        dispatchLatencyMs: 300,
        queueAgeMs: 5_000,
        runnerWaitMs: 500,
      },
    });
    expect(() => admit({ ...inputs, source_sha: "b".repeat(40) })).toThrow(
      "do not match the durable request ref",
    );
  });
});
