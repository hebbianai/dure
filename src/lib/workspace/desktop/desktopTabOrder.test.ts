import { describe, expect, it } from "vitest";
import {
  allowsManualReorder,
  orderDesktopTabs,
  recordDesktopVisit,
} from "@/lib/workspace/desktop/desktopTabOrder";

const spaces = [{ id: "a" }, { id: "b" }, { id: "c" }];

describe("orderDesktopTabs", () => {
  it("수동 모드는 배열을 그대로(같은 참조로) 돌려준다", () => {
    expect(orderDesktopTabs(spaces, "manual", { a: 3, b: 1 })).toBe(spaces);
  });

  it("최근순 모드는 마지막 방문이 늦은 탭을 앞으로 보낸다", () => {
    const out = orderDesktopTabs(spaces, "recent", { a: 10, b: 30, c: 20 });
    expect(out.map((d) => d.id)).toEqual(["b", "c", "a"]);
  });

  it("방문 기록이 없는 탭은 수동 순서를 지킨 채 뒤에 붙는다", () => {
    const out = orderDesktopTabs(spaces, "recent", { b: 5 });
    expect(out.map((d) => d.id)).toEqual(["b", "a", "c"]);
  });

  it("방문 시각이 같으면 수동 순서로 안정 정렬한다", () => {
    const out = orderDesktopTabs(spaces, "recent", { a: 7, b: 7, c: 7 });
    expect(out.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("기록이 하나도 없으면 원래 순서 그대로", () => {
    expect(orderDesktopTabs(spaces, "recent", {}).map((d) => d.id)).toEqual(["a", "b", "c"]);
  });

  it("탭이 하나 이하면 정렬하지 않는다", () => {
    const one = [{ id: "a" }];
    expect(orderDesktopTabs(one, "recent", { a: 1 })).toBe(one);
    expect(orderDesktopTabs([], "recent", {})).toEqual([]);
  });

  it("기록에만 있고 목록에 없는 id는 무시한다", () => {
    const out = orderDesktopTabs(spaces, "recent", { zzz: 999, c: 1 });
    expect(out.map((d) => d.id)).toEqual(["c", "a", "b"]);
  });
});

describe("recordDesktopVisit", () => {
  it("방문 시각을 남긴다", () => {
    expect(recordDesktopVisit({}, "a", 100, ["a", "b"])).toEqual({ a: 100 });
  });

  it("다시 방문하면 시각을 덮어쓴다", () => {
    expect(recordDesktopVisit({ a: 100 }, "a", 200, ["a"])).toEqual({ a: 200 });
  });

  it("사라진 데스크탑의 기록은 버린다 — 저장소가 계속 자라지 않게", () => {
    const next = recordDesktopVisit({ a: 1, gone: 2 }, "b", 300, ["a", "b"]);
    expect(next).toEqual({ a: 1, b: 300 });
  });

  it("목록에 아직 안 올라온 데스크탑을 방문해도 그 기록은 남긴다", () => {
    // addSpace 직후처럼 live 목록이 한 틱 늦게 오는 경우.
    expect(recordDesktopVisit({}, "new", 400, [])).toEqual({ new: 400 });
  });
});

describe("allowsManualReorder", () => {
  it("수동 모드에서만 끌어다 놓기를 허용한다", () => {
    expect(allowsManualReorder("manual")).toBe(true);
    expect(allowsManualReorder("recent")).toBe(false);
  });
});
