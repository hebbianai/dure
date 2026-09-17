#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  ARTIFACT_REQUEST_BRANCH_PREFIX,
  ARTIFACT_REQUEST_REF_PREFIX,
  ARTIFACT_RESULT_REF_PREFIX,
  ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
  ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE,
  ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS,
  ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX,
  ARTIFACT_WORKFLOW_PATH,
  CI_WORKFLOW_PATH,
  artifactCiFailureEvidence,
  artifactCiProductProofAvailability,
  artifactCiProofUnavailableEvidence,
  artifactCiReadiness,
  artifactAdmissionMetrics,
  artifactRunnerSnapshot,
  buildArtifactRequestRef,
  buildArtifactResultRef,
  buildArtifactRunnerObservationRef,
  parseArtifactRequestRef,
  parseArtifactRunnerObservationRef,
  planArtifactDispatch,
  planOfflineArtifactRecovery,
  CI_PRODUCT_VERIFICATION_ARTIFACT,
} from "./lib/hmux-artifact-dispatcher-core.mjs";
import { withoutLocalGitOverrides } from "./lib/git-environment.mjs";

const API_VERSION = "2026-03-10";
const MAX_API_BYTES = 16 * 1024 * 1024;
const MAX_EXACT_CI_PROOF_RUNS = 8;
const ACTIVE_RUN_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

function required(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function defaultGh({ body, endpoint, method = "GET", paginate = false }) {
  const args = [
    "api",
    "--method",
    method,
    endpoint,
    "-H",
    "Accept: application/vnd.github+json",
    "-H",
    `X-GitHub-Api-Version: ${API_VERSION}`,
  ];
  if (paginate) args.push("--paginate", "--slurp");
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    env: withoutLocalGitOverrides({
      ...process.env,
      GH_PROMPT_DISABLED: "1",
    }),
    input: body === undefined ? undefined : `${JSON.stringify(body)}\n`,
    maxBuffer: MAX_API_BYTES,
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `GitHub API ${method} ${endpoint} failed: ${String(result.stderr || result.error?.message || `exit ${result.status}`).trim()}`,
    );
  }
  const source = result.stdout.trim();
  return source ? JSON.parse(source) : null;
}

function repository(value = process.env.GITHUB_REPOSITORY) {
  const normalized = required(value, "GitHub repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("GitHub repository must be owner/name");
  }
  return normalized;
}

function appendSummary(lines, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
}

function appendOutput(values, outputPath = process.env.GITHUB_OUTPUT) {
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    `${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
    "utf8",
  );
}

function flattenPages(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} response is not an array`);
  if (value.length === 0) return [];
  if (value.every((entry) => Array.isArray(entry))) return value.flat();
  return value;
}

export function listArtifactRefs({
  gh = defaultGh,
  observation = false,
  repo,
  result = false,
}) {
  if (observation && result) {
    throw new Error("artifact ref list namespace is ambiguous");
  }
  const prefix = observation
    ? "heads/dure-hmux-artifact-observations/v1/"
    : result
      ? "heads/dure-hmux-artifact-results/v1/"
      : "heads/dure-hmux-artifact-requests/v1/";
  const pages = gh({
    endpoint: `repos/${repository(repo)}/git/matching-refs/${prefix}?per_page=100`,
    paginate: true,
  });
  return flattenPages(pages, "artifact ref list").map((entry) => ({
    ref: required(entry?.ref, "artifact ref name"),
    sha: required(entry?.object?.sha, "artifact ref target"),
  }));
}

function createRefIdempotently({ gh, ref, repo, sha }) {
  const observation = ref.startsWith(ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX);
  const existing = listArtifactRefs({
    gh,
    observation,
    repo,
    result: ref.startsWith(ARTIFACT_RESULT_REF_PREFIX),
  }).find((entry) => entry.ref === ref);
  if (existing) {
    if (existing.sha !== sha) {
      throw new Error(`artifact durable ref ${ref} already targets another SHA`);
    }
    return { created: false, ref, sha };
  }
  try {
    gh({
      body: { ref, sha },
      endpoint: `repos/${repository(repo)}/git/refs`,
      method: "POST",
    });
  } catch (error) {
    const raced = listArtifactRefs({
      gh,
      observation,
      repo,
      result: ref.startsWith(ARTIFACT_RESULT_REF_PREFIX),
    }).find((entry) => entry.ref === ref);
    if (!raced || raced.sha !== sha) throw error;
  }
  return { created: true, ref, sha };
}

export function enqueueArtifactRequest({
  gh = defaultGh,
  repo,
  runAttempt,
  runId,
  sourceEvent,
  sourceSha,
}) {
  const targetRepository = repository(repo);
  const trigger = gh({
    endpoint: `repos/${targetRepository}/actions/runs/${required(runId, "trigger run id")}`,
  });
  const enqueuedAt = Date.parse(required(trigger?.created_at, "trigger creation time"));
  const ref = buildArtifactRequestRef({
    enqueuedAt,
    sourceEvent,
    triggerRunAttempt: runAttempt,
    triggerRunId: runId,
  });
  const request = parseArtifactRequestRef(
    ref,
    required(sourceSha, "artifact source SHA").toLowerCase(),
  );
  const created = createRefIdempotently({
    gh,
    ref,
    repo: targetRepository,
    sha: request.sha,
  });
  return {
    ...created,
    enqueuedAt: new Date(enqueuedAt).toISOString(),
    requestId: ref.slice(ARTIFACT_REQUEST_REF_PREFIX.length),
    sourceEvent,
  };
}

function listArtifactRuns({ gh, repo }) {
  const response = gh({
    endpoint: `repos/${repository(repo)}/actions/workflows/hmux-linux-artifacts.yml/runs?event=workflow_dispatch&per_page=100`,
  });
  if (!Number.isSafeInteger(response?.total_count)) {
    throw new Error("artifact workflow run count is invalid");
  }
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error("artifact workflow run list is invalid");
  }
  return response.workflow_runs;
}

function artifactRequestForRun(run, requestsByBranch) {
  if (
    run?.event !== "workflow_dispatch" ||
    run?.path !== ARTIFACT_WORKFLOW_PATH ||
    typeof run?.head_branch !== "string" ||
    typeof run?.head_sha !== "string"
  ) {
    return null;
  }
  try {
    const request = parseArtifactRequestRef(
      `refs/heads/${run.head_branch}`,
      run.head_sha,
    );
    const durable = requestsByBranch?.get(request.branch);
    if (requestsByBranch && (!durable || durable.sha !== request.sha)) {
      return null;
    }
    return request;
  } catch {
    return null;
  }
}

function durableRequestsByBranch({ gh, repo }) {
  return new Map(
    listArtifactRefs({ gh, repo }).map(({ ref, sha }) => {
      const request = parseArtifactRequestRef(ref, sha);
      return [request.branch, request];
    }),
  );
}

function activeArtifactRuns(runs, requestsByBranch) {
  return runs.flatMap((run) => {
    const request = artifactRequestForRun(run, requestsByBranch);
    const id = Number(run?.id);
    const runAttempt = Number(run?.run_attempt ?? 1);
    if (
      !request ||
      !ACTIVE_RUN_STATUSES.has(String(run?.status ?? "")) ||
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(runAttempt) ||
      runAttempt <= 0
    ) {
      return [];
    }
    return [{ id, request, run, runAttempt, sha: request.sha }];
  });
}

function artifactRunnerSnapshotForRun({ gh, now, repo, run }) {
  const response = gh({
    endpoint: `repos/${repository(repo)}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100`,
  });
  if (!Number.isSafeInteger(response?.total_count) || !Array.isArray(response.jobs)) {
    throw new Error("artifact workflow job list is invalid");
  }
  const jobs = response.jobs.filter(
    (job) =>
      job?.status === "in_progress" &&
      Number.isSafeInteger(Number(job?.runner_id)) &&
      Number(job.runner_id) > 0,
  );
  if (jobs.length === 0) return null;
  if (jobs.length !== 1) {
    throw new Error("artifact workflow has multiple active runner jobs");
  }
  const runnerId = Number(jobs[0].runner_id);
  const runner = gh({
    endpoint: `repos/${repository(repo)}/actions/runners/${runnerId}`,
  });
  return artifactRunnerSnapshot({
    job: jobs[0],
    now,
    runner,
    runAttempt: run.run_attempt ?? 1,
    runId: run.id,
  });
}

function snapshotMatchesObservation(snapshot, observation) {
  return (
    snapshot?.state === "offline_busy" &&
    observation?.state === "offline_busy" &&
    snapshot.runId === observation.runId &&
    snapshot.runAttempt === observation.runAttempt &&
    snapshot.jobId === observation.jobId &&
    snapshot.runnerId === observation.runnerId &&
    snapshot.progressAt === observation.progressAt
  );
}

export function recordArtifactRunnerObservations({
  gh = defaultGh,
  now = () => Date.now(),
  repo,
  runs,
}) {
  const targetRepository = repository(repo);
  const requestsByBranch = durableRequestsByBranch({
    gh,
    repo: targetRepository,
  });
  const active = activeArtifactRuns(runs, requestsByBranch);
  if (active.length === 0) {
    return {
      action: "idle-runner-observations",
      createdCount: 0,
      observedRunIds: [],
    };
  }
  const existing = listArtifactRefs({
    gh,
    observation: true,
    repo: targetRepository,
  });
  const parsed = existing.map(({ ref, sha }) =>
    parseArtifactRunnerObservationRef(ref, sha),
  );
  let createdCount = 0;
  const observedRunIds = [];
  for (const entry of active) {
    const observedAt = now();
    const snapshot = artifactRunnerSnapshotForRun({
      gh,
      now: observedAt,
      repo: targetRepository,
      run: entry.run,
    });
    if (!snapshot) continue;
    const prior = parsed
      .filter(
        (observation) =>
          observation.runId === entry.id &&
          observation.runAttempt === entry.runAttempt &&
          observation.sha === entry.sha,
      )
      .sort(
        (left, right) =>
          left.observedAt - right.observedAt || left.ref.localeCompare(right.ref),
      )
      .at(-1);
    const stalledLongEnough =
      observedAt - snapshot.progressAt >=
      ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS;
    if (snapshot.state === "offline_busy" && !stalledLongEnough) continue;
    if (snapshot.state === "healthy" && prior?.state !== "offline_busy") continue;
    const ref = buildArtifactRunnerObservationRef({
      ...snapshot,
      requestRef: entry.request.ref,
    });
    const result = createRefIdempotently({
      gh,
      ref,
      repo: targetRepository,
      sha: entry.sha,
    });
    if (result.created) createdCount += 1;
    observedRunIds.push(entry.id);
  }
  return {
    action:
      createdCount > 0
        ? "record-runner-observations"
        : "idle-runner-observations",
    createdCount,
    observedRunIds,
  };
}

function listPromotionRuns({ gh, repo }) {
  const response = gh({
    endpoint: `repos/${repository(repo)}/actions/workflows/hmux-release-promotion.yml/runs?per_page=100`,
  });
  if (!Array.isArray(response?.workflow_runs)) {
    throw new Error("promotion workflow run list is invalid");
  }
  return response.workflow_runs;
}

function promotionRunTitle(runId, runAttempt) {
  return `Hmux release promotion · ${runId} · ${runAttempt}`;
}

function listArtifactRunsForBranch({ branch, gh, repo }) {
  const response = gh({
    endpoint: `repos/${repository(repo)}/actions/workflows/hmux-linux-artifacts.yml/runs?event=workflow_dispatch&branch=${encodeURIComponent(branch)}&per_page=100`,
  });
  if (!Array.isArray(response?.workflow_runs)) {
    throw new Error("artifact branch workflow run list is invalid");
  }
  return response.workflow_runs;
}

function exactSourceCiReadiness({ gh, repo, sourceSha }) {
  const exact = gh({
    endpoint: `repos/${repository(repo)}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${sourceSha}&per_page=20`,
  });
  if (!Array.isArray(exact?.workflow_runs)) {
    throw new Error("exact-source CI workflow run list is invalid");
  }
  const lane = gh({
    endpoint: `repos/${repository(repo)}/actions/workflows/ci.yml/runs?per_page=100`,
  });
  if (!Array.isArray(lane?.workflow_runs)) {
    throw new Error("ordinary CI lane workflow run list is invalid");
  }
  return artifactCiReadiness({
    runs: [...exact.workflow_runs, ...lane.workflow_runs],
    sourceSha,
  });
}

function legacyArtifactCiProductProofAvailability({ gh, repo, request }) {
  const targetRepository = repository(repo);
  const exact = gh({
    endpoint: `repos/${targetRepository}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${request.sha}&per_page=20`,
  });
  const visible = gh({
    endpoint: `repos/${targetRepository}/actions/workflows/ci.yml/runs?event=push&branch=main&per_page=100`,
  });
  const receipts = gh({
    endpoint: `repos/${targetRepository}/actions/artifacts?name=${CI_PRODUCT_VERIFICATION_ARTIFACT}&per_page=100`,
  });
  const exactArtifacts = exact.workflow_runs
    .filter(
      (run) =>
        run?.event === "push" &&
        run?.head_branch === "main" &&
        run?.head_sha === request.sha &&
        run?.path === CI_WORKFLOW_PATH &&
        run?.status === "completed" &&
        run?.conclusion === "success",
    )
    .slice(0, MAX_EXACT_CI_PROOF_RUNS)
    .flatMap((run) => {
      const runId = Number(run?.id);
      if (!Number.isSafeInteger(runId) || runId <= 0) {
        throw new Error("exact product-proof CI run id is invalid");
      }
      const response = gh({
        endpoint: `repos/${targetRepository}/actions/runs/${runId}/artifacts?name=${CI_PRODUCT_VERIFICATION_ARTIFACT}&per_page=100`,
      });
      if (!Array.isArray(response?.artifacts)) {
        throw new Error("exact product-proof artifact list is invalid");
      }
      return response.artifacts;
    });
  return artifactCiProductProofAvailability({
    artifacts: receipts?.artifacts,
    exactArtifacts,
    exactRuns: exact?.workflow_runs,
    observedAt: Date.now(),
    sourceSha: request.sha,
    visibleRuns: visible?.workflow_runs,
  });
}

function artifactCiReadinessForRequest({ gh, repo, request }) {
  const targetRepository = repository(repo);
  const trigger = gh({
    endpoint: `repos/${targetRepository}/actions/runs/${request.triggerRunId}/attempts/${request.triggerRunAttempt}`,
  });
  if (
    Number(trigger?.id) !== request.triggerRunId ||
    Number(trigger?.run_attempt) !== request.triggerRunAttempt ||
    trigger?.head_sha !== request.sha
  ) {
    throw new Error("artifact request trigger does not match GitHub run authority");
  }
  if (trigger.path !== CI_WORKFLOW_PATH) {
    return {
      ...exactSourceCiReadiness({
        gh,
        repo: targetRepository,
        sourceSha: request.sha,
      }),
      requestBound: false,
    };
  }
  const lane = gh({
    endpoint: `repos/${targetRepository}/actions/workflows/ci.yml/runs?per_page=100`,
  });
  if (!Array.isArray(lane?.workflow_runs)) {
    throw new Error("ordinary CI lane workflow run list is invalid");
  }
  return {
    ...artifactCiReadiness({
      requiredRunAttempt: request.triggerRunAttempt,
      requiredRunId: request.triggerRunId,
      runs: [trigger, ...lane.workflow_runs],
      sourceSha: request.sha,
    }),
    requestBound: true,
  };
}

export function recordArtifactCiFailure({ gh = defaultGh, ci, repo, request }) {
  const targetRepository = repository(repo);
  if (typeof ci?.requestBound !== "boolean") {
    throw new Error("artifact CI failure binding mode is required");
  }
  const observed = gh({
    endpoint: ci.requestBound
      ? `repos/${targetRepository}/actions/runs/${ci.runId}/attempts/${ci.runAttempt}`
      : `repos/${targetRepository}/actions/runs/${ci.runId}`,
  });
  const evidence = artifactCiFailureEvidence({
    conclusion: ci.conclusion,
    observed,
    requestRef: request.ref,
    requestSha: request.sha,
    runAttempt: ci.runAttempt,
    runId: ci.runId,
  });
  const durable = createRefIdempotently({
    gh,
    ref: evidence.ref,
    repo: targetRepository,
    sha: evidence.sha,
  });
  return {
    ...durable,
    conclusion: evidence.conclusion,
    requestId: evidence.request.requestId,
    runAttempt: evidence.runAttempt,
    runId: evidence.runId,
  };
}

export function recordArtifactCiProofUnavailable({
  gh = defaultGh,
  proof,
  repo,
  request,
}) {
  const targetRepository = repository(repo);
  const reobserved = legacyArtifactCiProductProofAvailability({
    gh,
    repo: targetRepository,
    request,
  });
  if (
    reobserved.state !== "unavailable" ||
    reobserved.runId !== proof?.runId ||
    reobserved.runAttempt !== proof?.runAttempt
  ) {
    throw new Error("artifact CI proof availability changed before recording");
  }
  const observed = gh({
    endpoint: `repos/${targetRepository}/actions/runs/${reobserved.runId}/attempts/${reobserved.runAttempt}`,
  });
  const evidence = artifactCiProofUnavailableEvidence({
    observed,
    requestRef: request.ref,
    requestSha: request.sha,
    runAttempt: reobserved.runAttempt,
    runId: reobserved.runId,
  });
  const durable = createRefIdempotently({
    gh,
    ref: evidence.ref,
    repo: targetRepository,
    sha: evidence.sha,
  });
  return {
    ...durable,
    conclusion: ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
    requestId: evidence.request.requestId,
    runAttempt: evidence.runAttempt,
    runId: evidence.runId,
  };
}

export function terminalizeArtifactCiFailures({
  gh = defaultGh,
  repo,
  requests,
  results,
  runs,
}) {
  const targetRepository = repository(repo);
  const durableRequests =
    requests ?? listArtifactRefs({ gh, repo: targetRepository });
  const durableResults =
    results ?? listArtifactRefs({ gh, repo: targetRepository, result: true });
  const artifactRuns = runs ?? listArtifactRuns({ gh, repo: targetRepository });
  let plan = planArtifactDispatch({
    requests: durableRequests,
    results: durableResults,
    runs: artifactRuns,
  });
  const terminalizations = [];
  let nextCi = null;
  while (plan.action === "dispatch") {
    const ci = artifactCiReadinessForRequest({
      gh,
      repo: targetRepository,
      request: plan.request,
    });
    const proof =
      ci.state === "ready" && ci.requestBound === false
        ? legacyArtifactCiProductProofAvailability({
            gh,
            repo: targetRepository,
            request: plan.request,
          })
        : null;
    const terminalKind =
      ci.state === "blocked"
        ? "ci-failure"
        : proof?.state === "unavailable"
          ? "ci-proof-unavailable"
          : null;
    if (terminalKind === null) {
      nextCi = proof ? { ...ci, proofState: proof.state } : ci;
      break;
    }
    if (
      terminalizations.length >=
      ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE
    ) {
      return {
        action: "ci-terminalization-budget-exhausted",
        createdCount: terminalizations.filter(({ created }) => created).length,
        nextCiState: ci.state,
        nextProofState: proof?.state ?? null,
        nextAction: plan.action,
        nextRequestId: plan.request?.requestId ?? null,
        terminalizations,
      };
    }
    const terminalized =
      terminalKind === "ci-failure"
        ? recordArtifactCiFailure({
            ci,
            gh,
            repo: targetRepository,
            request: plan.request,
          })
        : recordArtifactCiProofUnavailable({
            gh,
            proof,
            repo: targetRepository,
            request: plan.request,
          });
    terminalizations.push(terminalized);
    durableResults.push({ ref: terminalized.ref, sha: plan.request.sha });
    plan = planArtifactDispatch({
      requests: durableRequests,
      results: durableResults,
      runs: artifactRuns,
    });
  }
  return {
    action:
      terminalizations.length > 0
        ? "record-ci-failures"
        : "idle-ci-failures",
    createdCount: terminalizations.filter(({ created }) => created).length,
    nextCiState: nextCi?.state ?? null,
    nextProofState: nextCi?.proofState ?? null,
    nextAction: plan.action,
    nextRequestId: plan.request?.requestId ?? null,
    terminalizations,
  };
}

export function reconcileArtifactRequests({
  gh = defaultGh,
  now = () => Date.now(),
  repo,
}) {
  const targetRepository = repository(repo);
  const dispatcherStartedAt = now();
  const requests = listArtifactRefs({ gh, repo: targetRepository });
  const results = listArtifactRefs({
    gh,
    repo: targetRepository,
    result: true,
  });
  const runs = listArtifactRuns({ gh, repo: targetRepository });
  let plan = planArtifactDispatch({
    now: dispatcherStartedAt,
    requests,
    results,
    runs,
  });
  if (plan.action === "wait") {
    const requestsByBranch = new Map(
      requests.map(({ ref, sha }) => {
        const request = parseArtifactRequestRef(ref, sha);
        return [request.branch, request];
      }),
    );
    const active = activeArtifactRuns(runs, requestsByBranch);
    const observations = listArtifactRefs({
      gh,
      observation: true,
      repo: targetRepository,
    });
    const recovery = planOfflineArtifactRecovery({
      activeRuns: active.map(({ id, runAttempt, sha }) => ({
        id,
        runAttempt,
        sha,
      })),
      observations,
    });
    if (recovery.action === "force-cancel-offline") {
      const observed = gh({
        endpoint: `repos/${targetRepository}/actions/runs/${recovery.runId}/attempts/${recovery.runAttempt}`,
      });
      const current = activeArtifactRuns([observed], requestsByBranch).find(
        (entry) =>
          entry.id === recovery.runId &&
          entry.runAttempt === recovery.runAttempt,
      );
      const snapshot = current
        ? artifactRunnerSnapshotForRun({
            gh,
            now: dispatcherStartedAt,
            repo: targetRepository,
            run: current.run,
          })
        : null;
      if (!snapshotMatchesObservation(snapshot, recovery.latestObservation)) {
        return {
          ...plan,
          action: "wait-offline-revalidation",
          observedRunId: recovery.runId,
        };
      }
      gh({
        endpoint: `repos/${targetRepository}/actions/runs/${recovery.runId}/force-cancel`,
        method: "POST",
      });
      return { ...plan, ...recovery };
    }
  }
  if (plan.action === "cancel-stale") {
    for (const runId of plan.cancelRunIds) {
      gh({
        endpoint: `repos/${targetRepository}/actions/runs/${runId}/cancel`,
        method: "POST",
      });
    }
    return plan;
  }
  if (plan.action !== "dispatch") return plan;

  const ci = artifactCiReadinessForRequest({
    gh,
    repo: targetRepository,
    request: plan.request,
  });
  if (ci.state !== "ready") {
    return {
      ...plan,
      action: ci.state === "blocked" ? "blocked-ci" : "wait-priority-ci",
      ci,
    };
  }
  if (ci.requestBound === false) {
    const proof = legacyArtifactCiProductProofAvailability({
      gh,
      repo: targetRepository,
      request: plan.request,
    });
    if (proof.state !== "ready") {
      return {
        ...plan,
        action:
          proof.state === "unavailable"
            ? "blocked-ci-proof"
            : "wait-ci-proof",
        ci,
        proof,
      };
    }
  }

  // A durable request can outlive the workflow API's first page. Before a
  // dispatch, re-read this exact branch so a lost completion recorder or a
  // dispatcher crash after the API call cannot duplicate an old run.
  const exactRuns = listArtifactRunsForBranch({
    branch: plan.request.branch,
    gh,
    repo: targetRepository,
  });
  plan = planArtifactDispatch({
    now: dispatcherStartedAt,
    requests,
    results,
    runs: [...runs, ...exactRuns],
  });
  if (plan.action !== "dispatch") return plan;

  const dispatchedAt = now();
  const inputs = {
    dispatch_attempt: String(plan.dispatchAttempt),
    dispatched_at: new Date(dispatchedAt).toISOString(),
    dispatcher_started_at: new Date(dispatcherStartedAt).toISOString(),
    enqueued_at: new Date(plan.request.enqueuedAt).toISOString(),
    request_id: plan.request.requestId,
    source_event: plan.request.sourceEvent,
    source_sha: plan.request.sha,
  };
  const dispatched = gh({
    body: { inputs, ref: plan.request.branch },
    endpoint: `repos/${targetRepository}/actions/workflows/hmux-linux-artifacts.yml/dispatches`,
    method: "POST",
  });
  const workflowRunId = Number(dispatched?.workflow_run_id);
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) {
    throw new Error("artifact workflow dispatch did not return an exact run id");
  }
  return {
    ...plan,
    ci,
    dispatchApiLatencyMs: now() - dispatchedAt,
    inputs,
    workflowRunId,
  };
}

export function recordArtifactResult({
  conclusion,
  gh = defaultGh,
  repo,
  runAttempt,
  runId,
}) {
  const targetRepository = repository(repo);
  const observed = gh({
    endpoint: `repos/${targetRepository}/actions/runs/${required(runId, "artifact run id")}/attempts/${required(runAttempt, "artifact run attempt")}`,
  });
  if (
    observed?.event !== "workflow_dispatch" ||
    observed?.path !== ARTIFACT_WORKFLOW_PATH ||
    observed?.status !== "completed" ||
    observed?.conclusion !== conclusion
  ) {
    throw new Error("artifact completion does not match GitHub run authority");
  }
  const requestRef = `${ARTIFACT_REQUEST_REF_PREFIX}${required(observed.head_branch, "artifact run branch").replace(ARTIFACT_REQUEST_BRANCH_PREFIX, "")}`;
  const request = parseArtifactRequestRef(requestRef, observed.head_sha);
  if (request.branch !== observed.head_branch) {
    throw new Error("artifact completion branch is outside the request queue");
  }
  const resultRef = buildArtifactResultRef({
    conclusion,
    requestRef: request.ref,
    runAttempt,
    runId,
  });
  return createRefIdempotently({
    gh,
    ref: resultRef,
    repo: targetRepository,
    sha: request.sha,
  });
}

export function recoverArtifactResults({ gh = defaultGh, repo }) {
  const targetRepository = repository(repo);
  const requests = listArtifactRefs({ gh, repo: targetRepository });
  const requestsByBranch = new Map(
    requests.map(({ ref, sha }) => {
      const request = parseArtifactRequestRef(ref, sha);
      return [request.branch, request];
    }),
  );
  const results = listArtifactRefs({ gh, repo: targetRepository, result: true });
  const existing = new Set(results.map(({ ref }) => ref));
  const runs = listArtifactRuns({ gh, repo: targetRepository });
  const terminalRuns = runs
    .filter(
      (run) =>
        run?.status === "completed" &&
        typeof run?.conclusion === "string" &&
        artifactRequestForRun(run, requestsByBranch),
    )
    .sort((left, right) => Number(left.id) - Number(right.id));
  let createdCount = 0;
  for (const run of terminalRuns) {
    const request = artifactRequestForRun(run, requestsByBranch);
    const resultRef = buildArtifactResultRef({
      conclusion: run.conclusion,
      requestRef: request.ref,
      runAttempt: run.run_attempt,
      runId: run.id,
    });
    if (existing.has(resultRef)) continue;
    const result = recordArtifactResult({
      conclusion: run.conclusion,
      gh,
      repo: targetRepository,
      runAttempt: run.run_attempt,
      runId: run.id,
    });
    existing.add(result.ref);
    if (result.created) createdCount += 1;
  }
  const runnerObservations = recordArtifactRunnerObservations({
    gh,
    repo: targetRepository,
    runs,
  });
  const ciFailures = terminalizeArtifactCiFailures({
    gh,
    repo: targetRepository,
    requests,
    results,
    runs,
  });
  return {
    action:
      createdCount > 0
        ? "record-results"
        : runnerObservations.createdCount > 0
          ? runnerObservations.action
          : ciFailures.terminalizations.length > 0
            ? ciFailures.action
            : "idle-results",
    ciFailureAction: ciFailures.action,
    ciFailureCreatedCount: ciFailures.createdCount,
    ciFailureNextCiState: ciFailures.nextCiState,
    ciFailureNextProofState: ciFailures.nextProofState,
    ciFailureNextAction: ciFailures.nextAction,
    ciFailureNextRequestId: ciFailures.nextRequestId,
    ciTerminalizations: ciFailures.terminalizations,
    createdCount,
    runnerObservationCreatedCount: runnerObservations.createdCount,
    terminalCount: terminalRuns.length,
  };
}

export function reconcileArtifactPromotions({ gh = defaultGh, repo }) {
  const targetRepository = repository(repo);
  const requestsByBranch = durableRequestsByBranch({
    gh,
    repo: targetRepository,
  });
  const candidates = listArtifactRuns({ gh, repo: targetRepository })
    .filter((run) => {
      const request = artifactRequestForRun(run, requestsByBranch);
      return (
        request?.sourceEvent === "push" &&
        run?.status === "completed" &&
        run?.conclusion === "success" &&
        Number.isSafeInteger(Number(run?.id)) &&
        Number.isSafeInteger(Number(run?.run_attempt))
      );
    })
    .sort(
      (left, right) =>
        Date.parse(left.created_at) - Date.parse(right.created_at) ||
        Number(left.id) - Number(right.id),
    );
  const existingTitles = new Set(
    listPromotionRuns({ gh, repo: targetRepository }).map(
      (run) => run?.display_title,
    ),
  );
  const candidate = candidates.find(
    (run) =>
      !existingTitles.has(promotionRunTitle(run.id, run.run_attempt)),
  );
  if (!candidate) {
    return {
      action: "idle-promotion",
      candidateCount: candidates.length,
    };
  }
  const dispatched = gh({
    body: {
      inputs: {
        artifact_run_attempt: String(candidate.run_attempt),
        artifact_run_id: String(candidate.id),
      },
      ref: "main",
    },
    endpoint: `repos/${targetRepository}/actions/workflows/hmux-release-promotion.yml/dispatches`,
    method: "POST",
  });
  const promotionWorkflowRunId = Number(dispatched?.workflow_run_id);
  if (!Number.isSafeInteger(promotionWorkflowRunId) || promotionWorkflowRunId <= 0) {
    throw new Error("promotion workflow dispatch did not return an exact run id");
  }
  return {
    action: "dispatch-promotion",
    artifactRunAttempt: Number(candidate.run_attempt),
    artifactRunId: Number(candidate.id),
    promotionWorkflowRunId,
  };
}

export function verifyArtifactAdmission({
  admissionStartedAt = Date.now(),
  gh = defaultGh,
  inputs,
  ref,
  repo,
  runId,
  sha,
}) {
  const targetRepository = repository(repo);
  const dispatchAttempt = Number(inputs.dispatch_attempt);
  if (!Number.isSafeInteger(dispatchAttempt) || dispatchAttempt < 1 || dispatchAttempt > 3) {
    throw new Error("artifact dispatch attempt is outside the bounded retry policy");
  }
  const request = parseArtifactRequestRef(
    required(ref, "artifact workflow ref"),
    required(sha, "artifact workflow SHA"),
  );
  if (
    request.requestId !== required(inputs.request_id, "artifact request id") ||
    request.sha !== required(inputs.source_sha, "artifact input source SHA") ||
    request.sourceEvent !== required(inputs.source_event, "artifact source event") ||
    request.enqueuedAt !== Date.parse(required(inputs.enqueued_at, "artifact enqueue time"))
  ) {
    throw new Error("artifact dispatch inputs do not match the durable request ref");
  }
  const observed = gh({
    endpoint: `repos/${targetRepository}/actions/runs/${required(runId, "artifact workflow run id")}`,
  });
  if (
    observed?.event !== "workflow_dispatch" ||
    observed?.path !== ARTIFACT_WORKFLOW_PATH ||
    observed?.head_branch !== request.branch ||
    observed?.head_sha !== request.sha ||
    observed?.repository?.full_name !== targetRepository
  ) {
    throw new Error("artifact workflow run does not match GitHub authority");
  }
  return {
    metrics: artifactAdmissionMetrics({
      admissionStartedAt,
      dispatchedAt: inputs.dispatched_at,
      dispatcherStartedAt: inputs.dispatcher_started_at,
      enqueuedAt: inputs.enqueued_at,
    }),
    request,
  };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function main() {
  const command = process.argv[2];
  if (command === "enqueue") {
    const value = enqueueArtifactRequest({
      repo: process.env.GITHUB_REPOSITORY,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      runId: process.env.GITHUB_RUN_ID,
      sourceEvent: required(process.env.HMUX_ARTIFACT_SOURCE_EVENT, "source event"),
      sourceSha: process.env.GITHUB_SHA,
    });
    appendSummary([
      "### Hmux artifact queue",
      "",
      `- request: \`${value.requestId}\``,
      `- enqueued: \`${value.enqueuedAt}\``,
      `- durable ref created: \`${value.created}\``,
    ]);
    print(value);
    return;
  }
  if (command === "reconcile") {
    const value = reconcileArtifactRequests({ repo: process.env.GITHUB_REPOSITORY });
    appendSummary([
      "### Hmux artifact dispatcher",
      "",
      `- action: \`${value.action}\``,
      `- lane: \`${value.activeRunIds.length}/${value.laneLimit}\``,
      `- queued: \`${value.queuedRequestCount}\``,
      ...(value.workflowRunId
        ? [
            `- workflow run: \`${value.workflowRunId}\``,
            `- dispatch API latency: \`${value.dispatchApiLatencyMs}ms\``,
          ]
        : []),
    ]);
    print(value);
    return;
  }
  if (command === "record") {
    const value = recordArtifactResult({
      conclusion: required(process.env.HMUX_ARTIFACT_CONCLUSION, "artifact conclusion"),
      repo: process.env.GITHUB_REPOSITORY,
      runAttempt: process.env.HMUX_ARTIFACT_RUN_ATTEMPT,
      runId: process.env.HMUX_ARTIFACT_RUN_ID,
    });
    print(value);
    return;
  }
  if (command === "recover") {
    const value = recoverArtifactResults({ repo: process.env.GITHUB_REPOSITORY });
    print(value);
    return;
  }
  if (command === "promote") {
    const value = reconcileArtifactPromotions({
      repo: process.env.GITHUB_REPOSITORY,
    });
    print(value);
    return;
  }
  if (command === "admit") {
    const value = verifyArtifactAdmission({
      inputs: {
        dispatch_attempt: process.env.HMUX_ARTIFACT_DISPATCH_ATTEMPT,
        dispatched_at: process.env.HMUX_ARTIFACT_DISPATCHED_AT,
        dispatcher_started_at: process.env.HMUX_ARTIFACT_DISPATCHER_STARTED_AT,
        enqueued_at: process.env.HMUX_ARTIFACT_ENQUEUED_AT,
        request_id: process.env.HMUX_ARTIFACT_REQUEST_ID,
        source_event: process.env.HMUX_ARTIFACT_SOURCE_EVENT,
        source_sha: process.env.HMUX_ARTIFACT_SOURCE_SHA,
      },
      ref: process.env.GITHUB_REF,
      repo: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      sha: process.env.GITHUB_SHA,
    });
    appendOutput({
      dispatch_latency_ms: value.metrics.dispatchLatencyMs,
      queue_age_ms: value.metrics.queueAgeMs,
      runner_wait_ms: value.metrics.runnerWaitMs,
    });
    appendSummary([
      "### Hmux artifact admission",
      "",
      `- request: \`${value.request.requestId}\``,
      `- queue age: \`${value.metrics.queueAgeMs}ms\``,
      `- dispatch latency: \`${value.metrics.dispatchLatencyMs}ms\``,
      `- runner wait: \`${value.metrics.runnerWaitMs}ms\``,
    ]);
    print(value);
    return;
  }
  throw new Error(
    "usage: hmux-artifact-dispatcher.mjs <enqueue|reconcile|record|recover|promote|admit>",
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
