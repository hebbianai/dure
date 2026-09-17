import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_SAVE_MAX_DELAY_MS,
  AUTO_SAVE_MIN_DELAY_MS,
  createAutoSaveScheduler,
  normalizeAutoSaveDelay,
} from "@/lib/settings/autoSave";

describe("normalizeAutoSaveDelay", () => {
  it("정상 값은 그대로 쓴다", () => {
    expect(normalizeAutoSaveDelay(1000, 1000)).toBe(1000);
  });

  it("빈 값·NaN은 기본값으로 되돌린다", () => {
    expect(normalizeAutoSaveDelay("", 1000)).toBe(1000);
    expect(normalizeAutoSaveDelay(Number.NaN, 1000)).toBe(1000);
    expect(normalizeAutoSaveDelay(undefined, 1000)).toBe(1000);
  });

  it("0이나 음수를 넣어도 한 글자마다 저장하지는 않는다", () => {
    expect(normalizeAutoSaveDelay(0, 1000)).toBe(AUTO_SAVE_MIN_DELAY_MS);
    expect(normalizeAutoSaveDelay(-500, 1000)).toBe(AUTO_SAVE_MIN_DELAY_MS);
  });

  it("과하게 큰 값은 상한에서 멈춘다", () => {
    expect(normalizeAutoSaveDelay(10 ** 9, 1000)).toBe(AUTO_SAVE_MAX_DELAY_MS);
  });

  it("소수점은 정수 ms로 반올림한다", () => {
    expect(normalizeAutoSaveDelay(1500.6, 1000)).toBe(1501);
  });
});

describe("createAutoSaveScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("조용해진 뒤에야 저장한다", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    s.schedule();
    vi.advanceTimersByTime(999);
    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("타이핑이 이어지면 저장이 계속 뒤로 밀린다", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    for (let i = 0; i < 10; i++) {
      s.schedule();
      vi.advanceTimersByTime(500);
    }
    expect(onSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("cancel하면 저장하지 않는다", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    s.schedule();
    s.cancel();
    vi.advanceTimersByTime(5000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("flush는 예약된 저장을 지금 실행하고 타이머를 없앤다", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    s.schedule();
    s.flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("예약이 없을 때 flush는 아무 일도 하지 않는다 — 수동 저장 직후 중복 저장 방지", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    s.flush();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("pending이 예약 상태를 그대로 보여준다", () => {
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave: () => {} });
    expect(s.pending()).toBe(false);
    s.schedule();
    expect(s.pending()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(s.pending()).toBe(false);
  });

  it("dispose 후에는 새 예약을 받지 않는다 — 언마운트된 pane이 저장하지 않게", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 1000, onSave });
    s.schedule();
    s.dispose();
    s.schedule();
    vi.advanceTimersByTime(5000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("잘못된 지연값도 하한으로 다듬어 동작한다", () => {
    const onSave = vi.fn();
    const s = createAutoSaveScheduler({ delayMs: 0, onSave });
    s.schedule();
    vi.advanceTimersByTime(AUTO_SAVE_MIN_DELAY_MS);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("주입한 타이머를 쓴다", () => {
    const setTimer = vi.fn(() => 7);
    const clearTimer = vi.fn();
    const s = createAutoSaveScheduler({
      delayMs: 1000,
      onSave: () => {},
      setTimer,
      clearTimer,
    });
    s.schedule();
    expect(setTimer).toHaveBeenCalledWith(expect.any(Function), 1000);
    s.cancel();
    expect(clearTimer).toHaveBeenCalledWith(7);
  });
});
