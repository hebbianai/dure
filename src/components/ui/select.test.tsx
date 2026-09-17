// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it } from "vitest"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select"

beforeAll(() => {
  // Radix Select는 포인터 캡처와 scrollIntoView를 부르는데 jsdom엔 둘 다 없다.
  const proto = window.Element.prototype as unknown as Record<string, unknown>
  proto.hasPointerCapture ??= () => false
  proto.setPointerCapture ??= () => {}
  proto.releasePointerCapture ??= () => {}
  proto.scrollIntoView ??= () => {}
})

function renderOpenSelect() {
  return render(
    <Select defaultOpen defaultValue="recent">
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="recent">가장 최근</SelectItem>
        <SelectItem value="manual">탭 스트립 순서</SelectItem>
        <SelectItem value="name">이름</SelectItem>
      </SelectContent>
    </Select>
  )
}

describe("SelectContent", () => {
  it("항목을 트리거 높이로 자르지 않는다", () => {
    renderOpenSelect()
    // popper 모드에서 뷰포트에 트리거 높이를 강제하면 첫 줄만 보이고 나머지가
    // 잘린다. 세 항목이 모두 살아 있어야 한다.
    for (const label of ["가장 최근", "탭 스트립 순서", "이름"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }

    const viewport = document.querySelector("[data-position='popper']")
    expect(viewport?.className ?? "").not.toContain("select-trigger-height")
  })

  it("메뉴 폭을 트리거(인풋)에 맞춘다", () => {
    renderOpenSelect()
    const content = document.querySelector("[data-slot='select-content']")
    const className = content?.className ?? ""
    expect(className).toContain("w-(--radix-select-trigger-width)")
    // min-w-36(144px)이 남아 있으면 트리거가 그보다 좁을 때 메뉴가 더 넓어진다.
    expect(className).not.toContain("min-w-36")
  })

  it("항목은 시안 치수(13px 글자·6px 라운드·12px 아이콘)를 쓴다", () => {
    renderOpenSelect()
    const item = document.querySelector("[data-slot='select-item']")
    const className = item?.className ?? ""
    // text-xs는 이 앱에서 13px이다(index.css --text-xs: 0.8125rem).
    expect(className).toContain("text-xs")
    expect(className).toContain("rounded-sm")
    expect(className).toContain("py-1")
    expect(className).toContain("[&_svg]:size-3")
    // 둘 다 옛 값의 접두사다 — 짝이 없으면 되돌려도 통과한다.
    expect(className).not.toContain("py-1.5")
    expect(className).not.toContain("[&_svg]:size-3.5")
    // hover는 --accent가 아니라 glass/menu-hover다.
    expect(className).toContain("focus:bg-glass-menu-hover")
    expect(className).not.toContain("bg-accent")
  })
})
