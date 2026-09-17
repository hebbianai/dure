// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "@/components/ui/segmented";
import { hoverHint } from "@/test/tooltip";

const OPTIONS = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
] as const;

type Value = (typeof OPTIONS)[number]["value"];

const renderSegmented = (
  overrides: Partial<{
    value: Value;
    onChange: (v: Value) => void;
    variant: "outline" | "pills" | "chips";
  }> = {},
) =>
  render(
    <Segmented<Value>
      value={overrides.value ?? "b"}
      onChange={overrides.onChange ?? (() => {})}
      options={[...OPTIONS]}
      variant={overrides.variant}
    />,
  );

describe("Segmented", () => {
  afterEach(cleanup);

  it("radiogroup 시맨틱 — 트랙은 radiogroup, 칸은 radio + aria-checked", () => {
    renderSegmented();
    const track = screen.getByRole("radiogroup");
    const radios = screen.getAllByRole("radio");

    expect(track.children).toHaveLength(3);
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    // Roving tabindex: only the selected option sits in the tab order.
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    // Never a submit button when placed inside a form.
    expect(radios.every((r) => r.getAttribute("type") === "button")).toBe(true);
  });

  it("outline 기본형 — 도너의 트랙·칸·선택 클래스가 그대로다", () => {
    renderSegmented();
    const track = screen.getByRole("radiogroup");
    const [first, selected, last] = screen.getAllByRole("radio");

    expect(track.className).toContain("inline-grid");
    expect(track.className).toContain("auto-cols-fr");
    for (const button of [first, selected, last]) {
      expect(button.className).toContain("h-8");
      expect(button.className).toContain("min-w-[52px]");
      expect(button.className).toContain("border-input");
      expect(button.className).toContain("whitespace-nowrap");
    }
    expect(first.className).toContain("rounded-l-md");
    expect(last.className).toContain("rounded-r-md");
    expect(selected.className).toContain("-ml-px");
    // Selection speaks through one achromatic background step (SOUL §5.3).
    expect(selected.className).toContain("z-10");
    expect(selected.className).toContain("bg-accent");
    expect(first.className).toContain("bg-background");
  });

  it("pills 변형 — 유리 틴트 트랙 위에서 선택 칸만 떠오른다", () => {
    renderSegmented({ variant: "pills" });
    const track = screen.getByRole("radiogroup");
    const [first, selected] = screen.getAllByRole("radio");

    // The track is the sidebar's hover tint, not the achromatic muted fill,
    // so a scheme's colour shows through it on the glass (2026-09-09).
    expect(track.className).toContain("bg-glass-tint-hover");
    expect(track.className).not.toContain("bg-muted");
    expect(track.className).toContain("p-1");
    expect(track.className).toContain("gap-1");
    expect(selected.className).toContain("h-7");
    expect(selected.className).toContain("bg-background");
    expect(selected.className).toContain("shadow-sm");
    // An unselected pill brightens its text on hover only — a fill hover
    // would be the track's own tint and vanish against it.
    expect(first.className).toContain("hover:text-foreground");
    expect(first.className).not.toContain("hover:bg-");
  });

  it("small pills constrain every column and keep a composed label accessible", async () => {
    render(
      <Segmented<Value>
        value="b"
        onChange={() => {}}
        variant="pills"
        size="sm"
        options={[
          ...OPTIONS.slice(0, 2),
          {
            value: "c",
            label: (
              <span>
                <span>Open issues</span>
                <span>328</span>
              </span>
            ),
            ariaLabel: "Open issues 328",
          },
        ]}
      />,
    );

    const track = screen.getByRole("radiogroup");
    const composed = screen.getByRole("radio", { name: "Open issues 328" });
    expect(track.className).toContain("auto-cols-[minmax(0,1fr)]");
    expect(composed.className).toContain("min-w-0");
    expect(composed.className).toContain("overflow-hidden");
    expect(await hoverHint(composed)).toBe("Open issues 328");
  });

  it("icon-only pills keep their names while collapsing to square controls", async () => {
    render(
      <Segmented<Value>
        value="b"
        onChange={() => {}}
        variant="pills"
        size="sm"
        iconOnly
        options={OPTIONS.map((option) => ({
          ...option,
          icon: <svg data-testid={`icon-${option.value}`} />,
        }))}
      />,
    );

    const beta = screen.getByRole("radio", { name: "Beta" });
    expect(beta.className).toContain("size-6");
    expect(await hoverHint(beta)).toBe("Beta");
    expect(beta.textContent).toBe("Beta");
    expect(beta.querySelector('[data-testid="icon-b"]')).toBeTruthy();
    expect(beta.querySelector(".sr-only")?.textContent).toBe("Beta");
  });

  it("클릭은 정확히 그 칸의 값으로 onChange 1:1", () => {
    const onChange = vi.fn();
    renderSegmented({ onChange });

    fireEvent.click(screen.getByRole("radio", { name: "Gamma" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("c");
  });

  it("화살표 키가 선택과 포커스를 함께 옮기고 끝에서 감아 돈다", () => {
    const onChange = vi.fn();
    renderSegmented({ onChange });
    const [alpha, beta, gamma] = screen.getAllByRole("radio");

    beta.focus();
    fireEvent.keyDown(beta, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(gamma);

    fireEvent.keyDown(gamma, { key: "ArrowRight" });
    // Wrap-around: past the last option lands on the first.
    expect(onChange).toHaveBeenLastCalledWith("a");
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(document.activeElement).toBe(gamma);

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("화살표 외 키는 아무것도 바꾸지 않는다", () => {
    const onChange = vi.fn();
    renderSegmented({ onChange });
    const beta = screen.getByRole("radio", { name: "Beta" });

    beta.focus();
    fireEvent.keyDown(beta, { key: "Enter" });
    fireEvent.keyDown(beta, { key: "Tab" });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(beta);
  });

  it("chips 변형 — 줄바꿈되는 내용폭 칩, 아이콘은 라벨 앞, radio 시맨틱 유지", () => {
    render(
      <Segmented<Value>
        value="b"
        onChange={() => {}}
        variant="chips"
        options={[
          { value: "a", label: "Alpha", icon: <svg data-testid="icon-a" /> },
          { value: "b", label: "Beta" },
          { value: "c", label: "Gamma" },
        ]}
      />,
    );
    const track = screen.getByRole("radiogroup");
    expect(track.className).toContain("flex-wrap");
    expect(track.className).not.toContain("inline-grid");
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "Beta" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Alpha" }).querySelector('[data-testid="icon-a"]')).toBeTruthy();
  });
});
