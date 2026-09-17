// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumberField } from "@/components/settings/NumberField";

const field = () => screen.getByRole("spinbutton") as HTMLInputElement;

afterEach(cleanup);

describe("NumberField", () => {
  it("타이핑하는 동안은 입력을 건드리지 않는다", () => {
    const onCommit = vi.fn();
    render(<NumberField value={1000} onCommit={onCommit} />);
    fireEvent.focus(field());
    // 1000 -> 100 -> 10 -> 1 : 중간값이 클램프돼 되튀지 않아야 한다.
    for (const next of ["100", "10", "1"]) {
      fireEvent.change(field(), { target: { value: next } });
      expect(field().value).toBe(next);
    }
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blur에서 원문 그대로 확정한다 — 정규화는 호출자 몫", () => {
    const onCommit = vi.fn();
    render(<NumberField value={1000} onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "1500" } });
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledWith("1500");
  });

  it("Enter로도 확정한다", () => {
    const onCommit = vi.fn();
    render(<NumberField value={1} onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "2.5" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("2.5");
  });

  it("Escape는 되돌리고 확정하지 않는다", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<NumberField value={1000} onCommit={onCommit} onCancel={onCancel} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "7" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
    expect(field().value).toBe("1000");
  });

  it("Escape는 위로 새지 않는다 — 설정 창이 함께 닫히면 안 된다", () => {
    const onDialogEscape = vi.fn();
    render(
      <div onKeyDown={onDialogEscape}>
        <NumberField value={1} onCommit={() => {}} />
      </div>,
    );
    fireEvent.keyDown(field(), { key: "Escape", bubbles: true });
    expect(onDialogEscape).not.toHaveBeenCalled();
  });

  it("빈 칸도 원문으로 넘긴다 — 취소인지 기본값인지는 호출자가 정한다", () => {
    const onCommit = vi.fn();
    render(<NumberField value={1000} onCommit={onCommit} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(onCommit).toHaveBeenCalledWith("");
  });

  it("포커스가 없을 때는 밖에서 바뀐 값을 따라간다", () => {
    const { rerender } = render(<NumberField value={1} onCommit={() => {}} />);
    rerender(<NumberField value={3} onCommit={() => {}} />);
    expect(field().value).toBe("3");
  });

  it("타이핑 중에는 밖의 변경이 입력을 덮어쓰지 않는다", () => {
    const { rerender } = render(<NumberField value={1} onCommit={() => {}} />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: "25" } });
    rerender(<NumberField value={9} onCommit={() => {}} />);
    expect(field().value).toBe("25");
  });
});
