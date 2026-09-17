// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 Vercel Inc.
// Adapted from agent-browser c830d1b67dc18b754e305859f0ae587f858a1447,
// cli/src/native/react/. License: ../environment/device/LICENSE-agent-browser.

(() => {
  const active = window.__AB_RENDERS_ACTIVE__;
  if (!active) throw new Error("renders recording not active - run `react renders start` first");

  const data = window.__AB_RENDERS__;
  const startTime = window.__AB_RENDERS_START__;
  const elapsed = performance.now() - startTime;

  const fpsData = window.__AB_RENDERS_FPS__;
  let fpsStats = { avg: 0, min: 0, max: 0, drops: 0 };
  if (fpsData) {
    cancelAnimationFrame(fpsData.rafId);
    if (fpsData.frames.length > 0) {
      const fpsSamples = fpsData.frames.map((dt) => (dt > 0 ? 1000 / dt : 0));
      const sum = fpsSamples.reduce((a, b) => a + b, 0);
      fpsStats = {
        avg: Math.round(sum / fpsSamples.length),
        min: Math.round(fpsSamples.reduce((minimum, fps) => Math.min(minimum, fps), Infinity)),
        max: Math.round(fpsSamples.reduce((maximum, fps) => Math.max(maximum, fps), -Infinity)),
        drops: fpsSamples.filter((f) => f < 30).length,
      };
    }
  }

  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const orig = window.__AB_RENDERS_ORIG_COMMIT__;
  if (hook && hook.onCommitFiberRoot === window.__AB_RENDERS_COMMIT__) hook.onCommitFiberRoot = orig;

  delete window.__AB_RENDERS__;
  delete window.__AB_RENDERS_START__;
  delete window.__AB_RENDERS_ACTIVE__;
  delete window.__AB_RENDERS_ORIG_COMMIT__;
  delete window.__AB_RENDERS_COMMIT__;
  delete window.__AB_RENDERS_FPS__;

  if (!data) {
    return JSON.stringify({
      elapsed: 0, fps: fpsStats, totalRenders: 0, totalMounts: 0,
      totalReRenders: 0, totalComponents: 0, components: [],
    });
  }

  const round = (n) => Math.round(n * 100) / 100;
  const components = Object.entries(data)
    .map(([name, entry]) => {
      const summary = Object.create(null);
      for (const c of entry.changes) {
        const key = c.type === "props" ? "props." + c.name
          : c.type === "state" ? "state (" + c.name + ")"
          : c.type === "context" ? "context (" + c.name + ")"
          : c.type === "parent" ? "parent (" + c.name + ")"
          : c.type;
        summary[key] = (summary[key] || 0) + 1;
      }
      return {
        name,
        count: entry.count,
        mounts: entry.mounts,
        reRenders: entry.count - entry.mounts,
        instanceCount: entry._instances.size,
        totalTime: round(entry.totalTime),
        selfTime: round(entry.selfTime),
        domMutations: entry.domMutations,
        changes: entry.changes,
        changeSummary: summary,
      };
    })
    .sort((a, b) => b.totalTime - a.totalTime || b.count - a.count);

  return JSON.stringify({
    elapsed: round(elapsed / 1000),
    fps: fpsStats,
    totalRenders: components.reduce((s, c) => s + c.count, 0),
    totalMounts: components.reduce((s, c) => s + c.mounts, 0),
    totalReRenders: components.reduce((s, c) => s + c.reRenders, 0),
    totalComponents: components.length,
    components,
  });
})()
