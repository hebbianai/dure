// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityDot } from "@/components/agents/StatusBits";

describe("ActivityDot", () => {
  afterEach(cleanup);

  it("상태가 있으면 status 토큰 색과 접근성 라벨을 함께 그린다", () => {
    render(<ActivityDot activity="working" />);
    const dot = screen.getByRole("img", { name: "작업 중" });

    // 작업 중=주황, 완료·대기=초록 (2026-08-31 결정).
    expect(dot.className).toContain("bg-status-warn");
    expect(dot.getAttribute("aria-label")).toBe("작업 중");
  });

  it("keeps settled work static and reserves pulse for connecting", () => {
    render(<ActivityDot activity="working" />);
    expect(screen.getByRole("img", { name: "작업 중" }).className).not.toContain(
      "animate-",
    );

    cleanup();
    render(<ActivityDot activity="connecting" />);
    expect(
      screen.getByRole("img", { name: "연결 중" }).className,
    ).toContain("animate-pulse");
  });

  it("종료는 속 빈 점으로 남고 unread 링을 받지 않는다", () => {
    render(<ActivityDot activity="exited" unread />);
    const dot = screen.getByRole("img", { name: "종료됨" });

    expect(dot.className).toContain("bg-transparent");
    expect(dot.className).toContain("border-muted-foreground/50");
    expect(dot.className).not.toContain("ring-2");
  });

  it("unread면 유의미 상태에 링을 얹는다", () => {
    render(<ActivityDot activity="input" unread />);

    expect(screen.getByRole("img", { name: "입력 대기" }).className).toContain(
      "ring-2",
    );
  });

  it("상태가 없으면 색·라벨 없는 자리 표시 점만 남는다", () => {
    // Former SpaceRowDot contract: a non-agent row keeps the dot's footprint
    // for row alignment but paints nothing and stays decorative for AT.
    const { container } = render(<ActivityDot activity={undefined} unread />);
    const dot = container.firstElementChild as HTMLElement;

    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("title")).toBeNull();
    expect(dot.getAttribute("aria-label")).toBeNull();
    expect(dot.className).not.toContain("border");
    expect(dot.className).not.toContain("bg-");
    expect(dot.className).not.toContain("ring-2");
    expect(dot.className).toContain("rounded-full");
  });
});
