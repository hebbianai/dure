// Frontend performance harness — drives the REAL app in headless Chromium with
// a canned Tauri backend, exercises the interactions a user actually feels, and
// records real render/reflow numbers. Reproducible from bash:
//
//   pnpm exec vite --port 1425 --strictPort &   # or PERF_URL=<preview build>
//   node scripts/qa/frontend-perf.mjs
//
// Backend data is mocked; DOM / CodeMirror / dockview rendering is 100% real.
// Dev-server numbers are inflated vs a production build (unbundled modules);
// set PERF_URL to a `vite preview` build for release-representative figures.
import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import {
  assertFrontendPerformanceResult,
  formatPageError,
} from "./lib/frontend-perf-contract.mjs";

const APP_URL = process.env.PERF_URL ?? "http://localhost:1425";
const OUT = process.env.PERF_OUT ?? "/tmp/frontend-perf.json";
const mock = readFileSync(new (globalThis.URL)("./tauri-mock.js", import.meta.url), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(formatPageError(error)));
await page.addInitScript(mock);

// Sample rAF frames in-page while `interact` runs node-side interactions.
async function sampleDuring(windowMs, interact) {
  await page.evaluate((ms) => {
    window.__perf = window.__DURE_FRAME_SAMPLE__(ms);
  }, windowMs);
  await interact();
  return page.evaluate(() => window.__perf);
}

const cmCount = () => page.evaluate(() => document.querySelectorAll(".cm-editor").length);
const groupCount = () =>
  page.evaluate(() => document.querySelectorAll(".dv-groupview").length);

await page.goto(APP_URL, { waitUntil: "networkidle" });
await page.waitForFunction(
  () =>
    typeof window.__DURE_DOCK__ === "object" &&
    typeof window.__DURE_STORE__ === "function" &&
    typeof window.__DURE_FRAME_SAMPLE__ === "function",
  null,
  { timeout: 15000 },
);
const desktopId = await page.evaluate(() => window.__DURE_STORE__.getState().activeDesktopId);

const results = { url: APP_URL, startedAt: new Date().toISOString() };

// 1) Idle rendering — baseline smoothness with nothing happening.
results.idleFrames = await sampleDuring(2000, async () => {
  await page.waitForTimeout(2000);
});

// 2) Pane-open — open several file panes (first = cold chunk load, rest = warm).
for (let i = 0; i < 5; i++) {
  await page.evaluate(
    ([dt, n]) => {
      window.__DURE_DOCK__.openFileViewer(dt, {
        path: `/repo/src/module-${n}.ts`,
        source: "local",
      });
    },
    [desktopId, i],
  );
  await page.waitForTimeout(700); // let the editor mount + settle between opens
}
await page.waitForSelector(".cm-editor", { timeout: 8000 });
results.paneOpen = await page.evaluate(() => window.__DURE_WORKSPACE_REPORT__().paneOpen);
results.panesAfterOpen = { cmEditors: await cmCount(), groups: await groupCount() };

// 3) Resize reflow — does the layout re-render smoothly as the window resizes?
const sizes = [
  [1100, 720],
  [900, 640],
  [1280, 800],
  [760, 900],
  [1440, 900],
];
results.resizeFrames = await sampleDuring(2600, async () => {
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(400);
  }
});
results.panesAfterResize = { cmEditors: await cmCount(), groups: await groupCount() };

// 4) Pane-move reflow — move a pane to a new split and back; measure the churn.
results.moveFrames = await sampleDuring(2200, async () => {
  await page.evaluate((dt) => {
    const dock = window.__DURE_DOCK__;
    // Force layout churn through the real dockview path: open two more panes
    // (auto-split), then a real tab drag below relocates one. Each reflows.
    dock.openFileViewer(dt, { path: "/repo/src/move-a.ts", source: "local" });
    dock.openFileViewer(dt, { path: "/repo/src/move-b.ts", source: "local" });
  }, desktopId);
  await page.waitForTimeout(500);
  // Drag the last tab to the left edge to relocate the pane (real DnD gesture).
  const tabs = page.locator(".dv-tab");
  const count = await tabs.count();
  if (count >= 2) {
    const src = tabs.nth(count - 1);
    const box = await page.locator(".dv-groupview").first().boundingBox();
    if (box) {
      await src.dragTo(page.locator("body"), {
        targetPosition: { x: box.x + 20, y: box.y + box.height / 2 },
        force: true,
      });
    }
  }
  await page.waitForTimeout(500);
});
results.panesAfterMove = { cmEditors: await cmCount(), groups: await groupCount() };

// 5) Desktop switch — add a second desktop and flip between them. The first
// visit is intentionally long enough for the new workspace's initial terminal
// hydration to paint, giving remountCost a real cold-path sample instead of
// racing back to the original desktop after the transport's settle window.
results.switchFrames = await sampleDuring(2800, async () => {
  // Create and activate in ONE evaluate: any gap lets the idle neighbor
  // prewarm mount the new desktop first, turning this deterministic cold
  // sample into a (timing-dependent) warm one and starving the remountCost
  // gate below.
  const second = await page.evaluate(async () => {
    const st = window.__DURE_STORE__.getState();
    if (!st.addDesktop) return null;
    const id = st.addDesktop({ activate: false });
    window.__DURE_STORE__.getState().setActiveDesktop(id);
    // A new desktop no longer creates a terminal automatically. Open one
    // through the current Hmux path inside the cold-switch capture window so
    // attach, viewport hydration, and remount paint are measured together.
    const dock = window.__DURE_DOCK__;
    const api = await dock.waitForDesktopDockview(id);
    if (api) dock.openLocalTerminalPanel(id);
    return id;
  });
  if (second) {
    await page.waitForTimeout(1200);
    for (let i = 1; i < 4; i++) {
      await page.evaluate(
        ([a, b, even]) => window.__DURE_STORE__.getState().setActiveDesktop(even ? b : a),
        [desktopId, second, i % 2 === 0],
      );
      await page.waitForTimeout(350);
    }
  }
});
results.switchReport = await page.evaluate(
  () => window.__DURE_WORKSPACE_REPORT__().switchPaint,
);
// Cold-path regression-gate metric (P1-e): remount+rehydration isolated cost.
results.remountCost = await page.evaluate(
  () => window.__DURE_WORKSPACE_REPORT__().remountCost,
);
const journeyReport = await page.evaluate(() => window.__DURE_WORKSPACE_REPORT__());
results.journeys = journeyReport.journeys;
results.paneFocus = journeyReport.paneFocus;
results.recentTransitions = journeyReport.recentTransitions;
results.backendCommands = await page.evaluate(
  () => window.__DURE_FRONTEND_PERF_MOCK__?.commandCounts ?? {},
);

results.pageErrorSample = [...new Set(pageErrors)].slice(0, 8);
results.finishedAt = new Date().toISOString();

writeFileSync(OUT, JSON.stringify(results, null, 2));

// Compact human summary.
const f = (s) =>
  s ? `fps=${s.fps?.toFixed(0)} median=${s.medianFrameMs?.toFixed(1)}ms p95=${s.p95FrameMs?.toFixed(1)}ms worst=${s.worstFrameMs?.toFixed(1)}ms jank=${((s.jankRatio ?? 0) * 100).toFixed(1)}%` : "n/a";
const po = results.paneOpen?.byKind?.file;
console.log("── Frontend performance (headless Chromium, mocked backend) ──");
console.log("URL                :", APP_URL);
console.log("idle               :", f(results.idleFrames));
console.log("during resize      :", f(results.resizeFrames), "| panes:", JSON.stringify(results.panesAfterResize));
console.log("during pane-move   :", f(results.moveFrames), "| panes:", JSON.stringify(results.panesAfterMove));
console.log("during desktop-swap:", f(results.switchFrames));
console.log(
  "pane-open (file)   : cold median",
  po?.cold?.median?.toFixed?.(1) ?? "n/a",
  "ms (n=" + (po?.cold?.count ?? 0) + ") · warm median",
  po?.warm?.median?.toFixed?.(1) ?? "n/a",
  "ms (n=" + (po?.warm?.count ?? 0) + ")",
);
console.log("switch paint       :", JSON.stringify(results.switchReport?.cold), "(cold)");
console.log("remount cost (cold):", JSON.stringify(results.remountCost));
console.log("workspace journeys :", JSON.stringify(results.journeys));
console.log("pane focus         :", JSON.stringify(results.paneFocus));
console.log("backend commands   :", JSON.stringify(results.backendCommands));
console.log("distinct page errors:", results.pageErrorSample.length);
console.log("full JSON          :", OUT);
await browser.close();
assertFrontendPerformanceResult(results);
