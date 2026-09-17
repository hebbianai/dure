import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 사이드바 프레임은 스크롤하지 않는다 — 스크롤은 안쪽 ScrollArea 하나만 갖는다.
//
// 왜 소스를 읽어 검사하나: 이 결함은 렌더 결과가 아니라 **CSS 계산 규칙**에서
// 나온다. 한 축이 visible이 아니면 다른 축의 visible은 auto로 계산되므로,
// `overflow-x-hidden`만 준 요소는 세로가 조용히 스크롤 가능해진다. jsdom은 그
// 계산을 하지 않아 렌더 테스트로는 잡히지 않고, 내용이 넘칠 만큼 길어져야만
// 눈에 보인다 — 실제로 External Hmux sessions가 90개를 넘기고서야 드러났다
// (2026-07-31: 세로 스크롤바가 나란히 둘, 바깥 것을 끌면 빈 공간이 나왔다).
//
// 그래서 "두 축을 모두 명시했는가"를 선언 수준에서 지킨다.
const source = readFileSync(
  fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)),
  "utf8",
);

describe("사이드바 프레임의 overflow 선언", () => {
  it("overflow-x-hidden을 쓰는 곳은 세로 축도 함께 명시한다", () => {
    const offenders = source
      .split("\n")
      .map((line, index) => ({ line, number: index + 1 }))
      .filter(
        ({ line }) =>
          // 설명하는 주석이 아니라 실제 선언만 본다.
          line.includes("className") &&
          line.includes("overflow-x-hidden") &&
          !line.includes("overflow-y-hidden") &&
          !line.includes("overflow-y-auto") &&
          !line.includes("overflow-y-scroll"),
      )
      .map(({ line, number }) => `${number}: ${line.trim()}`);

    expect(offenders).toEqual([]);
  });

  it("스크롤 프레임에 min-h-0이 있다 — flex 자식은 min-height:auto라 높이를 넘긴다", () => {
    const frame = source
      .split("\n")
      .find((line) => line.includes("sidebar-scroll-region"));
    expect(frame).toBeDefined();
    expect(frame).toContain("min-h-0");
  });
});
