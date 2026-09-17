import type { SpawnReceipt, SpawnReceiptStep } from "@/lib/ipc";

/** spawn saga E2E 어서션 유틸 (test-harness-blueprint §1) — smoke 스크립트와
 * vitest가 GET /spawn/{id} receipt(journal fold)를 기계적으로 판정할 때 쓴다.
 * 화면 내용 검증은 여기 없음 — journal은 secret-free 원칙이라 단계·증거만 담는다. */

const SAGA_STEPS = [
  "preflight",
  "worktree",
  "runtime_session",
  "pane",
  "provider_exec",
  "prompt_delivery",
] as const;

const EVIDENCE_RANK: Record<string, number> = {
  written_to_pty: 1,
  provider_ready: 2,
  activity_observed: 3,
};

function stepByName(
  receipt: SpawnReceipt,
  name: (typeof SAGA_STEPS)[number],
): SpawnReceiptStep | undefined {
  return receipt.steps.find((step) => step.step === name);
}

/** ok|skipped 이외의 단계가 있으면 그 목록을 돌려준다(성공 판정용). */
export function unfinishedSteps(receipt: SpawnReceipt): string[] {
  return receipt.steps
    .filter((step) => step.status !== "ok" && step.status !== "skipped")
    .map((step) => `${step.step}:${step.status}`);
}

/** prompt_delivery에 기록된 최고 증거 레벨 (없으면 null). */
export function highestEvidence(receipt: SpawnReceipt): string | null {
  const evidence = stepByName(receipt, "prompt_delivery")?.evidence?.level;
  return evidence && EVIDENCE_RANK[evidence] ? evidence : null;
}

export function evidenceAtLeast(receipt: SpawnReceipt, level: string): boolean {
  const highest = highestEvidence(receipt);
  return (
    highest !== null &&
    (EVIDENCE_RANK[highest] ?? 0) >= (EVIDENCE_RANK[level] ?? Infinity)
  );
}

/** created_by_request=false(adopted) 산출물 목록 — compensation 불가침 검증용. */
export function adoptedArtifacts(
  receipt: SpawnReceipt,
): Array<Record<string, unknown>> {
  return receipt.steps.flatMap(
    (step) =>
      step.artifacts?.filter(
        (artifact) => artifact.created_by_request === false,
      ) ?? [],
  );
}

export interface SagaAssertion {
  ok: boolean;
  failures: string[];
}

/** 성공 시나리오의 표준 판정: terminal state + 전 단계 종결 + 최소 증거 레벨. */
export function assertSucceeded(
  receipt: SpawnReceipt,
  options: { minEvidence?: string; promptSent?: boolean } = {},
): SagaAssertion {
  const failures: string[] = [];
  if (receipt.state !== "succeeded") {
    failures.push(`state=${receipt.state} (expected succeeded)`);
  }
  const unfinished = unfinishedSteps(receipt);
  if (unfinished.length > 0) {
    failures.push(`unfinished steps: ${unfinished.join(", ")}`);
  }
  const promptSent = options.promptSent !== false;
  if (promptSent) {
    const min = options.minEvidence ?? "written_to_pty";
    if (!evidenceAtLeast(receipt, min)) {
      failures.push(
        `evidence ${highestEvidence(receipt) ?? "none"} < required ${min}`,
      );
    }
  }
  return { ok: failures.length === 0, failures };
}
