import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  expectedWorkspacePerformanceProviderSessions,
  readWorkspacePerformanceProviderFixture,
} from "./workspace-performance-provider-fixture.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dure-provider-fixture-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "provider-capture", "provider-sessions"), {
    recursive: true,
    mode: 0o700,
  });
  return root;
}

function publish(root, session, overrides = {}) {
  fs.writeFileSync(
    path.join(
      root,
      "provider-capture",
      "provider-sessions",
      `${session.sessionId}.json`,
    ),
    `${JSON.stringify({ schema: 1, ...session, ...overrides })}\n`,
    { mode: 0o600 },
  );
}

describe("workspace performance provider fixture", () => {
  test("derives the balanced provider topology from the shared scenario", () => {
    const sessions = expectedWorkspacePerformanceProviderSessions("baseline_15");
    expect(sessions).toHaveLength(15);
    expect(sessions.slice(0, 3)).toEqual([
      { provider: "claude", sessionId: "dure-perf-claude-d1-p1" },
      { provider: "codex", sessionId: "dure-perf-codex-d1-p2" },
      { provider: "claude", sessionId: "dure-perf-claude-d1-p3" },
    ]);
  });

  test("accepts only exact owner-only provider session receipts", () => {
    const root = fixtureRoot();
    const sessions = expectedWorkspacePerformanceProviderSessions("baseline_15");
    for (const session of sessions) publish(root, session);

    expect(readWorkspacePerformanceProviderFixture(root)).toEqual({
      ready: true,
      expected: 15,
      observed: 15,
      missing: [],
      invalid: [],
    });
  });

  test("fails closed when a real or wrong provider did not publish exact proof", () => {
    const root = fixtureRoot();
    const sessions = expectedWorkspacePerformanceProviderSessions("baseline_15");
    publish(root, sessions[0], { provider: "codex" });

    const result = readWorkspacePerformanceProviderFixture(root);
    expect(result.ready).toBe(false);
    expect(result.invalid).toEqual([
      "dure-perf-claude-d1-p1: identity mismatch",
    ]);
    expect(result.missing).toHaveLength(14);
  });
});
