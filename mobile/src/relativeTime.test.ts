import { describe, expect, it } from "vitest";
import { t } from "./i18n";
import { relativeTime } from "./relativeTime";

const NOW = 1_700_000_000_000;

describe("relativeTime", () => {
  it("calls the last few seconds just now", () => {
    expect(relativeTime(NOW - 900, NOW)).toBe(t("방금"));
  });

  it("counts seconds, minutes, hours and days", () => {
    expect(relativeTime(NOW - 12_000, NOW)).toBe(t("{count}초 전", { count: 12 }));
    expect(relativeTime(NOW - 8 * 60_000, NOW)).toBe(t("{count}분 전", { count: 8 }));
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe(t("{count}시간 전", { count: 3 }));
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe(t("{count}일 전", { count: 2 }));
  });

  /**
   * Rounding up would make the label claim the sync is fresher than it is, and
   * this line is what someone reads to decide whether the list is worth
   * trusting.
   */
  it("rounds down, never up", () => {
    expect(relativeTime(NOW - 119_000, NOW)).toBe(t("{count}분 전", { count: 1 }));
  });

  /** A clock correction while the app slept must not print a negative age. */
  it("survives a clock that went backwards", () => {
    expect(relativeTime(NOW + 60_000, NOW)).toBe(t("방금"));
  });
});
