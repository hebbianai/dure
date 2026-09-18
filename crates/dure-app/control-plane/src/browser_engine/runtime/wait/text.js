(text) => {
  if ((document.body?.innerText ?? "").includes(text)) return true;
  // Execute in the existing isolated world. Never call page-owned getters or
  // cross an iframe boundary; the selected frame supplies this document.
  const pending = [...document.children];
  let visited = 0;
  while (pending.length) {
    const node = pending.pop();
    if (++visited > 50_000) throw Error("browser_wait_text_limit");
    for (const child of node.children) pending.push(child);
    const shadow = node.shadowRoot;
    if (!shadow) continue;
    for (const child of shadow.children) pending.push(child);
    const pieces = [];
    for (const child of shadow.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const range = document.createRange();
        range.selectNodeContents(child);
        if (range.getClientRects().length && getComputedStyle(node).visibility !== "hidden") pieces.push(child.textContent);
      } else if (child instanceof HTMLElement) {
        // innerText falls back to textContent for display:none elements.
        // Require rendered geometry so hidden shadow content cannot satisfy a wait.
        const style = getComputedStyle(child);
        const range = document.createRange();
        range.selectNodeContents(child);
        if (range.getClientRects().length) {
          const boundary = style.display.startsWith("inline") || style.display === "contents" ? "" : "\n";
          pieces.push(boundary + child.innerText + boundary);
        }
      }
    }
    if (pieces.join("").includes(text)) return true;
  }
  return false;
}
