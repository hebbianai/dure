// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/scripts.rs. Registered only on the admitted Page session.
// License: ../environment/device/LICENSE-agent-browser.

(() => {
  if (window.__AB_VITALS_INSTALLED__) return;
  window.__AB_VITALS_INSTALLED__ = true;

  const cwv = { lcp: null, cls: 0, clsEntries: [], fcp: null, inp: null };
  window.__AB_VITALS__ = cwv;

  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        cwv.lcp = {
          startTime: Math.round(last.startTime * 100) / 100,
          size: last.size,
          element: last.element && last.element.tagName ? last.element.tagName.toLowerCase() : null,
          url: last.url || null,
        };
      }
    }).observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          cwv.cls += entry.value;
          cwv.clsEntries.push({
            value: Math.round(entry.value * 10000) / 10000,
            startTime: Math.round(entry.startTime * 100) / 100,
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === "first-contentful-paint") {
          cwv.fcp = Math.round(entry.startTime * 100) / 100;
        }
      }
    }).observe({ type: "paint", buffered: true });
  } catch {}

  try {
    new PerformanceObserver((list) => {
      let worst = cwv.inp || 0;
      for (const entry of list.getEntries()) {
        if (entry.duration > worst) worst = entry.duration;
      }
      if (worst > 0) cwv.inp = Math.round(worst * 100) / 100;
    }).observe({ type: "event", buffered: true, durationThreshold: 40 });
  } catch {}

  // React profiling build emits console.timeStamp(label, start, end, track, trackGroup, color)
  // for reconciler phases and per-component hydration timing. Intercept and collect.
  const timing = [];
  window.__AB_REACT_TIMING__ = timing;
  const orig = console.timeStamp;
  console.timeStamp = function (label) {
    const args = arguments;
    if (typeof label === "string" && args.length >= 3 && typeof args[1] === "number") {
      timing.push({
        label,
        startTime: args[1],
        endTime: args[2],
        track: args[3] || "",
        trackGroup: args[4] || "",
        color: args[5] || "",
      });
    }
    return orig.apply(console, args);
  };
})()
