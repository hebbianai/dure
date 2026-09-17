// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField } from "@/components/ui/search-field";
import { SEARCH_FIELD_SURFACE, SEARCH_FIELD_TEXT } from "@/lib/ui/searchField";

const inputOf = (container: HTMLElement) =>
  container.querySelector("input") as HTMLInputElement;

describe("SearchField", () => {
  afterEach(cleanup);

  it("기본 아이콘과 공용 검색 표면을 그린다", () => {
    const { container } = render(<SearchField aria-label="search" />);
    const icon = container.querySelector("svg");
    const input = inputOf(container);

    expect(icon?.getAttribute("class")).toContain(
      "pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-muted-foreground",
    );
    expect(input.className).toContain("w-full");
    expect(input.className).toContain("appearance-none");
    expect(input.className).toContain("rounded-md");
    expect(input.className).toContain("border");
    expect(input.className).toContain("pl-7");
    // No trailing affordance declared — narrow right inset.
    expect(input.className).toContain("pr-3");
    expect(input.className).toContain(SEARCH_FIELD_TEXT);
    for (const token of SEARCH_FIELD_SURFACE.split(/\s+/)) {
      expect(input.className).toContain(token);
    }
  });

  it("wrapper와 input 클래스가 각자의 prop으로 갈라진다", () => {
    const { container } = render(
      <SearchField aria-label="search" className="mx-2" inputClassName="h-8" />,
    );
    const wrapper = container.firstElementChild as HTMLElement;

    expect(wrapper.className).toContain("relative");
    expect(wrapper.className).toContain("mx-2");
    expect(inputOf(container).className).toContain("h-8");
    expect(inputOf(container).className).not.toContain("mx-2");
  });

  it("input prop이 전부 그대로 흐른다 — 콤보박스 배선 포함", () => {
    const { container } = render(
      <SearchField
        aria-label="search"
        role="combobox"
        aria-activedescendant="opt-2"
        placeholder="파일 검색"
        value="que"
        onChange={() => {}}
      />,
    );
    const input = inputOf(container);

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-activedescendant")).toBe("opt-2");
    expect(input.getAttribute("placeholder")).toBe("파일 검색");
    expect(input.value).toBe("que");
  });

  it("onClear는 값이 있을 때만 지우기 버튼을 보이고 pr-8을 예약한다", () => {
    const onClear = vi.fn();
    const empty = render(
      <SearchField aria-label="search" value="" onChange={() => {}} onClear={onClear} />,
    );
    expect(empty.container.querySelector("button")).toBeNull();
    expect(inputOf(empty.container).className).toContain("pr-8");

    const filled = render(
      <SearchField aria-label="s2" value="que" onChange={() => {}} onClear={onClear} />,
    );
    const button = filled.container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("검색 지우기");
    fireEvent.click(button);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("loading이면 지우기 대신 스피너를 그린다", () => {
    const { container } = render(
      <SearchField aria-label="search" value="que" onChange={() => {}} loading onClear={() => {}} />,
    );
    const spinner = container.querySelector(".dure-loader");

    expect(spinner?.getAttribute("class")).toContain(
      "pointer-events-none absolute right-2 text-muted-foreground",
    );
    expect(spinner?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector("button")).toBeNull();
  });

  it("trailing 슬롯이 기본 스피너·지우기 렌더를 대체한다", () => {
    const { container } = render(
      <SearchField
        aria-label="search"
        value="que"
        onChange={() => {}}
        loading
        trailing={<kbd data-testid="hint">/</kbd>}
      />,
    );

    expect(container.querySelector("[data-testid='hint']")).not.toBeNull();
    expect(container.querySelector(".dure-loader")).toBeNull();
    expect(inputOf(container).className).toContain("pr-8");
  });

  it("icon 슬롯이 기본 Search 아이콘을 대체한다", () => {
    const { container } = render(
      <SearchField aria-label="search" icon={<span data-testid="glyph" />} />,
    );

    expect(container.querySelector("[data-testid='glyph']")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
