// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({ appCompatibility: vi.fn() }));

import { appCompatibility } from "@/lib/ipc";
import { resetFrameBudgetSchedulerForTest } from "@/lib/scheduling/frameBudgetScheduler";
import {
  startBackendCompatibilityWatch,
  useBackendCompatibilityStore,
} from "@/lib/platform/backendCompatibilityStore";

function compat(mode: string, backendBuild: string | null) {
  return {
    mode,
    comparisonBasis: "runtime-fingerprint",
    frontendBuildId: "0.1.1+front",
    frontendSourceRevision: null,
    frontendWorktreeOverlay: "unknown",
    frontendRuntimeFingerprint: `git-object-v1:${"a".repeat(40)}`,
    backend: backendBuild
      ? {
          buildId: backendBuild,
          runtimeFingerprint: `git-object-v1:${"a".repeat(40)}`,
        }
      : null,
    missingFeatures: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFrameBudgetSchedulerForTest();
  useBackendCompatibilityStore.setState({ compatibility: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("backend compatibility watch", () => {
  it("probes immediately and publishes the mode", async () => {
    vi.mocked(appCompatibility).mockResolvedValue(compat("current", "0.1.1+front") as never);
    const stop = startBackendCompatibilityWatch();
    await vi.advanceTimersByTimeAsync(0);
    expect(useBackendCompatibilityStore.getState().compatibility?.mode).toBe("current");
    expect(document.documentElement.dataset.backendCompatibility).toBe("current");
    expect(document.documentElement.dataset.backendCompatibilityBasis).toBe(
      "runtime-fingerprint",
    );
    stop();
  });

  it("detects skew that develops after boot (재시작 없는 dev의 실제 시나리오)", async () => {
    vi.mocked(appCompatibility).mockResolvedValue(compat("current", "0.1.1+front") as never);
    const stop = startBackendCompatibilityWatch(60_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(useBackendCompatibilityStore.getState().compatibility?.mode).toBe("current");

    // 이후 프론트가 리로드된 상황 — 다음 주기에서 skew로 전환돼야 한다
    vi.mocked(appCompatibility).mockResolvedValue(compat("version-skew", "0.1.1+old") as never);
    // 틱 발화 + maintenance 레인 슬라이스(폴백 시계 250ms 이내) 경과.
    await vi.advanceTimersByTimeAsync(60_000 + 300);
    expect(useBackendCompatibilityStore.getState().compatibility?.mode).toBe("version-skew");
    stop();
  });

  it("stops probing after cleanup", async () => {
    vi.mocked(appCompatibility).mockResolvedValue(compat("current", "b") as never);
    const stop = startBackendCompatibilityWatch(60_000);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const calls = vi.mocked(appCompatibility).mock.calls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(vi.mocked(appCompatibility).mock.calls.length).toBe(calls);
  });

  it("keeps the last state when a probe fails", async () => {
    vi.mocked(appCompatibility).mockResolvedValue(compat("version-skew", "old") as never);
    const stop = startBackendCompatibilityWatch(60_000);
    await vi.advanceTimersByTimeAsync(0);
    vi.mocked(appCompatibility).mockRejectedValue(new Error("backend down"));
    await vi.advanceTimersByTimeAsync(60_000 + 300);
    expect(useBackendCompatibilityStore.getState().compatibility?.mode).toBe("version-skew");
    stop();
  });
});
