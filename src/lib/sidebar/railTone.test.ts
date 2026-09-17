import { describe, expect, it } from "vitest";
import { RAIL_ICON_SIZE, RAIL_ITEM_BASE, railItemSurface } from "@/lib/sidebar/railTone";

describe("railItemSurface", () => {
  // 흰 면 + 테두리 + 그림자를 겹치면 아이콘 하나만 웹앱 버튼처럼 튀어나온다.
  // macOS 사이드바의 선택은 반대로 배경보다 한 단 진한 파인 면이다.
  // 유리 밝기가 모드마다 반대라 활성 표시도 갈린다: 라이트 유리는 거의 흰색이라
  // 틴트가 안 읽히고 흰 면이 읽히며, 다크는 그 반대다. 공통으로 금지되는 건
  // 그림자다 — 2026-08-01에 "웹앱 버튼처럼 튀어나온다"의 원인이 그것이었다.
  it("활성 표시는 라이트=흰 면, 다크=틴트로 갈리고 그림자는 쓰지 않는다", () => {
    const surface = railItemSurface(true);
    expect(surface).toContain("bg-glass-pane/75");
    expect(surface).toContain("dark:bg-foreground/[0.13]");
    expect(surface).not.toContain("shadow");
  });

  it("비활성 항목은 표면이 없고 호버에서만 틴트가 얹힌다", () => {
    const surface = railItemSurface(false);
    expect(surface).not.toContain("bg-glass-pane");
    expect(surface).toContain("hover:bg-glass-tint-hover");
  });

  // 활성 칩이 흰 카드에서 파인 틴트로 바뀐 뒤(2026-08-01) 표면만으로는 선택이
  // 약하게 읽혀, 아이콘 색까지 위계를 싣는다(소유자 결정, 2026-08-02).
  // 시안(2070:32039 라이트 #0A0A0A / 2072:33537 다크 #FAFAFA)은 비활성도
  // foreground로 내보내므로 이 테스트가 "시안대로" 되돌리는 것을 막는다.
  it("활성 아이콘은 foreground, 비활성은 보조 텍스트 색으로 갈린다", () => {
    expect(railItemSurface(true)).toContain("text-sidebar-foreground");
    expect(railItemSurface(false)).toContain("text-muted-foreground");
  });

  // 틴트만 얹히고 글리프는 그대로면 가리키는 대상이 반응하지 않는 것처럼 보인다.
  it("비활성 항목은 호버에서 아이콘 색이 foreground로 돌아온다", () => {
    expect(railItemSurface(false)).toContain("hover:text-sidebar-foreground");
  });

  // 접힘 전용 변형은 없앴다. 시안 2070:32039(라이트)·2072:33537(다크) 어느
  // 쪽에도 접힘용 활성 표시가 따로 없고, 화면에서는 접을 때마다 아이콘
  // 배경만 어두워지는 깜빡임으로 읽혔다. 표면이 --background로 내려가면
  // 그 회귀다.
  it("접혀도 활성 칩은 그대로다 — 배경이 어두워지지 않는다", () => {
    const surface = railItemSurface(true);
    expect(surface).toContain("bg-glass-pane/75");
    expect(surface).toContain("dark:bg-foreground/[0.13]");
    // "bg-background"는 예전 접힘 분기가 쓰던 값이다. bg-glass-pane 같은
    // 다른 토큰의 부분 문자열이 아니므로 단어 경계로 정확히 본다.
    expect(surface).not.toMatch(/(^|\s)bg-background(\s|$)/);
  });

  // 하드코딩 hex는 라이트에서만 맞고 다크에서 어긋난다 — 토큰만 쓰는 게 계약이다.
  it("어느 상태도 hex를 직접 쓰지 않는다", () => {
    expect(railItemSurface(true)).not.toMatch(/#[0-9a-f]{3,8}/i);
    expect(railItemSurface(false)).not.toMatch(/#[0-9a-f]{3,8}/i);
  });

  it("기하는 디자인 값(36px 박스 / 8px 라운드 / 16px 아이콘)을 유지한다", () => {
    expect(RAIL_ITEM_BASE).toContain("size-9");
    expect(RAIL_ITEM_BASE).toContain("rounded-md");
    expect(RAIL_ICON_SIZE).toBe("size-4");
  });
});
