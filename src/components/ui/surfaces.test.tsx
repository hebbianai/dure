// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Card } from "@/components/ui/card";
import { GlassPanel } from "@/components/ui/glass-panel";
import { InsetPanel } from "@/components/ui/inset-panel";

const surfaceOf = (container: HTMLElement) =>
  container.firstElementChild as HTMLElement;

describe("InsetPanel", () => {
  afterEach(cleanup);

  it("기본형 — 기부 사이트 다수결 클래스의 div 한 장", () => {
    const { container } = render(<InsetPanel>세부 내용</InsetPanel>);
    const panel = surfaceOf(container);

    expect(panel.tagName).toBe("DIV");
    expect(panel.textContent).toBe("세부 내용");
    const className = panel.getAttribute("class") ?? "";
    for (const cls of [
      "rounded-md",
      "border-border/70",
      "bg-muted/25",
      "p-2.5",
    ]) {
      expect(className).toContain(cls);
    }
  });

  it("호출부 같은 그룹 클래스가 기본값을 이긴다 (tailwind-merge)", () => {
    const { container } = render(<InsetPanel className="bg-muted/40 p-3" />);
    const className = surfaceOf(container).getAttribute("class") ?? "";

    expect(className).toContain("bg-muted/40");
    expect(className).not.toContain("bg-muted/25");
    expect(className).toContain("p-3");
    expect(className).not.toContain("p-2.5");
  });

  it("표준 div props가 그대로 통과한다 (KillAgentDialog의 aria-live)", () => {
    const { container } = render(<InsetPanel aria-live="polite" />);
    expect(surfaceOf(container).getAttribute("aria-live")).toBe("polite");
  });
});

describe("Card", () => {
  afterEach(cleanup);

  it("기본형 — border+p-[17px]만, radius는 base에 없다", () => {
    const { container } = render(<Card>카드 내용</Card>);
    const card = surfaceOf(container);

    expect(card.tagName).toBe("DIV");
    expect(card.textContent).toBe("카드 내용");
    const className = card.getAttribute("class") ?? "";
    expect(className).toContain("border-border");
    expect(className).toContain("p-[17px]");
    // Radius unification is design authority: the base must stay radius-free.
    expect(className).not.toContain("rounded");
  });

  it("호출부가 자기 radius를 className으로 가져온다", () => {
    const { container } = render(<Card className="rounded-[11px]" />);
    const className = surfaceOf(container).getAttribute("class") ?? "";

    expect(className).toContain("rounded-[11px]");
    expect(className).toContain("border-border");
    expect(className).toContain("p-[17px]");
  });
});

describe("GlassPanel", () => {
  afterEach(cleanup);

  it("기본형 — 두 기부 카드의 동일한 유리 클래스", () => {
    const { container } = render(<GlassPanel>플러그인 카드</GlassPanel>);
    const panel = surfaceOf(container);

    expect(panel.tagName).toBe("DIV");
    expect(panel.textContent).toBe("플러그인 카드");
    const className = panel.getAttribute("class") ?? "";
    for (const cls of [
      "rounded-xl",
      "border-glass-hairline",
      "bg-glass-tint",
    ]) {
      expect(className).toContain(cls);
    }
  });

  it("호출부 배치 클래스가 유리 표면과 공존한다", () => {
    const { container } = render(
      <GlassPanel className="mx-2 mt-3 overflow-hidden" />,
    );
    const className = surfaceOf(container).getAttribute("class") ?? "";

    expect(className).toContain("mx-2");
    expect(className).toContain("overflow-hidden");
    expect(className).toContain("bg-glass-tint");
  });
});
