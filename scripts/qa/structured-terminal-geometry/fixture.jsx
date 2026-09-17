import { createRoot } from "react-dom/client";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { useStore } from "@/store";
import { hmuxPaneBinding, resizeAppliedReceiptRecord, viewportFrameRecord } from "@/test/terminalRecordFixtures";
import "@/index.css";

const epoch = "perf-terminal-1";
let revision = 0n;
const records = [];
let waiter;
let settledLeft;
const resizes = [];
const observations = [];
const errors = [];
const frame = (columns, rows) => viewportFrameRecord({
  terminalEpoch: epoch,
  projectionRevision: ++revision,
  appliedIntentSeq: 0n,
  columns,
  texts: Array.from({ length: rows }, () => "x".repeat(columns - 1) + "Z"),
});
function deliver(bytes) {
  const record = bytes.buffer;
  if (waiter) { const resolve = waiter; waiter = undefined; resolve(record); }
  else records.push(record);
}

const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke = async (command, args) => {
  if (command === "hmux_structured_terminal_attach") {
    const receipt = await nativeInvoke(command, args);
    deliver(frame(80, 16));
    return { ...receipt, initialDeliveryRecordCount: 1 };
  }
  if (command === "hmux_structured_terminal_next") {
    return records.shift() ?? new Promise((resolve) => { waiter = resolve; });
  }
  if (command === "hmux_structured_terminal_upstream") {
    const decoded = decodeTerminalStateRecord(new Uint8Array(args.record));
    const body = decoded.record.body;
    if (body.case === "inputIntent" && body.value.intent.case === "resize") {
      const { columns, rows } = body.value.intent.value;
      resizes.push({ columns, rows });
      if (settledLeft !== undefined) {
        // Keep the previous frame on screen while the resize is in flight.
        await nextPaint();
        await nextPaint();
        const layer = pane.querySelector('[data-testid="structured-terminal-presentation"]');
        const left = layer.getBoundingClientRect().left;
        const held = layer.style.width !== "";
        observations.push({ label: "in-flight", held, left });
        if (!held || left !== settledLeft) errors.push("held frame lost its inset anchor");
      }
      deliver(resizeAppliedReceiptRecord(decoded.metadata.recordId, columns, rows, epoch));
      deliver(frame(columns, rows));
    }
    return "1";
  }
  return nativeInvoke(command, args);
};

useStore.setState({ terminalFontSize: 10, uiPrefs: { terminalFontFamily: "monospace" } });
const pane = document.getElementById("root");
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
const launched = [];
createRoot(pane).render(<StructuredTerminalView
  sessionId="perf-terminal" surfaceId="geometry-qa" binding={hmuxPaneBinding("perf-terminal")}
  ensure={async (columns, rows) => { launched.push({ columns, rows }); }}
/>);

async function settled(minimumResizes) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const layer = pane.querySelector('[data-testid="structured-terminal-presentation"]');
    const surface = pane.querySelector(".structured-terminal-dom");
    if (resizes.length >= minimumResizes && surface?.dataset.projectionRevision === String(revision) && layer?.dataset.terminalCanonicalColumns === String(resizes.at(-1)?.columns) && !layer?.style.width) {
      await nextPaint();
      return;
    }
    await nextPaint();
  }
  throw new Error(`geometry did not settle: ${JSON.stringify(resizes)}`);
}

function observe(label) {
  const host = pane.querySelector(".structured-terminal-host");
  const surface = pane.querySelector(".structured-terminal-dom");
  const row = surface.querySelector(".term-row");
  const range = document.createRange();
  const lastText = row.lastElementChild.firstChild;
  range.setStart(lastText, lastText.textContent.length - 1);
  range.setEnd(lastText, lastText.textContent.length);
  const edge = range.getBoundingClientRect();
  const available = surface.getBoundingClientRect();
  settledLeft = available.left;
  const grid = row.getBoundingClientRect();
  const visible = edge.right <= available.right + 0.1 && grid.right <= available.right + 0.1;
  observations.push({ label, hostWidth: host.getBoundingClientRect().width,
    surfaceWidth: available.width, gridWidth: grid.width, rightOverflow: edge.right - available.right,
    inset: available.left - pane.getBoundingClientRect().left, columns: resizes.at(-1)?.columns, visible });
  if (!visible) errors.push(`${label}: final column is clipped`);
  if (Math.abs(host.getBoundingClientRect().width - available.width) > 0.1) errors.push(`${label}: measured host differs from drawing area`);
}

try {
  await settled(1);
  observe("initial");
  const cell = Number(pane.querySelector("[data-terminal-cell-width]").dataset.terminalCellWidth);
  const surface = pane.querySelector(".structured-terminal-dom");
  if (launched[0].columns !== Math.floor(surface.getBoundingClientRect().width / cell)) errors.push("launch columns exceed drawing area");
  for (const width of [347.5, 227.5, 267.5]) {
    const expected = resizes.length + 1;
    pane.style.width = `${width}px`;
    await settled(expected);
    observe(`resize-${width}`);
  }
  window.__terminalGeometryResult = { errors, launched, resizes, observations };
} catch (error) {
  window.__terminalGeometryResult = { errors: [...errors, String(error)], launched, resizes, observations };
}
