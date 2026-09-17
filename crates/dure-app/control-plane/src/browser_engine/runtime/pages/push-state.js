// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// PUSHSTATE from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/scripts.rs. Dure quotes the URL placeholder, substitutes
// a JSON URL and executes it through the admitted Host renderer transport.
// License: ../environment/device/LICENSE-agent-browser.

((url) => {
  const before = location.href;
  const absolute = new URL(url, before).href;
  if (absolute === before) return before;

  // Next.js pages + app router expose window.next.router with a `push`
  // method that triggers the RSC fetch and re-render pipeline.
  const r = typeof window.next === "object" && window.next && window.next.router;
  if (r && typeof r.push === "function") {
    try { r.push(url); return location.href; } catch {}
  }

  history.pushState(null, "", absolute);
  try { dispatchEvent(new PopStateEvent("popstate", { state: null })); } catch {}
  try { dispatchEvent(new Event("navigate")); } catch {}
  return location.href;
})("{{URL}}")
