#!/usr/bin/env node

import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const route = "/__qa/structured-terminal-presentation-workload";
const html = String.raw`<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #000; }
  #root { width: 1600px; }
  .surface { position: relative; width: 1600px; height: 1000px; overflow: hidden; }
  .structured-terminal-dom { direction: ltr; font-kerning: none; font-variant-ligatures: none; white-space: pre; }
  .terminal-viewport-row { white-space: pre; }
  .terminal-viewport-cursor { position: absolute; }
</style>
<div id="root"></div>
<script type="module">
  import React from "/node_modules/.vite/deps/react.js";
  import ReactDOM from "/node_modules/.vite/deps/react-dom.js";
  import ReactDOMClient from "/node_modules/.vite/deps/react-dom_client.js";
  import { create, fromBinary } from "/node_modules/.vite/deps/@bufbuild_protobuf.js";
  import {
    BufferId,
    CellStyleSchema,
    GraphemeSchema,
    InputModesSchema,
    MouseEncoding,
    MouseTrackingMode,
    RowTermination,
    TerminalColorOverridesSchema,
    TerminalRowSchema,
    TerminalStateRecordSchema,
    TerminalTablesSchema,
    UnderlineKind,
    UnicodeWidthProfileSchema,
    ViewportAnchorStatus,
    ViewportFrameSchema,
  } from "/src/contracts/terminalStateProtocol.ts";
  import { TerminalBoxCache } from "/src/lib/terminal/geometry/terminalBoxCache.ts";
  import { createTerminalCanvasRenderer } from "/src/components/terminal/structured/TerminalCanvasRenderer.ts";
  import { createTerminalViewportDomRenderer } from "/src/components/terminal/structured/TerminalViewportDomRenderer.ts";
  import { useStructuredTerminalViewportPaint } from "/src/components/terminal/structured/useStructuredTerminalViewportPaint.ts";
  import {
    decodeTerminalStateRecord,
    encodeTerminalStateRecord,
    TERMINAL_STATE_ENVELOPE_HEADER_BYTES,
    validateTerminalStateRecord,
  } from "/src/lib/terminal/protocol/terminalStateProtocol.ts";
  import { createTerminalViewportMultipartAssembler } from "/src/lib/terminal/protocol/terminalViewportMultipartAssembler.ts";

  const { useMemo, useRef } = React;
  const { flushSync } = ReactDOM;
  const { createRoot } = ReactDOMClient;

  const columns = 160;
  const rows = 50;
  const surfaceCount = 6;
  const updateCount = 225;
  const alphabet = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ "];
  const graphemes = alphabet.map((text) => create(GraphemeSchema, { text, displayWidth: 1 }));
  const styles = [create(CellStyleSchema, { underline: UnderlineKind.NONE })];
  const theme = {
    background: "rgb(0 0 0)",
    foreground: "rgb(255 255 255)",
    cursor: "rgb(255 255 255)",
    selectionBackground: "rgb(60 70 80)",
    indexed: [],
  };
  const counters = { render: 0, presented: 0, afterPaint: 0 };
  const completeResizePresentation = () => {};
  const reportPresentationPainted = () => { counters.presented += 1; };
  const afterPresentationPainted = () => { counters.afterPaint += 1; };

  function installedFrame(surface, revision, marker) {
    return {
      schemaMinor: 5,
      frame: create(ViewportFrameSchema, {
        projectionRevision: revision,
        damageBaseProjectionRevision: revision - 1n,
        canonicalColumns: columns,
        viewportRows: rows,
        activeBuffer: BufferId.NORMAL,
        rows: Array.from({ length: rows }, (_, row) =>
          create(TerminalRowSchema, {
            rowId: BigInt(surface * 1000 + row + 1),
            logicalLineId: BigInt(surface * 1000 + row + 1),
            logicalCellSpan: columns,
            termination: RowTermination.HARD_BREAK,
            cells: Array.from({ length: columns }, (_, column) => ({
              graphemeIndex:
                row === rows - 1 && column === columns - 1
                  ? marker
                  : (row + column) % alphabet.length,
              styleIndex: 0,
            })),
          }),
        ),
        tables: create(TerminalTablesSchema, { graphemes, styles }),
        inputModes: create(InputModesSchema, {
          mouseTracking: MouseTrackingMode.NONE,
          mouseEncoding: MouseEncoding.DEFAULT,
        }),
        colorOverrides: create(TerminalColorOverridesSchema),
        unicodeWidth: create(UnicodeWidthProfileSchema, {
          unicodeVersion: "15.1",
          ambiguousWidth: 1,
          emojiWidth: 2,
        }),
        followTail: true,
        anchorStatus: ViewportAnchorStatus.FOLLOW_TAIL,
        rowsFromTail: 0n,
      }),
    };
  }

  function Surface({ id, frame, throughOutputSeq }) {
    const terminalSurfaceRef = useRef(null);
    const presentationLayerRef = useRef(null);
    const paintedPresentationRef = useRef(null);
    const paintedRef = useRef(false);
    const geometryRef = useRef({ columns, rows });
    const confirmedGeometryRef = useRef({ columns, rows });
    const resizePresentationRef = useRef({ held: false, largeViewHeld: false });
    const surfaceBox = useMemo(() => {
      const cache = new TerminalBoxCache(() => ({ width: 1600, height: 1000 }));
      cache.updateFromEntry({
        borderBoxSize: [{ inlineSize: 1600, blockSize: 1000 }],
        contentRect: { width: 1600, height: 1000 },
      });
      return cache;
    }, []);
    const canvasRenderer = useMemo(createTerminalCanvasRenderer, []);
    const viewportRenderer = useMemo(() => {
      const renderer = createTerminalViewportDomRenderer();
      return {
        ...renderer,
        render(host, installed, options) {
          counters.render += 1;
          return renderer.render(host, installed, options);
        },
      };
    }, []);
    useStructuredTerminalViewportPaint({
      sessionId: "session-" + id,
      terminalSurfaceRef,
      presentationLayerRef,
      surfaceBox,
      paintedPresentationRef,
      paintedRef,
      geometryRef,
      confirmedGeometryRef,
      resizePresentationRef,
      resizePresentationReady: false,
      resizePaintRevision: 0,
      completeResizePresentation,
      installedFrame: frame,
      attachmentId: "attachment-" + id,
      terminalEpoch: "epoch-" + id,
      throughOutputSeq,
      focused: id === 0,
      fontFamily: "monospace",
      fontSize: 16,
      lineHeight: 1.25,
      canvasTheme: theme,
      canvasRenderer,
      viewportRenderer,
      reportPresentationPainted,
      afterPresentationPainted,
    });
    return React.createElement(
      "div",
      { ref: presentationLayerRef, className: "surface" },
      React.createElement("div", { ref: terminalSurfaceRef }),
    );
  }

  const rootElement = document.getElementById("root");
  const root = createRoot(rootElement);
  const revisions = Array.from({ length: surfaceCount }, () => 1n);
  const markers = Array.from({ length: surfaceCount }, (_, index) => index);
  const frames = revisions.map((revision, surface) => installedFrame(surface, revision, markers[surface]));
  const render = () => root.render(
    React.createElement(
      React.Fragment,
      null,
      frames.map((frame, id) => React.createElement(Surface, {
        key: id,
        id,
        frame,
        throughOutputSeq: revisions[id],
      })),
    ),
  );
  flushSync(render);
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  let decodeMarker = 0;
  const encodedViewports = Array.from({ length: updateCount }, (_, index) => {
    if (index % 5 === 0) decodeMarker = (decodeMarker + 1) % alphabet.length;
    const revision = BigInt(index + 1);
    return encodeTerminalStateRecord(
      revision,
      create(TerminalStateRecordSchema, {
        schemaMinor: 5,
        terminalEpoch: "decode-workload",
        throughOutputSeq: revision,
        stateRevision: revision,
        body: {
          case: "viewportFrame",
          value: installedFrame(0, revision, decodeMarker).frame,
        },
      }),
    );
  });

  window.__structuredTerminalPresentationReady = true;
  window.__runStructuredTerminalPresentationWorkload = async () => {
    counters.render = 0;
    counters.presented = 0;
    counters.afterPaint = 0;
    const parseDurations = [];
    for (const encoded of encodedViewports) {
      const startedAt = performance.now();
      fromBinary(
        TerminalStateRecordSchema,
        encoded.subarray(TERMINAL_STATE_ENVELOPE_HEADER_BYTES),
      );
      parseDurations.push(performance.now() - startedAt);
    }
    const validatedRecord = decodeTerminalStateRecord(encodedViewports[0]).record;
    const validationDurations = [];
    for (let index = 0; index < updateCount; index += 1) {
      const startedAt = performance.now();
      validateTerminalStateRecord(validatedRecord);
      validationDurations.push(performance.now() - startedAt);
    }
    const decodeDurations = [];
    for (const encoded of encodedViewports) {
      const startedAt = performance.now();
      const decoded = decodeTerminalStateRecord(encoded);
      decodeDurations.push(performance.now() - startedAt);
      if (decoded.record.body.case !== "viewportFrame") {
        throw new Error("decoded workload record is not a viewport frame");
      }
    }
    const carrier = createTerminalViewportMultipartAssembler();
    const carrierDecodeDurations = [];
    let carrierDecodedFrames = 0;
    let carrierRowObjects = 0;
    let previousRows = null;
    for (const encoded of encodedViewports) {
      const startedAt = performance.now();
      const assembly = carrier.push(encoded);
      carrierDecodeDurations.push(performance.now() - startedAt);
      if (
        assembly.status !== "downstream" ||
        assembly.decoded.record.body.case !== "viewportFrame"
      ) {
        throw new Error("carrier workload did not deliver a complete viewport frame");
      }
      carrierDecodedFrames += 1;
      const nextRows = assembly.decoded.record.body.value.rows;
      if (previousRows === null) {
        carrierRowObjects += nextRows.length;
      } else {
        carrierRowObjects += nextRows.reduce(
          (count, row, rowIndex) => count + Number(row !== previousRows[rowIndex]),
          0,
        );
      }
      previousRows = nextRows;
    }
    const mutations = { total: 0, attributes: 0, childList: 0, characterData: 0 };
    const observer = new MutationObserver((records) => {
      mutations.total += records.length;
      for (const record of records) mutations[record.type] += 1;
    });
    observer.observe(rootElement, {
      subtree: true,
      attributes: true,
      childList: true,
      characterData: true,
    });

    const durations = [];
    let visualChanges = 0;
    for (let index = 0; index < updateCount; index += 1) {
      const surface = index % surfaceCount;
      const changesPaint = index % 5 === 0;
      if (changesPaint) {
        markers[surface] = (markers[surface] + 1) % alphabet.length;
        visualChanges += 1;
      }
      revisions[surface] += 1n;
      frames[surface] = installedFrame(surface, revisions[surface], markers[surface]);
      const startedAt = performance.now();
      flushSync(render);
      void rootElement.offsetWidth;
      durations.push(performance.now() - startedAt);
    }
    await Promise.resolve();
    await Promise.resolve();
    observer.disconnect();

    const sorted = [...durations].sort((left, right) => left - right);
    const sortedDecode = [...decodeDurations].sort((left, right) => left - right);
    const sortedCarrierDecode = [...carrierDecodeDurations].sort((left, right) => left - right);
    const sortedParse = [...parseDurations].sort((left, right) => left - right);
    const sortedValidation = [...validationDurations].sort((left, right) => left - right);
    const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
    const decodePercentile = (ratio) => sortedDecode[Math.min(sortedDecode.length - 1, Math.ceil(sortedDecode.length * ratio) - 1)] ?? 0;
    const carrierDecodePercentile = (ratio) => sortedCarrierDecode[Math.min(sortedCarrierDecode.length - 1, Math.ceil(sortedCarrierDecode.length * ratio) - 1)] ?? 0;
    const parsePercentile = (ratio) => sortedParse[Math.min(sortedParse.length - 1, Math.ceil(sortedParse.length * ratio) - 1)] ?? 0;
    const validationPercentile = (ratio) => sortedValidation[Math.min(sortedValidation.length - 1, Math.ceil(sortedValidation.length * ratio) - 1)] ?? 0;
    const finalMarkers = [...rootElement.querySelectorAll(".structured-terminal-dom")].map(
      (surface) => [...surface.querySelectorAll(".terminal-viewport-row")].at(-1)?.textContent?.at(-1),
    );
    const expectedMarkers = markers.map((index) => alphabet[index]);
    const errors = [];
    if (counters.presented !== updateCount || counters.afterPaint !== updateCount) {
      errors.push("protocol progress did not reach every presentation observer");
    }
    if (JSON.stringify(finalMarkers) !== JSON.stringify(expectedMarkers)) {
      errors.push("final visual projection is stale");
    }
    if (carrierDecodedFrames !== updateCount) {
      errors.push("carrier did not deliver every complete frame");
    }
    if (carrierRowObjects > rows + visualChanges) {
      errors.push("carrier allocated rows that were byte-identical to the installed frame");
    }
    const genericDecodeTotal = decodeDurations.reduce((sum, duration) => sum + duration, 0);
    const carrierDecodeTotal = carrierDecodeDurations.reduce((sum, duration) => sum + duration, 0);
    if (carrierDecodeTotal >= genericDecodeTotal * 0.7) {
      errors.push("carrier row reuse did not materially reduce complete-frame decode time");
    }
    return {
      errors,
      surfaces: surfaceCount,
      columns,
      rows,
      appliedFrames: updateCount,
      visualChanges,
      visualEquivalentFrames: updateCount - visualChanges,
      renderCalls: counters.render,
      presentationReceipts: counters.presented,
      afterPaintReceipts: counters.afterPaint,
      mutations,
      parseMs: {
        total: parseDurations.reduce((sum, duration) => sum + duration, 0),
        median: parsePercentile(0.5),
        p95: parsePercentile(0.95),
        max: parsePercentile(1),
      },
      validationMs: {
        total: validationDurations.reduce((sum, duration) => sum + duration, 0),
        median: validationPercentile(0.5),
        p95: validationPercentile(0.95),
        max: validationPercentile(1),
      },
      decodeMs: {
        total: genericDecodeTotal,
        median: decodePercentile(0.5),
        p95: decodePercentile(0.95),
        max: decodePercentile(1),
      },
      carrierDecode: {
        decodedFrames: carrierDecodedFrames,
        rowObjects: carrierRowObjects,
        totalRowSlots: updateCount * rows,
        ms: {
          total: carrierDecodeTotal,
          median: carrierDecodePercentile(0.5),
          p95: carrierDecodePercentile(0.95),
          max: carrierDecodePercentile(1),
        },
      },
      projectionMs: {
        total: durations.reduce((sum, duration) => sum + duration, 0),
        median: percentile(0.5),
        p95: percentile(0.95),
        max: percentile(1),
      },
    };
  };
</script>`;

const chromiumMetricNames = new Set([
  "LayoutCount",
  "RecalcStyleCount",
  "LayoutDuration",
  "RecalcStyleDuration",
  "ScriptDuration",
  "TaskDuration",
  "JSHeapUsedSize",
  "Nodes",
]);

function performanceMetrics(result) {
  return Object.fromEntries(
    result.metrics
      .filter((metric) => chromiumMetricNames.has(metric.name))
      .map((metric) => [metric.name, metric.value]),
  );
}

function performanceDelta(before, after) {
  return Object.fromEntries(
    [...chromiumMetricNames].map((name) => [
      name,
      (after[name] ?? 0) - (before[name] ?? 0),
    ]),
  );
}

const server = await createServer({
  root: repositoryRoot,
  configFile: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
  resolve: { alias: { "@": resolve(repositoryRoot, "src") } },
  plugins: [
    {
      name: "structured-terminal-presentation-workload",
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
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${address.port}${route}`);
  await page.waitForFunction(
    () => window.__structuredTerminalPresentationReady === true,
    undefined,
    { timeout: 60_000 },
  ).catch((error) => {
    throw new Error(`${error}\npage errors: ${JSON.stringify(pageErrors)}`);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const before = performanceMetrics(await cdp.send("Performance.getMetrics"));
  const result = await page.evaluate(() => window.__runStructuredTerminalPresentationWorkload());
  const after = performanceMetrics(await cdp.send("Performance.getMetrics"));
  result.chromium = performanceDelta(before, after);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.errors.length > 0) process.exitCode = 1;
} finally {
  await browser?.close();
  await server.close();
}
