import { describe, expect, it } from "vitest";
import { preprocessCSS, resolveConfig } from "vite";
import { scopeChildIndexSelectors } from "./css-child-index-scope.mjs";

describe("CSS child-index invalidation scope", () => {
  it.each([
    ".space-y-2", ".space-x-3", ".divide-y", ".divide-border",
    String.raw`.space-y-0\.5`, String.raw`.divide-border\/50`,
    String.raw`.lg\:space-y-2`, String.raw`.space-y-\[13px\]`,
    String.raw`.escaped\,class`, String.raw`.escaped\>class`,
  ])("scopes %s without changing either zero-specificity test", (parent) => {
    const rule = { selectors: [`:where(${parent} > :not(:last-child))`], nodes: [{ prop: "margin-block-end", value: "8px" }] };
    const nodes = rule.nodes;
    const plugin = scopeChildIndexSelectors();
    plugin.Rule(rule);
    expect(rule.selectors).toEqual([`:where(${parent}) > :where(:not(:last-child))`]);
    expect(rule.nodes).toBe(nodes);
    plugin.Rule(rule);
    expect(rule.selectors).toEqual([`:where(${parent}) > :where(:not(:last-child))`]);
  });

  it("accepts minified combinator spacing", () => {
    const rule = { selectors: [":where(.divide-y>:not(:last-child))"] };
    scopeChildIndexSelectors().Rule(rule);
    expect(rule.selectors).toEqual([":where(.divide-y) > :where(:not(:last-child))"]);
  });

  it.each([
    ":where(.a.b > :not(:last-child))",
    ":where(.a .b > :not(:last-child))",
    ":where(.a, .b > :not(:last-child))",
    ":where(.a:hover > :not(:last-child))",
    ":where([data-parent] > :not(:last-child))",
    ":where(#parent > :not(:last-child))",
    ":where(& > :not(:last-child))",
    ":where(.a > :not(:first-child))",
    ":where(.a > :last-child)",
    ".outer :where(.a > :not(:last-child))",
    ":where(.a) > :where(:not(:last-child))",
    String.raw`:where(.\31 23 > :not(:last-child))`,
  ])("leaves unsupported/already-scoped selector %s intact", (selector) => {
    const selectors = [selector];
    const rule = { selectors };
    scopeChildIndexSelectors().Rule(rule);
    expect(rule.selectors).toBe(selectors);
  });

  it("handles merged utilities without touching a complex list member", () => {
    const rule = { selectors: [":where(.divide-border>:not(:last-child))", String.raw`:where(.divide-border\/50>:not(:last-child))`, ":is(.a, .b)"] };
    scopeChildIndexSelectors().Rule(rule);
    expect(rule.selectors).toEqual([":where(.divide-border) > :where(:not(:last-child))", String.raw`:where(.divide-border\/50) > :where(:not(:last-child))`, ":is(.a, .b)"]);
  });

  it("uses PostCSS list parsing in Vite while preserving layers, media and declarations", async () => {
    const config = await resolveConfig({ configFile: false,
      css: { postcss: { plugins: [scopeChildIndexSelectors()] } } }, "build");
    const selector = String.raw`:where(.lg\:space-y-2>:not(:last-child)),:where(.escaped\,class>:not(:last-child)),:is(.a,.b)`;
    const css = `@layer utilities { @media (width >= 64rem) { ${selector} { margin-block-end: var(--space); } } }`;
    const { code } = await preprocessCSS(css, "child-index-fixture.css", config);
    expect(code).toBe(css.replace(selector,
      String.raw`:where(.lg\:space-y-2) > :where(:not(:last-child)),:where(.escaped\,class) > :where(:not(:last-child)),:is(.a,.b)`));
  });
});
