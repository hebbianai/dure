import { describe, expect, it } from "vitest";
import {
  cacheReuseRate,
  isScanning,
  isUsageScope,
  providerSummaryCounts,
  providersInScope,
  scanningProviders,
  toggleScanning,
} from "@/lib/usage/usageScope";

describe("scanningProviders", () => {
  it("treats an absent preference as everything on", () => {
    // 기본값을 꺼짐으로 두면 기존 사용자의 화면이 갑자기 비어버린다.
    expect(scanningProviders(undefined)).toEqual(["claude", "codex"]);
  });

  it("distinguishes an empty list from an absent one", () => {
    expect(scanningProviders([])).toEqual([]);
  });

  it("drops values it does not scan and keeps a stable order", () => {
    expect(scanningProviders(["opencode", "codex", "claude"])).toEqual(["claude", "codex"]);
  });
});

describe("toggleScanning", () => {
  it("turns one off without touching the other", () => {
    expect(toggleScanning(undefined, "claude")).toEqual(["codex"]);
  });

  it("turns one back on in canonical order", () => {
    expect(toggleScanning(["codex"], "claude")).toEqual(["claude", "codex"]);
  });

  it("round-trips", () => {
    const off = toggleScanning(undefined, "codex");
    expect(isScanning(off, "codex")).toBe(false);
    expect(isScanning(toggleScanning(off, "codex"), "codex")).toBe(true);
  });
});

describe("providersInScope", () => {
  it("returns every scanning provider for the overview", () => {
    expect(providersInScope("overview", undefined)).toEqual(["claude", "codex"]);
  });

  it("narrows to the selected provider", () => {
    expect(providersInScope("claude", undefined)).toEqual(["claude"]);
  });

  it("never resurrects a provider whose scanning is off", () => {
    // 스코프로 고른 것과 스캔 대상은 별개다 — 꺼둔 걸 고르면 비어야 한다.
    expect(providersInScope("codex", ["claude"])).toEqual([]);
  });
});

describe("providerSummaryCounts", () => {
  it("counts enabled and with-data separately", () => {
    expect(providerSummaryCounts(undefined, { claude: 1200, codex: 0 })).toEqual({
      enabled: 2,
      withData: 1,
    });
  });

  it("ignores totals from a provider that is switched off", () => {
    expect(providerSummaryCounts(["claude"], { claude: 5, codex: 999 })).toEqual({
      enabled: 1,
      withData: 1,
    });
  });
});

describe("cacheReuseRate", () => {
  it("uses cacheRead / (input + cacheRead)", () => {
    expect(cacheReuseRate(2, 18)).toBeCloseTo(90);
  });

  it("is unknown rather than zero when nothing was read", () => {
    // 0%와 '알 수 없음'은 다르다 — 0%로 표시하면 캐시를 안 쓴 것처럼 읽힌다.
    expect(cacheReuseRate(0, 0)).toBeNull();
  });
});

describe("isUsageScope", () => {
  it("accepts the overview and scannable providers only", () => {
    expect(isUsageScope("overview")).toBe(true);
    expect(isUsageScope("claude")).toBe(true);
    expect(isUsageScope("opencode")).toBe(false);
  });
});
