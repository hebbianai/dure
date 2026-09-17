import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANE_COLORS } from "./gitGraph";

// Figma base/lane palettes as they existed before tokenization — the token
// migration must preserve every byte of these values in index.css.
const LIGHT_HEXES = [
  "#64a6fc", "#a78bfa", "#fb8783", "#46d1d6", "#f8d356",
  "#99d464", "#11b6e8", "#26d8a0", "#ed86c7", "#f48252",
];
const DARK_HEXES = [
  "#64a6fc", "#b78ff0", "#fb7a76", "#00bfc6", "#cb9d00",
  "#7db64a", "#00acdf", "#00c084", "#e87ec1", "#f68251",
];

describe("gitGraph lane palette", () => {
  it("모든 레인이 var(--scm-lane-N) 토큰을 내놓는다", () => {
    expect(LANE_COLORS).toHaveLength(10);
    LANE_COLORS.forEach((color, i) => {
      expect(color).toBe(`var(--scm-lane-${i})`);
    });
  });

  it("index.css가 이전 라이트/다크 팔레트 헥스 20개를 --scm-lane-* 정의로 보존한다", () => {
    const css = readFileSync(new URL("../../../index.css", import.meta.url), "utf8");
    // Containment must be judged inside the rule's braces, not by document
    // order — a definition drifting outside :root/.dark (or a duplicate
    // redefinition later in the cascade) must fail here.
    const ruleBlock = (selector: string): string => {
      const start = css.indexOf(selector);
      expect(start, `${selector.trim()} rule exists`).toBeGreaterThan(-1);
      let depth = 0;
      let i = css.indexOf("{", start);
      for (; i < css.length; i++) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}" && --depth === 0) break;
      }
      return css.slice(start, i + 1);
    };
    const rootBlock = ruleBlock(":root {");
    const darkBlock = ruleBlock("\n.dark {");

    LIGHT_HEXES.forEach((hex, i) => {
      expect(rootBlock, `light lane ${i} (${hex}) defined inside :root`).toContain(
        `--scm-lane-${i}: ${hex};`,
      );
    });
    DARK_HEXES.forEach((hex, i) => {
      expect(darkBlock, `dark lane ${i} (${hex}) defined inside .dark`).toContain(
        `--scm-lane-${i}: ${hex};`,
      );
    });
    for (let i = 0; i < LIGHT_HEXES.length; i++) {
      const occurrences = css.split(`--scm-lane-${i}:`).length - 1;
      expect(occurrences, `lane ${i} defined exactly twice (light + dark)`).toBe(2);
    }
  });
});
