import { describe, expect, it } from "vitest";
import {
  KEY_CATEGORIES,
  TERMINAL_KEYS,
  pressKey,
  terminalKey,
} from "./terminalKeys";

describe("terminal keys", () => {
  /** A finger cannot hold Ctrl and press C, so a modifier arms the next press. */
  it("arms a modifier instead of sending it", () => {
    expect(pressKey("ctrl", undefined)).toEqual({
      intent: undefined,
      armed: "ctrl",
    });
    expect(pressKey("alt", undefined)).toEqual({
      intent: undefined,
      armed: "alt",
    });
  });

  /**
   * A modifier that stays on turns the next ordinary key into something
   * destructive — press Ctrl, change your mind, press D, and the session ends.
   */
  it("disarms after one press", () => {
    const fired = pressKey("tab", "ctrl");

    expect(fired.intent).toMatchObject({
      kind: "key",
      key: "Tab",
      ctrlKey: true,
    });
    expect(fired.armed).toBeUndefined();
  });

  it("lets a second press of the same modifier take it back", () => {
    expect(pressKey("ctrl", "ctrl").armed).toBeUndefined();
    expect(pressKey("alt", "alt").armed).toBeUndefined();
  });

  /**
   * Only one modifier can ride the next key, so pressing the other replaces it.
   * Two flags could say both are armed, which is a state no press produces.
   */
  it("lets one modifier replace the other", () => {
    expect(pressKey("alt", "ctrl").armed).toBe("alt");
    expect(pressKey("ctrl", "alt").armed).toBe("ctrl");
  });

  /**
   * 구조화 attach 는 바이트를 받지 않는다 — 이름 붙은 키와 텍스트를 받는다.
   * 두 표현을 여기서 함께 만들어야, 경계에서 이스케이프 시퀀스를 거꾸로 읽어
   * 키를 추측하는 일이 생기지 않는다.
   */
  describe("intent", () => {
    it("이름 있는 키는 그 이름으로 간다", () => {
      expect(pressKey("esc", undefined).intent).toEqual({
        kind: "key",
        key: "Escape",
        code: "Escape",
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      });
      // ⇧Tab 의 shift 는 걸어 둔 수식자가 아니라 키의 일부다.
      expect(pressKey("shift-tab", undefined).intent).toMatchObject({
        key: "Tab",
        shiftKey: true,
      });
      expect(pressKey("up", undefined).intent).toMatchObject({
        key: "ArrowUp",
      });
      expect(pressKey("f5", undefined).intent).toMatchObject({ key: "F5" });
    });

    /**
     * 호스트는 **`code`** 로 키를 찾는다 — `key` 는 그 키가 만들어 낸 글자일
     * 뿐이다. 빈 `code` 는 어떤 키도 가리키지 못하고, 이름 붙은 키(Esc, 화살표,
     * ⇧Tab)는 글자도 없으므로 누름 자체가 거부된다. 서랍의 캡 스물넷이 전부
     * 그렇게 조용히 막혀 있었다(2026-09-03 사용자 보고).
     */
    it("이름 붙은 키는 물리 키 이름까지 들고 간다", () => {
      // 서랍은 이제 어휘 전체를 그리므로, 이름 붙은 키 전부를 본다.
      const codes = TERMINAL_KEYS.filter((key) => key.key !== undefined).map((key) => {
        const intent = pressKey(key.id, undefined).intent;
        return [key.id, intent?.kind === "key" ? intent.code : ""] as const;
      });

      expect(codes.filter(([, code]) => code === "")).toEqual([]);
      expect(Object.fromEntries(codes)).toMatchObject({
        esc: "Escape",
        up: "ArrowUp",
        "shift-tab": "Tab",
        // 글자를 내는 키의 물리 이름은 그 글자가 아니다.
        "ctrl-c": "KeyC",
        "ctrl-backslash": "Backslash",
        "alt-backspace": "Backspace",
        pgup: "PageUp",
      });
    });

    it("^C 는 c 에 ctrl 이 붙은 것이다", () => {
      expect(pressKey("ctrl-c", undefined).intent).toMatchObject({
        key: "c",
        ctrlKey: true,
      });
      expect(pressKey("alt-b", undefined).intent).toMatchObject({
        key: "b",
        altKey: true,
      });
    });

    /**
     * `?` 는 키가 아니라 글자다. `shouldSendTerminalKey` 가 수식자 없는 한 글자
     * 키를 떨어뜨리므로, 텍스트로 가야 도착한다.
     */
    it("이름 없는 인쇄 가능한 키는 텍스트로 간다", () => {
      expect(pressKey("question", undefined).intent).toEqual({
        kind: "text",
        text: "?",
      });
      expect(pressKey("slash", undefined).intent).toEqual({
        kind: "text",
        text: "/",
      });
    });

    it("수식자를 걸면 그 글자도 키가 된다", () => {
      expect(pressKey("slash", "ctrl").intent).toEqual({
        kind: "key",
        key: "/",
        // `/` 는 그 키를 그냥 눌러서 나오는 글자다.
        code: "Slash",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
      });
      // `?` 는 같은 키에 Shift 를 얹은 것이다. Shift 없이 `Slash` 라고 말하면
      // 물음표 대신 빗금이 나가므로, 글자만 들고 간다.
      expect(pressKey("question", "ctrl").intent).toMatchObject({
        key: "?",
        code: "",
      });
    });

    /** 수식자 자체를 누르는 것은 보내는 것이 아니라 거는 것이다. */
    it("수식자 누름은 아무 intent 도 만들지 않는다", () => {
      expect(pressKey("ctrl", undefined).intent).toBeUndefined();
      expect(pressKey("alt", undefined).intent).toBeUndefined();
    });
  });

  it("keeps every id unique, because saved trays name them", () => {
    const ids = TERMINAL_KEYS.map((key) => key.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(terminalKey("nope")).toBeUndefined();
  });

  /**
   * A picker where the same chip appears under two tabs makes the person
   * wonder whether they are two different keys.
   */
  it("puts every key under exactly one tab, and leaves no tab empty", () => {
    const known = new Set(KEY_CATEGORIES.map((tab) => tab.id));

    for (const key of TERMINAL_KEYS) {
      expect(known.has(key.category)).toBe(true);
    }
    for (const tab of KEY_CATEGORIES) {
      expect(TERMINAL_KEYS.some((key) => key.category === tab.id)).toBe(true);
    }
  });

  it("names every function key directly", () => {
    expect(pressKey("f1", undefined).intent).toMatchObject({
      key: "F1",
      code: "F1",
    });
    expect(pressKey("f5", undefined).intent).toMatchObject({
      key: "F5",
      code: "F5",
    });
    expect(pressKey("f12", undefined).intent).toMatchObject({
      key: "F12",
      code: "F12",
    });
  });
});
