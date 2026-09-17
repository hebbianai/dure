// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chromeSidebarColumnWidth,
  TOGGLE_TRAILING_INSET,
  collapsedToggleInset,
  SHELL_CORNER_RADIUS,
  collapsedToggleLeavesRail,
  collapsedToggleWorkspaceInset,
  TRAFFIC_LIGHT_CENTER,
  shellChromeClass,
  shellEdgeOverlayClass,
  trafficLightSpacerWidth,
  useWindowShellShape,
} from "@/lib/workspace/window/windowShellShape";

const { isFullscreen, onResized } = vi.hoisted(() => ({
  isFullscreen: vi.fn(),
  onResized: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFullscreen, onResized }),
}));


describe("shell shape", () => {
  beforeEach(() => {
    isFullscreen.mockReset().mockResolvedValue(false);
    onResized.mockReset().mockResolvedValue(() => {});
  });

  it("창 모드에서는 모서리·그림자를 그린다", () => {
    expect(shellChromeClass(false, true)).toContain("rounded-[12px]");
    expect(shellChromeClass(false, true)).toContain("shadow-shell");
  });

  /** 엣지는 레이아웃을 늘리는 border가 아니라 shadow-shell + 오버레이가
   *  그린다. border 유틸리티로 되돌리면 셸 안쪽이 좌우 1px씩 줄어 여백
   *  계산이 어긋난다. */
  it("엣지는 border 유틸리티가 아니라 그림자 계열이 그린다", () => {
    const classes = shellChromeClass(false, true).split(/\s+/);
    expect(classes).not.toContain("border");
    expect(classes.some((c) => /^border-/.test(c))).toBe(false);
  });

  /** 경계 오버레이 — 루트 inset 링은 가장자리까지 채우는 자식이 덮어 보이지
   *  않으므로(2026-08-17 제보 2회), 자식 위 absolute 오버레이가 경계선을
   *  그린다. Tailwind v4에는 v3의 ring-inset이 없다 — inset-ring 유틸리티가
   *  진짜 inset이며, 입력을 막지 않도록 pointer-events-none이어야 한다. */
  it("경계 오버레이는 입력을 막지 않는 inset-ring 위 레이어다", () => {
    const classes = shellEdgeOverlayClass(false, true).split(/\s+/);
    expect(classes).toContain("pointer-events-none");
    expect(classes).toContain("absolute");
    expect(classes).toContain("inset-ring-1");
    expect(classes).toContain("inset-ring-foreground/15");
    expect(classes).not.toContain("ring-inset");
  });

  it("전체화면에서는 창 chrome을 전부 뗀다 — 화면 모서리는 창 모서리가 아니다", () => {
    expect(shellChromeClass(true, true)).toBe("");
    expect(shellEdgeOverlayClass(true, true)).toBe("");
  });

  it("does not draw the macOS shell inside native Windows and Linux frames", () => {
    expect(shellChromeClass(false, false)).toBe("");
    expect(shellEdgeOverlayClass(false, false)).toBe("");
  });

  it("CSS 반경은 창의 windowEffects.radius와 같은 상수를 쓴다", () => {
    expect(shellChromeClass(false, true)).toContain(
      `rounded-[${SHELL_CORNER_RADIUS}px]`,
    );
  });

  it("신호등 자리는 macOS 창 모드에서만 82px — 전체화면에서는 탭이 왼쪽에 붙는다", () => {
    expect(trafficLightSpacerWidth(true, false)).toBe(82);
    // 전체화면 여백은 시안 2156:23585의 chrome 줄 px-14.
    expect(trafficLightSpacerWidth(true, true)).toBe(14);
  });

  it("접힘 토글은 글리프가 여백 위치에 오도록 버튼 박스를 4px 앞세운다", () => {
    // 시안 2156:24653은 16px 아이콘을 px-14로 감싼다 — 글리프가 왼쪽에서 14px.
    // 24px 버튼 안에서 글리프가 4px 들어가 있으므로 박스는 10px에서 시작한다.
    expect(collapsedToggleInset(true, true)).toBe(14 - 4);
    // 창 모드에서는 글리프가 신호등(82px) 바로 뒤에 온다.
    expect(collapsedToggleInset(true, false)).toBe(82 - 4);
  });

  it("접힘 토글 컬럼은 시안과 같은 44px가 된다", () => {
    // 시안 2156:24653 = px-14 + 16px 아이콘 + px-14 = 44px.
    const TOGGLE_BUTTON = 24;
    expect(
      collapsedToggleInset(true, true) + TOGGLE_BUTTON + TOGGLE_TRAILING_INSET,
    ).toBe(44);
    // 오른쪽 여백은 신호등과 무관하므로 창 모드에서도 같은 값이다.
    expect(TOGGLE_TRAILING_INSET).toBe(10);
  });

  it("macOS가 아니면 신호등 자리가 없다 — 전체화면 여부와 무관하다", () => {
    expect(trafficLightSpacerWidth(false, false)).toBe(12);
    expect(trafficLightSpacerWidth(false, true)).toBe(12);
  });

  it("chrome 열은 사이드바 폭을 그대로 따라간다 — 토글이 경계에 맞는다", () => {
    expect(chromeSidebarColumnWidth(207)).toBe(207);
    expect(chromeSidebarColumnWidth(320)).toBe(320);
    // 하한 아래로는 내려가지 않는다.
    expect(chromeSidebarColumnWidth(120)).toBe(207);
  });

  it("전체화면에서도 열을 당기지 않는다 — 당기면 탭이 사이드바를 덮는다", () => {
    // 사이드바는 전체화면에서 좁아지지 않는다. 열만 68px 당기면 토글이
    // 사이드바 안쪽으로 들어오고 데스크탑 탭이 사이드바 위로 넘어온다.
    // 전체화면에서 왼쪽으로 오는 건 워드마크뿐(trafficLightSpacerWidth).
    expect(chromeSidebarColumnWidth(320)).toBe(320);
  });

  it("전체화면 여부만 읽는다 — 모서리는 네이티브 windowEffects가 깎는다", async () => {
    // Given: 창 모드인 Tauri 창
    // When: 셸 모양 상태를 구독한다
    const { result } = renderHook(() => useWindowShellShape());
    await waitFor(() => expect(isFullscreen).toHaveBeenCalledOnce());

    // Then: 창 모드로 판정한다. 모서리 자체는 창의 windowEffects radius가
    // 깎으므로(windows.ts) 여기서 네이티브를 호출할 일이 없다.
    await waitFor(() => expect(result.current).toBe(false));
  });
});

describe("TRAFFIC_LIGHT_CENTER", () => {
  /** 신호등 중심을 chrome 줄 중앙에 놓는 값이다 — 워드마크와 같은 베이스라인. */
  it("chrome 줄의 세로 중앙이다", () => {
    expect(TRAFFIC_LIGHT_CENTER).toBe(44 / 2);
  });

  /** 이 값은 CSS 변수에서 파생된다 — 줄 높이를 index.css에서만 바꾸고 여기를
   *  잊으면 신호등만 어긋난 채 남는다. */
  it("index.css의 --app-chrome-bar-height와 어긋나지 않는다", () => {
    const css = readFileSync(join(__dirname, "../../../index.css"), "utf8");
    const declared = css.match(/--app-chrome-bar-height:\s*(\d+)px/)?.[1];
    expect(declared, "index.css에서 --app-chrome-bar-height를 찾지 못했다").toBeDefined();
    expect(TRAFFIC_LIGHT_CENTER).toBe(Number(declared) / 2);
  });
});

describe("접힘 토글 자리", () => {
  /** 레일은 52px이고 신호등이 그 위를 덮는다 — 레일 오른쪽 끝에 붙이면
   *  글리프가 창 왼쪽 22px, 즉 닫기 버튼 정중앙에 겹친다. */
  it("macOS 창 모드에서는 레일을 떠난다", () => {
    expect(collapsedToggleLeavesRail(true, false)).toBe(true);
  });

  it("전체화면에서는 신호등이 없으므로 레일에 남는다", () => {
    expect(collapsedToggleLeavesRail(true, true)).toBe(false);
  });

  it("macOS가 아니면 신호등 자체가 없어 레일에 남는다", () => {
    expect(collapsedToggleLeavesRail(false, false)).toBe(false);
  });

  /** 접었다 폈을 때 토글과 워드마크가 같은 x에서 교대해야 한다. */
  it("글리프가 펼침 워드마크와 같은 창 좌표에 온다", () => {
    const railWidth = 52;
    const measuredRight = 68;
    const wordmarkX = trafficLightSpacerWidth(true, false, measuredRight);
    const inset = collapsedToggleWorkspaceInset(true, false, railWidth, measuredRight);
    // 이 줄은 레일 뒤에서 시작하고, 글리프는 버튼 박스에서 4px 들어가 있다.
    expect(railWidth + inset + 4).toBe(wordmarkX);
  });

  it("워드마크가 레일보다 앞이면 0으로 접는다 — 음수 여백을 만들지 않는다", () => {
    expect(collapsedToggleWorkspaceInset(true, false, 999, 68)).toBe(0);
  });
});
