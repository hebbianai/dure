import { describe, expect, it } from "vitest"

import {
  MENU_ITEM_CHECKABLE_CLASS,
  MENU_ITEM_CLASS,
  MENU_ITEM_HOVER_CLASS,
  MENU_ITEM_INDICATOR_CLASS,
  MENU_ITEM_PLAIN_CLASS,
  MENU_LABEL_CLASS,
  MENU_SIDE_OFFSET,
  MENU_SURFACE_CLASS,
} from "@/lib/ui/menuSurface"

describe("menuSurface", () => {
  it("트리거 바로 아래 4px에 메뉴를 연다", () => {
    expect(MENU_SIDE_OFFSET).toBe(4)
  })

  it("패널은 10px 라운드에 1px hairline을 쓴다", () => {
    // rounded-lg가 --radius 원값(10px)이다. rounded-md는 그 0.8배인 8px.
    expect(MENU_SURFACE_CLASS).toContain("rounded-lg")
    expect(MENU_SURFACE_CLASS).not.toContain("rounded-md")
    // 시안은 ring이 아니라 실제 테두리다 — 링은 레이아웃 밖에 그려진다.
    expect(MENU_SURFACE_CLASS).toContain("border border-glass-menu-hairline")
    expect(MENU_SURFACE_CLASS).not.toContain("ring")
  })

  it("패널은 불투명 popover가 아니라 유리 표면이다", () => {
    // 메뉴는 터미널 출력·다른 pane 위에 뜬다. 불투명 면으로 덮으면 아래
    // 맥락이 통째로 사라진다(시안 2332:36522: glass/menu + blur 15px).
    expect(MENU_SURFACE_CLASS).toContain("bg-glass-menu")
    expect(MENU_SURFACE_CLASS).not.toContain("bg-popover")
    expect(MENU_SURFACE_CLASS).toContain("backdrop-blur-[15px]")
    expect(MENU_SURFACE_CLASS).toContain("shadow-menu")
  })

  it("패널은 항목 둘레에 4px 여백을 준다", () => {
    expect(MENU_SURFACE_CLASS).toContain("p-1")
  })

  it("항목은 13px 글자(text-xs)에 4px 세로 여백, 6px 라운드다", () => {
    // text-xs는 이 앱에서 13px이다(index.css --text-xs: 0.8125rem).
    // 4+16+4 = 24px = 시안 419:4518의 hover pill 높이.
    expect(MENU_ITEM_CLASS).toContain("text-xs")
    expect(MENU_ITEM_CLASS).not.toContain("text-sm")
    expect(MENU_ITEM_CLASS).toContain("py-1")
    expect(MENU_ITEM_CLASS).not.toContain("py-1.5")
    expect(MENU_ITEM_CLASS).toContain("rounded-sm")
  })

  it("hover pill은 행을 꽉 채우지 않는다 — 위아래 2px을 비운다", () => {
    // 배경이 행을 꽉 채우면 연속한 항목이 한 덩어리로 읽힌다(시안 419:4518).
    expect(MENU_ITEM_CLASS).toContain("my-0.5")
  })

  it("hover 배경은 accent가 아니라 glass/menu-hover이고 글자색은 안 바뀐다", () => {
    // --accent는 앱 전역 hover라 다크에서 --popover 대비 5배 세게 찍힌다.
    expect(MENU_ITEM_HOVER_CLASS).toContain("focus:bg-glass-menu-hover")
    expect(MENU_ITEM_HOVER_CLASS).not.toContain("bg-accent")
    // 흐린 보조 텍스트(예: "Spaces에 유지")가 hover에서도 흐리게 남아야 한다.
    expect(MENU_ITEM_HOVER_CLASS).not.toContain("text-accent-foreground")
  })

  it("항목 아이콘은 12px이고, 호출부 크기 클래스가 이를 못 덮는다", () => {
    // 예외 없는 자손 선택자여야 한다 — :not([class*='size-'])로 빠져나갈 수
    // 있으면 호출부에 박힌 size-3.5/size-4가 토큰을 무력화한다.
    expect(MENU_ITEM_CLASS).toContain("[&_svg]:size-3")
    expect(MENU_ITEM_CLASS).not.toContain("size-3.5")
    expect(MENU_ITEM_CLASS).not.toContain(":not([class*='size-'])")
  })

  it("긴 라벨은 줄바꿈 대신 잘린다 — 행 높이를 균일하게 유지한다", () => {
    expect(MENU_ITEM_CLASS).toContain("whitespace-nowrap")
    expect(MENU_ITEM_CLASS).toContain("overflow-hidden")
  })

  it("체크 항목은 아이콘 자리를 비우고 체크는 그 자리에 온다", () => {
    // pr-8(32px) 안쪽에 right-2(8px) + size-3(12px)가 들어간다.
    expect(MENU_ITEM_CHECKABLE_CLASS).toContain("pr-8")
    expect(MENU_ITEM_CHECKABLE_CLASS).toContain("pl-2")
    expect(MENU_ITEM_INDICATOR_CLASS).toContain("right-2")
    expect(MENU_ITEM_INDICATOR_CLASS).toContain("size-3")
    // "size-3"은 "size-3.5"의 접두사라, 짝이 없으면 되돌려도 통과한다.
    expect(MENU_ITEM_INDICATOR_CLASS).not.toContain("size-3.5")
  })

  it("체크 없는 항목과 그룹 제목은 좌측 8px로 정렬을 맞춘다", () => {
    expect(MENU_ITEM_PLAIN_CLASS).toContain("px-2")
    expect(MENU_LABEL_CLASS).toContain("px-2")
  })
})
