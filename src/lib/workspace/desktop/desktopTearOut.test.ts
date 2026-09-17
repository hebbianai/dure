import { describe, expect, it } from "vitest";
import { desktopToTearOut, TEAR_OUT_MARGIN, type DesktopTearOutInput } from "@/lib/workspace/desktop/desktopTearOut";

// 메인 창 하나가 (0,0)-(1400,900)에 떠 있는 상태.
const windows = [{ x: 0, y: 0, width: 1400, height: 900 }];

function input(over: Partial<DesktopTearOutInput> = {}): DesktopTearOutInput {
  return {
    armedDesktopId: "d1",
    dropEffect: "none",
    point: { x: 1600, y: 500 }, // 창 오른쪽 바깥 = 바탕화면
    windows,
    ...over,
  };
}

describe("desktopToTearOut", () => {
  it("앱 창 밖에서 놓으면 그 데스크탑을 새 창으로 연다", () => {
    expect(desktopToTearOut(input())).toBe("d1");
  });

  it("창 안에서 놓으면 열지 않는다", () => {
    expect(desktopToTearOut(input({ point: { x: 700, y: 400 } }))).toBeNull();
  });

  it("창 경계에서 여백 안쪽이면 열지 않는다", () => {
    expect(desktopToTearOut(input({ point: { x: 1400, y: 900 } }))).toBeNull();
    // 여백 경계 위도 안쪽으로 본다 — 창끝에서 놓친 드롭이 창을 만들지 않게.
    expect(desktopToTearOut(input({ point: { x: 1400 + TEAR_OUT_MARGIN, y: 500 } }))).toBeNull();
    expect(desktopToTearOut(input({ point: { x: 1401 + TEAR_OUT_MARGIN, y: 500 } }))).toBe("d1");
  });

  it("탭 위로 살짝 흘러 메뉴바에 놓은 것은 분리가 아니다", () => {
    // 데스크탑 탭은 창 상단에서 ~5px 아래다. 왼쪽으로 순서를 바꾸다 위로
    // 조금 벗어나는 건 흔한 실수라, 여백 없이는 그것만으로 창이 열렸다.
    expect(desktopToTearOut(input({ point: { x: 300, y: -10 } }))).toBeNull();
    expect(desktopToTearOut(input({ point: { x: 300, y: -(TEAR_OUT_MARGIN + 1) } }))).toBe("d1");
  });

  it("앱 안의 드롭존이 받았으면 열지 않는다 — 재정렬이 여기 걸린다", () => {
    // dockview는 워크스페이스 전역에서 dragover를 preventDefault하므로
    // 창 안에서 끝난 드래그는 좌표와 무관하게 여기서 걸러진다.
    expect(desktopToTearOut(input({ dropEffect: "move" }))).toBeNull();
    expect(desktopToTearOut(input({ dropEffect: "copy" }))).toBeNull();
  });

  it("dropEffect가 없어도 좌표로 판단한다", () => {
    expect(desktopToTearOut(input({ dropEffect: undefined }))).toBe("d1");
  });

  it("무장되지 않은 드래그는 무시한다", () => {
    expect(desktopToTearOut(input({ armedDesktopId: null }))).toBeNull();
  });

  it("창 목록을 못 얻으면 열지 않는다 — 창 열기는 되돌리기 어렵다", () => {
    expect(desktopToTearOut(input({ windows: [] }))).toBeNull();
  });

  it("창이 여럿이면 그중 어느 하나 안이어도 열지 않는다", () => {
    const two = [
      { x: 0, y: 0, width: 800, height: 600 },
      { x: 900, y: 100, width: 700, height: 500 },
    ];
    expect(desktopToTearOut(input({ windows: two, point: { x: 1000, y: 300 } }))).toBeNull();
    // 창 가장자리 여백 안(800..824)은 아직 분리가 아니다.
    expect(desktopToTearOut(input({ windows: two, point: { x: 810, y: 300 } }))).toBeNull();
    // 두 창 사이 틈이 여백보다 넓으면(824..876) 그 사이는 정말 바깥이다.
    expect(desktopToTearOut(input({ windows: two, point: { x: 850, y: 300 } }))).toBe("d1");
    expect(desktopToTearOut(input({ windows: two, point: { x: 1700, y: 300 } }))).toBe("d1");
  });
});
