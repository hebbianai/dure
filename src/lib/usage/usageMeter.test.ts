import { describe, expect, it } from "vitest";
import {
  claudeUsedTokens,
  claudeMeter,
  compactUsageIndicator,
  codexMeter,
  codexModelMeters,
  fmtAgo,
  fmtReset,
  fmtTokens,
  type ProviderUsage,
} from "@/lib/usage/usageMeter";

function usage(over: Partial<ProviderUsage>): ProviderUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    usedPercent: null,
    usedPercentWeekly: null,
    resetsAt: null,
    weeklyResetsAt: null,
    usedPercentCapturedAt: null,
    rateLimits: [],
    ...over,
  };
}

describe("fmtTokens", () => {
  it("abbreviates by magnitude", () => {
    expect(fmtTokens(500)).toBe("500");
    expect(fmtTokens(34_000)).toBe("34k");
    expect(fmtTokens(1_234_567)).toBe("1.2M");
  });
  it("keeps billion and trillion totals readable without a four-digit mantissa", () => {
    expect(fmtTokens(37_791_400_000)).toBe("37.79B");
    expect(fmtTokens(1_219_988_300_000)).toBe("1.22T");
    expect(fmtTokens(999_950_000)).toBe("1B");
    expect(fmtTokens(999_999_000_000)).toBe("1T");
  });
});

describe("fmtReset", () => {
  const now = 1_000_000;
  it("분/시+분/일+시 두 단위 조합으로 상세 표시한다", () => {
    expect(fmtReset(now + 1800, now)).toBe("30m");
    expect(fmtReset(now + 4 * 3600, now)).toBe("4h");
    expect(fmtReset(now + 3 * 3600 + 40 * 60, now)).toBe("3h 40m");
    expect(fmtReset(now + 3 * 86400, now)).toBe("3d");
    expect(fmtReset(now + 2 * 86400 + 5 * 3600, now)).toBe("2d 5h");
  });

  it("올림 경계는 상위 단위로 넘긴다 (3h 59.5m → 4h)", () => {
    expect(fmtReset(now + 3 * 3600 + 3590, now)).toBe("4h");
    expect(fmtReset(now + 2 * 86400 + 23 * 3600 + 3500, now)).toBe("3d");
  });
  it("returns null for past or absent resets", () => {
    expect(fmtReset(now - 10, now)).toBeNull();
    expect(fmtReset(null, now)).toBeNull();
    expect(fmtReset(undefined, now)).toBeNull();
  });
  it("rounds sub-minute up to 1m rather than 0m", () => {
    expect(fmtReset(now + 20, now)).toBe("1m");
  });
});

describe("claudeUsedTokens", () => {
  it("입력+출력만 — 캐시생성(전체의 80%+ 차지)·캐시읽기는 헤드라인에서 제외", () => {
    expect(
      claudeUsedTokens(usage({ input: 100, output: 50, cacheWrite: 9_999, cacheRead: 9_999 })),
    ).toBe(150);
  });
});

describe("compactUsageIndicator", () => {
  it("keeps normal usage compact and reveals warning/danger percentages", () => {
    expect(compactUsageIndicator(59.9)).toEqual({
      pct: 59.9,
      level: "normal",
      showLabel: false,
    });
    expect(compactUsageIndicator(60)).toEqual({
      pct: 60,
      level: "warning",
      showLabel: true,
    });
    expect(compactUsageIndicator(85)).toEqual({
      pct: 85,
      level: "danger",
      showLabel: true,
    });
  });

  it("keeps missing data distinct and clamps provider values for the ring", () => {
    expect(compactUsageIndicator(null)).toEqual({
      pct: null,
      level: "unknown",
      showLabel: false,
    });
    expect(compactUsageIndicator(-4).pct).toBe(0);
    expect(compactUsageIndicator(140).pct).toBe(100);
  });
});

describe("codexMeter", () => {
  const now = 1_000_000;
  it("prefers the 5h window when present, with its reset", () => {
    const m = codexMeter(
      usage({ usedPercent: 2, resetsAt: now + 3600, usedPercentWeekly: 6, weeklyResetsAt: now + 86400 }),
      now,
    );
    expect(m).toEqual({ pct: 2, window: "5h", resetLabel: "1h" });
  });
  it("falls back to weekly when only weekly is reported", () => {
    const m = codexMeter(usage({ usedPercentWeekly: 38, weeklyResetsAt: now + 2 * 86400 }), now);
    expect(m).toEqual({ pct: 38, window: "weekly", resetLabel: "2d" });
  });
  it("returns null (never a fake 0%) when no rate-limit data exists", () => {
    expect(codexMeter(usage({}), now)).toEqual({ pct: null, window: null, resetLabel: null });
  });
  it("keeps a real 0% distinct from missing data", () => {
    const m = codexMeter(usage({ usedPercent: 0, resetsAt: now + 100 }), now);
    expect(m.pct).toBe(0);
    expect(m.window).toBe("5h");
  });
});

describe("codexModelMeters", () => {
  const now = 1_000_000;

  it("keeps a model-specific limit separate from the general Codex bucket", () => {
    const meters = codexModelMeters(
      usage({
        rateLimits: [
          {
            limitId: "codex",
            limitName: null,
            usedPercent: 12,
            usedPercentWeekly: 34,
            resetsAt: now + 3600,
            weeklyResetsAt: now + 86400,
          },
          {
            limitId: "codex_bengalfox",
            limitName: "GPT-5.3-Codex-Spark",
            usedPercent: 77,
            usedPercentWeekly: 81,
            resetsAt: now + 7200,
            weeklyResetsAt: now + 2 * 86400,
          },
        ],
      }),
      now,
    );

    expect(meters).toEqual([
      {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        pct: 77,
        window: "5h",
        resetLabel: "2h",
        weeklyPct: 81,
        weeklyResetLabel: "2d",
      },
    ]);
  });
});

describe("claudeMeter", () => {
  const now = 1_000_000;
  it("shows the collector-cached 5h percentage when present", () => {
    const m = claudeMeter(
      usage({ usedPercent: 23.5, resetsAt: now + 3600, usedPercentCapturedAt: now - 60 }),
      now,
    );
    expect(m).toEqual({ pct: 23.5, window: "5h", resetLabel: "1h" });
  });
  it("returns null without collector data — caller falls back to tokens", () => {
    expect(claudeMeter(usage({}), now)).toEqual({ pct: null, window: null, resetLabel: null });
  });
});

describe("fmtAgo", () => {
  const now = 1_000_000;
  it("formats elapsed minutes / hours / days", () => {
    expect(fmtAgo(now - 30, now)).toBe("1m");
    expect(fmtAgo(now - 1800, now)).toBe("30m");
    expect(fmtAgo(now - 4 * 3600, now)).toBe("4h");
    expect(fmtAgo(now - 3 * 86400, now)).toBe("3d");
  });
  it("returns null for absent or future timestamps", () => {
    expect(fmtAgo(null, now)).toBeNull();
    expect(fmtAgo(undefined, now)).toBeNull();
    expect(fmtAgo(now + 10, now)).toBeNull();
  });
});
