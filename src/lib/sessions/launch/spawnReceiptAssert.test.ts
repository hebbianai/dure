import { describe, expect, it } from "vitest";
import type { SpawnReceipt } from "@/lib/ipc";
import {
  adoptedArtifacts,
  assertSucceeded,
  evidenceAtLeast,
  highestEvidence,
  unfinishedSteps,
} from "@/lib/sessions/launch/spawnReceiptAssert";

function receipt(overrides: Partial<SpawnReceipt> = {}): SpawnReceipt {
  return {
    v: 1,
    receiptId: "sp_test",
    request: null,
    state: "succeeded",
    updatedAt: 1,
    steps: [
      { step: "preflight", status: "ok" },
      {
        step: "worktree",
        status: "ok",
        artifacts: [{ kind: "worktree", id: "/w", created_by_request: false }],
      },
      {
        step: "runtime_session",
        status: "ok",
        artifacts: [
          { kind: "hmux_session", id: "s1", created_by_request: false },
        ],
      },
      { step: "pane", status: "ok" },
      { step: "provider_exec", status: "ok" },
      {
        step: "prompt_delivery",
        status: "ok",
        evidence: { level: "written_to_pty" },
      },
    ],
    ...overrides,
  };
}

describe("spawnReceiptAssert", () => {
  it("passes a fully-succeeded receipt at written_to_pty", () => {
    const verdict = assertSucceeded(receipt());
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("fails when required evidence level is not reached", () => {
    const verdict = assertSucceeded(receipt(), {
      minEvidence: "activity_observed",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]).toContain("written_to_pty");
  });

  it("treats skipped prompt_delivery as success when promptSent=false", () => {
    const r = receipt();
    r.steps[5] = { step: "prompt_delivery", status: "skipped" };
    expect(assertSucceeded(r, { promptSent: false }).ok).toBe(true);
    expect(assertSucceeded(r).ok).toBe(false); // prompt를 보냈다면 증거가 있어야 한다
  });

  it("reports unfinished steps and non-terminal state", () => {
    const r = receipt({ state: "failed" });
    r.steps[4] = {
      step: "provider_exec",
      status: "failed",
      error: { code: "provider_not_detected", message: "x" },
    };
    const verdict = assertSucceeded(r);
    expect(verdict.ok).toBe(false);
    expect(unfinishedSteps(r)).toEqual(["provider_exec:failed"]);
  });

  it("ranks evidence levels and lists adopted artifacts", () => {
    const r = receipt();
    expect(highestEvidence(r)).toBe("written_to_pty");
    expect(evidenceAtLeast(r, "written_to_pty")).toBe(true);
    expect(evidenceAtLeast(r, "provider_ready")).toBe(false);
    expect(adoptedArtifacts(r).map((a) => a.id)).toEqual(["/w", "s1"]);
  });
});
