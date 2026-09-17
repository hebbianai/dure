// Keep the parent test outside :where's child-index condition. WebKit otherwise
// invalidates unrelated terminal descendants when a dropzone sibling is added.
// Match only one class + this exact child condition; leave complex selectors alone.
const utilityChild = /^:where\((\.(?:[\w-]|\\[^\r\n\f])+)\s*>\s*:not\(:last-child\)\)$/u;

export function scopeChildIndexSelectors() {
  return {
    postcssPlugin: "dure-child-index-scope",
    /** @param {{ selectors: string[] }} rule */
    Rule(rule) {
      // Both halves remain zero-specificity; declarations/layers stay untouched.
      // PostCSS owns list parsing, including escaped/nested commas. Tailwind's
      // production optimizer can merge several utilities into one selector list.
      const selectors = rule.selectors;
      const scoped = selectors.map((selector) =>
        selector.replace(utilityChild, ":where($1) > :where(:not(:last-child))"));
      if (scoped.some((selector, index) => selector !== selectors[index])) {
        rule.selectors = scoped;
      }
    },
  };
}
