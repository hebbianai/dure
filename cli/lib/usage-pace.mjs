// How fast an account uses a provider limit window, from one usage reading.
// The percentage alone hides it: 43% one day into a 7-day window fills the
// window in about two days, long before it resets.

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The length of each kind of limit window the account usage check records.
 * A window of another kind has no known length and no pace. */
const WINDOW_LENGTHS_MS = { fiveHour: 5 * HOUR_MS, weekly: 7 * DAY_MS, modelWeekly: 7 * DAY_MS };

// A few busy minutes early in a window do not predict the rest of it.
const MIN_ELAPSED_FRACTION = 0.1;

/** The average rate since the window began, as percent per hour, and when it
 * fills the window at that rate, or null when the window resets first. Null
 * when the reading cannot give a rate: an unknown window length, reset or
 * reading time, a window too young to tell, unused or already full. */
export function windowPace({ usedPercent, resetsAtMs }, { kind, observedAtMs }) {
  const lengthMs = Object.hasOwn(WINDOW_LENGTHS_MS, kind) ? WINDOW_LENGTHS_MS[kind] : undefined;
  if (!lengthMs || resetsAtMs === null || observedAtMs === null || !(usedPercent > 0) ||
      usedPercent >= 100) return null;
  const elapsedMs = observedAtMs - (resetsAtMs - lengthMs);
  if (elapsedMs < lengthMs * MIN_ELAPSED_FRACTION) return null;
  const percentPerHour = (usedPercent * HOUR_MS) / elapsedMs;
  const fillsAtMs = observedAtMs + Math.round(((100 - usedPercent) / percentPerHour) * HOUR_MS);
  return { percentPerHour, fillsAtMs: fillsAtMs < resetsAtMs ? fillsAtMs : null };
}

/** The rate per day for a window longer than a day, otherwise per hour. */
export function formatPaceRate({ percentPerHour }, kind) {
  const perDay = WINDOW_LENGTHS_MS[kind] > DAY_MS;
  const rate = perDay ? percentPerHour * 24 : percentPerHour;
  const shown = rate >= 10 ? Math.round(rate) : Number(rate.toPrecision(2));
  return `${shown}%/${perDay ? "day" : "h"}`;
}
