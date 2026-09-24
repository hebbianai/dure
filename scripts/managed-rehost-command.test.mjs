import { describe, expect, it, vi } from "vitest";
import { collectManagedRehostCommand } from "../cli/lib/managed-rehost-command.mjs";

describe.each(["start", "retry"])("%s", (action) => {
  const args = {
    action,
    sessionId: "source",
    workspaceId: "workspace",
    operationId: "operation",
    confirmRestart: true,
    command: "hmux",
  };
  const receipt = {
    schema: "hmux-managed-rehost-v1",
    schemaVersion: 1,
    operationId: "operation",
    replayed: true,
    sourceStopReceipt: { sessionId: "source", workspaceId: "workspace" },
    replacementReceipt: { sessionId: "target", workspaceId: "workspace" },
    conversationId: "conversation",
  };

  it.each(["timeout", "unavailable", "output_limit", "nonzero", "aborted"])(
    "%s never retries, restarts from scratch, or calls observation implicitly",
    async (kind) => {
      const run = vi.fn().mockResolvedValue({ kind });
      const report = await collectManagedRehostCommand({ ...args, run });
      expect(report).toMatchObject({
        ok: false,
        operationId: args.operationId,
        error: { code: `rehost_${action}_${kind}` },
      });
      expect(report.error.message).toContain("unknown");
      expect(report.error.message).toContain(
        "rehost status source --workspace workspace --operation-id operation",
      );
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0][1]).toBe(
        action === "start"
          ? "managed-rehost-start"
          : "managed-rehost-reconcile",
      );
    },
  );

  it.each([
    "not-json",
    "null",
    "{}",
    JSON.stringify({ ...receipt, operationId: "other" }),
    JSON.stringify({
      ...receipt,
      sourceStopReceipt: { sessionId: "other", workspaceId: "workspace" },
    }),
    JSON.stringify({
      ...receipt,
      sourceStopReceipt: { sessionId: "source", workspaceId: "other" },
    }),
    JSON.stringify({ ...receipt, schemaVersion: 9 }),
  ])(
    "keeps an unreadable or cross-request receipt unknown: %s",
    async (stdout) => {
      const run = vi.fn().mockResolvedValue({ kind: "success", stdout });
      expect(await collectManagedRehostCommand({ ...args, run })).toMatchObject(
        {
          ok: false,
          error: { code: `rehost_${action}_response_invalid` },
        },
      );
      expect(run).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    receipt,
    {
      ...receipt,
      schema: "managed-session-replacement-receipt-v2",
      schemaVersion: 2,
      conversationId: undefined,
    },
  ])(
    "preserves both existing exact and fresh receipt envelopes",
    async (result) => {
      const wire = JSON.stringify(result);
      const run = vi.fn().mockResolvedValue({ kind: "success", stdout: wire });
      const report = await collectManagedRehostCommand({ ...args, run });
      expect(report).toEqual({
        ok: true,
        operationId: args.operationId,
        receipt: JSON.parse(wire),
      });
    },
  );

  it.each(["sessionId", "workspaceId", "operationId"])(
    "requires %s at the CLI boundary",
    async (key) => {
      const run = vi.fn();
      expect(
        await collectManagedRehostCommand({ ...args, [key]: undefined, run }),
      ).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("operation-only retry boundary", () => {
  const args = { action: "retry", operationId: "operation", confirmRestart: true, command: "hmux" };
  const receipt = {
    schema: "hmux-managed-rehost-v1", schemaVersion: 1, operationId: "operation", replayed: true,
    sourceStopReceipt: { sessionId: "original", workspaceId: "original-workspace" },
    replacementReceipt: { sessionId: "replacement" },
  };
  it.each(["timeout", "unavailable", "output_limit", "nonzero", "aborted"])(
    "%s preserves the operation without a current-source lookup or automatic second request", async (kind) => {
      const run = vi.fn().mockResolvedValue({ kind });
      const report = await collectManagedRehostCommand({ ...args, run });
      expect(report.ok).toBe(false);
      expect(report.error.message).toContain("status --operation-id operation");
      expect(report.error.message).not.toContain("undefined");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).toEqual(["hmux", "managed-rehost-reconcile", "--operation-id", "operation", "--confirm-restart", "--json"]);
    },
  );
  it.each([
    { ...receipt, operationId: "foreign-operation" },
    { ...receipt, sourceStopReceipt: undefined },
    { ...receipt, sourceStopReceipt: { sessionId: "", workspaceId: "workspace" } },
    { ...receipt, sourceStopReceipt: { sessionId: "source" } },
  ])("does not accept an uncorrelated or sourceless result: %j", async (result) => {
    const run = vi.fn().mockResolvedValue({ kind: "success", stdout: JSON.stringify(result) });
    expect(await collectManagedRehostCommand({ ...args, run })).toMatchObject({ ok: false, error: { code: "rehost_retry_response_invalid" } });
  });
});


it("pins rehost to the selected Dure runtime instead of a sibling or ambient build", async () => {
  const calls = [];
  await collectManagedRehostCommand({ action: "start", sessionId: "session-1", workspaceId: "workspace-1",
    operationId: "operation-1", confirmRestart: true, command: "/build/hmux", runtime: "/build/hmux-runtime-current",
    run: async (args) => { calls.push(args); return { kind: "nonzero", stderr: "fixture" }; },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0].slice(-3)).toEqual(["--runtime", "/build/hmux-runtime-current", "--json"]);
});
