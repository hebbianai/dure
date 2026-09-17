import { describe, expect, it } from "vitest";
import { frequentDesktopIds } from "@/lib/workspace/desktop/desktopVisitFrequency";

const visits = (ids: readonly string[]) =>
  ids.map((desktopId, index) => ({ desktopId, sequence: index + 1 }));

describe("frequentDesktopIds", () => {
  it("ranks by decayed visit count, most-visited first", () => {
    const result = frequentDesktopIds(
      visits(["a", "b", "a", "c", "a", "b"]),
      { limit: 2 },
    );
    expect(result).toEqual(["a", "b"]);
  });

  it("forgets stale habits — recent visits outweigh many old ones", () => {
    // 오래된 a 방문 다수 vs 최근 b 집중 방문: 감쇠로 b가 이겨야 한다.
    const result = frequentDesktopIds(
      visits(["a", "a", "a", "a", "b", "b", "b", "b", "b", "b"]),
      { limit: 1, decay: 0.5 },
    );
    expect(result).toEqual(["b"]);
  });

  it("excludes requested ids and respects the limit", () => {
    const result = frequentDesktopIds(
      visits(["a", "b", "a", "c", "a"]),
      { exclude: ["a"], limit: 1 },
    );
    expect(result).toEqual(["c"]);
  });

  it("returns nothing for empty history or zero limit", () => {
    expect(frequentDesktopIds([], {})).toEqual([]);
    expect(frequentDesktopIds(visits(["a"]), { limit: 0 })).toEqual([]);
  });
});
