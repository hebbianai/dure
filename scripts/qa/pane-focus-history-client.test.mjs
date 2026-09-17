import { describe, expect, test } from "vitest";
import { parsePaneFocusHistoryReport } from "./pane-focus-history-client.mjs";

const runId = "12345678-1234-1234-1234-123456789abc";
function receipt(overrides = {}) {
  return `[2026-09-07T00:00:00Z] ${JSON.stringify(["pane-focus-history", {
    schemaVersion: 1, runId, pass: true, nativeWindowLabel: "main",
    keyboardSource: "synthetic-dom", nativeFocusChecks: 22,
    observations: Array.from({ length: 21 }, () => ({ focusInsidePane: true })),
    activation: { focusRequests: 1, firstInput: "x", trustedInput: true, focusMs: 5 },
    ...overrides,
  }])}`;
}

test("accepts only this generation's completed native focus journey", () => {
  expect(parsePaneFocusHistoryReport(receipt(), runId)?.pass).toBe(true);
  expect(parsePaneFocusHistoryReport(receipt({ runId: "older-run" }), runId)).toBeUndefined();
  expect(parsePaneFocusHistoryReport("unrelated log", runId)).toBeUndefined();
  expect(parsePaneFocusHistoryReport(receipt().slice(0, -4), runId)).toBeUndefined();
});

describe("incomplete native observations are never success", () => {
  test.each([
    { observations: [] },
    { observations: Array.from({ length: 20 }, () => ({ focusInsidePane: false })) },
    { nativeFocusChecks: 0 },
    { nativeWindowLabel: "other-window" },
    { schemaVersion: 2 },
    { activation: undefined },
    { activation: { focusRequests: 2, firstInput: "x", trustedInput: true, focusMs: 5 } },
    { activation: { focusRequests: 1, firstInput: "", trustedInput: true, focusMs: 5 } },
    { activation: { focusRequests: 1, firstInput: "x", trustedInput: false, focusMs: 5 } },
  ])("rejects %j", (overrides) => {
    expect(() => parsePaneFocusHistoryReport(receipt(overrides), runId)).toThrow("incomplete evidence");
  });
});

test("retains an exact-run failure instead of waiting for another success", () => {
  expect(() => parsePaneFocusHistoryReport(receipt({ pass: false, error: "focus lost" }), runId)).toThrow("focus lost");
});
