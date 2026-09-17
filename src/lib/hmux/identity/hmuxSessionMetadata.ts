import { sameHmuxManagedGeneration } from "@/lib/hmux/identity/hmuxManagedGeneration";
import type {
  HmuxSessionFailure,
  HmuxSessionSummary,
} from "@/lib/ipc";

export function hmuxSessionMetadataKey(workspaceId: string, sessionId: string) {
  return JSON.stringify([workspaceId, sessionId]);
}

export function normalizeHmuxSessionSummary(
  summary: HmuxSessionSummary,
): HmuxSessionSummary {
  return {
    ...summary,
    sessionName: summary.sessionName?.trim() || undefined,
    capabilities: [...summary.capabilities],
    failure: summary.failure ? { ...summary.failure } : undefined,
    retirementPolicy: summary.retirementPolicy
      ? { ...summary.retirementPolicy }
      : undefined,
  };
}

/** 필드 → 비교 방식 분류. HmuxSessionSummary에 필드가 늘면 이 satisfies가
 *  컴파일을 깨뜨린다 — 분류가 빠진 필드는 그 필드만 바뀐 census 업데이트를
 *  캐시가 "동일"로 드랍시킨다(실제로 hostProcessAlive/stopFence 누락으로
 *  host 사망 확정·stop fence 세대 변화가 소비자에 전달되지 않았다).
 *  한계: structured 분류는 아래 명시 비교 분기 추가까지 강제하지 못한다. */
const summaryFieldComparison = {
  sessionId: "scalar",
  sessionName: "scalar",
  workspaceId: "scalar",
  sessionClass: "scalar",
  lifecycle: "scalar",
  manifestLifecycle: "scalar",
  health: "scalar",
  hostBuildVersion: "scalar",
  clientSelection: "scalar",
  inputAllowed: "scalar",
  detachOnly: "scalar",
  hostProcessAlive: "scalar",
  hostSocketOwnerAbsent: "scalar",
  runtimeHost: "scalar",
  terminalEpoch: "scalar",
  outputSeq: "scalar",
  diagnostic: "structured",
  failure: "structured",
  stopFence: "structured",
  capabilities: "structured",
  retirementPolicy: "structured",
} as const satisfies Record<keyof HmuxSessionSummary, "scalar" | "structured">;

type ScalarSummaryField = {
  [K in keyof typeof summaryFieldComparison]: (typeof summaryFieldComparison)[K] extends "scalar"
    ? K
    : never;
}[keyof typeof summaryFieldComparison];

const scalarSummaryFields = (
  Object.keys(summaryFieldComparison) as (keyof typeof summaryFieldComparison)[]
).filter(
  (field): field is ScalarSummaryField =>
    summaryFieldComparison[field] === "scalar",
);

function sameSessionFailure(
  left: HmuxSessionFailure | undefined,
  right: HmuxSessionFailure | undefined,
) {
  if (!left || !right) return left === right;
  return (
    left.correlationId === right.correlationId &&
    left.sessionId === right.sessionId &&
    left.workspaceId === right.workspaceId &&
    left.terminalEpoch === right.terminalEpoch &&
    left.code === right.code &&
    left.phase === right.phase &&
    left.summary === right.summary &&
    left.exitKind === right.exitKind &&
    left.exitCode === right.exitCode &&
    left.occurredUnixMs === right.occurredUnixMs &&
    left.retryPosture === right.retryPosture
  );
}

export function sameHmuxSessionSummary(
  left: HmuxSessionSummary | undefined,
  right: HmuxSessionSummary,
) {
  if (!left) return false;
  return (
    scalarSummaryFields.every((field) => left[field] === right[field]) &&
    left.diagnostic?.code === right.diagnostic?.code &&
    left.diagnostic?.message === right.diagnostic?.message &&
    left.diagnostic?.retry === right.diagnostic?.retry &&
    sameSessionFailure(left.failure, right.failure) &&
    sameHmuxManagedGeneration(left.stopFence, right.stopFence) &&
    left.retirementPolicy?.kind === right.retirementPolicy?.kind &&
    left.retirementPolicy?.gracePeriodMs ===
      right.retirementPolicy?.gracePeriodMs &&
    left.capabilities.length === right.capabilities.length &&
    left.capabilities.every(
      (capability, index) => capability === right.capabilities[index],
    )
  );
}

export function mergeHmuxSessionMetadata(
  current: Record<string, HmuxSessionSummary>,
  sessions: readonly HmuxSessionSummary[],
): Record<string, HmuxSessionSummary> {
  let next: Record<string, HmuxSessionSummary> | undefined;
  for (const session of sessions) {
    const normalized = normalizeHmuxSessionSummary(session);
    const key = hmuxSessionMetadataKey(
      normalized.workspaceId,
      normalized.sessionId,
    );
    if (sameHmuxSessionSummary((next ?? current)[key], normalized)) continue;
    next ??= { ...current };
    next[key] = normalized;
  }
  return next ?? current;
}

export function hmuxSessionDiagnosticDetail(
  summary: HmuxSessionSummary | undefined,
): string | undefined {
  if (!summary?.diagnostic) return undefined;
  return [
    summary.health,
    summary.diagnostic.code,
    summary.diagnostic.message,
    summary.diagnostic.retry,
  ]
    .filter(Boolean)
    .join(" · ");
}
