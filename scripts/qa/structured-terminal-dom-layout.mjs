#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const route = "/__qa/structured-terminal-dom-layout";
const html = String.raw`<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; }
  .structured-terminal-dom {
    direction: ltr;
    font-kerning: none;
    font-variant-ligatures: none;
    white-space: pre;
  }
  .structured-terminal-dom .terminal-viewport-row {
    height: var(--terminal-row-height);
    line-height: var(--terminal-row-height);
    white-space: pre;
  }
  .structured-terminal-dom [data-terminal-run] {
    display: inline-block;
    height: 100%;
    vertical-align: top;
    white-space: pre;
  }
  .structured-terminal-dom .terminal-viewport-cursor { position: absolute; }
</style>
<div id="mixed"></div>
<div id="bidi"></div>
<div id="ascii-monospace"></div>
<div id="ascii-arial"></div>
<div id="selection"></div>
<script type="module">
  import { createTerminalCanvasRenderer } from "/src/components/terminal/structured/TerminalCanvasRenderer.ts";
  import { createTerminalViewportDomRenderer, terminalViewportSelectionText } from "/src/components/terminal/structured/TerminalViewportDomRenderer.ts";
  import { applyTerminalViewportSelection } from "/src/lib/terminal/presentation/terminalViewportSelection.ts";
  import { mergeTerminalSelectionDocumentRows, terminalSelectionDocumentRows, terminalSelectionDocumentText } from "/src/lib/terminal/state/terminalSelection.ts";

  const style = {
    flags: 0n,
    underline: 1,
    hyperlinkIndex: 0,
  };
  const cells = (values) => values.map(([text, displayWidth]) => ({ text, displayWidth }));
  const mixed = cells([["A", 1], ["界", 2], ["🙂", 2]]);
  const bidi = cells([["A", 1], ["א", 1], ["ב", 1], ["B", 1]]);
  const ascii = cells([["W", 1], ["i", 1], ["W", 1], ["i", 1]]);

  function installedFrame(values) {
    return {
      schemaMinor: 5,
      frame: {
        projectionRevision: 1n,
        damageBaseProjectionRevision: 0n,
        canonicalColumns: values.reduce((sum, value) => sum + value.displayWidth, 0),
        viewportRows: 1,
        rows: [{
          rowId: 1n,
          logicalLineId: 1n,
          logicalCellOffset: 0,
          logicalCellSpan: values.reduce((sum, value) => sum + value.displayWidth, 0),
          continuesFromPrevious: false,
          termination: 3,
          cells: values.map((_, graphemeIndex) => ({ graphemeIndex, styleIndex: 0 })),
        }],
        tables: { graphemes: values, styles: [style], hyperlinks: [] },
        changedRowIndices: [],
        colorOverrides: { indexed: [] },
      },
    };
  }

  const metricsRenderer = createTerminalCanvasRenderer();
  const metricsFor = (fontFamily) => metricsRenderer.measure(600, 20, fontFamily, 16, 1.25);
  const monospaceMetrics = metricsFor("monospace");
  const arialMetrics = metricsFor("Arial");

  function render(id, values, fontFamily, metrics) {
    const host = document.getElementById(id);
    host.style.width = "600px";
    createTerminalViewportDomRenderer().render(host, installedFrame(values), {
      attachmentId: "layout-qa-" + id,
      terminalEpoch: "epoch-layout-qa",
      focused: false,
      fontFamily,
      fontSize: 16,
      lineHeight: 1.25,
      metrics: { ...metrics, rows: 1 },
      theme: {
        background: "rgb(0 0 0)",
        foreground: "rgb(255 255 255)",
        cursor: "rgb(255 255 255)",
        selectionBackground: "rgb(60 70 80)",
        indexed: [],
      },
    });
    return host.querySelector(".terminal-viewport-row");
  }

  function runLayout(row) {
    const origin = row.getBoundingClientRect().left;
    return [...row.querySelectorAll("[data-terminal-run]")].map((run) => {
      const rect = run.getBoundingClientRect();
      return {
        text: run.textContent,
        left: rect.left - origin,
        right: rect.right - origin,
      };
    });
  }

  function textBoundaries(row, values) {
    const origin = row.getBoundingClientRect().left;
    const textNodes = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let target = 0;
    return values.map((value) => {
      target += value.text.length;
      let consumed = 0;
      for (const node of textNodes) {
        const end = consumed + node.data.length;
        if (target <= end) {
          const range = document.createRange();
          range.setStart(node, target - consumed);
          range.collapse(true);
          return range.getBoundingClientRect().left - origin;
        }
        consumed = end;
      }
      return Number.NaN;
    });
  }

  const mixedRow = render("mixed", mixed, "monospace", monospaceMetrics);
  const bidiRow = render("bidi", bidi, "monospace", monospaceMetrics);
  const monospaceAsciiRow = render("ascii-monospace", ascii, "monospace", monospaceMetrics);
  const arialAsciiRow = render("ascii-arial", ascii, "Arial", arialMetrics);
  const mixedRuns = runLayout(mixedRow);
  const bidiRuns = runLayout(bidiRow);
  const monospaceAsciiRuns = runLayout(monospaceAsciiRow);
  const arialAsciiRuns = runLayout(arialAsciiRow);
  const tolerance = 0.75;
  const near = (actual, expected) => Math.abs(actual - expected) <= tolerance;
  const errors = [];

  function requireGrid(name, runs, values, cellWidth) {
    if (runs.length !== values.length) {
      errors.push(name + ": expected " + values.length + " positioned cells, got " + runs.length);
      return;
    }
    let column = 0;
    for (const [index, value] of values.entries()) {
      const run = runs[index];
      const left = column * cellWidth;
      column += value.displayWidth;
      const right = column * cellWidth;
      if (run.text !== value.text || !near(run.left, left) || !near(run.right, right)) {
        errors.push(name + "[" + index + "]: " + JSON.stringify(run) + " expected " + value.text + " at " + left + ".." + right);
      }
    }
  }

  function requireCoalesced(name, runs, values, cellWidth) {
    const text = values.map((value) => value.text).join("");
    const columns = values.reduce((sum, value) => sum + value.displayWidth, 0);
    if (
      runs.length !== 1 ||
      runs[0].text !== text ||
      !near(runs[0].left, 0) ||
      !near(runs[0].right, columns * cellWidth)
    ) {
      errors.push(name + ": expected one fixed-advance run, got " + JSON.stringify(runs));
    }
  }

  requireGrid("mixed", mixedRuns, mixed, monospaceMetrics.cellWidth);
  requireGrid("bidi", bidiRuns, bidi, monospaceMetrics.cellWidth);
  requireCoalesced("ascii-monospace", monospaceAsciiRuns, ascii, monospaceMetrics.cellWidth);
  requireGrid("ascii-arial", arialAsciiRuns, ascii, arialMetrics.cellWidth);
  if (monospaceMetrics.asciiRunCapability !== "fixed_cell_advance") {
    errors.push("monospace: expected fixed_cell_advance, got " + monospaceMetrics.asciiRunCapability);
  }
  if (arialMetrics.asciiRunCapability !== "positioned_cells") {
    errors.push("Arial: expected positioned_cells, got " + arialMetrics.asciiRunCapability);
  }

  function textFrame(texts, logicalLineIds, projectionRevision) {
    const graphemes = texts.flatMap((text) => [...text].map((character) => ({ text: character, displayWidth: 1 })));
    let graphemeIndex = 0;
    return {
      schemaMinor: 5,
      frame: {
        projectionRevision,
        damageBaseProjectionRevision: 0n,
        canonicalColumns: Math.max(...texts.map((text) => text.length)),
        viewportRows: texts.length,
        rows: texts.map((text, index) => ({
          rowId: projectionRevision * 100n + BigInt(index),
          logicalLineId: logicalLineIds[index],
          logicalCellOffset: 0,
          logicalCellSpan: text.length,
          continuesFromPrevious: false,
          termination: 3,
          cells: [...text].map(() => ({ graphemeIndex: graphemeIndex++, styleIndex: 0 })),
        })),
        tables: { graphemes, styles: [style], hyperlinks: [] },
        changedRowIndices: [],
        colorOverrides: { indexed: [] },
      },
    };
  }

  const selectionHost = document.getElementById("selection");
  selectionHost.style.width = "600px";
  selectionHost.style.height = "40px";
  const selectionRenderer = createTerminalViewportDomRenderer();
  const selectionOptions = {
    attachmentId: "layout-qa-selection",
    terminalEpoch: "epoch-layout-qa",
    focused: false,
    fontFamily: "monospace",
    fontSize: 16,
    lineHeight: 1.25,
    metrics: { ...monospaceMetrics, rows: 2 },
    theme: {
      background: "rgb(0 0 0)",
      foreground: "rgb(255 255 255)",
      cursor: "rgb(255 255 255)",
      selectionBackground: "rgb(60 70 80)",
      indexed: [],
    },
  };
  const firstSelectionFrame = textFrame(["first", "second"], [1n, 2n], 1n);
  selectionRenderer.render(selectionHost, firstSelectionFrame, selectionOptions);
  const initialSelection = {
    anchor: { logicalLineId: 1n, logicalCellOffset: 0 },
    focus: { logicalLineId: 2n, logicalCellOffset: 6 },
  };
  applyTerminalViewportSelection(selectionHost, initialSelection, "start");
  const secondSelectionFrame = textFrame(["second", "third"], [2n, 3n], 2n);
  const retainedSelectionRows = mergeTerminalSelectionDocumentRows(
    terminalSelectionDocumentRows(firstSelectionFrame.frame.rows, firstSelectionFrame.frame.tables),
    terminalSelectionDocumentRows(secondSelectionFrame.frame.rows, secondSelectionFrame.frame.tables),
    "newer",
  );
  const extendedSelection = {
    anchor: initialSelection.anchor,
    focus: { logicalLineId: 3n, logicalCellOffset: 5 },
  };
  selectionRenderer.render(selectionHost, secondSelectionFrame, selectionOptions);
  applyTerminalViewportSelection(selectionHost, extendedSelection, "start");
  const visibleSelectionText = terminalViewportSelectionText(selectionHost, window.getSelection());
  const accumulatedSelectionText = terminalSelectionDocumentText(retainedSelectionRows, extendedSelection);
  if (visibleSelectionText !== "second\nthird") {
    errors.push("selection: visible native projection was " + JSON.stringify(visibleSelectionText));
  }
  if (accumulatedSelectionText !== "first\nsecond\nthird") {
    errors.push("selection: accumulated copy was " + JSON.stringify(accumulatedSelectionText));
  }
  window.__terminalLayoutResult = {
    errors,
    monospaceMetrics,
    arialMetrics,
    mixedRuns,
    mixedTextBoundaries: textBoundaries(mixedRow, mixed),
    bidiRuns,
    bidiTextBoundaries: textBoundaries(bidiRow, bidi),
    monospaceAsciiRuns,
    monospaceAsciiTextBoundaries: textBoundaries(monospaceAsciiRow, ascii),
    arialAsciiRuns,
    arialAsciiTextBoundaries: textBoundaries(arialAsciiRow, ascii),
    selection: { visibleSelectionText, accumulatedSelectionText },
  };
</script>`;

const server = await createServer({
  root: repositoryRoot,
  configFile: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  resolve: { alias: { "@": resolve(repositoryRoot, "src") } },
  plugins: [
    {
      name: "structured-terminal-dom-layout-fixture",
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url?.split("?", 1)[0] !== route) return next();
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        });
      },
    },
  ],
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a QA port");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}${route}`);
  await page.waitForFunction(() => window.__terminalLayoutResult !== undefined);
  const result = await page.evaluate(() => window.__terminalLayoutResult);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
