export const ARTIFACT_REQUEST_REF_PREFIX =
  "refs/heads/dure-hmux-artifact-requests/v1/";
export const ARTIFACT_REQUEST_BRANCH_PREFIX =
  "dure-hmux-artifact-requests/v1/";
export const ARTIFACT_RESULT_REF_PREFIX =
  "refs/heads/dure-hmux-artifact-results/v1/";
export const ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX =
  "refs/heads/dure-hmux-artifact-observations/v1/";
export const ARTIFACT_WORKFLOW_PATH =
  ".github/workflows/hmux-linux-artifacts.yml";
export const ARTIFACT_LANE_LIMIT = 1;
export const ARTIFACT_ACTIVE_STALE_MS = 4 * 60 * 60 * 1_000;
export const ARTIFACT_MAX_AUTOMATIC_ATTEMPTS = 3;
export const ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS = 5 * 60 * 1_000;
export const ARTIFACT_CI_FAILURE_CONCLUSION = "ci_failed";
export const ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION =
  "ci_proof_unavailable";
export const ARTIFACT_MAX_CI_TERMINALIZATIONS_PER_RECONCILE = 8;
export const ARTIFACT_CI_PROOF_VISIBILITY_GRACE_MS = 5 * 60 * 1_000;
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const CI_PRODUCT_VERIFICATION_ARTIFACT =
  "ci-product-verification-receipt-v3";

const REQUEST_ID = /^(\d{13})-(push|schedule)-(\d+)-(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const OBSERVATION_STATE = new Set(["healthy", "offline_busy"]);
const ACTIVE_STATUSES = new Set([
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);
const TERMINAL_CONCLUSIONS = new Set([
  "action_required",
  "failure",
  "success",
  "timed_out",
]);
const PRE_ARTIFACT_TERMINAL_CONCLUSIONS = new Set([
  ARTIFACT_CI_FAILURE_CONCLUSION,
  ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
]);

function integer(value, label, { minimum = 0 } = {}) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function timestamp(value, label) {
  const parsed =
    typeof value === "number" ? value : Date.parse(String(value ?? ""));
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return parsed;
}

function sourceSha(value, label = "artifact request source SHA") {
  const normalized = String(value ?? "").toLowerCase();
  if (!SHA.test(normalized)) throw new Error(`${label} must be a full Git SHA`);
  return normalized;
}

export function buildArtifactRequestRef({
  enqueuedAt,
  sourceEvent,
  triggerRunAttempt,
  triggerRunId,
}) {
  const epoch = integer(enqueuedAt, "artifact request enqueue time");
  const event = String(sourceEvent ?? "");
  if (event !== "push" && event !== "schedule") {
    throw new Error("artifact request source event must be push or schedule");
  }
  const runId = integer(triggerRunId, "artifact trigger run id", { minimum: 1 });
  const attempt = integer(triggerRunAttempt, "artifact trigger run attempt", {
    minimum: 1,
  });
  return `${ARTIFACT_REQUEST_REF_PREFIX}${String(epoch).padStart(13, "0")}-${event}-${runId}-${attempt}`;
}

export function parseArtifactRequestRef(ref, sha) {
  const normalizedRef = String(ref ?? "");
  if (!normalizedRef.startsWith(ARTIFACT_REQUEST_REF_PREFIX)) {
    throw new Error("artifact request ref is outside the durable queue namespace");
  }
  const requestId = normalizedRef.slice(ARTIFACT_REQUEST_REF_PREFIX.length);
  const match = REQUEST_ID.exec(requestId);
  if (!match) throw new Error("artifact request ref has an invalid identity");
  const enqueuedAt = integer(match[1], "artifact request enqueue time");
  const sourceEvent = match[2];
  const triggerRunId = integer(match[3], "artifact trigger run id", {
    minimum: 1,
  });
  const triggerRunAttempt = integer(
    match[4],
    "artifact trigger run attempt",
    { minimum: 1 },
  );
  return {
    branch: `${ARTIFACT_REQUEST_BRANCH_PREFIX}${requestId}`,
    enqueuedAt,
    ref: normalizedRef,
    requestId,
    sha: sourceSha(sha),
    sourceEvent,
    triggerRunAttempt,
    triggerRunId,
  };
}

function observationState(value) {
  const normalized = String(value ?? "");
  if (!OBSERVATION_STATE.has(normalized)) {
    throw new Error("artifact runner observation state is invalid");
  }
  return normalized;
}

export function artifactRunnerSnapshot({
  job,
  now = Date.now(),
  runner,
  runAttempt,
  runId,
}) {
  if (job?.status !== "in_progress") {
    throw new Error("artifact runner observation requires an active artifact job");
  }
  const observedAt = timestamp(now, "artifact runner observation time");
  const jobId = integer(job.id, "artifact job id", { minimum: 1 });
  const runnerId = integer(job.runner_id, "artifact job runner id", {
    minimum: 1,
  });
  if (integer(runner?.id, "artifact runner id", { minimum: 1 }) !== runnerId) {
    throw new Error("artifact job and runner identities do not match");
  }
  if (typeof runner?.busy !== "boolean") {
    throw new Error("artifact runner busy state is invalid");
  }
  const runnerStatus = String(runner?.status ?? "");
  if (!new Set(["online", "offline"]).has(runnerStatus)) {
    throw new Error("artifact runner status is invalid");
  }
  const progressCandidates = [job.started_at];
  if (!Array.isArray(job.steps)) {
    throw new Error("artifact job steps are invalid");
  }
  for (const step of job.steps) {
    if (step?.started_at) progressCandidates.push(step.started_at);
    if (step?.completed_at) progressCandidates.push(step.completed_at);
  }
  const progressAt = Math.max(
    ...progressCandidates.map((value) =>
      timestamp(value, "artifact job progress time"),
    ),
  );
  if (progressAt > observedAt) {
    throw new Error("artifact job progress cannot be newer than its observation");
  }
  return {
    jobId,
    observedAt,
    progressAt,
    runAttempt: integer(runAttempt, "artifact workflow run attempt", {
      minimum: 1,
    }),
    runId: integer(runId, "artifact workflow run id", { minimum: 1 }),
    runnerId,
    runnerName: String(runner.name ?? ""),
    state:
      runnerStatus === "offline" && runner.busy ? "offline_busy" : "healthy",
  };
}

export function buildArtifactRunnerObservationRef({
  jobId,
  observedAt,
  progressAt,
  requestRef,
  runAttempt,
  runId,
  runnerId,
  state,
}) {
  const request = parseArtifactRequestRef(requestRef, "0".repeat(40));
  return (
    ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX +
    `${request.requestId}/${integer(runId, "artifact workflow run id", { minimum: 1 })}` +
    `-${integer(runAttempt, "artifact workflow run attempt", { minimum: 1 })}` +
    `/${integer(jobId, "artifact job id", { minimum: 1 })}` +
    `-${integer(runnerId, "artifact runner id", { minimum: 1 })}` +
    `/${timestamp(progressAt, "artifact job progress time")}` +
    `-${timestamp(observedAt, "artifact runner observation time")}` +
    `-${observationState(state)}`
  );
}

export function parseArtifactRunnerObservationRef(ref, sha) {
  const normalizedRef = String(ref ?? "");
  if (!normalizedRef.startsWith(ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX)) {
    throw new Error("artifact runner observation ref is outside its namespace");
  }
  const suffix = normalizedRef.slice(
    ARTIFACT_RUNNER_OBSERVATION_REF_PREFIX.length,
  );
  const match = /^(\d{13}-(?:push|schedule)-\d+-\d+)\/(\d+)-(\d+)\/(\d+)-(\d+)\/(\d+)-(\d+)-(healthy|offline_busy)$/.exec(
    suffix,
  );
  if (!match) throw new Error("artifact runner observation ref is invalid");
  const request = parseArtifactRequestRef(
    `${ARTIFACT_REQUEST_REF_PREFIX}${match[1]}`,
    sha,
  );
  return {
    jobId: integer(match[4], "artifact job id", { minimum: 1 }),
    observedAt: timestamp(Number(match[7]), "artifact runner observation time"),
    progressAt: timestamp(Number(match[6]), "artifact job progress time"),
    ref: normalizedRef,
    request,
    runAttempt: integer(match[3], "artifact workflow run attempt", {
      minimum: 1,
    }),
    runId: integer(match[2], "artifact workflow run id", { minimum: 1 }),
    runnerId: integer(match[5], "artifact runner id", { minimum: 1 }),
    sha: request.sha,
    state: observationState(match[8]),
  };
}

function sameOfflineIdentity(left, right) {
  return (
    left.state === "offline_busy" &&
    right.state === "offline_busy" &&
    left.request.ref === right.request.ref &&
    left.runId === right.runId &&
    left.runAttempt === right.runAttempt &&
    left.jobId === right.jobId &&
    left.runnerId === right.runnerId &&
    left.progressAt === right.progressAt
  );
}

export function planOfflineArtifactRecovery({
  activeRuns,
  observations,
  minimumIntervalMs = ARTIFACT_OFFLINE_OBSERVATION_MIN_INTERVAL_MS,
}) {
  const minimum = integer(
    minimumIntervalMs,
    "artifact offline observation interval",
    { minimum: 1 },
  );
  const parsed = observations.map(({ ref, sha }) =>
    parseArtifactRunnerObservationRef(ref, sha),
  );
  for (const active of [...activeRuns].sort((left, right) => left.id - right.id)) {
    const runId = integer(active.id, "active artifact run id", { minimum: 1 });
    const runAttempt = integer(
      active.runAttempt,
      "active artifact run attempt",
      { minimum: 1 },
    );
    const sha = sourceSha(active.sha, "active artifact run SHA");
    const runObservations = parsed
      .filter(
        (entry) =>
          entry.runId === runId &&
          entry.runAttempt === runAttempt &&
          entry.sha === sha,
      )
      .sort(
        (left, right) =>
          left.observedAt - right.observedAt || left.ref.localeCompare(right.ref),
      );
    const previous = runObservations.at(-2);
    const latest = runObservations.at(-1);
    if (
      previous &&
      latest &&
      sameOfflineIdentity(previous, latest) &&
      latest.observedAt - previous.observedAt >= minimum
    ) {
      return {
        action: "force-cancel-offline",
        jobId: latest.jobId,
        latestObservation: latest,
        observedIntervalMs: latest.observedAt - previous.observedAt,
        runAttempt,
        runId,
        runnerId: latest.runnerId,
      };
    }
  }
  return { action: "wait-offline-observation" };
}

export function buildArtifactResultRef({
  conclusion,
  requestRef,
  runAttempt,
  runId,
}) {
  const request = parseArtifactRequestRef(requestRef, "0".repeat(40));
  const normalizedConclusion = String(conclusion ?? "");
  if (!/^[a-z_]+$/.test(normalizedConclusion)) {
    throw new Error("artifact result conclusion is invalid");
  }
  const id = integer(runId, "artifact result run id", { minimum: 1 });
  const attempt = integer(runAttempt, "artifact result run attempt", {
    minimum: 1,
  });
  return `${ARTIFACT_RESULT_REF_PREFIX}${request.requestId}/${normalizedConclusion}/${id}-${attempt}`;
}

export function parseArtifactResultRef(ref, sha) {
  const normalizedRef = String(ref ?? "");
  if (!normalizedRef.startsWith(ARTIFACT_RESULT_REF_PREFIX)) {
    throw new Error("artifact result ref is outside the durable result namespace");
  }
  const suffix = normalizedRef.slice(ARTIFACT_RESULT_REF_PREFIX.length);
  const match = /^(\d{13}-(?:push|schedule)-\d+-\d+)\/([a-z_]+)\/(\d+)-(\d+)$/.exec(
    suffix,
  );
  if (!match) throw new Error("artifact result ref has an invalid identity");
  const request = parseArtifactRequestRef(
    `${ARTIFACT_REQUEST_REF_PREFIX}${match[1]}`,
    sha,
  );
  return {
    conclusion: match[2],
    ref: normalizedRef,
    request,
    runAttempt: integer(match[4], "artifact result run attempt", {
      minimum: 1,
    }),
    runId: integer(match[3], "artifact result run id", { minimum: 1 }),
    sha: request.sha,
  };
}

function normalizeRun(run, requestsByBranch) {
  if (
    run?.event !== "workflow_dispatch" ||
    run?.path !== ARTIFACT_WORKFLOW_PATH
  ) {
    return null;
  }
  const request = requestsByBranch.get(String(run.head_branch ?? ""));
  if (!request || sourceSha(run.head_sha, "artifact run source SHA") !== request.sha) {
    return null;
  }
  const id = integer(run.id, "artifact workflow run id", { minimum: 1 });
  const status = String(run.status ?? "");
  const conclusion = run.conclusion === null ? null : String(run.conclusion ?? "");
  const createdAt = timestamp(run.created_at, "artifact workflow creation time");
  return {
    conclusion,
    createdAt,
    id,
    request,
    runAttempt: integer(run.run_attempt ?? 1, "artifact workflow run attempt", {
      minimum: 1,
    }),
    status,
  };
}

function groupKey(request) {
  return `${request.sourceEvent}:${request.sha}`;
}

function basePlan(groups, coalescedRequestCount) {
  return {
    activeRunIds: [],
    coalescedRequestCount,
    laneLimit: ARTIFACT_LANE_LIMIT,
    queuedRequestCount: groups.filter((group) => group.eligible).length,
    terminalRequestCount: groups.filter((group) => group.terminal).length,
  };
}

export function planArtifactDispatch({
  now = Date.now(),
  requests: requestInputs,
  results: resultInputs = [],
  runs: runInputs,
}) {
  const observedAt = timestamp(now, "artifact dispatcher observation time");
  const requests = requestInputs
    .map((request) => parseArtifactRequestRef(request.ref, request.sha))
    .sort(
      (left, right) =>
        left.enqueuedAt - right.enqueuedAt || left.ref.localeCompare(right.ref),
    );
  const duplicateRefs = requests.length - new Set(requests.map(({ ref }) => ref)).size;
  if (duplicateRefs !== 0) throw new Error("artifact request refs must be unique");
  const requestsByBranch = new Map(
    requests.map((request) => [request.branch, request]),
  );
  const observedRuns = runInputs
    .map((run) => normalizeRun(run, requestsByBranch))
    .filter(Boolean);
  const parsedResults = resultInputs.map((result) => {
    const parsed = parseArtifactResultRef(result.ref, result.sha);
    const request = requestsByBranch.get(parsed.request.branch);
    if (!request || request.sha !== parsed.sha) {
      throw new Error("artifact result does not bind a durable request");
    }
    return parsed;
  });
  const preArtifactTerminalRequestRefs = new Set(
    parsedResults
      .filter(({ conclusion }) =>
        PRE_ARTIFACT_TERMINAL_CONCLUSIONS.has(conclusion),
      )
      .map(({ request }) => request.ref),
  );
  const resultRuns = parsedResults.flatMap((parsed) => {
    if (PRE_ARTIFACT_TERMINAL_CONCLUSIONS.has(parsed.conclusion)) return [];
    const request = requestsByBranch.get(parsed.request.branch);
    return {
      conclusion: parsed.conclusion,
      createdAt: request.enqueuedAt,
      id: parsed.runId,
      request,
      runAttempt: parsed.runAttempt,
      status: "completed",
    };
  });
  const runsByIdentity = new Map();
  for (const run of [...resultRuns, ...observedRuns]) {
    runsByIdentity.set(`${run.id}:${run.runAttempt}`, run);
  }
  const runs = [...runsByIdentity.values()];
  const groupsByKey = new Map();
  for (const request of requests) {
    const key = groupKey(request);
    const group = groupsByKey.get(key) ?? { key, requests: [], runs: [] };
    group.requests.push(request);
    groupsByKey.set(key, group);
  }
  for (const run of runs) groupsByKey.get(groupKey(run.request))?.runs.push(run);

  let coalescedRequestCount = 0;
  const groups = [...groupsByKey.values()].map((group) => {
    group.requests.sort(
      (left, right) =>
        left.enqueuedAt - right.enqueuedAt || left.ref.localeCompare(right.ref),
    );
    group.runs.sort(
      (left, right) => left.createdAt - right.createdAt || left.id - right.id,
    );
    coalescedRequestCount += Math.max(0, group.requests.length - 1);
    const activeRuns = group.runs.filter((run) => ACTIVE_STATUSES.has(run.status));
    const pendingRequests = group.requests.filter(
      ({ ref }) => !preArtifactTerminalRequestRefs.has(ref),
    );
    const artifactTerminal = group.runs.some(
      (run) =>
        run.status === "completed" && TERMINAL_CONCLUSIONS.has(run.conclusion),
    );
    const attemptsExhausted =
      group.runs.length >= ARTIFACT_MAX_AUTOMATIC_ATTEMPTS;
    return {
      ...group,
      activeRuns,
      canonicalRequest: pendingRequests[0] ?? group.requests[0],
      eligible:
        pendingRequests.length > 0 &&
        activeRuns.length === 0 &&
        !artifactTerminal &&
        !attemptsExhausted,
      terminal:
        pendingRequests.length === 0 || artifactTerminal || attemptsExhausted,
    };
  });
  const plan = basePlan(groups, coalescedRequestCount);
  const activeRuns = groups.flatMap((group) => group.activeRuns);
  const staleRuns = activeRuns.filter(
    (run) => observedAt - run.createdAt >= ARTIFACT_ACTIVE_STALE_MS,
  );
  if (staleRuns.length > 0) {
    return {
      ...plan,
      action: "cancel-stale",
      activeRunIds: activeRuns.map(({ id }) => id).sort((a, b) => a - b),
      cancelRunIds: staleRuns.map(({ id }) => id).sort((a, b) => a - b),
    };
  }
  if (activeRuns.length >= ARTIFACT_LANE_LIMIT) {
    return {
      ...plan,
      action: "wait",
      activeRunIds: activeRuns.map(({ id }) => id).sort((a, b) => a - b),
      overCapacity: activeRuns.length > ARTIFACT_LANE_LIMIT,
    };
  }
  const next = groups
    .filter((group) => group.eligible)
    .sort(
      (left, right) =>
        left.canonicalRequest.enqueuedAt - right.canonicalRequest.enqueuedAt ||
        left.canonicalRequest.ref.localeCompare(right.canonicalRequest.ref),
    )[0];
  if (!next) return { ...plan, action: "idle" };
  return {
    ...plan,
    action: "dispatch",
    dispatchAttempt: next.runs.length + 1,
    request: next.canonicalRequest,
  };
}

export function artifactAdmissionMetrics({
  admissionStartedAt,
  dispatchedAt,
  dispatcherStartedAt,
  enqueuedAt,
}) {
  const admission = timestamp(admissionStartedAt, "artifact admission start");
  const dispatched = timestamp(dispatchedAt, "artifact dispatch time");
  const dispatcher = timestamp(dispatcherStartedAt, "artifact dispatcher start");
  const enqueued = timestamp(enqueuedAt, "artifact enqueue time");
  if (!(enqueued <= dispatcher && dispatcher <= dispatched && dispatched <= admission)) {
    throw new Error("artifact admission timestamps are not monotonic");
  }
  return {
    dispatchLatencyMs: dispatched - dispatcher,
    queueAgeMs: dispatcher - enqueued,
    runnerWaitMs: admission - dispatched,
  };
}

export function artifactCiReadiness({
  requiredRunAttempt,
  requiredRunId,
  runs,
  sourceSha: source,
}) {
  const expectedSha = sourceSha(source, "artifact CI source SHA");
  const observed = runs.map((run) => ({
    conclusion: run.conclusion === null ? null : String(run.conclusion ?? ""),
    headSha: sourceSha(run.head_sha, "observed CI run source SHA"),
    id: integer(run.id, "artifact CI run id", { minimum: 1 }),
    runAttempt: integer(run.run_attempt ?? 1, "artifact CI run attempt", {
      minimum: 1,
    }),
    status: String(run.status ?? ""),
  }));
  // Artifact work uses the same persistent runner pool as ordinary CI. Give
  // every already-visible product CI run priority, including a newer SHA that
  // arrived after this request's exact proof became green.
  const active = [
    ...new Set(
      observed
        .filter((run) => ACTIVE_STATUSES.has(run.status))
        .map(({ id }) => id),
    ),
  ].sort((left, right) => left - right);
  if (active.length > 0) return { runIds: active, state: "running" };
  const requiredIdentity =
    requiredRunId === undefined && requiredRunAttempt === undefined
      ? null
      : {
          runAttempt: integer(
            requiredRunAttempt,
            "required artifact CI run attempt",
            { minimum: 1 },
          ),
          runId: integer(requiredRunId, "required artifact CI run id", {
            minimum: 1,
          }),
        };
  const matching = observed.filter(
    (run) =>
      run.headSha === expectedSha &&
      (requiredIdentity === null ||
        (run.id === requiredIdentity.runId &&
          run.runAttempt === requiredIdentity.runAttempt)),
  );
  const successful = matching
    .filter(
      (run) => run.status === "completed" && run.conclusion === "success",
    )
    .sort((left, right) => right.id - left.id)[0];
  if (successful) return { runId: successful.id, state: "ready" };
  const failed = matching
    .filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion !== null &&
        run.conclusion !== "cancelled" &&
        run.conclusion !== "skipped",
    )
    .sort((left, right) => right.id - left.id)[0];
  if (failed) {
    return {
      conclusion: failed.conclusion,
      runAttempt: failed.runAttempt,
      runId: failed.id,
      state: "blocked",
    };
  }
  return { state: "pending" };
}

function exactPushCiRun(run, expectedSha) {
  return (
    run?.event === "push" &&
    run?.head_branch === "main" &&
    run?.head_sha === expectedSha &&
    run?.path === CI_WORKFLOW_PATH
  );
}

export function artifactCiProductProofAvailability({
  artifacts,
  exactArtifacts,
  exactRuns,
  observedAt,
  sourceSha: source,
  visibleRuns,
}) {
  if (!Array.isArray(exactRuns) || !Array.isArray(visibleRuns)) {
    throw new Error("artifact CI product proof run lists are invalid");
  }
  if (!Array.isArray(artifacts) || !Array.isArray(exactArtifacts)) {
    throw new Error("artifact CI product proof artifact list is invalid");
  }
  const expectedSha = sourceSha(source, "artifact CI product proof source SHA");
  const observed = timestamp(
    observedAt,
    "artifact CI product proof observation time",
  );
  const exact = exactRuns.filter((run) => exactPushCiRun(run, expectedSha));
  const active = [
    ...new Set(
      exact
        .filter((run) => ACTIVE_STATUSES.has(String(run.status ?? "")))
        .map((run) => integer(run.id, "artifact CI product proof run id", { minimum: 1 })),
    ),
  ].sort((left, right) => left - right);
  if (active.length > 0) return { runIds: active, state: "running" };

  const successful = exact
    .filter(
      (run) => run.status === "completed" && run.conclusion === "success",
    )
    .map((run) => ({
      completedAt: timestamp(
        run.updated_at,
        "artifact CI product proof completion time",
      ),
      runAttempt: integer(
        run.run_attempt ?? 1,
        "artifact CI product proof run attempt",
        { minimum: 1 },
      ),
      runId: integer(run.id, "artifact CI product proof run id", {
        minimum: 1,
      }),
    }))
    .sort(
      (left, right) =>
        right.runId - left.runId || right.runAttempt - left.runAttempt,
    );
  if (successful.length === 0) return { state: "pending" };

  for (const candidate of successful) {
    const identity = {
      runAttempt: candidate.runAttempt,
      runId: candidate.runId,
    };
    const exactArtifact = exactArtifacts.find(
      (entry) =>
        entry?.expired === false &&
        entry?.name === CI_PRODUCT_VERIFICATION_ARTIFACT &&
        Number.isSafeInteger(Number(entry?.id)) &&
        Number(entry.id) > 0 &&
        Number(entry?.workflow_run?.id) === candidate.runId &&
        entry?.workflow_run?.head_sha === expectedSha,
    );
    if (!exactArtifact) continue;
    const visible = visibleRuns.some(
      (run) =>
        exactPushCiRun(run, expectedSha) &&
        Number(run.id) === candidate.runId &&
        run.status === "completed" &&
        run.conclusion === "success",
    );
    if (!visible) {
      return observed - candidate.completedAt >=
        ARTIFACT_CI_PROOF_VISIBILITY_GRACE_MS
        ? { ...identity, state: "unavailable" }
        : { ...identity, state: "pending" };
    }
    const artifact = artifacts.find(
      (entry) =>
        entry?.expired === false &&
        entry?.name === CI_PRODUCT_VERIFICATION_ARTIFACT &&
        Number.isSafeInteger(Number(entry?.id)) &&
        Number(entry.id) > 0 &&
        Number(entry?.workflow_run?.id) === candidate.runId &&
        entry?.workflow_run?.head_sha === expectedSha,
    );
    if (artifact) {
      return {
        artifactId: Number(artifact.id),
        ...identity,
        state: "ready",
      };
    }
    return observed - candidate.completedAt >=
      ARTIFACT_CI_PROOF_VISIBILITY_GRACE_MS
      ? { ...identity, state: "unavailable" }
      : { ...identity, state: "pending" };
  }
  return { state: "pending" };
}

export function artifactCiFailureEvidence({
  conclusion,
  observed,
  requestRef,
  requestSha,
  runAttempt,
  runId,
}) {
  const request = parseArtifactRequestRef(requestRef, requestSha);
  const expectedRunId = integer(runId, "artifact CI failure run id", {
    minimum: 1,
  });
  const expectedRunAttempt = integer(
    runAttempt,
    "artifact CI failure run attempt",
    { minimum: 1 },
  );
  const expectedConclusion = String(conclusion ?? "");
  if (
    !expectedConclusion ||
    new Set(["cancelled", "skipped", "success"]).has(expectedConclusion)
  ) {
    throw new Error("artifact CI failure conclusion is not terminal red");
  }
  if (
    integer(observed?.id, "observed artifact CI run id", { minimum: 1 }) !==
      expectedRunId ||
    integer(observed?.run_attempt, "observed artifact CI run attempt", {
      minimum: 1,
    }) !== expectedRunAttempt ||
    observed?.path !== CI_WORKFLOW_PATH ||
    sourceSha(observed?.head_sha, "observed artifact CI source SHA") !==
      request.sha ||
    observed?.status !== "completed" ||
    observed?.conclusion !== expectedConclusion
  ) {
    throw new Error("artifact CI failure does not match current GitHub authority");
  }
  return {
    conclusion: expectedConclusion,
    ref: buildArtifactResultRef({
      conclusion: ARTIFACT_CI_FAILURE_CONCLUSION,
      requestRef: request.ref,
      runAttempt: expectedRunAttempt,
      runId: expectedRunId,
    }),
    request,
    runAttempt: expectedRunAttempt,
    runId: expectedRunId,
    sha: request.sha,
  };
}

export function artifactCiProofUnavailableEvidence({
  observed,
  requestRef,
  requestSha,
  runAttempt,
  runId,
}) {
  const request = parseArtifactRequestRef(requestRef, requestSha);
  const expectedRunId = integer(runId, "artifact proof run id", {
    minimum: 1,
  });
  const expectedRunAttempt = integer(
    runAttempt,
    "artifact proof run attempt",
    { minimum: 1 },
  );
  if (
    integer(observed?.id, "observed artifact proof run id", { minimum: 1 }) !==
      expectedRunId ||
    integer(observed?.run_attempt ?? 1, "observed artifact proof attempt", {
      minimum: 1,
    }) !== expectedRunAttempt ||
    !exactPushCiRun(observed, request.sha) ||
    observed?.status !== "completed" ||
    observed?.conclusion !== "success"
  ) {
    throw new Error(
      "artifact CI proof availability does not match current GitHub authority",
    );
  }
  return {
    conclusion: ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
    ref: buildArtifactResultRef({
      conclusion: ARTIFACT_CI_PROOF_UNAVAILABLE_CONCLUSION,
      requestRef: request.ref,
      runAttempt: expectedRunAttempt,
      runId: expectedRunId,
    }),
    request,
    runAttempt: expectedRunAttempt,
    runId: expectedRunId,
    sha: request.sha,
  };
}
