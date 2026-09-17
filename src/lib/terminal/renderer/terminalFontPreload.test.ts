// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { preloadTerminalFont } from "@/lib/terminal/renderer/terminalFontPreload";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preloadTerminalFont", () => {
  it("커스텀 계열을 fonts.load로 선요청한다", () => {
    const load = vi.fn().mockResolvedValue([]);
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    preloadTerminalFont("JetBrains Mono");
    expect(load).toHaveBeenCalledWith('12px "JetBrains Mono"');
  });

  it("빈 계열(기본 스택)은 요청하지 않는다", () => {
    const load = vi.fn();
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    preloadTerminalFont("");
    expect(load).not.toHaveBeenCalled();
  });

  it("fonts API 부재·로드 실패에 무해하다", () => {
    Object.defineProperty(document, "fonts", { value: undefined, configurable: true });
    expect(() => preloadTerminalFont("Whatever")).not.toThrow();
    const load = vi.fn().mockRejectedValue(new Error("no such font"));
    Object.defineProperty(document, "fonts", { value: { load }, configurable: true });
    expect(() => preloadTerminalFont("Missing Font")).not.toThrow();
  });
});
