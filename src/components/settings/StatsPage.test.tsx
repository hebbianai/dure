// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "@/lib/usage/usageMeter";

// Radix Select가 여는 순간 쓰는 레이아웃 API는 jsdom에 없다. 이 파일 안에서만
// 채운다 — 전역 setup에 넣으면 다른 테스트의 환경까지 바꾼다.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

const usageRecentMock = vi.fn();
const usageStatsMock = vi.fn();
const collectorStatusMock = vi.fn();

vi.mock("@tauri-apps/plugin-dialog", () => ({ message: vi.fn() }));
vi.mock("@/lib/ipc", () => ({
  usageRecent: (hours: number) => usageRecentMock(hours),
  usageStats: (days: number) => usageStatsMock(days),
  claudeCollectorStatus: () => collectorStatusMock(),
  claudeCollectorInstall: () => Promise.resolve("installed"),
  codexUsageProfilesSync: () => Promise.resolve(),
  accountLoginIdentity: () => Promise.resolve({ email: null, plan: null }),
}));

import { StatsPage } from "@/components/settings/StatsPage";
import { DEFAULT_SCAN_DAYS } from "@/lib/usage/usageScope";
import { useStore } from "@/store";

function providerUsage(over: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    total: 150,
    usedPercent: null,
    usedPercentWeekly: null,
    resetsAt: null,
    weeklyResetsAt: null,
    usedPercentCapturedAt: null,
    rateLimits: [],
    ...over,
  };
}

const EMPTY_STATS = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  sessions: 0,
  turns: 0,
  daily: [],
};

beforeEach(() => {
  collectorStatusMock.mockResolvedValue("installed");
  usageStatsMock.mockResolvedValue({ claude: EMPTY_STATS, codex: EMPTY_STATS });
  usageRecentMock.mockResolvedValue({
    claude: providerUsage({ usedPercent: 42, total: 1_000 }),
    codex: providerUsage(),
    claudeAccounts: [],
    codexAccounts: [],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useStore.setState({
    uiPrefs: { ...useStore.getState().uiPrefs, usageScanProviders: undefined, usageScanDays: undefined },
  });
});

async function selectScope(name: string) {
  // 스캔 기간 선택기가 생겨 combobox가 둘이다 — 접근성 이름으로 특정한다.
  fireEvent.click(screen.getByRole("combobox", { name: "집계 범위" }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("StatsPage", () => {
  it("shows readable trillion totals and exact non-overlapping token counts without hover", async () => {
    usageStatsMock.mockResolvedValue({
      claude: EMPTY_STATS,
      codex: {
        ...EMPTY_STATS,
        input: 1_200_000_000_000,
        output: 19_988_300_000,
        cacheRead: 1_190_000_000_000,
        total: 29_988_300_000,
      },
    });
    render(<StatsPage />);
    expect(await screen.findByText("1.22T")).toBeTruthy();
    expect(screen.getByText("1,219,988,300,000")).toBeTruthy();
    expect(screen.getByText("29,988,300,000")).toBeTruthy();
    expect(screen.getByText("10,000,000,000")).toBeTruthy();
    expect(screen.getByText("19,988,300,000")).toBeTruthy();
    expect(screen.getByText("1,190,000,000,000")).toBeTruthy();
    expect(screen.getAllByText("97.54%").length).toBeGreaterThan(0);
  });

  it("집계 범위 트리거에 아이콘이 한 번만 뜬다", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalled());

    const trigger = screen.getByRole("combobox", { name: "집계 범위" });
    // SelectValue가 고른 항목의 children(아이콘 + 라벨)을 그대로 그린다. 여기에
    // 트리거의 펼침 화살표를 더해 svg는 둘이어야 한다. 트리거가 아이콘을 또
    // 그리면 셋이 되고, 화면에는 같은 아이콘이 나란히 두 번 찍힌다.
    expect(trigger.querySelectorAll("svg").length).toBe(2);
  });

  it("공급자를 고르면 배지와 같은 한도 상세를 보여준다", async () => {
    // 한도 %는 42일 로그 스캔(usage_stats)에 없는 값이다 — 이게 뜬다는 것은
    // 설정 화면이 배지와 같은 usage_recent 출처를 쓰고 있다는 뜻이다.
    render(<StatsPage />);
    await waitFor(() => expect(usageRecentMock).toHaveBeenCalled());

    await selectScope("Claude");

    expect(await screen.findByText("42%")).toBeTruthy();
    expect(usageRecentMock).toHaveBeenCalledWith(5);
    expect(usageRecentMock).toHaveBeenCalledWith(24);
  });

  it("개요에서는 한도 상세 대신 빈 상태와 스캔 토글을 보여준다", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalledWith(DEFAULT_SCAN_DAYS));

    expect(screen.getByText("토큰 추적 시작")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude 스캔 중" })).toBeTruthy();
  });

  it("스캔을 끄면 그 공급자가 집계 대상에서 빠진다", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Codex 스캔 중" }));

    expect(useStore.getState().uiPrefs?.usageScanProviders).toEqual(["claude"]);
    expect(screen.getByText("1 활성화됨 · 0 데이터 있음")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Codex 활성화" })).toBeTruthy();
  });
});

describe("StatsPage 스캔 기간", () => {
  it("기간을 바꾸면 그 창으로 다시 조회한다", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalledWith(DEFAULT_SCAN_DAYS));

    fireEvent.click(screen.getByRole("combobox", { name: "스캔 기간" }));
    fireEvent.click(await screen.findByRole("option", { name: "최근 14일" }));

    await waitFor(() => expect(usageStatsMock).toHaveBeenCalledWith(14));
  });
});

describe("StatsPage 스캔 상태", () => {
  it("기본 기간은 42일이 아니라 짧게 — 첫 스캔에 1분을 기다리게 하지 않는다", async () => {
    // 실측: 캐시가 빈 42일 스캔은 62초였다. 기본값이 그걸 강제하면 안 된다.
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalled());

    expect(DEFAULT_SCAN_DAYS).toBeLessThan(42);
    expect(usageStatsMock).toHaveBeenCalledWith(DEFAULT_SCAN_DAYS);
    expect(usageStatsMock).not.toHaveBeenCalledWith(42);
  });

  it("고른 기간을 저장해 다시 열어도 유지한다", async () => {
    render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("combobox", { name: "스캔 기간" }));
    fireEvent.click(await screen.findByRole("option", { name: /최근 30일/ }));

    await waitFor(() => expect(usageStatsMock).toHaveBeenCalledWith(30));
    expect(useStore.getState().uiPrefs?.usageScanDays).toBe(30);
  });

  it("스캔이 실패하면 '스캔 중'이 아니라 실패라고 말하고 재시도를 준다", async () => {
    usageStatsMock.mockRejectedValue(new Error("boom"));
    render(<StatsPage />);

    expect(await screen.findByText(/스캔 실패/)).toBeTruthy();
    expect(screen.queryByText(/로그 스캔 중/)).toBeNull();

    usageStatsMock.mockResolvedValue({ claude: EMPTY_STATS, codex: EMPTY_STATS });
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.queryByText(/스캔 실패/)).toBeNull());
  });

  it("스캔 중에는 취소를 주고, 취소 후 늦게 온 결과는 버린다", async () => {
    let resolveScan: (v: unknown) => void = () => {};
    usageStatsMock.mockReturnValue(new Promise((r) => { resolveScan = r; }));
    render(<StatsPage />);

    expect(await screen.findByText(/로그 스캔 중/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByText("스캔을 취소했습니다.")).toBeTruthy();

    resolveScan({ claude: EMPTY_STATS, codex: EMPTY_STATS });
    await waitFor(() => expect(screen.getByText("스캔을 취소했습니다.")).toBeTruthy());
    expect(screen.queryByText(/로그 스캔 중/)).toBeNull();
  });
});

describe("StatsPage 레이아웃 (시안 2527:77100 / 2527:78081)", () => {
  it("카드 없이 구획으로 나눈다", async () => {
    const { container } = render(<StatsPage />);
    await waitFor(() => expect(usageStatsMock).toHaveBeenCalled());

    // 720px 카드(rounded-xl border bg-background)가 다시 붙으면 실패한다.
    // 통계·공급자 카드는 rounded-[12px]라 여기에 걸리지 않는다.
    expect(container.querySelector('[class*="rounded-xl"]')).toBeNull();
    // 구획 경계는 hairline 하나뿐이다.
    expect(container.querySelectorAll("section").length).toBe(3);
  });
});
