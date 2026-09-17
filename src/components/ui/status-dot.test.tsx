// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StatusDot } from "@/components/ui/status-dot";
import { hoverHint } from "@/test/tooltip";

const dotOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

describe("StatusDot", () => {
  afterEach(cleanup);

  it("톤별 상태 토큰과 기본 6px 크기를 그린다", () => {
    const { container } = render(<StatusDot tone="run" />);
    const dot = dotOf(container);

    expect(dot.className).toContain("size-1.5");
    expect(dot.className).toContain("rounded-full");
    expect(dot.className).toContain("bg-status-run");
    expect(dot.className).not.toContain("animate-pulse");
    // Decorative by contract — the accessible text lives next to the dot.
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  it("pulse는 과도 상태에만 맥동 클래스를 더한다", () => {
    const { container } = render(<StatusDot tone="warn" pulse />);

    expect(dotOf(container).className).toContain("animate-pulse");
    expect(dotOf(container).className).toContain("bg-status-warn");
  });

  it("호출부 크기 오버라이드가 기본 크기를 대체한다", () => {
    const { container } = render(<StatusDot tone="error" className="size-2" />);
    const classes = dotOf(container).className;

    expect(classes).toContain("size-2");
    expect(classes).not.toContain("size-1.5");
    expect(classes).toContain("bg-destructive");
  });

  it("title은 시각 툴팁으로만 남는다", async () => {
    const { container } = render(<StatusDot tone="run" title="connected" />);

    expect(dotOf(container).getAttribute("title")).toBeNull();
    expect(await hoverHint(dotOf(container))).toBe("connected");
  });
});
