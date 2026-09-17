import { describe, expect, it } from "vitest";

import {
  MAX_SPLITTER_SIZE,
  normalizeSplitterSize,
} from "@/lib/settings/paneLayout";

describe("normalizeSplitterSize", () => {
  it("빈 칸과 숫자가 아닌 값은 기본값으로 되돌린다", () => {
    expect(normalizeSplitterSize("", 2)).toBe(2);
    expect(normalizeSplitterSize("px", 2)).toBe(2);
  });

  it("정수 px로 반올림하고 범위를 지킨다", () => {
    expect(normalizeSplitterSize("3.4", 2)).toBe(3);
    expect(normalizeSplitterSize("0", 2)).toBe(1);
    expect(normalizeSplitterSize("99", 2)).toBe(MAX_SPLITTER_SIZE);
  });
});
