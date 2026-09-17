#!/usr/bin/env node

// Explicit, isolated WebKit QA; not a native app or a transport-only CI gate.
// Run: node scripts/qa/pane-focus-style.mjs (requires installed Playwright WebKit).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { webkit } from "@playwright/test";
import tailwindcss from "@tailwindcss/vite";
import { build as buildCss, createServer } from "vite";
import { ensureHeadroom } from "../lib/build-storage-admission.mjs";
import { scopeChildIndexSelectors } from "../lib/css-child-index-scope.mjs";
import { requireCurrentNodeDependencyInstall } from "../node-dependency-preflight.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
requireCurrentNodeDependencyInstall(root);
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
let dockRequire = require;
for (const name of ["dockview-react", "dockview", "dockview-core"]) {
  dockRequire = createRequire(dockRequire.resolve(name));
}
const dockCss = readFileSync(dockRequire.resolve("../styles/dockview.css"), "utf8");
const cases = [
  ["sessions/SessionListRow.tsx", "group/item", "opacity"],
  ["ssh/SshPane.tsx", "group/ssh", "opacity"],
  ["spaces/LocationManagerDialog.tsx", "group", "opacity"],
  ["ui/disclosure-chevron.tsx", "group/label", "visibility"],
].flatMap(([file, group, property]) => {
  const source = readFileSync(new URL(`../../src/components/${file}`, import.meta.url), "utf8");
  // Exercise the actual caller tokens, not a parallel copy that stays green
  // when production classes change. All five callers must remain covered.
  const classes = (source.match(/[^\s"`]*focus-within[^\s"`]*/g) ?? [])
    .filter((token) => token.startsWith("group-") || token.startsWith("["));
  return classes.map((focusClass) => ({ file, group, property, focusClass }));
});
assert.equal(cases.length, 5, "Update coverage deliberately when focus-reveal callers change");
const admission = ensureHeadroom({
  cwd: root, requestedBytes: 512 * 1024 * 1024, label: "pane focus style QA",
  reclaimOutputs: () => { throw new Error("Focus QA does not reclaim other outputs"); },
});
if (!admission.ok) throw new Error(admission.message);
let server;
let browser;
try {
  server = await createServer({
    root, configFile: false, plugins: [tailwindcss()], logLevel: "error",
    css: { postcss: { plugins: [scopeChildIndexSelectors()] } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { hmr: false, middlewareMode: true },
  });
  const css = await server.transformRequest("/src/index.css?direct");
  assert.ok(css, "Production CSS must compile");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("./pane-focus-style.fixture.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", globalName: "focusStyleQa",
    platform: "browser", alias: { "@": `${root}src` },
  });
  await server.close();
  server = undefined;
  // Compile CSS only, through the actual app configuration. Tailwind's
  // production optimizer merges selectors that remain separate in development.
  const production = await buildCss({
    root, configFile: `${root}vite.config.ts`, logLevel: "error",
    build: { write: false, assetsInlineLimit: 0, rollupOptions: { input: `${root}src/index.css` } },
  });
  const productionCss = production.output.filter((asset) => asset.type === "asset" && asset.fileName.endsWith(".css"));
  assert.equal(productionCss.length, 1, "Expected the app CSS entry asset");
  browser = await webkit.launch({ headless: true });
  for (const [mode, content] of [["development", css.code], ["production", productionCss[0].source]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // No network, providers, native discovery or user data in this fixture.
    await page.route("**/*", (route) => route.abort());
    await page.setContent('<div id="controls"></div><div id="fixture" style="height:760px"></div>');
    await page.addStyleTag({ content: dockCss });
    await page.addStyleTag({ content });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const paneDrop = await page.evaluate(() => window.focusStyleQa.measurePaneDropStyle());
    console.log(JSON.stringify({ engine: "WebKit", mode, paneDrop }, null, 2));
    assert.equal(paneDrop.runs, 12 * 48 * 22, "Drag style QA needs real terminal runs");
    assert.equal(paneDrop.inheritedChanges, 0, "Pane hover must not change inherited terminal style variables");
    assert.ok(paneDrop.contentPreserved && paneDrop.gridPreserved, "Pane hover must preserve terminal content and layout");
    const overlay = await page.evaluate(() => window.focusStyleQa.measurePaneOverlayStyle());
    const overlayP95 = overlay.samples.toSorted((a, b) => a - b)[Math.ceil(overlay.samples.length * 0.95) - 1];
    console.log(JSON.stringify({ engine: "WebKit", mode, overlay, overlayP95 }, null, 2));
    assert.equal(overlay.runs, 12 * 48 * 22, "Overlay QA needs real terminal runs");
    assert.ok(overlay.contentPreserved && overlay.gridPreserved, "Overlay insertion must preserve terminal content and layout");
    assert.ok(overlayP95 < 1000 / 60, `Overlay insertion/removal p95 ${overlayP95}ms exceeds one frame`);
    const result = await page.evaluate(async () => window.focusStyleQa.measureFocus());
    assert.equal(result.runs, 12 * 48 * 22, "The large terminal DOM must actually be rendered");

    // Visibility and group isolation are behavior assertions, not class snapshots.
    for (const entry of cases) {
      await page.evaluate(({ group, focusClass, property }) => {
        const host = document.getElementById("controls");
        host.replaceChildren();
        for (let index = 0; index < 2; index++) {
          const row = document.createElement("div");
          row.className = group;
          const input = document.createElement("input");
          input.id = `row-input-${index}`;
          const target = document.createElement("span");
          target.id = `row-action-${index}`;
          target.textContent = "Action";
          const suffix = group.includes("/") ? `/${group.split("/")[1]}` : "";
          target.className = property === "opacity"
            ? `opacity-0 ${focusClass} group-hover${suffix}:opacity-100`
            : `invisible ${focusClass} group-hover${suffix}:visible`;
          row.append(input, target);
          host.append(row);
        }
      }, entry);
      await page.mouse.move(1279, 899);
      const values = () => page.evaluate((property) => [0, 1].map((index) =>
        getComputedStyle(document.getElementById(`row-action-${index}`))[property]), entry.property);
      const hidden = entry.property === "opacity" ? "0" : "hidden";
      const shown = entry.property === "opacity" ? "1" : "visible";
      assert.deepEqual(await values(), [hidden, hidden], `${entry.file}: at rest`);
      await page.locator("#row-input-0").focus();
      assert.deepEqual(await values(), [shown, hidden], `${entry.file}: focus within only its row`);
      await page.keyboard.press("Tab");
      assert.deepEqual(await values(), [hidden, shown], `${entry.file}: keyboard moves to next row`);
      await page.locator("#row-input-1").evaluate((input) => input.blur());
      await page.locator("#row-input-0").hover();
      assert.deepEqual(await values(), [shown, hidden], `${entry.file}: hover still reveals actions`);
    }
    const sorted = result.samples.toSorted((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    console.log(JSON.stringify({ engine: "WebKit", mode, runs: result.runs, visibilityCases: cases.length,
      median, p95, samples: result.samples }, null, 2));
    // A synchronous input focus must fit within one 60 Hz frame on this fixture.
    // Keep raw samples: a busy host is an inconclusive run, not a reason to relax it.
    assert.ok(p95 < 1000 / 60, `Input focus p95 ${p95}ms exceeds one frame`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server?.close();
  admission.reservation?.release();
}
