import { describe, expect, it } from "vitest";
import {
  isPaneRecoveryDiagnosticCode,
  parsePaneRecoveryDiagnostics,
} from "../cli/lib/contracts/pane-recovery-diagnostics.mjs";

const event = { stage: "lineage_wake", code: "agent_runtime_transition_conflict",
  agentId: "agent-1", firstSeenMs: 1, lastSeenMs: 2, count: 1 };
const report = (events) => ({ schemaVersion: 1, state: "available", events });

describe("bounded pane recovery diagnostic projection", () => {
  it("keeps the failing stage and code while stripping arbitrary payloads", () => {
    expect(parsePaneRecoveryDiagnostics({
      ...report([{ ...event, message: "/Users/private/worktree", detail: "private" }]),
      secret: "private",
    })).toEqual(report([event]));
  });

  it("keeps a row whose agent was not identified", () => {
    const { agentId: _agentId, ...anonymous } = event;
    expect(parsePaneRecoveryDiagnostics(report([anonymous]))).toEqual(report([anonymous]));
  });

  it.each([
    { stage: "unknown_stage" }, { code: "store is busy" }, { code: "/Users/private" },
    { code: "Recovering" }, { code: "" }, { code: `a${"b".repeat(128)}` },
    { agentId: "agent with spaces" }, { agentId: "" }, { agentId: 7 },
    { count: 0 }, { count: 0x1_0000_0000 }, { lastSeenMs: 0 }, { firstSeenMs: NaN },
  ])("refuses invalid recovery evidence %j", (override) => {
    expect(parsePaneRecoveryDiagnostics(report([{ ...event, ...override }]))).toBeNull();
  });

  it("bounds reports and supports explicit older-native unavailability", () => {
    expect(parsePaneRecoveryDiagnostics(report(Array(64).fill(event)))?.events).toHaveLength(64);
    expect(parsePaneRecoveryDiagnostics(report(Array(65).fill(event)))).toBeNull();
    expect(parsePaneRecoveryDiagnostics({ schemaVersion: 1, state: "unavailable", events: [] }))
      .toEqual({ schemaVersion: 1, state: "unavailable", events: [] });
    expect(parsePaneRecoveryDiagnostics({ schemaVersion: 1, state: "unavailable", events: [event] })).toBeNull();
    expect(parsePaneRecoveryDiagnostics(undefined)).toBeNull();
  });

  it("accepts only snake_case codes, never free text", () => {
    expect(isPaneRecoveryDiagnosticCode("session_checkout_store_busy")).toBe(true);
    expect(isPaneRecoveryDiagnosticCode("recovering")).toBe(true);
    expect(isPaneRecoveryDiagnosticCode("store is busy during prepare_session_checkout")).toBe(false);
    expect(isPaneRecoveryDiagnosticCode(undefined)).toBe(false);
  });
});
