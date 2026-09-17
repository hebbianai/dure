import { describe, expect, it } from "vitest";
import { isOutsideAllWindows, type ScreenRect } from "@/lib/workspace/pane/paneTearOut";

const main: ScreenRect = { x: 100, y: 100, width: 1200, height: 800 };
const popout: ScreenRect = { x: 1400, y: 200, width: 600, height: 400 };

describe("isOutsideAllWindows", () => {
  it("모든 창 밖이면 true — tear-out 트리거", () => {
    expect(isOutsideAllWindows({ x: 50, y: 50 }, [main, popout])).toBe(true);
    expect(isOutsideAllWindows({ x: 1350, y: 700 }, [main, popout])).toBe(true);
  });

  it("어느 창이든 안이면 false — 다른 창 위 드롭은 분리 아님", () => {
    expect(isOutsideAllWindows({ x: 500, y: 400 }, [main, popout])).toBe(false);
    expect(isOutsideAllWindows({ x: 1500, y: 300 }, [main, popout])).toBe(false);
  });

  it("경계선 정확히 위는 안쪽 — 창끝 드롭 오발 방지", () => {
    expect(isOutsideAllWindows({ x: 100, y: 100 }, [main])).toBe(false);
    expect(isOutsideAllWindows({ x: 1300, y: 900 }, [main])).toBe(false);
    expect(isOutsideAllWindows({ x: 1301, y: 900 }, [main])).toBe(true);
  });

  it("창 목록이 비면(조회 실패) 분리하지 않는다", () => {
    expect(isOutsideAllWindows({ x: 0, y: 0 }, [])).toBe(false);
  });
});
