import { describe, expect, it } from "vitest";
import { SEARCH_FIELD_SURFACE, SEARCH_FIELD_SURFACE_WITHIN } from "@/lib/ui/searchField";

describe("검색 입력 표면", () => {
  const surfaces = [SEARCH_FIELD_SURFACE, SEARCH_FIELD_SURFACE_WITHIN];

  it("양쪽 모드에서 셸 위로 떠오르는 면을 쓴다", () => {
    for (const surface of surfaces) {
      // 다크는 Figma의 chrome(흰색 6%)이 그대로 들어올림이 된다. 라이트에서는
      // 같은 토큰이 검정 3.5%라 회색 셸에 가라앉아, 분리를 테두리 혼자 지고
      // 외곽선만 튀었다(2026-09-08). 라이트는 흰 면으로 뒤집는다.
      expect(surface).toContain("dark:bg-glass-chrome");
      expect(surface).toContain("bg-background/70");
      // 유리 위의 선은 사이드바의 선 토큰(glass/hairline)이다 — --border의 라이트값은
      // 불투명 회색이라 유리 위에 고정선으로 앉았다(오너 지적 2026-09-09).
      expect(surface).toContain("border-glass-hairline");
      expect(surface).not.toContain("border-border ");
      expect(surface).toContain("shadow-none");
      expect(surface).not.toContain("shadow-xs");
    }
  });

  it("색을 hex로 직접 쓰지 않는다", () => {
    for (const surface of surfaces) {
      expect(surface).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("포커스를 링으로 표시한다", () => {
    for (const surface of surfaces) {
      expect(surface).toMatch(/ring-ring\/50/);
    }
  });

  it("호버는 같은 유리 계열 틴트로 받는다", () => {
    for (const surface of surfaces) {
      expect(surface).toContain("hover:bg-glass-tint-hover");
    }
  });
});
