import { describe, expect, it } from "vitest";
import {
  desktopAddButtonClass,
  desktopBarClass,
  desktopTabClass,
  desktopTabNumberClass,
  desktopTabStripClass,
} from "@/lib/workspace/desktop/desktopTabStyle";

const ALL = [
  desktopBarClass,
  desktopTabStripClass,
  desktopTabClass(true),
  desktopTabClass(false),
  desktopTabNumberClass,
  desktopAddButtonClass,
];

describe("desktopTabStyle", () => {
  it("활성 탭은 배경 칩이 아니라 글자색+굵기로만 구분한다", () => {
    const active = desktopTabClass(true);
    expect(active).toContain("text-foreground");
    expect(active).toContain("font-medium");
    // 시안의 활성 트리거에는 채워진 배경이 없다 — hover 틴트도 활성에는 없다.
    expect(active).not.toMatch(/(^|\s)(hover:)?bg-/);
  });

  it("비활성 탭은 muted이고 hover에서만 glass 틴트가 올라온다", () => {
    const inactive = desktopTabClass(false);
    expect(inactive).toContain("text-muted-foreground");
    expect(inactive).toContain("hover:bg-glass-tint-hover");
    expect(inactive).not.toContain("font-medium");
  });

  it("두 상태의 기하(높이·radius·여백)는 동일하다", () => {
    const geometry = ["h-6", "rounded-sm", "px-2", "text-xs"];
    for (const token of geometry) {
      expect(desktopTabClass(true).split(" ")).toContain(token);
      expect(desktopTabClass(false).split(" ")).toContain(token);
    }
  });

  it("탭 스트립은 44px 줄의 기하 중심에서 1px 아래에 선다 — 시각 보정", () => {
    // 아래 pane 카드에 대고 보면 글자가 떠 보인다는 소유자 지적(2026-09-10).
    // transform이라 정수 픽셀만 움직이고, margin처럼 반픽셀 중심이 되지 않는다.
    expect(desktopTabStripClass.split(" ")).toContain("translate-y-px");
  });

  it("탭 스트립은 자기 표면을 갖지 않는다 — 창 최상단 줄의 일부다", () => {
    // 시안(2070:32171 + default-light 전체 렌더)에서 데스크탑 탭은 별도 줄이
    // 아니라 워드마크 오른쪽으로 이어지는 같은 줄이다. 그래서 높이·배경·
    // 경계선은 WindowTitleBar가 소유하고 여기는 남은 폭만 쓴다. 이 중 하나라도
    // 되살아나면 창 최상단에 시안에 없는 두 번째 바가 생긴다.
    for (const surface of ["bg-", "border-b", "border-t", "h-["]) {
      expect(desktopBarClass).not.toContain(surface);
    }
    expect(desktopBarClass).toContain("flex-1");
  });

  it("탭 스트립은 pane 카드의 안쪽 모서리에서 시작한다", () => {
    // 첫 탭의 글자가 아래 pane 헤더의 글리프와 같은 x에 서려면, 스트립이
    // 워크스페이스 열의 카드 여백(--workspace-inset) + 카드 패딩 1px에서
    // 시작하고 탭의 px-2가 헤더의 pl-2를 되풀이해야 한다 (2026-09-09).
    expect(desktopBarClass).toContain("pl-[calc(var(--workspace-inset,4px)+5px)]");
    expect(desktopBarClass).not.toMatch(/\bpl-4\b/);
  });

  it("'+' 어포던스는 탭과 같은 radius·hover 틴트를 쓴다", () => {
    expect(desktopAddButtonClass).toContain("rounded-sm");
    expect(desktopAddButtonClass).toContain("hover:bg-glass-tint-hover");
  });

  it("번호는 이름과 같은 색을 쓰되 폭만 고정한다", () => {
    expect(desktopTabNumberClass).toContain("tabular-nums");
    expect(desktopTabNumberClass).not.toContain("text-");
  });

  it("어떤 클래스도 토큰 대신 하드코딩 색을 쓰지 않는다", () => {
    for (const cls of ALL) {
      expect(cls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(cls).not.toMatch(/\b(?:bg|text|border)-\[/);
    }
  });
});
