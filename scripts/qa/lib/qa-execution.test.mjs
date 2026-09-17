import { describe, expect, test } from "vitest";
import {
  QaExecutionTimeline,
  sanitizeQaExecution,
} from "./qa-execution.mjs";

describe("QA execution evidence", () => {
  test("records bounded phase durations and the first failure class", () => {
    let now = 1_000;
    const timeline = new QaExecutionTimeline("background", () => now);

    timeline.begin("connect");
    now += 120;
    timeline.complete();
    timeline.begin("delivery");
    now += 45;
    timeline.fail("background_streaming");
    timeline.fail("cleanup");

    expect(timeline.snapshot()).toEqual({
      schemaVersion: 1,
      layer: "background",
      phaseDurationsMs: {
        connect: 120,
        delivery: 45,
      },
      failureClass: "background_streaming",
    });
  });

  test("projects an in-flight phase without exposing wall-clock timestamps", () => {
    let now = 5_000;
    const timeline = new QaExecutionTimeline("exclusive_focus", () => now);
    timeline.begin("focus_handoff");
    now += 75;

    expect(timeline.decorate({ ok: false })).toMatchObject({
      ok: false,
      qaExecution: {
        layer: "exclusive_focus",
        currentPhase: "focus_handoff",
        currentPhaseElapsedMs: 75,
      },
    });
    expect(JSON.stringify(timeline.snapshot())).not.toContain("5000");
  });

  test("rejects unbounded or free-form manifest execution input", () => {
    expect(
      sanitizeQaExecution({
        schemaVersion: 1,
        layer: "background",
        phaseDurationsMs: { delivery: 10 },
        failureClass: "background_streaming",
      }),
    ).toBeDefined();
    expect(
      sanitizeQaExecution({
        schemaVersion: 1,
        layer: "../background",
        phaseDurationsMs: {},
      }),
    ).toBeUndefined();
    expect(
      sanitizeQaExecution({
        schemaVersion: 1,
        layer: "background",
        phaseDurationsMs: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`phase_${index}`, 1]),
        ),
      }),
    ).toBeUndefined();
  });
});
