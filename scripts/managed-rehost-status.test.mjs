import { describe, expect, it, vi } from "vitest";
import {
  collectManagedRehostStatus,
  formatManagedRehostStatus,
  observeManagedRehostSource,
} from "../cli/lib/managed-rehost-status.mjs";

const args = {
  sessionId: "source-1",
  workspaceId: "workspace-1",
  operationId: "operation-1",
  command: "hmux",
};
const missing = {
  schema: "hmux-managed-rehost-resolution-v1",
  schemaVersion: 1,
  state: "not_found",
  source: { sessionId: args.sessionId, workspaceId: args.workspaceId },
};

describe("exact rehost observation boundary", () => {
  it.each(["timeout", "unavailable", "output_limit", "nonzero", "aborted"])(
    "keeps %s unknown without retry or fallback",
    async (kind) => {
      const run = vi
        .fn()
        .mockResolvedValue({ kind, stderr: "fixture transport error" });
      const report = await collectManagedRehostStatus({ ...args, run });
      expect(report).toMatchObject({
        ok: false,
        error: { code: `rehost_status_${kind}` },
      });
      expect(formatManagedRehostStatus(report)).toContain("unknown");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0][0]).not.toContain("managed-rehost");
    },
  );

  it.each([
    "not JSON",
    "null",
    "{}",
    JSON.stringify({
      ...missing,
      source: { ...missing.source, sessionId: "other" },
    }),
    JSON.stringify({
      ...missing,
      source: { ...missing.source, workspaceId: "other" },
    }),
    JSON.stringify({
      ...missing,
      state: "retry_required",
      operationId: "other",
    }),
    JSON.stringify({
      ...missing,
      state: "resolved",
      operationIds: [args.operationId, "later"],
    }),
    JSON.stringify({ ...missing, schemaVersion: 2 }),
  ])("refuses an unreadable or mismatched observation: %s", async (stdout) => {
    const run = vi.fn().mockResolvedValue({ kind: "success", stdout });
    expect(await collectManagedRehostStatus({ ...args, run })).toMatchObject({
      ok: false,
      error: { code: "rehost_status_response_invalid" },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(["sessionId", "workspaceId", "operationId"])(
    "requires %s before invoking Hmux",
    async (key) => {
      const run = vi.fn();
      expect(
        await collectManagedRehostStatus({ ...args, [key]: undefined, run }),
      ).toMatchObject({ ok: false });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("does not call a missing receipt an execution failure", async () => {
    const report = await collectManagedRehostStatus({
      ...args,
      run: async () => ({ kind: "success", stdout: JSON.stringify(missing) }),
    });
    expect(report).toMatchObject({ ok: true, result: missing });
    expect(formatManagedRehostStatus(report)).toContain(
      "does not prove execution failed",
    );
  });
});

describe("operation-only status boundary", () => {
  const operation = { operationId: args.operationId, command: "hmux" };
  it("accepts a pending source supplied by the journal, without authorizing execution", async () => {
    const result = { ...missing, state: "retry_required", operationId: args.operationId };
    const run = vi.fn().mockResolvedValue({ kind: "success", stdout: JSON.stringify(result) });
    expect(await collectManagedRehostStatus({ ...operation, run })).toMatchObject({ ok: true, result });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each([
    missing,
    { ...missing, state: "retry_required", operationId: "foreign" },
    { ...missing, state: "retry_required", operationId: args.operationId, source: {} },
    { ...missing, state: "resolved", operationIds: [args.operationId, "later"] },
  ])("does not accept absent or uncorrelated source evidence: %j", async (result) => {
    const run = vi.fn().mockResolvedValue({ kind: "success", stdout: JSON.stringify(result) });
    expect(await collectManagedRehostStatus({ ...operation, run })).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("source lookup boundary", () => {
  const source = { sessionId: args.sessionId, workspaceId: args.workspaceId, command: "hmux" };
  const pending = { ...missing, state: "retry_required", code: "hmux_managed_rehost_retry_required",
    operationId: "operation-held" };
  const resolved = { ...missing, state: "resolved", operationIds: ["operation-held"],
    sourceGeneration: missing.source, currentGeneration: { sessionId: "successor-1", workspaceId: args.workspaceId } };
  it.each([missing, pending, resolved])("reads the latest edge for the exact source only: %j", async (result) => {
    const run = vi.fn().mockResolvedValue({ kind: "success", stdout: JSON.stringify(result) });
    expect(await observeManagedRehostSource({ ...source, run })).toEqual(result);
    expect(run.mock.calls).toEqual([[["hmux", "managed-rehost-resolve", "--session", args.sessionId,
      "--workspace", args.workspaceId, "--json"], { timeoutMs: 5_000, maxCaptureBytes: 1024 * 1024 }]]);
  });
  it.each([
    { kind: "timeout" },
    { kind: "success", stdout: "not JSON" },
    { kind: "success", stdout: JSON.stringify({ ...pending, schemaVersion: 2 }) },
    { kind: "success", stdout: JSON.stringify({ ...pending, source: { ...missing.source, sessionId: "other" } }) },
    { kind: "success", stdout: JSON.stringify({ ...pending, operationId: "" }) },
    { kind: "success", stdout: JSON.stringify({ ...resolved, operationIds: [] }) },
    { kind: "success", stdout: JSON.stringify({ ...resolved, currentGeneration: undefined }) },
  ])("gives no answer for an unavailable or inexact observation: %j", async (response) => {
    const run = vi.fn().mockResolvedValue(response);
    expect(await observeManagedRehostSource({ ...source, run })).toBeUndefined();
  });
  it("gives no answer when the native command cannot run", async () => {
    const run = vi.fn().mockRejectedValue(new Error("spawn failed"));
    expect(await observeManagedRehostSource({ ...source, run })).toBeUndefined();
  });
});
