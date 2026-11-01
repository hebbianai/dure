import { describe, expect, it, vi } from "vitest";
import { collectManagedRehostCommand, MANAGED_REHOST_SETTLE_MS } from "../cli/lib/managed-rehost-command.mjs";

/** A virtual clock: waiting advances time instead of blocking the test. */
function fakeClock() {
  let time = 0;
  return { now: () => time, sleep: async (ms) => { time += Math.max(1, ms); } };
}

const busy = {
  kind: "nonzero", code: 1,
  stdout: JSON.stringify({
    schema: "hmux-managed-rehost-v1", schemaVersion: 1, state: "refused",
    error: { code: "hmux_recovery_busy", message: "hmux_recovery_busy: recovery operation is already running" },
  }),
  stderr: "hmux: error: hmux_recovery_busy: recovery operation is already running",
};
const pending = (operationId, source) => ({
  schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "retry_required",
  code: "hmux_managed_rehost_retry_required", operationId, source,
});
const resolved = (operationId, source) => ({
  schema: "hmux-managed-rehost-resolution-v1", schemaVersion: 1, state: "resolved",
  operationIds: [operationId], sourceGeneration: source,
  currentGeneration: { sessionId: "target", workspaceId: source.workspaceId },
});

/** Native fake: execution replies in order; status reads replay their own script. */
function nativeScript({ executions, observations }) {
  let observed = 0;
  return vi.fn(async (argv) => {
    if (argv[1] === "managed-rehost-resolve") {
      const next = observations[Math.min(observed++, observations.length - 1)];
      return next.kind ? next : { kind: "success", stdout: JSON.stringify(next) };
    }
    return executions.shift() ?? { kind: "unavailable" };
  });
}
const executions = (run) => run.mock.calls.map((call) => call[0]).filter((argv) => argv[1] !== "managed-rehost-resolve");

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

  it.each(["unavailable", "output_limit", "nonzero", "aborted"])(
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

  const source = { sessionId: "source", workspaceId: "workspace" };
  const replay = ["hmux", "managed-rehost-reconcile", "--session", "source", "--workspace", "workspace",
    "--operation-id", "operation", "--confirm-restart", "--json"];

  it.each([["timeout", { kind: "timeout" }], ["busy", busy]])(
    "waits through a %s for the journal's completion and replays only its receipt",
    async (_label, first) => {
      const run = nativeScript({
        executions: [first, { kind: "success", stdout: JSON.stringify(receipt) }],
        observations: [pending("operation", source), pending("operation", source), resolved("operation", source)],
      });
      const report = await collectManagedRehostCommand({ ...args, run, settle: fakeClock() });
      expect(report).toEqual({ ok: true, operationId: "operation", receipt });
      // One submitted execution, then a reconcile that can only replay the completed journal.
      expect(executions(run)).toEqual([run.mock.calls[0][0], replay]);
      expect(run.mock.calls[0][0][1]).toBe(action === "start" ? "managed-rehost-start" : "managed-rehost-reconcile");
    },
  );

  it.each([["timeout", { kind: "timeout" }], ["busy", busy]])(
    "reports an operation still running after a %s instead of an error, without resubmitting it",
    async (_label, first) => {
      const clock = fakeClock();
      const run = nativeScript({ executions: [first], observations: [pending("operation", source)] });
      const report = await collectManagedRehostCommand({ ...args, run, settle: clock });
      expect(report).toMatchObject({
        ok: true, operationId: "operation", state: "running", observation: pending("operation", source),
      });
      expect(report.error).toBeUndefined();
      expect(report.message).toContain("dure hmux rehost status source --workspace workspace --operation-id operation");
      expect(executions(run)).toHaveLength(1);
      expect(clock.now()).toBeGreaterThanOrEqual(MANAGED_REHOST_SETTLE_MS);
    },
  );

  it("keeps a timeout unknown when the journal never shows the operation", async () => {
    const run = nativeScript({ executions: [{ kind: "timeout" }], observations: [{ kind: "timeout" }] });
    const report = await collectManagedRehostCommand({ ...args, run, settle: fakeClock() });
    expect(report).toMatchObject({ ok: false, error: { code: `rehost_${action}_timeout` } });
    expect(report.error.message).toContain("unknown");
    expect(executions(run)).toHaveLength(1);
  });

  it("does not treat another refusal as a running operation", async () => {
    const refused = { ...busy, stdout: busy.stdout.replace("hmux_recovery_busy", "hmux_recovery_source_busy") };
    const run = nativeScript({ executions: [refused], observations: [pending("operation", source)] });
    const report = await collectManagedRehostCommand({ ...args, run, settle: fakeClock() });
    expect(report).toMatchObject({ ok: false, error: { code: `rehost_${action}_nonzero` } });
    expect(run).toHaveBeenCalledTimes(1);
  });

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
      const report = await collectManagedRehostCommand({ ...args, run, settle: fakeClock() });
      expect(report.ok).toBe(false);
      expect(report.error.message).toContain("status --operation-id operation");
      expect(report.error.message).not.toContain("undefined");
      expect(executions(run)).toEqual([["hmux", "managed-rehost-reconcile", "--operation-id", "operation", "--confirm-restart", "--json"]]);
      // Waiting reads only the same operation's journal, never a current source.
      for (const [argv] of run.mock.calls.slice(1)) {
        expect(argv).toEqual(["hmux", "managed-rehost-resolve", "--operation-id", "operation", "--json"]);
      }
    },
  );
  it("reports a busy operation-only retry as running from the operation's own journal", async () => {
    const original = { sessionId: "original", workspaceId: "original-workspace" };
    const run = nativeScript({ executions: [busy], observations: [pending("operation", original)] });
    const report = await collectManagedRehostCommand({ ...args, run, settle: fakeClock() });
    expect(report).toMatchObject({ ok: true, state: "running", observation: { source: original } });
    expect(report.message).toContain("dure hmux rehost status --operation-id operation");
    expect(report.message).not.toContain("undefined");
    expect(executions(run)).toHaveLength(1);
  });
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
