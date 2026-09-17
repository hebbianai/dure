// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalFontPreview } from "@/components/terminal/TerminalFontPreview";
import { useStore } from "@/store";

afterEach(() => {
  cleanup();
  useStore.setState({ terminalFontSize: 12.5 });
  useStore.getState().setUiPrefs({ terminalLineHeight: 1.25 });
});

/** jsdom은 레이아웃을 계산하지 않으므로 실제 px 대신 "높이가 내용이 아니라
 *  고정 클래스에서 온다"는 것을 검증한다. 클래스 문자열은 상수라 두 렌더를
 *  맞대보는 비교는 실패할 수 없다 — 대신 '어떤 클래스인지'를 좁게 못박는다. */
function previewBox() {
  return screen.getByTestId("terminal-font-preview");
}

/** 정확히 `h-[\d+px]` 토큰만 센다. 부분 일치를 쓰면 `min-h-[200px]`도 통과하는데,
 *  min-h는 내용에 따라 박스가 자라는 원래 버그를 그대로 되살린다. */
function fixedHeightClass(el: HTMLElement) {
  return el.className.split(/\s+/).filter((c) => /^h-\[\d+px\]$/.test(c));
}

function renderAt(fontSize: number) {
  // setState가 아니라 실제 setter를 써서 store의 8..30 clamp를 함께 태운다.
  useStore.getState().setTerminalFontSize(fontSize);
  render(<TerminalFontPreview />);
  return previewBox();
}

describe("TerminalFontPreview", () => {
  it("pins the box height to a class so content size cannot grow it", () => {
    const box = renderAt(9);

    expect(fixedHeightClass(box)).toHaveLength(1);
    // 인라인 height가 없어야 클래스가 실제 권위다.
    expect(box.style.height).toBe("");
    // min-h/max-h로 바꿔치기하면 박스가 다시 내용을 따라 자란다.
    expect(box.className).not.toMatch(/\b(?:min|max)-h-\[/);
  });

  it("applies the font size to the glyphs, not to the box", () => {
    expect(renderAt(9).style.fontSize).toBe("9px");
    cleanup();
    expect(renderAt(26).style.fontSize).toBe("26px");
  });

  it("previews the configured line height", () => {
    useStore.getState().setUiPrefs({ terminalLineHeight: 1.45 });

    expect(renderAt(9).style.lineHeight).toBe("1.45");
  });

  it("wraps long lines instead of cutting them off at the fixed width", () => {
    const box = renderAt(30);

    // 가로는 접고, 접혀서 넘친 세로는 스크롤로 닿을 수 있게 — 어느 쪽도 잘리지 않는다.
    expect(box.className).toContain("break-words");
    expect(box.className).toContain("overflow-x-hidden");
    expect(box.className).toContain("overflow-y-auto");
    // 스크롤이 생길 때 내용 폭이 줄며 모든 줄이 다시 접히는 점프를 막는다.
    expect(box.className).toContain("[scrollbar-gutter:stable]");
  });

  it("keeps the PASS row able to wrap its filename", () => {
    renderAt(30);
    const row = screen.getByText("PASS").parentElement;
    const cls = row?.className ?? "";

    expect(row?.textContent).toContain("src/preview.test.ts");
    // 일반 흐름이거나 flex-wrap이면 된다 — nowrap flex 행일 때만 오른쪽이 잘린다.
    const isNowrapFlexRow = /\bflex\b/.test(cls) && !/\bflex-wrap\b/.test(cls);
    expect(isNowrapFlexRow).toBe(false);
  });
});
