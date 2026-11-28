import assert from "node:assert/strict";
import { test } from "vitest";
import { formatPaceRate, windowPace } from "../cli/lib/usage-pace.mjs";

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

test("a weekly window used at 43% one day in is on pace to fill well before it resets", () => {
  const pace = windowPace({ usedPercent: 43, resetsAtMs: NOW + 6 * DAY }, { kind: "weekly", observedAtMs: NOW });
  assert.equal(pace.percentPerHour, 43 / 24);
  // The remaining 57% at 43% a day takes about 1.3 days, not the 6 left in the window.
  assert.equal(pace.fillsAtMs, NOW + Math.round((57 / 43) * DAY));
  assert.equal(formatPaceRate(pace, "weekly"), "43%/day");
});

test("a window used slower than it resets has a rate and no fill time", () => {
  const pace = windowPace({ usedPercent: 10, resetsAtMs: NOW + 3.5 * DAY }, { kind: "modelWeekly", observedAtMs: NOW });
  assert.deepEqual(pace, { percentPerHour: 10 / 84, fillsAtMs: null });
  assert.equal(formatPaceRate(pace, "modelWeekly"), "2.9%/day");
});

test("the pace is measured from the reading, not from now", () => {
  const observedAtMs = NOW - 2 * HOUR;
  const pace = windowPace({ usedPercent: 50, resetsAtMs: NOW + HOUR }, { kind: "fiveHour", observedAtMs });
  // Two of the window's five hours had passed when it read 50%.
  assert.deepEqual(pace, { percentPerHour: 25, fillsAtMs: observedAtMs + 2 * HOUR });
  assert.equal(formatPaceRate(pace, "fiveHour"), "25%/h");
});

test("a rate below one percent keeps two significant digits", () => {
  const pace = windowPace({ usedPercent: 1, resetsAtMs: NOW + DAY }, { kind: "weekly", observedAtMs: NOW });
  assert.equal(formatPaceRate(pace, "weekly"), "0.17%/day");
});

test("no pace while the window is too young, unused, full or not fully described", () => {
  const cases = [
    // A few busy minutes early in a window do not predict the rest of it.
    [{ usedPercent: 2, resetsAtMs: NOW + 7 * DAY - HOUR }, { kind: "weekly", observedAtMs: NOW }],
    [{ usedPercent: 0, resetsAtMs: NOW + DAY }, { kind: "weekly", observedAtMs: NOW }],
    [{ usedPercent: 100, resetsAtMs: NOW + DAY }, { kind: "weekly", observedAtMs: NOW }],
    [{ usedPercent: 40, resetsAtMs: null }, { kind: "weekly", observedAtMs: NOW }],
    [{ usedPercent: 40, resetsAtMs: NOW + DAY }, { kind: "weekly", observedAtMs: null }],
    // A window Dure does not know the length of.
    [{ usedPercent: 40, resetsAtMs: NOW + DAY }, { kind: "other", observedAtMs: NOW }],
  ];
  for (const [window, reading] of cases) assert.equal(windowPace(window, reading), null);
});
