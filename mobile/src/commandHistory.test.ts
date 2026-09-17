import { describe, expect, it, vi } from "vitest";
import { type SentCommand, clear, load, save, withCommand } from "./commandHistory";

const NOW = 1_700_000_000_000;

function history(...texts: string[]): SentCommand[] {
  return texts.map((text, index) => ({ text, sentAtUnixMs: NOW - index }));
}

describe("commandHistory", () => {
  it("puts the newest command first", () => {
    expect(withCommand(history("git status"), "pnpm build", NOW)).toEqual([
      { text: "pnpm build", sentAtUnixMs: NOW },
      { text: "git status", sentAtUnixMs: NOW },
    ]);
  });

  /** A list where the same command appears four times is one you read past. */
  it("moves a repeat up instead of adding a copy", () => {
    const moved = withCommand(history("a", "b", "c"), "c", NOW);

    expect(moved.map((entry) => entry.text)).toEqual(["c", "a", "b"]);
  });

  it("trims, and drops a blank submit", () => {
    expect(withCommand([], "  ls  ", NOW)[0].text).toBe("ls");
    expect(withCommand(history("ls"), "   ", NOW).map((entry) => entry.text)).toEqual(["ls"]);
  });

  /**
   * An unbounded log would leave a permanent record of everything ever typed
   * from this phone. This is a convenience, not a shell history.
   */
  it("keeps the list bounded", () => {
    let kept: SentCommand[] = [];
    for (let index = 0; index < 40; index += 1) {
      kept = withCommand(kept, `command-${index}`, NOW + index);
    }

    expect(kept).toHaveLength(20);
    expect(kept[0].text).toBe("command-39");
  });

  it("answers with an empty list when the store is broken or blocked", () => {
    expect(load({ getItem: () => "not json" })).toEqual([]);
    expect(load({ getItem: () => JSON.stringify([{ text: 1 }]) })).toEqual([]);
    expect(
      load({
        getItem: () => {
          throw new Error("private mode");
        },
      }),
    ).toEqual([]);
  });

  it("round-trips through storage", () => {
    let written = "";
    save(history("ls"), { setItem: (_key, value) => (written = value) });

    expect(load({ getItem: () => written }).map((entry) => entry.text)).toEqual(["ls"]);
  });

  /** The command was already sent; only the memory of it is lost. */
  it("does not throw when the store refuses a write", () => {
    expect(() =>
      save(history("ls"), {
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });

  /**
   * 설정 → 터미널 → 최근 명령 지우기. The key itself goes, not an empty list
   * under it: a store that still holds `[]` is a store that still says this
   * phone used the feature.
   */
  it("clear는 키 자체를 지워 다음 load가 비어 있다", () => {
    const store = new Map<string, string>([["hebbian.commands.v1", JSON.stringify(history("ls"))]]);
    const removeItem = vi.fn((key: string) => {
      store.delete(key);
    });

    clear({ removeItem });

    expect(removeItem).toHaveBeenCalledWith("hebbian.commands.v1");
    expect(load({ getItem: (key) => store.get(key) ?? null })).toEqual([]);
  });

  it("저장소가 removeItem을 거부해도 던지지 않는다", () => {
    expect(() =>
      clear({
        removeItem: () => {
          throw new Error("private mode");
        },
      }),
    ).not.toThrow();
  });
});
