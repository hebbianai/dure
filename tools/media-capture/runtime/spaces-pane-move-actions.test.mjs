import { describe, expect, it, vi } from "vitest";
import { scenarioById } from "../scenarios.mjs";
import { captureProofManifest } from "./capture-proof.mjs";
import { runSpacesPaneMoveAction } from "./spaces-pane-move-actions.mjs";
import { replayVisibility } from "../providers/live-sessions.mjs";
import { liveReplaySteps } from "./live-terminal-replay.mjs";
import { requiredLiveStillSessionIds } from "./live-terminal-still.mjs";
import { normalizeProviderScreen, providerPrivacyViolations } from "../providers/privacy.mjs";

describe("Spaces move media evidence", () => {
  it("brackets the actual drag with live source observations", async () => {
    const events = [];
    const locator = {
      first() { return this; },
      waitFor: vi.fn(),
      dragTo: vi.fn(async () => { events.push("drag"); }),
    };
    const page = {
      locator: () => locator,
      evaluate: vi.fn()
        .mockResolvedValueOnce({ source: ["agent:demo"], target: [], sessionId: "demo" })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ dragstart: 1, drop: 1 }),
      waitForFunction: vi.fn(async () => { events.push("presentation-verified"); }),
    };
    await runSpacesPaneMoveAction(page, {
      action: "moveSpacesPane", panelId: "agent:demo",
      fromDesktopId: "source", toDesktopId: "target",
    }, {
      captureKind: "webm",
      probeLiveSessions: async ({ captureKind, phase }) => {
        expect(captureKind).toBe("webm");
        events.push(phase);
      },
    });
    expect(events).toEqual(["before", "drag", "presentation-verified", "after"]);
  });

  it("cannot promote fixture-only pane motion as live source continuity", () => {
    expect(() => captureProofManifest({
      scenario: scenarioById("spaces-pane-move"),
      captureSurface: "browser-client", providerSource: "fixture",
    })).toThrow("requires live provider evidence");
  });

  it("replays and requires the moved session in its destination desktop", () => {
    const scenario = structuredClone(scenarioById("spaces-pane-move"));
    const sessionId = "session-codex-navigation";
    scenario.liveProviderSessionIds = [sessionId];
    const visibility = replayVisibility(scenario, sessionId);
    const steps = liveReplaySteps({
      [sessionId]: { ...visibility, kind: "pty", frames: [
        { columns: 80, rows: 24, repaintBase64: "ZGVtbw==", sequenceThrough: "1" },
      ] },
    }, scenario.durationMs);
    expect(steps).toMatchObject([{ desktopId: "desk-review" }]);
    expect(steps[0].atMs).toBeGreaterThan(4_000);
    expect(requiredLiveStillSessionIds(scenario)).toEqual([sessionId]);
  });

  it("sanitizes abbreviated absolute checkout paths outside disposable HOME", () => {
    const raw = "directory: /Users/demo/AAA/.../owned-worktree";
    expect(providerPrivacyViolations(raw)).toContain("private home path");
    const sanitized = normalizeProviderScreen(raw, {
      home: "/tmp/disposable-home", abbreviatedPathAlias: "~/dure-demo/codex",
      ownedPaths: [{ path: "/Users/demo/AAA/project/owned-worktree", alias: "~/dure-demo/codex" }],
    });
    expect(sanitized).toBe("directory: ~/dure-demo/codex");
    expect(providerPrivacyViolations(sanitized)).toEqual([]);
  });
});
