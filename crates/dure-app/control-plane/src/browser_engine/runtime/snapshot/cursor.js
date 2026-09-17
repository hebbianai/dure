function() {
  if (!this.isConnected || !document.body?.contains(this) || this.closest('[hidden], [aria-hidden="true"]')) return null;
  const rect = this.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const pointer = getComputedStyle(this).cursor === "pointer";
  const onclick = this.hasAttribute("onclick");
  const tabindex = this.getAttribute("tabindex");
  const contenteditable = this.getAttribute("contenteditable");
  const editable = contenteditable === "" || contenteditable === "true";
  const input = this.querySelector('input[type="radio"], input[type="checkbox"]');
  let hiddenRole = null;
  let checked = null;
  if (input) {
    const style = getComputedStyle(input);
    if (input.hidden || style.display === "none" || style.visibility === "hidden") {
      hiddenRole = input.type;
      checked = input.indeterminate ? "mixed" : String(input.checked);
    }
  }
  return {
    pointer, onclick, editable,
    focusable: tabindex !== null && tabindex !== "-1",
    inheritedPointer: pointer && this.parentElement !== null && getComputedStyle(this.parentElement).cursor === "pointer",
    text: (this.textContent || "").trim().slice(0, 100),
    hiddenRole, checked,
  };
}
