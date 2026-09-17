(locator) => {
  const normalize = value => (value ?? "").replace(/\s+/gu, " ").trim();
  const matches = (value, expected = locator.value) => value !== null && (locator.exact
    ? normalize(value) === normalize(expected)
    : normalize(value).toLowerCase().includes(normalize(expected).toLowerCase()));
  if (locator.kind === "nth" && locator.selector.startsWith("xpath=")) {
    const nodes = document.evaluate(locator.selector.slice(6), document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (nodes.snapshotLength > 50_000) throw Error("browser_locator_limit");
    const index = locator.index < 0 ? nodes.snapshotLength + locator.index : locator.index;
    return index < 0 ? null : nodes.snapshotItem(index);
  }
  // Isolated-world lookups return the node itself; page attributes stay intact.
  const all = [];
  const pending = [...document.children].reverse();
  while (pending.length) {
    const node = pending.pop();
    all.push(node);
    if (all.length > 50_000) throw Error("browser_locator_limit");
    const children = [...(node.shadowRoot?.children ?? []), ...node.children];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  if (locator.kind === "nth") {
    const nodes = all.filter(node => node.matches(locator.selector));
    return nodes[locator.index < 0 ? nodes.length + locator.index : locator.index] ?? null;
  }
  if (locator.kind === "text") {
    return all.find(node => !["SCRIPT", "STYLE", "HEAD", "HTML", "BODY"].includes(node.tagName)
      && matches(node.textContent) && ![...node.children].some(child => matches(child.textContent))) ?? null;
  }
  if (locator.kind === "label") {
    return all.find(node => {
      const references = node.getAttribute("aria-labelledby");
      if (references) return matches(references.split(/\s+/u).map(id => node.getRootNode().getElementById(id)?.textContent ?? "").join(" "));
      const aria = node.getAttribute("aria-label");
      if (aria !== null) return matches(aria);
      return node.labels && [...node.labels].some(label => matches(label.textContent));
    }) ?? null;
  }
  if (locator.kind === "role") {
    return all.find(node => (node.getAttribute("role") ?? "").toLowerCase().split(/\s+/u).includes(locator.value.toLowerCase())
      && (locator.name === null || matches(node.getAttribute("aria-label") ?? node.textContent, locator.name))) ?? null;
  }
  const attribute = {placeholder: "placeholder", alt: "alt", title: "title", testid: "data-testid"}[locator.kind];
  return all.find(node => locator.kind === "testid"
    ? node.getAttribute(attribute) === locator.value
    : matches(node.getAttribute(attribute))) ?? null;
}
