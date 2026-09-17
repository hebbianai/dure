import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  desktopConstructionPending,
  resetDesktopConstructionLedgerForTest,
  subscribeDesktopConstruction,
  trackDesktopTerminalConstruction,
} from "./desktopConstructionLedger";

describe("desktopConstructionLedger", () => {
  beforeEach(() => {
    resetDesktopConstructionLedgerForTest();
  });

  it("등록 구간 동안만 pending이고 데스크탑별로 격리된다", () => {
    const done = trackDesktopTerminalConstruction("d1", "t1");
    expect(desktopConstructionPending("d1")).toBe(true);
    expect(desktopConstructionPending("d2")).toBe(false);
    done();
    expect(desktopConstructionPending("d1")).toBe(false);
  });

  it("여러 pane 중 마지막 완료에서만 pending이 풀린다", () => {
    const first = trackDesktopTerminalConstruction("d1", "t1");
    const second = trackDesktopTerminalConstruction("d1", "t2");
    first();
    expect(desktopConstructionPending("d1")).toBe(true);
    second();
    expect(desktopConstructionPending("d1")).toBe(false);
  });

  it("구독자는 등록·해제에서 통지되고 dispose는 멱등이다", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeDesktopConstruction("d1", listener);
    const done = trackDesktopTerminalConstruction("d1", "t1");
    done();
    done();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    trackDesktopTerminalConstruction("d1", "t2");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
