// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityDot } from "@/components/agents/StatusBits";

describe("ActivityDot", () => {
  afterEach(cleanup);

  it("draws working as the green breathing mark with its accessible label", () => {
    render(<ActivityDot activity="working" />);
    const dot = screen.getByRole("img", { name: "작업 중" });

    expect(dot.className).toContain("agent-status-dot");
    expect(dot.dataset.agentTone).toBe("live");
    expect(dot.dataset.agentMotion).toBe("breathe");
    expect(dot.getAttribute("aria-label")).toBe("작업 중");
  });

  it("keeps a finished turn quiet and needs-you in the accent", () => {
    render(<ActivityDot activity="waiting" />);
    const waiting = screen.getByRole("img", { name: "응답 대기" });
    expect(waiting.dataset.agentTone).toBe("rest");
    expect(waiting.dataset.agentMotion).toBe("still");

    cleanup();
    render(<ActivityDot activity="input" />);
    expect(screen.getByRole("img", { name: "입력 대기" }).dataset.agentTone).toBe(
      "attention",
    );
  });

  it("reserves the passing pulse for connecting", () => {
    render(<ActivityDot activity="connecting" />);
    expect(
      screen.getByRole("img", { name: "연결 중" }).dataset.agentMotion,
    ).toBe("pulse");
  });

  it("종료는 속 빈 점으로 남고 unread 링을 받지 않는다", () => {
    render(<ActivityDot activity="exited" unread />);
    const dot = screen.getByRole("img", { name: "종료됨" });

    expect(dot.dataset.agentFill).toBe("hollow");
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
    expect(dot.dataset.agentTone).toBeUndefined();
    expect(dot.className).not.toContain("ring-2");
    expect(dot.className).toContain("agent-status-dot");
  });
});
