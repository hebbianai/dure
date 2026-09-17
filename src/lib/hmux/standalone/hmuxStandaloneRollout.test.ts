import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStandaloneOnce,
  HMUX_STANDALONE_OPT_OUT_KEY,
  hmuxStandaloneOptedOut,
  hmuxStandaloneReady,
  resetStandaloneCreateTracking,
} from "@/lib/hmux/standalone/hmuxStandaloneRollout";

beforeEach(() => {
  vi.unstubAllEnvs();
  localStorage.removeItem(HMUX_STANDALONE_OPT_OUT_KEY);
  localStorage.removeItem("hebbian.hmuxStandaloneOptOut.v1");
  resetStandaloneCreateTracking();
});

describe("새 로컬 터미널 런타임 선택", () => {
  it("새 비상 스위치는 Dure 이름으로만 기록한다", () => {
    expect(HMUX_STANDALONE_OPT_OUT_KEY).toBe("dure.hmuxStandaloneOptOut.v1");
  });

  it("기본은 Hmux — 비상 스위치가 꺼져 있다", () => {
    expect(hmuxStandaloneOptedOut()).toBe(false);
  });

  it("비상 스위치를 켜면 legacy로 되돌린다", async () => {
    localStorage.setItem(HMUX_STANDALONE_OPT_OUT_KEY, "1");
    expect(hmuxStandaloneOptedOut()).toBe(true);
    // 스위치가 켜져 있으면 백엔드 지원 여부를 묻지도 않는다.
    await expect(hmuxStandaloneReady()).resolves.toBe(false);
  });

  it("기존 Hebbian 스위치를 읽되 canonical key로 새로 쓰지는 않는다", () => {
    localStorage.setItem("hebbian.hmuxStandaloneOptOut.v1", "1");
    expect(hmuxStandaloneOptedOut()).toBe(true);
    expect(localStorage.getItem(HMUX_STANDALONE_OPT_OUT_KEY)).toBeNull();
  });

  it("canonical storage가 있으면 상충하는 legacy storage를 무시한다", () => {
    localStorage.setItem(HMUX_STANDALONE_OPT_OUT_KEY, "0");
    localStorage.setItem("hebbian.hmuxStandaloneOptOut.v1", "1");
    expect(hmuxStandaloneOptedOut()).toBe(false);
  });

  it("canonical env가 있으면 상충하는 legacy env를 무시한다", () => {
    vi.stubEnv("VITE_DURE_HMUX_STANDALONE", "1");
    vi.stubEnv("VITE_HEBBIAN_HMUX_STANDALONE", "0");
    expect(hmuxStandaloneOptedOut()).toBe(false);

    vi.stubEnv("VITE_DURE_HMUX_STANDALONE", "0");
    vi.stubEnv("VITE_HEBBIAN_HMUX_STANDALONE", "1");
    expect(hmuxStandaloneOptedOut()).toBe(true);
  });
});

describe("생성 요청 합치기", () => {
  it("같은 자리의 동시 요청은 한 번만 만든다 — StrictMode 이중 마운트 방지", async () => {
    let runs = 0;
    const create = () => {
      runs += 1;
      return Promise.resolve(`session-${runs}`);
    };

    const [first, second] = await Promise.all([
      createStandaloneOnce("term-desktop-1", create),
      createStandaloneOnce("term-desktop-1", create),
    ]);

    expect(runs).toBe(1);
    expect(first).toBe("session-1");
    expect(second).toBe("session-1");
  });

  it("자리가 다르면 각각 만든다 — 분할은 클릭마다 새 pane", async () => {
    let runs = 0;
    const create = () => {
      runs += 1;
      return Promise.resolve(runs);
    };

    await Promise.all([
      createStandaloneOnce("term-a", create),
      createStandaloneOnce("term-b", create),
    ]);

    expect(runs).toBe(2);
  });

  it("생성이 실패하면 기록을 비워 다시 시도할 수 있다", async () => {
    let runs = 0;
    const failing = () => {
      runs += 1;
      return Promise.reject(new Error("host unavailable"));
    };

    await expect(createStandaloneOnce("term-x", failing)).rejects.toThrow("host unavailable");
    await expect(createStandaloneOnce("term-x", failing)).rejects.toThrow("host unavailable");
    expect(runs).toBe(2);
  });
});
