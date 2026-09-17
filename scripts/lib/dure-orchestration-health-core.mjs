export const DEFAULT_CI_QUEUE_STALE_MS = 10 * 60 * 1_000;

const VERDICT_RANK = Object.freeze({
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
  unknown: 3,
});

function addReason(reasons, severity, code, message, source) {
  reasons.push({ code, message, severity, source });
}

function finalVerdict(reasons) {
  let verdict = "healthy";
  for (const reason of reasons) {
    if (VERDICT_RANK[reason.severity] > VERDICT_RANK[verdict]) {
      verdict = reason.severity;
    }
  }
  return verdict;
}

export function evaluateDureOrchestrationHealth(
  snapshot,
  { ciQueueStaleMs = DEFAULT_CI_QUEUE_STALE_MS, nowMs = Date.now() } = {},
) {
  if (!Number.isSafeInteger(nowMs)) {
    throw new Error("orchestration health now must be an integer timestamp");
  }
  const reasons = [];
  const github = snapshot?.github;
  const host = snapshot?.host;

  if (!github?.available || !github.ci) {
    addReason(
      reasons,
      "unknown",
      "github_snapshot_unavailable",
      github?.error?.message ?? "GitHub CI state could not be observed",
      "github_actions",
    );
  }
  if (!host?.available) {
    addReason(
      reasons,
      "unknown",
      "host_snapshot_unavailable",
      host?.error?.message ?? "local host state could not be observed",
      "local_host",
    );
  }

  const ciQueueAgeMs = github?.ci?.oldestQueuedAgeMs;
  if (Number.isSafeInteger(ciQueueAgeMs) && ciQueueAgeMs > ciQueueStaleMs) {
    addReason(
      reasons,
      ciQueueAgeMs > ciQueueStaleMs * 3 ? "unhealthy" : "degraded",
      "github_ci_queue_stale",
      `oldest queued CI run has waited ${ciQueueAgeMs}ms`,
      "github_actions",
    );
  }

  if (host?.available) {
    if ((host.worktrees?.orphanRegistrations ?? 0) > 0) {
      addReason(
        reasons,
        "degraded",
        "orphan_worktree_registration",
        `${host.worktrees.orphanRegistrations} worktree registrations are prunable`,
        "local_host",
      );
    }
  }

  return {
    checkedAt: new Date(nowMs).toISOString(),
    observedAtMs: nowMs,
    reasons,
    verdict: finalVerdict(reasons),
  };
}

export function dureOrchestrationHealthExitCode(verdict) {
  if (verdict === "healthy") return 0;
  if (verdict === "unknown") return 2;
  if (verdict === "degraded" || verdict === "unhealthy") return 1;
  throw new Error(`unsupported orchestration health verdict: ${verdict}`);
}
