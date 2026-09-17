import { describe, expect, it } from "vitest";
import { composeReturnLayout } from "@/lib/workspace/window/popoutReturnLayout";

const grid = (marker: string) => ({ root: { data: marker } });

describe("composeReturnLayout", () => {
  it("지오메트리는 스냅샷, 패널 params는 현재 값을 쓴다", () => {
    const snapshot = {
      grid: grid("old-geometry"),
      panels: {
        a: { id: "a", params: { sessionId: "S1" } },
        b: { id: "b", params: { sessionId: "X" } },
      },
    };
    const current = {
      grid: grid("appended-geometry"),
      panels: {
        // 분리 중 재시작으로 세션이 갱신된 pane — 스냅샷 값으로 되감으면 안 된다
        a: { id: "a", params: { sessionId: "S2" } },
        b: { id: "b", params: { sessionId: "X" } },
      },
    };
    const composed = composeReturnLayout(snapshot, current) as typeof snapshot;
    expect(composed.grid).toEqual(grid("old-geometry"));
    expect(composed.panels.a.params).toEqual({ sessionId: "S2" });
  });

  it("패널 집합이 달라졌으면(추가/제거) null — append 폴백", () => {
    const snapshot = { panels: { a: {}, b: {} } };
    expect(composeReturnLayout(snapshot, { panels: { a: {}, b: {}, c: {} } })).toBeNull();
    expect(composeReturnLayout(snapshot, { panels: { a: {} } })).toBeNull();
  });

  it("형식이 어긋나면 null", () => {
    expect(composeReturnLayout(null, { panels: {} })).toBeNull();
    expect(composeReturnLayout({ panels: {} }, undefined)).toBeNull();
    expect(composeReturnLayout({}, { panels: {} })).toBeNull();
  });
});
