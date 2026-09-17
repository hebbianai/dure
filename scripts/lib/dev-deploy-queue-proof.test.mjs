import { describe, expect, it } from "vitest";
import { parentReconciliationAfter } from "./dev-deploy-queue-proof.mjs";

const WORKTREE = "/tmp/dure-live";
const PROVEN_PARENT = {
  sourceGeneration: "1".repeat(64),
  supervisor: {
    pid: 10,
    processIdentity: "parent",
    generation: "2".repeat(64),
  },
  launch: {
    pid: 11,
    processIdentity: "child",
    generation: "3".repeat(64),
  },
};

describe("parentReconciliationAfter", () => {
  it.each([
    {
      name: "retargets an existing obligation to the deployed target",
      request: {
        reconciliation: { kind: "parent_generation", targetHead: "aaa" },
      },
      deployed: { sourceHead: "old", parentGeneration: PROVEN_PARENT },
      receipt: { action: "deploy", deployed: true, targetHead: "bbb" },
      expected: "bbb",
    },
    {
      name: "requires proof for a successful source without a parent generation",
      request: {},
      deployed: { sourceHead: "bbb" },
      expected: "bbb",
    },
    {
      name: "uses the latest exact terminal skip over stale deployment history",
      request: {},
      deployed: { sourceHead: "aaa", parentGeneration: PROVEN_PARENT },
      terminalReceipt: {
        action: "skip",
        currentHead: "bbb",
        targetHead: "bbb",
      },
      expected: "bbb",
    },
  ])("$name", ({ request, deployed, receipt, terminalReceipt, expected }) => {
    expect(
      parentReconciliationAfter({
        request,
        deployed,
        receipt,
        terminalReceipt,
        worktree: WORKTREE,
      }),
    ).toEqual({ kind: "parent_generation", targetHead: expected });
  });

  it("does not create a target obligation when admission failed before checkout", () => {
    expect(
      parentReconciliationAfter({
        request: {},
        priorFailure: {
          receipt: {
            action: "deploy",
            deployed: false,
            targetHead: "bbb",
            impact: { kind: "parent_reload" },
          },
        },
        worktree: WORKTREE,
      }),
    ).toBeUndefined();
  });
});
