// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";

const chevronOf = (container: HTMLElement) =>
  container.firstElementChild as SVGElement;

describe("DisclosureChevron", () => {
  afterEach(cleanup);

  it("닫힘 기본형 — 12px, muted, 회전 없음, 장식 전용", () => {
    const { container } = render(<DisclosureChevron />);
    const chevron = chevronOf(container);

    expect(chevron.getAttribute("class")).toContain("size-3");
    expect(chevron.getAttribute("class")).toContain("transition-transform");
    expect(chevron.getAttribute("class")).not.toContain("rotate-90");
    // Decorative by contract — the wrapping toggle owns aria-expanded.
    expect(chevron.getAttribute("aria-hidden")).toBe("true");
  });

  it("open이면 rotate-90으로 돈다", () => {
    const { container } = render(<DisclosureChevron open />);
    expect(chevronOf(container).getAttribute("class")).toContain("rotate-90");
  });

  it("down-up 방향 — 닫힘은 ▾(회전 없음), 열림은 rotate-180으로 ▴", () => {
    const closed = render(<DisclosureChevron orientation="down-up" />);
    const closedClass = chevronOf(closed.container).getAttribute("class") ?? "";
    expect(closedClass).toContain("size-3");
    expect(closedClass).toContain("transition-transform");
    expect(closedClass).not.toContain("rotate-90");
    expect(closedClass).not.toContain("rotate-180");

    const open = render(<DisclosureChevron orientation="down-up" open />);
    const openClass = chevronOf(open.container).getAttribute("class") ?? "";
    expect(openClass).toContain("rotate-180");
    expect(openClass).not.toContain("rotate-90");
  });

  it("두 방향의 글리프가 다르다 — right-down은 ChevronRight, down-up은 ChevronDown", () => {
    const right = render(<DisclosureChevron />);
    const down = render(<DisclosureChevron orientation="down-up" />);
    // lucide paths differ per glyph; equal markup would mean one glyph serves both.
    expect(chevronOf(right.container).innerHTML).not.toBe(
      chevronOf(down.container).innerHTML,
    );
  });

  it("호출부 className이 색 기본값을 이긴다", () => {
    const { container } = render(
      <DisclosureChevron className="text-sidebar-foreground opacity-45" />,
    );
    const className = chevronOf(container).getAttribute("class") ?? "";
    expect(className).toContain("text-sidebar-foreground");
    expect(className).not.toContain("text-muted-foreground");
  });
});
