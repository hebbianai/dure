import { describe, expect, it } from "vitest";
import {
  buildStorageReservationDiagnostics,
  formatBuildStorageReservationDiagnostics,
} from "./build-storage-diagnostics.mjs";
import { GIB } from "./disk-space.mjs";

function holder(index, record = {}) {
  return {
    liveness: "active",
    pathname: "/private/lease-path-canary",
    record: {
      pid: 40 + index,
      acquiredAtUnixMs: 1_000 + index,
      requestedBytes: 20 * GIB,
      cwd: "/fixture/.worktrees/worker",
      label: "dev build",
      token: "private-token-canary",
      processIdentity: "private-identity-canary",
      ...record,
    },
  };
}

function diagnostics(active, nowMs = 121_000) {
  return buildStorageReservationDiagnostics({
    active,
    invalid: [{ reason: "private-invalid-canary" }],
    observationStatus: "complete",
    reservedBytes: active.reduce((sum, entry) => sum + entry.record.requestedBytes, 0),
  }, { nowMs });
}

describe("build storage reservation diagnostics", () => {
  it("shows holder identity, legacy class and age without lease capabilities", () => {
    const snapshot = diagnostics([holder(0)]);
    expect(snapshot.active[0]).toEqual({
      pid: 40,
      acquiredAtUnixMs: 1_000,
      ageMs: 120_000,
      requestedBytes: 20 * GIB,
      cwd: "/fixture/.worktrees/worker",
      label: "dev build",
      buildClass: "dev",
      liveness: "active",
    });
    const text = formatBuildStorageReservationDiagnostics(snapshot);
    expect(text).toContain('pid=40 class=dev reserved=20.0 GiB age=2m 0s liveness=active');
    expect(text).toContain('worktree="/fixture/.worktrees/worker"');
    expect(JSON.stringify(snapshot) + text).not.toContain("private-");
  });

  it("does not guess class or release time from an old custom label or unknown liveness", () => {
    const unknown = holder(0, { label: "custom build", acquiredAtUnixMs: 122_000 });
    unknown.liveness = "unknown";
    const snapshot = diagnostics([unknown, holder(1, { buildClass: "qa", label: "custom QA" })]);
    expect(snapshot.active.map(({ buildClass }) => buildClass)).toEqual(["qa", "unknown"]);
    const text = formatBuildStorageReservationDiagnostics(snapshot);
    expect(text).toContain("age=0s liveness=unknown");
    expect(text).toContain("not a completion estimate");
    expect(text).toContain("Unknown liveness does not prove exit");
  });

  it("caps oldest holders and context without truncating reserved totals", () => {
    const active = Array.from({ length: 12 }, (_, index) => holder(index, {
      cwd: "\u001b\u202e".repeat(2_048),
      label: "\n".repeat(256),
    })).reverse();
    const snapshot = diagnostics(active);
    expect(snapshot.active).toHaveLength(8);
    expect(snapshot.active[0].pid).toBe(40);
    expect(snapshot).toMatchObject({ activeCount: 12, omittedCount: 4, reservedBytes: 240 * GIB });
    expect(snapshot.active[0].cwd).toHaveLength(512);
    expect(snapshot.active[0].label).toHaveLength(96);
    const text = formatBuildStorageReservationDiagnostics(snapshot);
    expect(text).not.toMatch(/[\u001b\u202e]/u);
    expect(text.split("\n")).toHaveLength(11);
    expect(text).toContain("4 more holders omitted");
    expect(Buffer.byteLength(text)).toBeLessThan(32 * 1_024);
  });
});
