import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_CONTROL_SEQUENCE,
  terminalKeyAction,
  type TerminalKeyEvent,
} from "@/lib/terminal/interaction/terminalKeyBindings";

const i18n = vi.hoisted(() => ({
  t: vi.fn((key: string) => key),
}));

vi.mock("@/lib/i18n", () => ({ t: i18n.t }));

const event = (over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
  key: "a",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

describe("terminalKeyAction — 기본값", () => {
  it("⌘C는 복사", () => {
    expect(terminalKeyAction(event({ metaKey: true, key: "c" }), {})).toBe("copy");
  });

  it("resolves a bindable terminal key without rebuilding display copy", () => {
    i18n.t.mockClear();
    const action = terminalKeyAction(event({ metaKey: true, key: "c" }), {});

    expect({ action, translationLookups: i18n.t.mock.calls.length }).toEqual({
      action: "copy",
      translationLookups: 0,
    });
  });

  it("⌘⌫ / ⌘← / ⌘→ 는 각각 줄 삭제·줄 처음·줄 끝", () => {
    expect(terminalKeyAction(event({ metaKey: true, key: "Backspace" }), {})).toBe("kill-line");
    expect(terminalKeyAction(event({ metaKey: true, key: "ArrowLeft" }), {})).toBe("bol");
    expect(terminalKeyAction(event({ metaKey: true, key: "ArrowRight" }), {})).toBe("eol");
  });

  it("⌥⌫ 는 단어 삭제", () => {
    expect(terminalKeyAction(event({ altKey: true, key: "Backspace" }), {})).toBe("kill-word");
  });

  it("평범한 타이핑은 그대로 터미널로 넘긴다", () => {
    expect(terminalKeyAction(event({ key: "a" }), {})).toBeNull();
    expect(terminalKeyAction(event({ key: "Backspace" }), {})).toBeNull();
  });

  it("skips the display catalog for ordinary and IME keydowns", () => {
    i18n.t.mockClear();
    const actions = [
      terminalKeyAction(event({ key: "a" }), {}),
      terminalKeyAction(event({ key: "Process" }), {}),
    ];

    expect({ actions, translationLookups: i18n.t.mock.calls.length }).toEqual({
      actions: [null, null],
      translationLookups: 0,
    });
  });

  it("수정 키가 섞이면 가로채지 않는다 — ⌘⇧C는 복사가 아니다", () => {
    expect(terminalKeyAction(event({ metaKey: true, shiftKey: true, key: "c" }), {})).toBeNull();
    expect(terminalKeyAction(event({ metaKey: true, altKey: true, key: "c" }), {})).toBeNull();
  });
});

describe("terminalKeyAction — 재지정", () => {
  it("재지정한 조합으로 옮겨간다", () => {
    const overrides = { "term-copy": { mod: true, shift: true, alt: false, key: "c" } };
    expect(terminalKeyAction(event({ metaKey: true, shiftKey: true, key: "c" }), overrides))
      .toBe("copy");
    // 옛 조합은 더 이상 가로채지 않는다 — 그대로 셸로 간다.
    expect(terminalKeyAction(event({ metaKey: true, key: "c" }), overrides)).toBeNull();
  });

  it("할당을 해제하면 그 키가 셸로 돌아간다", () => {
    expect(terminalKeyAction(event({ metaKey: true, key: "c" }), { "term-copy": null }))
      .toBeNull();
  });

  it("다른 항목의 재지정은 서로 간섭하지 않는다", () => {
    const overrides = { "term-copy": null };
    expect(terminalKeyAction(event({ metaKey: true, key: "ArrowLeft" }), overrides)).toBe("bol");
  });
});

describe("TERMINAL_CONTROL_SEQUENCE", () => {
  it("각 동작이 관례적인 제어문자로 간다", () => {
    expect(TERMINAL_CONTROL_SEQUENCE["kill-line"]).toBe("\x15"); // ^U
    expect(TERMINAL_CONTROL_SEQUENCE.bol).toBe("\x01"); // ^A
    expect(TERMINAL_CONTROL_SEQUENCE.eol).toBe("\x05"); // ^E
    expect(TERMINAL_CONTROL_SEQUENCE["kill-word"]).toBe("\x17"); // ^W
  });
});

describe("Ctrl은 터미널의 것이다 (3차 리뷰: SIGINT 회귀)", () => {
  it("Ctrl+C를 복사로 가로채지 않는다 — SIGINT가 셸에 닿아야 한다", () => {
    expect(terminalKeyAction(event({ ctrlKey: true, key: "c" }), {})).toBeNull();
  });

  it("Ctrl+← / Ctrl+→ 는 단어 이동이라 건드리지 않는다", () => {
    expect(terminalKeyAction(event({ ctrlKey: true, key: "ArrowLeft" }), {})).toBeNull();
    expect(terminalKeyAction(event({ ctrlKey: true, key: "ArrowRight" }), {})).toBeNull();
  });

  it("Ctrl+⌫ 는 단어 삭제라 줄 삭제로 바꾸지 않는다", () => {
    expect(terminalKeyAction(event({ ctrlKey: true, key: "Backspace" }), {})).toBeNull();
  });

  it("⌘와 Ctrl을 동시에 눌러도 가로채지 않는다 (기존 !ctrlKey 조건과 동일)", () => {
    expect(terminalKeyAction(event({ metaKey: true, ctrlKey: true, key: "c" }), {})).toBeNull();
  });

  it("Ctrl을 막아도 ⌘ 조합은 그대로 동작한다", () => {
    expect(terminalKeyAction(event({ metaKey: true, key: "c" }), {})).toBe("copy");
  });
});
