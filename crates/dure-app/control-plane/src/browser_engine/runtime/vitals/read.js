// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/scripts.rs. Registered only on the admitted Page session.
// License: ../environment/device/LICENSE-agent-browser.

(() => {
  const cwv = window.__AB_VITALS__ || {};
  const timing = window.__AB_REACT_TIMING__ || [];
  const nav = performance.getEntriesByType("navigation")[0];
  const ttfb = nav
    ? Math.round((nav.responseStart - nav.requestStart) * 100) / 100
    : null;
  return JSON.stringify({ cwv, timing, ttfb });
})()
