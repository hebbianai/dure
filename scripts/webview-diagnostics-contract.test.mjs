import { describe, expect, it } from "vitest";
import { parseWebviewDiagnostics } from "../cli/lib/contracts/webview-diagnostics.mjs";

const event = { level: "error", source: "console", code: "client_space_window_changed",
  windowLabel: "win-195-1", firstSeenMs: 1, lastSeenMs: 2, count: 1 };
const report = (events) => ({ schemaVersion: 1, state: "available", events });

describe("bounded WebView diagnostic projection", () => {
  it("keeps known diagnostic evidence while stripping arbitrary payloads", () => {
    expect(parseWebviewDiagnostics({ ...report([{ ...event, message: "private", stack: "private" }]), secret: "private" }))
      .toEqual(report([event]));
  });
  it.each([
    { code: "unknown_secret" }, { source: "unsupported" }, { level: "info" },
    { windowLabel: "private-title" }, { windowLabel: `win-${"1".repeat(130)}-1` },
    { count: -1 }, { count: 0x1_0000_0000 }, { lastSeenMs: 0 }, { firstSeenMs: NaN },
  ])("refuses invalid event evidence %j", (override) => {
    expect(parseWebviewDiagnostics(report([{ ...event, ...override }]))).toBeNull();
  });
  it("bounds reports and supports explicit older-native unavailability", () => {
    expect(parseWebviewDiagnostics(report(Array(256).fill(event)))?.events).toHaveLength(256);
    expect(parseWebviewDiagnostics(report(Array(257).fill(event)))).toBeNull();
    expect(parseWebviewDiagnostics({ schemaVersion: 1, state: "unavailable", events: [] })).toEqual({ schemaVersion: 1, state: "unavailable", events: [] });
    expect(parseWebviewDiagnostics({ schemaVersion: 1, state: "unavailable", events: [event] })).toBeNull();
    expect(parseWebviewDiagnostics(undefined)).toBeNull();
  });
});
