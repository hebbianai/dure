/**
 * "2 seconds ago" — how long ago something happened, in words.
 *
 * A pure function of two timestamps rather than of one plus `Date.now()`, so a
 * test can state the elapsed time instead of mocking the clock, and so the one
 * place that decides "now" is the screen that is about to draw.
 *
 * Rounds **down**. "1 minute ago" for something 59 seconds old would be the
 * screen claiming the sync is fresher than it is, and this label is how someone
 * decides whether the list in front of them is worth trusting.
 */

import { t } from "./i18n";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTime(atMs: number, nowMs: number): string {
  // A clock that went backwards (NTP correction, timezone change while the app
  // slept) must not print a negative age. Treat it as just now: the sync did
  // happen, and the phone cannot say more than that honestly.
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < 5_000) return t("방금");
  if (elapsed < MINUTE) return t("{count}초 전", { count: Math.floor(elapsed / 1000) });
  if (elapsed < HOUR) return t("{count}분 전", { count: Math.floor(elapsed / MINUTE) });
  if (elapsed < DAY) return t("{count}시간 전", { count: Math.floor(elapsed / HOUR) });
  return t("{count}일 전", { count: Math.floor(elapsed / DAY) });
}
