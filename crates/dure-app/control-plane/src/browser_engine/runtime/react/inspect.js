// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/. License: ../environment/device/LICENSE-agent-browser.

(() => {
  const id = {{ID}};
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const ri = hook && hook.rendererInterfaces && hook.rendererInterfaces.get && hook.rendererInterfaces.get(1);
  if (!ri) throw new Error("No React renderer attached");
  if (!ri.hasElementWithId(id)) throw new Error("element " + id + " not found (page reloaded?)");
  const result = ri.inspectElement(1, id, null, true);
  if (!result || result.type !== "full-data") {
    throw new Error("inspect failed: " + (result && result.type));
  }
  const v = result.value;
  const name = ri.getDisplayNameForElementID(id);
  const lines = [name + " #" + id];
  if (v.key != null) lines.push("key: " + JSON.stringify(v.key));
  section("props", v.props);
  section("hooks", v.hooks);
  section("state", v.state);
  section("context", v.context);
  if (v.owners && v.owners.length) {
    lines.push("rendered by: " + v.owners.map((o) => o.displayName).join(" > "));
  }
  const source = Array.isArray(v.source)
    ? [v.source[1], v.source[2], v.source[3]]
    : null;
  return JSON.stringify({ text: lines.join("\n"), source });

  function section(label, payload) {
    const data = (payload && payload.data) || payload;
    if (data == null) return;
    if (Array.isArray(data)) {
      if (data.length === 0) return;
      lines.push(label + ":");
      for (const h of data) lines.push("  " + hookLine(h));
    } else if (typeof data === "object") {
      const entries = Object.entries(data);
      if (entries.length === 0) return;
      lines.push(label + ":");
      for (const [k, val] of entries) lines.push("  " + k + ": " + preview(val));
    }
  }
  function hookLine(h) {
    const idx = h.id != null ? "[" + h.id + "] " : "";
    const sub = h.subHooks && h.subHooks.length ? " (" + h.subHooks.length + " sub)" : "";
    return idx + h.name + ": " + preview(h.value) + sub;
  }
  function preview(v) {
    if (v == null) return String(v);
    if (typeof v !== "object") return JSON.stringify(v);
    if (v.type === "undefined") return "undefined";
    if (v.preview_long) return v.preview_long;
    if (v.preview_short) return v.preview_short;
    if (Array.isArray(v)) return "[" + v.map(preview).join(", ") + "]";
    const entries = Object.entries(v).map((e) => e[0] + ": " + preview(e[1]));
    return "{" + entries.join(", ") + "}";
  }
})()
