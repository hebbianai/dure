// @vitest-environment jsdom
import type * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

// jsdom cannot drive Radix's hover open path reliably (pointer transit +
// delay timers), so these tests assert the controlled-open state instead —
// the same rendered output the hover path produces.
function renderOpenTooltip(
  contentProps: Partial<React.ComponentProps<typeof TooltipContent>> = {},
) {
  return render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger>설정 열기</TooltipTrigger>
        <TooltipContent {...contentProps}>설정 열기 툴팁</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

// Portalled content lands in document.body, outside RTL's container. Vitest
// runs without `globals`, so RTL auto-cleanup never registers — clean up
// explicitly or a previous test's portal satisfies the next query.
afterEach(cleanup);

const queryContent = () =>
  document.querySelector("[data-slot='tooltip-content']");

describe("Tooltip", () => {
  it("opens every shared tooltip within 100ms of intentional hover", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip>
          <TooltipTrigger>Settings</TooltipTrigger>
          <TooltipContent>Open settings</TooltipContent>
        </Tooltip>,
      );
      const trigger = document.querySelector("[data-slot='tooltip-trigger']");
      expect(trigger).not.toBeNull();

      fireEvent.pointerMove(trigger as Element, { pointerType: "mouse" });
      await act(() => vi.advanceTimersByTimeAsync(99));
      expect(queryContent()).toBeNull();

      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(queryContent()?.textContent).toBe("Open settings");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("닫힘 상태에서는 content를 렌더하지 않는다", () => {
    render(
      <Tooltip>
        <TooltipTrigger>설정 열기</TooltipTrigger>
        <TooltipContent>설정 열기 툴팁</TooltipContent>
      </Tooltip>,
    );
    const trigger = document.querySelector("[data-slot='tooltip-trigger']");
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toBe("설정 열기");
    expect(queryContent()).toBeNull();
  });

  it("열림 상태에서 라벨을 담은 content를 렌더한다", () => {
    renderOpenTooltip();
    const content = queryContent();
    expect(content).not.toBeNull();
    expect(content?.textContent).toContain("설정 열기 툴팁");
  });

  it("짧은 설명을 공통 제목·설명 위계로 렌더한다", () => {
    renderOpenTooltip({
      description: "Dure를 닫아도 세션은 계속 실행됩니다.",
    });

    const content = queryContent();
    const label = content?.querySelector("[data-slot='tooltip-label']");
    const description = content?.querySelector(
      "[data-slot='tooltip-description']",
    );
    const arrow = content?.querySelector("[data-slot='tooltip-arrow']");
    expect(label?.textContent).toBe("설정 열기 툴팁");
    expect(description?.textContent).toBe(
      "Dure를 닫아도 세션은 계속 실행됩니다.",
    );
    expect(description?.className).toContain("text-meta");
    expect(description?.className).toContain("text-primary-foreground/70");
    expect(description?.className).toContain("min-w-0");
    expect(description?.className).toContain("break-words");
    expect(description?.className).toContain("leading-3.5");
    expect(label?.className).toContain("font-medium");
    // The two-line form sits on the comp's md geometry (17103:809).
    expect(content?.className).toContain("grid");
    expect(content?.className).toContain("max-w-96");
    expect(content?.className).toContain("gap-0.5");
    expect(content?.className).toContain("rounded-md");
    expect(content?.className).toContain("px-3");
    expect(content?.className).toContain("py-1.5");
    expect(content?.className).toContain("text-left");
    expect(arrow?.getAttribute("width")).toBe("14");
    expect(arrow?.getAttribute("height")).toBe("7");
  });

  it("역전 톤의 유리 면·8px 라운드·12×6·13px·화살표로, 그림자 없이 pane chrome 위에 뜬다", () => {
    renderOpenTooltip();
    const className = queryContent()?.className ?? "";
    const classes = className.split(/\s+/);
    const arrow = queryContent()?.querySelector("[data-slot='tooltip-arrow']");
    // Dockview pane chrome reaches z-index 99. The shared tooltip must clear
    // that ceiling. A fully opaque semantic inverse surface and matching
    // Radix arrow form one crisp speech-bubble silhouette in every theme.
    expect(classes).toContain("z-[100]");
    expect(classes).toContain("rounded-md");
    // Frosted glass in the inverse tone — light on dark, like the system
    // tooltip — with the menus' blur and a hairline instead of a shadow.
    expect(classes).toContain("bg-primary/92");
    expect(classes).toContain("text-primary-foreground");
    expect(classes).toContain("backdrop-blur-[15px]");
    expect(classes).toContain("border-primary-foreground/10");
    expect(classes).not.toContain("shadow-menu");
    expect(classes).toContain("px-3");
    expect(classes).toContain("py-1.5");
    expect(classes).toContain("text-xs");
    expect(classes).toContain("max-w-96");
    expect(arrow).not.toBeNull();
    expect(arrow?.getAttribute("width")).toBe("14");
    expect(arrow?.getAttribute("height")).toBe("7");
    expect(arrow?.getAttribute("class")).toContain("fill-primary/92");
    expect(
      queryContent()?.querySelector("[data-slot='tooltip-description']"),
    ).toBeNull();
  });

  it("기본값으로 document.body에 portal된다", () => {
    const { container } = renderOpenTooltip();
    const content = queryContent();
    expect(content).not.toBeNull();
    expect(container.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });

  it("portalled={false}는 제자리에 렌더한다 — 보조 창(별도 document) 탈출구", () => {
    const { container } = renderOpenTooltip({ portalled: false });
    const content = queryContent();
    expect(content).not.toBeNull();
    expect(container.contains(content)).toBe(true);
  });

  it("container를 주면 그 노드 안으로 portal된다", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    try {
      renderOpenTooltip({ container: target });
      const content = queryContent();
      expect(content).not.toBeNull();
      expect(target.contains(content)).toBe(true);
    } finally {
      target.remove();
    }
  });
});
