import { createQaRuntimeErrorLedger } from "@/lib/qa/qaRuntimeErrorLedger";
import { describe, expect, it } from "vitest";

describe("createQaRuntimeErrorLedger", () => {
  it("scopes a run without clearing errors recorded by an earlier run", () => {
    const ledger = createQaRuntimeErrorLedger();
    ledger.record({ kind: "window_error", message: "before" });
    const scope = ledger.beginScope();

    ledger.record({ kind: "window_error", message: "during" });
    ledger.record({ kind: "unhandled_rejection", message: "rejected" });

    expect(ledger.snapshot(scope)).toEqual({
      cursor: { sequence: 3 },
      total: 2,
      dropped: 0,
      errors: [
        {
          sequence: 2,
          kind: "window_error",
          message: "during",
          filename: undefined,
          line: undefined,
          column: undefined,
          stack: undefined,
        },
        {
          sequence: 3,
          kind: "unhandled_rejection",
          message: "rejected",
          filename: undefined,
          line: undefined,
          column: undefined,
          stack: undefined,
        },
      ],
    });
  });

  it("reports errors lost from a bounded scope instead of hiding them", () => {
    const ledger = createQaRuntimeErrorLedger(2);
    const scope = ledger.beginScope();
    ledger.record({ kind: "window_error", message: "one" });
    ledger.record({ kind: "window_error", message: "two" });
    ledger.record({ kind: "window_error", message: "three" });

    expect(ledger.snapshot(scope)).toMatchObject({
      cursor: { sequence: 3 },
      total: 3,
      dropped: 1,
    });
    expect(ledger.snapshot(scope).errors.map((error) => error.message)).toEqual([
      "two",
      "three",
    ]);
  });

  it("supports incremental reads from the returned cursor", () => {
    const ledger = createQaRuntimeErrorLedger();
    ledger.record({ kind: "window_error", message: "first" });
    const cursor = ledger.snapshot().cursor;
    ledger.record({ kind: "window_error", message: "second" });

    expect(ledger.snapshot(cursor)).toMatchObject({
      total: 1,
      dropped: 0,
      errors: [{ sequence: 2, message: "second" }],
    });
  });

  it("fails closed instead of hiding errors behind a malformed cursor", () => {
    const ledger = createQaRuntimeErrorLedger();
    ledger.record({ kind: "window_error", message: "visible" });

    expect(ledger.snapshot({ sequence: Number.NaN })).toMatchObject({
      total: 1,
      dropped: 0,
      errors: [{ sequence: 1, message: "visible" }],
    });
    expect(ledger.snapshot({ sequence: 99 })).toMatchObject({
      total: 1,
      dropped: 0,
      errors: [{ sequence: 1, message: "visible" }],
    });
  });

  it("bounds diagnostic text and returns snapshots that cannot mutate storage", () => {
    const ledger = createQaRuntimeErrorLedger();
    const recorded = ledger.record({
      kind: "window_error",
      message: "m".repeat(5_000),
      filename: "f".repeat(3_000),
      line: -2,
      column: Number.POSITIVE_INFINITY,
      stack: "s".repeat(20_000),
    });
    recorded.message = "mutated";
    const snapshot = ledger.snapshot();
    snapshot.errors[0].message = "also mutated";

    const reread = ledger.snapshot().errors[0];
    expect(reread.message).toHaveLength(4_096);
    expect(reread.filename).toHaveLength(2_048);
    expect(reread.line).toBe(0);
    expect(reread.column).toBeUndefined();
    expect(reread.stack).toHaveLength(16_384);
  });

  it("rejects a non-positive or fractional capacity", () => {
    expect(() => createQaRuntimeErrorLedger(0)).toThrow(
      "qa_runtime_error_capacity_invalid",
    );
    expect(() => createQaRuntimeErrorLedger(1.5)).toThrow(
      "qa_runtime_error_capacity_invalid",
    );
  });
});
