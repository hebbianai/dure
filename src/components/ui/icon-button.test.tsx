// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "lucide-react";
import { createRef } from "react";
import { createPortal } from "react-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton, RowMenuButton } from "@/components/ui/icon-button";

describe("IconButton", () => {
  afterEach(cleanup);

  it("does not submit its containing form", () => {
    render(
      <IconButton title="새로고침">
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "새로고침" });

    // Never a submit button when placed inside a form.
    expect(button.getAttribute("type")).toBe("button");
  });

  it("forwards the button ref and shows keyboard hints in the trigger document", () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const target = frame.contentDocument!.body;
    const ref = createRef<HTMLButtonElement>();
    try {
      render(
        createPortal(
          <IconButton ref={ref} title="Close"><Check /></IconButton>,
          target,
        ),
      );
      const button = target.querySelector("button")!;
      expect(ref.current).toBe(button);

      fireEvent.focus(button);
      expect(target.querySelector('[role="tooltip"]')?.textContent).toBe("Close");
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      fireEvent.blur(button);
      expect(target.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      cleanup();
      expect(ref.current).toBeNull();
      frame.remove();
    }
  });

  it("title이 aria-label로도 미러링된다 — 이름 없는 아이콘 버튼 금지", () => {
    render(
      <IconButton title="목록으로 돌아가기">
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "목록으로 돌아가기" });
    expect(button.getAttribute("aria-label")).toBe("목록으로 돌아가기");
  });

  it("shows the shared tooltip after intentional hover and dismisses it on click", async () => {
    vi.useFakeTimers();
    try {
      const onClick = vi.fn();
      render(
        <IconButton title="Refresh" onClick={onClick}><Check /></IconButton>,
      );
      const button = screen.getByRole("button", { name: "Refresh" });

      fireEvent.pointerMove(button, { pointerType: "mouse" });
      await act(() => vi.advanceTimersByTimeAsync(99));
      expect(screen.queryByRole("tooltip")).toBeNull();
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByRole("tooltip").textContent).toBe("Refresh");
      expect(button.getAttribute("title")).toBe("");

      fireEvent.click(button);
      expect(onClick).toHaveBeenCalledOnce();
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("can omit the shared tooltip without losing its accessible name", () => {
    render(
      <IconButton title="추가 메뉴" showTooltip={false}>
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "추가 메뉴" });

    fireEvent.focus(button);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(button.getAttribute("title")).toBe("");
    expect(button.getAttribute("aria-label")).toBe("추가 메뉴");
  });

  it("exposes the pressed toggle state", () => {
    render(
      <IconButton title="현재 리포에 고정" pressed>
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "현재 리포에 고정" });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("exposes the unpressed toggle state", () => {
    render(
      <IconButton title="고정 해제됨" pressed={false}>
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "고정 해제됨" });
    // Still a toggle for AT — the attribute stays, announcing the off state.
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("pressed 생략 시 aria-pressed 속성 자체가 없다 — 토글 아닌 버튼", () => {
    render(
      <IconButton title="새로고침">
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "새로고침" });
    expect(button.hasAttribute("aria-pressed")).toBe(false);
  });

  it("onClick과 disabled가 ...rest로 통과한다", () => {
    const onClick = vi.fn();
    render(
      <IconButton title="정리" disabled onClick={onClick}>
        <Check />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "정리" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe.each([IconButton, RowMenuButton])("%s menu trigger", (Button) => {
  afterEach(cleanup);

  it("shows the shared hover hint and dismisses it when opening the menu", async () => {
    vi.useFakeTimers();
    try {
      render(
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button title="Session actions" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem>Resume</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );
      const trigger = screen.getByRole("button", { name: "Session actions" });
      expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
      expect(trigger.getAttribute("data-state")).toBe("closed");

      fireEvent.pointerMove(trigger, { pointerType: "mouse" });
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(screen.getByRole("tooltip").textContent).toBe("Session actions");
      expect(trigger.getAttribute("title")).toBe("");
      expect(trigger.getAttribute("data-state")).toBe("closed");

      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
      expect(trigger.getAttribute("data-state")).toBe("open");
      expect(screen.getByRole("menuitem", { name: "Resume" })).toBeTruthy();
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      cleanup();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
