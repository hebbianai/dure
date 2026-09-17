// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  nativeWindowTheme,
  nativeWindowTitle,
  useNativeWindowTheme,
} from "@/lib/platform/windowAppearance";

const { setTheme, setNativeTitleBarColors, resolvedDark, resolvedColors } = vi.hoisted(() => ({
  setTheme: vi.fn(),
  setNativeTitleBarColors: vi.fn(),
  resolvedDark: vi.fn(),
  resolvedColors: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme }),
}));
vi.mock("@/lib/ipc/system", () => ({ setNativeTitleBarColors }));
vi.mock("@/lib/theme/themePreference", () => ({
  useResolvedDark: resolvedDark,
  useResolvedUiSurfaceColors: resolvedColors,
}));

describe("native window appearance", () => {
  beforeEach(() => {
    setTheme.mockReset().mockResolvedValue(undefined);
    setNativeTitleBarColors.mockReset().mockResolvedValue(undefined);
    resolvedDark.mockReset().mockReturnValue(false);
    resolvedColors.mockReset().mockReturnValue({
      background: "#ffffff",
      foreground: "#0d0d0d",
    });
  });

  it("앱 테마를 창 외형 값으로 옮긴다", () => {
    expect(nativeWindowTheme(true)).toBe("dark");
    expect(nativeWindowTheme(false)).toBe("light");
  });

  it("라이트 테마면 창 외형도 라이트다 — 시스템이 다크여도", async () => {
    // 시스템 다크 + 앱 라이트에서 창 외형을 시스템에 맡기면 vibrancy material이
    // 어둡게 깔려 사이드바가 검게 보인다.
    renderHook(() => useNativeWindowTheme());
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("light"));
  });

  it("다크 테마면 창 외형도 다크다", async () => {
    resolvedDark.mockReturnValue(true);
    renderHook(() => useNativeWindowTheme());
    await waitFor(() => expect(setTheme).toHaveBeenCalledWith("dark"));
  });

  it("Windows caption에서는 앱 이름을 숨기고 유용한 창 제목만 남긴다", () => {
    expect(nativeWindowTitle("Dure", "windows")).toBe("");
    expect(nativeWindowTitle("Dure — UI polish", "windows")).toBe("UI polish");
    expect(nativeWindowTitle("Durely", "windows")).toBe("Durely");
    expect(nativeWindowTitle("Dure — UI polish", "macos")).toBe("Dure — UI polish");
  });

  it("Windows 네이티브 제목 표시줄을 앱 기본 표면색과 맞춘다", async () => {
    resolvedColors.mockReturnValue({
      background: "#0a1628",
      foreground: "#f4f7fb",
    });

    renderHook(() => useNativeWindowTheme());

    await waitFor(() =>
      expect(setNativeTitleBarColors).toHaveBeenCalledWith("#0a1628", "#f4f7fb"),
    );
  });

  it("실패해도 앱은 계속 돈다 — material이 시스템을 따를 뿐이다", async () => {
    setTheme.mockRejectedValue(new Error("no such window"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderHook(() => useNativeWindowTheme());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });
});
