#!/usr/bin/env node
// Isolated browser fixture: actual Spaces hook/store, synthetic session facts.
// No app connection, terminal input, output payloads, or product instrumentation.
import { createServer } from "vite";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const route = "/__qa/spaces-metadata";
const html = `<!doctype html><meta charset="utf-8">
<title>Isolated Spaces metadata workload</title><link rel="icon" href="data:,"><div id="root"></div>
<script type="module" src="/__qa/spaces-metadata.js"></script>`;
const source = `
import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { useSpaces } from "/src/components/spaces/useSpaces.ts";
import { useStore } from "/src/store.ts";
import { hmuxSessionMetadataKey } from "/src/lib/hmux/identity/hmuxSessionMetadata.ts";

let renders = 0;
let currentRows;
function Rows() {
  currentRows = useSpaces();
  renders += 1;
  return React.createElement("div", null, currentRows.map(row =>
    React.createElement("div", { key: row.key }, row.hmuxSessionName + ":" + row.hostBuild)));
}
const app = createRoot(document.getElementById("root"));
const initial = useStore.getState();
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.ceil(sorted.length * p) - 1];
  return { count: sorted.length, median: at(.5), p95: at(.95), max: at(1) };
};

window.runSpacesMetadataWorkload = async ({ sessions = 400, bursts = 120, updates = 32, countScans = false } = {}) => {
  if (![12, 100, 400].includes(sessions) || !Number.isSafeInteger(bursts) || !Number.isSafeInteger(updates) || bursts > 240 || updates > 64 || bursts < 1 || updates < 1) throw new Error("unbounded workload");
  flushSync(() => app.render(null));
  useStore.setState(initial, true);
  const workspaceId = "qa-workspace";
  const metadata = Object.fromEntries(Array.from({ length: sessions }, (_, index) => {
    const sessionId = "qa-session-" + index;
    return [hmuxSessionMetadataKey(workspaceId, sessionId), {
      sessionId, workspaceId, sessionName: "Synthetic " + index,
      hostBuildVersion: "qa-build", sessionClass: "standalone", lifecycle: "ready",
      terminalEpoch: "qa-epoch", outputSeq: "0", capabilities: []
    }];
  }));
  let scans = 0;
  const panels = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
    const sessionId = "qa-session-" + index;
    return ["term:" + sessionId, { params: { sessionId,
      binding: { schemaVersion: 1, runtime: "hmux_standalone_v1", source: "local", hostId: "local", sessionId, workspaceId }
    }}];
  }));
  useStore.setState({
    agents: [], projects: [], spaces: [{ id: "qa-space", name: "QA" }],
    activeSpaceId: "qa-space", layouts: { "qa-space": { panels } },
    hmuxSessionMetadata: countScans ? new Proxy(metadata, {
      ownKeys(target) { scans += 1; return Reflect.ownKeys(target); }
    }) : metadata
  });
  const coldStart = performance.now();
  flushSync(() => app.render(React.createElement(Rows)));
  const coldMountMs = performance.now() - coldStart;
  const stableRows = currentRows;
  const publish = () => useStore.getState().requestTerminalRefresh("qa-unrelated-pane");
  // Warm the identical publication path; no detailed clocks inside the loop.
  for (let index = 0; index < 128; index += 1) publish();
  const startRenders = renders;
  scans = 0;
  const work = [], task = [];
  const channel = new MessageChannel();
  const start = performance.now();
  try {
    for (let burst = 0; burst < bursts; burst += 1) {
      const at = performance.now();
      const delivered = new Promise(resolve => { channel.port1.onmessage = () => resolve(performance.now() - at); });
      channel.port2.postMessage(null);
      for (let index = 0; index < updates; index += 1) publish();
      work.push(performance.now() - at);
      task.push(await delivered);
    }
  } finally {
    channel.port1.close(); channel.port2.close();
  }
  const durationMs = performance.now() - start;
  const unchanged = currentRows === stableRows && renders === startRenders;
  const scanCount = countScans ? scans : null;
  const key = hmuxSessionMetadataKey(workspaceId, "qa-session-0");
  flushSync(() => useStore.getState().setHmuxSessionMetadata({ ...metadata[key], sessionName: "Updated", hostBuildVersion: "qa-build-2" }));
  const fresh = document.getElementById("root").textContent.includes("Updated:qa-build-2");
  flushSync(() => useStore.setState({ hmuxSessionMetadata: {} }));
  const removed = currentRows.every(row => row.hmuxSessionName === undefined && row.hostBuild === undefined);
  flushSync(() => app.render(null));
  useStore.setState(initial, true);
  if (!unchanged || !fresh || !removed) throw new Error("row identity/freshness/removal regression");
  return { at: new Date().toISOString(), sessions, panes: 12, windows: 1, bursts, updates, countScans,
    publications: bursts * updates, coldMountMs, durationMs, syncWorkMs: stats(work), queuedTaskMs: stats(task),
    scanCount, unchanged, fresh, removed, userAgent: navigator.userAgent };
};
window.spacesMetadataReady = true;
`;

const server = await createServer({
  root,
  configFile: false,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client", "react-dom", "zustand", "zustand/react/shallow"] },
  resolve: { alias: { "@": resolve(root, "src") } },
  plugins: [{
    name: "spaces-metadata-workload",
    resolveId(id) { if (id === "/__qa/spaces-metadata.js") return "\0spaces-metadata-workload"; },
    load(id) { if (id === "\0spaces-metadata-workload") return source; },
    configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url !== route) return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(await vite.transformIndexHtml(route, html));
      });
    },
  }],
});
await server.listen();
const address = server.httpServer.address();
console.log(`Spaces QA: http://127.0.0.1:${address.port}${route}`);
const expiry = setTimeout(() => void stop(), 20 * 60 * 1000);
async function stop() { clearTimeout(expiry); await server.close(); }
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
