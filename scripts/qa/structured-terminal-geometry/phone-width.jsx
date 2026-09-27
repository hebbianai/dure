// Real desktop component/CSS with synthetic Hub observations and Host records.
import { createRoot } from "react-dom/client";
import { StructuredTerminalView } from "@/components/terminal/structured/StructuredTerminalView";
import { decodeTerminalStateRecord } from "@/lib/terminal/protocol/terminalStateProtocol";
import { useStore } from "@/store";
import { hmuxPaneBinding, inputReceiptRecord, resizeAppliedReceiptRecord, viewportFrameRecord } from "@/test/terminalRecordFixtures";
import "@/index.css";

const epoch = "perf-terminal-1";
const records = [], resizes = [], inputs = [], observations = [], errors = [];
const callbacks = new Map();
let waiter, widthHandler, columns = 38, rows = 16, revision = 0n, widthRevision = 0;
let attachments = 0, detachments = 0, physicalColumns;
const widths = { generation: "width-browser-fixture", revision: "0", observations: [] };
const native = window.__TAURI_INTERNALS__;
const invoke = native.invoke, transformCallback = native.transformCallback;
native.transformCallback = (callback, once) => {
  const id = transformCallback(callback, once);
  callbacks.set(id, callback);
  return id;
};
function deliver(bytes) {
  if (waiter) { const resolve = waiter; waiter = undefined; resolve(bytes.buffer); }
  else records.push(bytes.buffer);
}
function frame() {
  return viewportFrameRecord({ terminalEpoch: epoch, columns,
    texts: Array.from({ length: rows }, (_, i) => (i === 0 ? "P" : "x").repeat(columns - 1) + "Z"),
    projectionRevision: ++revision,
    logicalLineIds: Array.from({ length: rows }, (_, i) => BigInt(i + 1)),
  });
}
native.invoke = async (command, args) => {
  if (command === "plugin:event|listen" && args.event === "hub://terminal-widths") widthHandler = args.handler;
  if (command === "hub_terminal_widths") return structuredClone(widths);
  if (command === "hmux_structured_terminal_attach") {
    attachments++;
    const receipt = await invoke(command, args);
    deliver(frame());
    return { ...receipt, initialDeliveryRecordCount: 1 };
  }
  if (command === "hmux_structured_terminal_detach") detachments++;
  if (command === "hmux_structured_terminal_next") return records.shift() ?? new Promise((resolve) => { waiter = resolve; });
  if (command === "hmux_structured_terminal_upstream") {
    const decoded = decodeTerminalStateRecord(new Uint8Array(args.record));
    const body = decoded.record.body;
    if (body.case === "inputIntent") {
      if (body.value.intent.case === "resize") {
        ({ columns, rows } = body.value.intent.value);
        resizes.push({ columns, rows });
        deliver(resizeAppliedReceiptRecord(decoded.metadata.recordId, columns, rows, epoch));
        deliver(frame());
      } else {
        inputs.push(body.value.intent.case);
        deliver(inputReceiptRecord(decoded.metadata.recordId, epoch));
      }
    }
    return "1";
  }
  return invoke(command, args);
};
const pane = document.getElementById("root");
useStore.setState({ terminalFontSize: 10, uiPrefs: { terminalFontFamily: "monospace" } });
createRoot(pane).render(<StructuredTerminalView sessionId="perf-terminal" surfaceId="phone-width-qa" binding={hmuxPaneBinding("perf-terminal")} />);
const nextPaint = () => new Promise((resolve) => requestAnimationFrame(resolve));
async function settled(expected) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const layer = pane.querySelector('[data-testid="structured-terminal-presentation"]');
    const surface = pane.querySelector(".structured-terminal-dom");
    if (resizes.length && (expected === undefined || resizes.at(-1).columns === expected) &&
      surface?.dataset.projectionRevision === String(revision) && !layer?.style.width) {
      await nextPaint(); await nextPaint(); return;
    }
    await nextPaint();
  }
  throw new Error(`resize did not settle: ${JSON.stringify(resizes)}`);
}
async function phone(columns) {
  widths.revision = String(++widthRevision);
  widths.observations = columns === undefined ? [] : [{
    route: { source: "local", hostId: "local" },
    fence: { session_id: "perf-terminal", workspace_id: "workspace-a", runner_principal: "qa",
      runner_instance: "qa", channel_epoch: "1", host_instance_id: "qa", terminal_epoch: epoch }, columns,
  }];
  callbacks.get(widthHandler)?.({ event: "hub://terminal-widths", id: 1, payload: structuredClone(widths) });
  await settled(columns ?? physicalColumns);
}
function assert(condition, message) { if (!condition) throw new Error(message); }
try {
  await settled();
  const original = resizes.at(-1).columns;
  physicalColumns = original;
  const layer = pane.querySelector('[data-testid="structured-terminal-presentation"]');
  const surface = pane.querySelector(".structured-terminal-dom");
  const input = pane.querySelector("textarea");
  const row = surface.querySelector(".term-row");
  const selection = getSelection();
  const selected = document.createRange();
  selected.setStart(row.firstElementChild.firstChild, 2);
  selected.setEnd(row.firstElementChild.firstChild, 7);
  selection.addRange(selected);
  const selectedText = selection.toString();
  await phone(53);
  assert(selection.toString() === selectedText, "phone resize lost selection");
  assert(layer.scrollWidth > layer.clientWidth, "wide canonical content is unreachable");
  surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 100 }));
  assert(Math.abs(layer.scrollLeft - Math.min(100, layer.scrollWidth - layer.clientWidth)) <= 1, `horizontal wheel did not pan exactly once: ${layer.scrollLeft}`);
  layer.scrollLeft = layer.scrollWidth;
  const lastRow = surface.querySelector(".term-row");
  const range = document.createRange();
  range.selectNodeContents(lastRow.lastElementChild);
  const edge = range.getBoundingClientRect();
  assert(edge.right <= layer.getBoundingClientRect().right + 1, "last canonical column remains clipped after panning");
  observations.push({ stage: "phone-53", original, columns, viewport: layer.clientWidth, content: layer.scrollWidth, scrollLeft: layer.scrollLeft, selection: selection.toString() });
  await phone(90);
  assert(columns === 90 && input === pane.querySelector("textarea"), "rotation replaced input attachment");
  // Let external browser automation send a real wheel event before restoring.
  window.__phoneWidthReady = { viewport: layer.clientWidth, content: layer.scrollWidth };
  window.__finishPhoneWidth = async () => {
    await phone(undefined);
    assert(columns === original, "phone detach did not restore physical desktop columns");
    assert(layer.scrollLeft === 0, "phone detach retained horizontal offset");
    assert(attachments === 1 && detachments === 0, "width updates replaced the session attachment");
    window.__terminalGeometryResult = { errors, attachments, detachments, resizes, inputs, observations };
  };
} catch (error) {
  window.__terminalGeometryResult = { errors: [...errors, String(error)], resizes, attachments, detachments, observations };
}
