// pane 카드 모서리는 CSS 규칙과 컨테이너 클리핑이 같은 값을 볼 때만 성립한다.
// 링에만 라운드를 주고 컨테이너 클리핑이 다른 값이면 다시 잘리고, 반대로
// 클리핑만 바꾸면 링이 호를 벗어난다. 두 출처를 이 계약으로 묶어 둔다.
// 서식이 아니라 관계만 본다 — 들여쓰기나 선택자 순서가 바뀌었다고 실패하면
// 게이트가 리팩터링을 막을 뿐 회귀는 못 잡는다.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const paneStyles = readFileSync("src/index.css", "utf8");
const workspace = readFileSync("src/components/workspace/Workspace.tsx", "utf8");

const RADIUS_TOKEN = "var(--glass-radius-pane)";
const INNER_RADIUS_TOKEN = "var(--glass-radius-pane-inner)";
const CORNERS = {
  tl: "top-left",
  tr: "top-right",
  bl: "bottom-left",
  br: "bottom-right",
} as const;

/** 워크스페이스 카드를 클리핑하는 컨테이너의 className */
const cardContainerClasses =
  workspace.match(/className="[^"]*absolute inset-0 overflow-hidden[^"]*"/)?.[0] ?? "";

describe("pane 카드 모서리 스타일 계약", () => {
  it("워크스페이스 클리핑이 라운드 토큰을 쓴다", () => {
    expect(cardContainerClasses).toContain(`rounded-[${RADIUS_TOKEN}]`);
    // 하드코딩으로 되돌아가면 링과 클리핑이 조용히 어긋난다.
    expect(cardContainerClasses).not.toMatch(/rounded-\[\d/);
  });

  it("네 모서리 표시마다 그룹 오버레이에 안쪽 라운드를 준다", () => {
    // [^{}\n]* — 개행을 넘지 않게 묶는다. 개행까지 삼키면 43KB CSS의 실패
    // 지점마다 긴 구간을 다시 쪼개며 되짚어(catastrophic backtracking) 이
    // 계약 하나가 5초 예산을 넘긴다(측정: 코너당 2~3.5초 → 전체 12ms).
    for (const [corner, side] of Object.entries(CORNERS)) {
      const rule = paneStyles.match(
        new RegExp(
          `((?:[^{}\n]*\\[data-pane-card-corners~="${corner}"\\]::after,?\\s*)+)\\{([^}]*)\\}`,
        ),
      );
      expect(rule, `${corner} 규칙이 없다`).not.toBeNull();
      const [, selectors, body] = rule ?? [];
      // Spaces 호버 오버레이(::after)가 사각이면 클리핑 호 바깥으로 나가
      // 잘린다(2026-08-07). 포커스 링은 바깥 box-shadow라 그룹의 라운드를
      // 그대로 따라가므로 여기서 잴 것이 없다.
      expect(selectors).toContain("::after");
      // 그룹 자신도 같은 모서리를 되돌려야 한다 — 안쪽 2px 기본값이 남으면
      // 바깥 모서리에서 그룹 배경이 클리핑 호보다 안쪽으로 깎인다.
      expect(paneStyles).toContain(
        `.dockview-theme-abyss .dv-groupview[data-pane-card-corners~="${corner}"],`,
      );
      // 컨테이너 패딩(1px — 시안의 카드 외곽선이자 포커스 링 한 겹의 자리)만큼 그룹이
      // 안쪽에 있으므로, 그룹 호가 클리핑 호(12px)와 동심이 되려면 반경도
      // 같은 값을 빼야 한다. 12px 그대로면 링이 호 안쪽으로 들어간다.
      expect(body?.replace(/\s+/g, " ").trim()).toBe(
        `border-${side}-radius: calc(${RADIUS_TOKEN} - 1px);`,
      );
    }
  });

  it("안쪽 모서리는 그룹과 오버레이가 같은 작은 라운드를 쓴다", () => {
    // 한쪽만 둥글면 사각인 그룹 배경이 오버레이 밖으로 삐져나오거나 그 반대다.
    const rule = paneStyles.match(
      /((?:[^{}\n]*\.dv-groupview(?:::after)?,?\s*)+)\{\s*border-radius: ([^;]+);\s*\}/,
    );
    expect(rule, "안쪽 라운드 규칙이 없다").not.toBeNull();
    const [, selectors, value] = rule ?? [];
    expect(selectors).toContain("::after");
    expect(value).toBe(INNER_RADIUS_TOKEN);
    // 안쪽까지 카드와 같은 12px이면 카드가 한 장으로 안 읽힌다.
    expect(value).not.toContain(RADIUS_TOKEN);
  });

  it("포커스 링은 pane 바깥에 그리고 카드 외곽선을 덮어쓴다", () => {
    // 바깥은 box-shadow — 그룹의 overflow:hidden이 자식(::before)을 밖으로
    // 못 내보낸다. 색은 불투명이라 갭 위에서도 같은 값이다.
    const outside = paneStyles.match(
      /\.dv-groupview\.dv-active-group \{([^}]*)\}/,
    );
    expect(outside, "바깥 링 규칙이 없다").not.toBeNull();
    const shadow = outside?.[1].match(/box-shadow:\s*([^;]+);/)?.[1] ?? "";
    // 링은 컨테이너 패딩 1px에 정확히 들어가는 한 겹이다 — 바깥에 심을 덧대
    // 2.5px까지 벌렸더니 그 띠가 카드 가장자리로 읽혀 시안(1px)보다 두꺼웠고,
    // 두께로 가시성을 벌던 1.5px는 "두껍다"로 되돌아왔다(2026-09-01).
    expect(shadow).toMatch(/^0 0 0 1px /);
    expect(shadow).toContain("var(--ring)");
    expect(shadow).not.toContain("transparent");

    // dockview는 split container와 view 래퍼 양쪽에서 자른다 — 둘 다 열어야
    // 중첩 분할 pane의 옆 변에도 링이 나온다(2026-08-11 사용자 보고: 세로로
    // 나뉜 pane은 양옆에 보더가 안 생김).
    expect(paneStyles).toMatch(
      /\.dv-split-view-container,\s*[^{]*\.dv-view \{\s*overflow: visible;\s*\}/,
    );
    // 사시의 ±10px 히트 띠는 다시 가둔다.
    expect(paneStyles).toMatch(
      /\.dv-split-view-container > \.dv-sash-container \{\s*overflow: hidden;\s*\}/,
    );

    // 변마다 안쪽에 겹쳐 그리던 폴백은 없어야 한다 — 카드 외곽선과 두 줄로
    // 서 보였다(2026-08-11 사용자 보고).
    expect(paneStyles).not.toContain("data-pane-card-edges");
  });

  it("a pane that fills the card draws no focus ring", () => {
    // One pane in a space is the card itself: the ring would only repaint the
    // card outline brighter, and there is no second pane to tell it from
    // (owner decision 2026-09-03). The state is read off the corner marks the
    // measurement already writes, so the rule needs every one of the four —
    // fewer would silence the ring on ordinary corner panes too.
    const rule = paneStyles.match(
      /\.dv-groupview\.dv-active-group((?:\[data-pane-card-corners~="(?:tl|tr|bl|br)"\]){4}) \{([^}]*)\}/,
    );
    expect(rule, "single-pane ring rule is missing").not.toBeNull();
    const [, marks, body] = rule ?? [];
    for (const corner of Object.keys(CORNERS)) {
      expect(marks).toContain(`[data-pane-card-corners~="${corner}"]`);
    }
    expect(body?.replace(/\s+/g, " ").trim()).toBe("box-shadow: none;");
  });

  it("카드 외곽선은 덮어쓸 수 있는 자리에 한 번만 그린다", () => {
    // border는 padding box 바깥이라 overflow-hidden이 자르고, 포커스된 pane이
    // 그 자리를 못 덮는다 — 외곽선과 포커스 선이 두 줄로 섰다(2026-08-11).
    // padding + inset ring이면 띠가 클리핑 안쪽이라 pane의 box-shadow가 닿는다.
    // 패딩 폭 1px는 시안의 카드 외곽선이자 포커스 링 한 겹의 자리다.
    expect(cardContainerClasses).toContain("p-px");
    expect(cardContainerClasses).toContain("pane-card-surface");
    expect(cardContainerClasses).not.toContain("border border-[");
    const surface = paneStyles.match(/\.pane-card-surface \{([^}]*)\}/);
    expect(surface, "카드 표면 규칙이 없다").not.toBeNull();
    expect(surface?.[1]).toContain(
      "inset 0 0 0 1px var(--glass-card-outline)",
    );
    // 그림자를 잃으면 카드가 셸 위에 떠 보이지 않는다.
    expect(surface?.[1]).toContain("var(--glass-shadow-pane)");

    // 선택자 문자열이 아니라 효과로 막는다: .dv-groupview 의 오버레이가
    // 눈에 보이는 border를 선언하면 어떤 이름·공백으로 써도 걸린다.
    const overlayRules = paneStyles.matchAll(
      /\.dv-groupview(?:\[[^\]]*\])?::(?:before|after)[^{]*\{([^}]*)\}/g,
    );
    for (const [, body] of overlayRules) {
      const border = body.match(/border(?:-(?:top|right|bottom|left))?:\s*([^;]*);/);
      if (!border) continue;
      expect(
        border[1],
        `그룹 오버레이가 보이는 외곽선을 그린다: ${border[0]}`,
      ).toMatch(/transparent|color-mix|var\(--ring\)/);
    }
  });

  it("외곽선 색은 모드별 토큰 한 곳에서 나오고 두 모드 다 선을 긋지 않는다", () => {
    // 카드의 가장자리는 1px sheet 띠가 긋는다. 그 위에 다른 색 링을 얹으면
    // 테두리가 두 줄로 읽히므로(2026-09-01 사용자 보고) 두 모드 모두 sheet
    // 색이다 — 투명으로 두면 컨테이너 배경이 비쳐 어차피 같은 띠가 되지만,
    // 값의 출처를 모드별 토큰 한 곳으로 묶어 두려고 값으로 적는다.
    const declarations = paneStyles.match(/--glass-card-outline:\s*[^;]+;/g) ?? [];
    expect(declarations).toHaveLength(2);
    for (const declaration of declarations) {
      expect(declaration).toMatch(/var\(--glass-sheet\)/);
    }
  });

});
