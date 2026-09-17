import { describe, expect, it } from "vitest";
import {
  MINIMAP_MAX_ROW_HEIGHT,
  MINIMAP_MIN_ROW_HEIGHT,
  MINIMAP_MIN_VIEWPORT_HEIGHT,
  minimapBar,
  minimapLayout,
  minimapSampledLines,
  minimapScrollTop,
  minimapViewport,
} from "@/lib/editor/codeMinimap";

describe("minimapLayout", () => {
  it("짧은 문서는 최대 높이로 그리고 남은 자리는 비워 둔다", () => {
    const layout = minimapLayout(10, 600);
    expect(layout.rowHeight).toBe(MINIMAP_MAX_ROW_HEIGHT);
    expect(layout.step).toBe(1);
    expect(layout.rowCount).toBe(10);
    expect(layout.drawnHeight).toBe(30);
  });

  it("스트립에 겨우 들어가는 문서는 막대를 얇게 해 전부 그린다", () => {
    const layout = minimapLayout(400, 600);
    expect(layout.step).toBe(1);
    expect(layout.rowCount).toBe(400);
    expect(layout.rowHeight).toBeCloseTo(1.5);
    expect(layout.drawnHeight).toBeCloseTo(600);
  });

  it("1px보다 얇아질 문서는 줄을 건너뛰며 샘플링한다", () => {
    const layout = minimapLayout(6000, 600);
    expect(layout.rowHeight).toBe(MINIMAP_MIN_ROW_HEIGHT);
    expect(layout.step).toBe(10);
    expect(layout.rowCount).toBe(600);
    expect(layout.drawnHeight).toBeLessThanOrEqual(600);
  });

  it("샘플링해도 문서 전체가 스트립 안에 남는다", () => {
    for (const lines of [1200, 9999, 100_000]) {
      const layout = minimapLayout(lines, 480);
      expect(layout.drawnHeight).toBeLessThanOrEqual(480);
      expect(layout.rowCount * layout.step).toBeGreaterThanOrEqual(lines);
    }
  });

  it("빈 문서나 높이 0에서는 아무것도 그리지 않는다", () => {
    expect(minimapLayout(0, 600).rowCount).toBe(0);
    expect(minimapLayout(100, 0).rowCount).toBe(0);
    expect(minimapLayout(0, 600).drawnHeight).toBe(0);
  });
});

describe("minimapBar", () => {
  it("들여쓰기와 내용 길이를 나눈다", () => {
    expect(minimapBar("  const a = 1;")).toEqual({ indent: 2, length: 12 });
  });

  it("탭은 indentUnit과 같은 2열로 센다", () => {
    expect(minimapBar("\t\tx")).toEqual({ indent: 4, length: 1 });
  });

  it("뒤쪽 공백은 막대 길이에서 뺀다", () => {
    expect(minimapBar("  ab   ")).toEqual({ indent: 2, length: 2 });
  });

  it("빈 줄과 공백뿐인 줄은 길이 0이다", () => {
    expect(minimapBar("")).toEqual({ indent: 0, length: 0 });
    expect(minimapBar("     ")).toEqual({ indent: 5, length: 0 });
  });
});

describe("minimapViewport", () => {
  it("문서가 화면에 다 들어가면 상자가 전체를 덮는다", () => {
    const box = minimapViewport({
      scrollTop: 0,
      clientHeight: 800,
      scrollHeight: 800,
      drawnHeight: 300,
    });
    expect(box).toEqual({ top: 0, height: 300 });
  });

  it("스크롤 비율만큼 상자가 내려간다", () => {
    const box = minimapViewport({
      scrollTop: 1000,
      clientHeight: 500,
      scrollHeight: 2000,
      drawnHeight: 400,
    });
    expect(box.top).toBeCloseTo(200);
    expect(box.height).toBeCloseTo(100);
  });

  it("맨 아래에서도 상자가 그린 범위를 벗어나지 않는다", () => {
    const box = minimapViewport({
      scrollTop: 1500,
      clientHeight: 500,
      scrollHeight: 2000,
      drawnHeight: 400,
    });
    expect(box.top + box.height).toBeLessThanOrEqual(400 + 1e-9);
  });

  it("아주 긴 문서에서도 상자를 잡을 수 있을 만큼은 남긴다", () => {
    const box = minimapViewport({
      scrollTop: 0,
      clientHeight: 20,
      scrollHeight: 200_000,
      drawnHeight: 400,
    });
    expect(box.height).toBe(MINIMAP_MIN_VIEWPORT_HEIGHT);
  });

  it("그릴 게 없으면 상자도 없다", () => {
    expect(minimapViewport({ scrollTop: 0, clientHeight: 10, scrollHeight: 100, drawnHeight: 0 }))
      .toEqual({ top: 0, height: 0 });
  });
});

describe("minimapScrollTop", () => {
  const base = { drawnHeight: 400, scrollHeight: 2000, clientHeight: 500 };

  it("찍은 지점이 뷰포트 한가운데가 된다", () => {
    // 절반 지점 → 문서의 절반(1000)이 뷰포트 중앙 → scrollTop 750
    expect(minimapScrollTop({ ...base, pointerY: 200 })).toBeCloseTo(750);
  });

  it("맨 위를 찍어도 음수로 넘어가지 않는다", () => {
    expect(minimapScrollTop({ ...base, pointerY: 0 })).toBe(0);
  });

  it("맨 아래를 찍어도 문서 끝을 넘지 않는다", () => {
    expect(minimapScrollTop({ ...base, pointerY: 400 })).toBe(1500);
  });

  it("스트립 밖의 좌표도 범위 안으로 잘린다", () => {
    expect(minimapScrollTop({ ...base, pointerY: -50 })).toBe(0);
    expect(minimapScrollTop({ ...base, pointerY: 9999 })).toBe(1500);
  });
});

describe("minimapSampledLines", () => {
  it("step 간격의 라인 번호를 돌려준다", () => {
    const layout = minimapLayout(6000, 600);
    const lines = minimapSampledLines(layout, 6000);
    expect(lines[0]).toBe(0);
    expect(lines[1]).toBe(layout.step);
    expect(lines[lines.length - 1]).toBeLessThan(6000);
  });

  it("문서 끝을 넘는 샘플은 만들지 않는다", () => {
    const layout = minimapLayout(5, 600);
    expect(minimapSampledLines(layout, 5)).toEqual([0, 1, 2, 3, 4]);
  });
});
