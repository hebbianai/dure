// Injected via page.addInitScript BEFORE any app code runs. It stands up a
// minimal window.__TAURI_INTERNALS__ so the frontend boots in a plain browser
// (no Tauri backend). The DOM/CodeMirror/dockview rendering is 100% real — only
// the backend *data* is canned. That isolation is exactly what we want for
// measuring frontend render/reflow cost.
(() => {
  let cbId = 0;
  const callbacks = new Map();
  const fixture = window.__DURE_FRONTEND_PERF_FIXTURE__ ?? {};
  // Encoded with viewportFrameRecord({ terminalEpoch: "perf-terminal-1",
  // texts: ["$ "], appliedIntentSeq: 0n }). A fresh attach must not acknowledge
  // an input intent that this frontend replica never issued.
  const defaultStructuredTerminalRecords = [
    "VFNQQgEDCABqAAAAAQAAAAAAAAAIAxIPcGVyZi10ZXJtaW5hbC0xGAEgAYoBUAgBGHggASgBMg4IZRoAGgIIASADKGU4AjoSCgUKASQQAQoFCgEgEAESAigBQgQgASgBSgQoATABUgBaDAoGMTUuMS4wEAEYAngBoAEBqAEA",
  ];
  // The fixed 1440x900 journey measures a 74x51 terminal. The Host orders the
  // resize receipt before the authoritative geometry successor. Resize uses
  // the input receipt path, so the viewport-intent fence remains zero.
  const defaultStructuredTerminalResizeRecords = [
    "VFNQQgEECwAgAAAAhwMAAAAAAAAIBBIPcGVyZi10ZXJtaW5hbC0xIAGiAQgIAVIECEoQMw==",
    "VFNQQgEDCABjAgAAAgAAAAAAAAAIAxIPcGVyZi10ZXJtaW5hbC0xGAEgAooByAQIAhhKIDMoATIQCMkBGgAaAggBIAMoyQE4AjIICMoBIAMoygEyCAjLASADKMsBMggIzAEgAyjMATIICM0BIAMozQEyCAjOASADKM4BMggIzwEgAyjPATIICNABIAMo0AEyCAjRASADKNEBMggI0gEgAyjSATIICNMBIAMo0wEyCAjUASADKNQBMggI1QEgAyjVATIICNYBIAMo1gEyCAjXASADKNcBMggI2AEgAyjYATIICNkBIAMo2QEyCAjaASADKNoBMggI2wEgAyjbATIICNwBIAMo3AEyCAjdASADKN0BMggI3gEgAyjeATIICN8BIAMo3wEyCAjgASADKOABMggI4QEgAyjhATIICOIBIAMo4gEyCAjjASADKOMBMggI5AEgAyjkATIICOUBIAMo5QEyCAjmASADKOYBMggI5wEgAyjnATIICOgBIAMo6AEyCAjpASADKOkBMggI6gEgAyjqATIICOsBIAMo6wEyCAjsASADKOwBMggI7QEgAyjtATIICO4BIAMo7gEyCAjvASADKO8BMggI8AEgAyjwATIICPEBIAMo8QEyCAjyASADKPIBMggI8wEgAyjzATIICPQBIAMo9AEyCAj1ASADKPUBMggI9gEgAyj2ATIICPcBIAMo9wEyCAj4ASADKPgBMggI+QEgAyj5ATIICPoBIAMo+gEyCAj7ASADKPsBOhIKBQoBJBABCgUKASAQARICKAFCBhACIAEoAUoEKAEwAVIAWgwKBjE1LjEuMBABGAJ4AaABAagBAA==",
  ];
  const hmuxSession = {
    sessionId: "perf-terminal",
    sessionName: "perf-terminal",
    workspaceId: "perf-workspace",
    sessionClass: "standalone",
    lifecycle: "ready",
    manifestLifecycle: "ready",
    health: "current_healthy",
    hostBuildVersion: "perf-mock-build",
    clientSelection: "direct_rust",
    inputAllowed: true,
    detachOnly: false,
    runtimeHost: "local",
    terminalEpoch: "perf-terminal-1",
    outputSeq: "1",
    capabilities: [
      "terminal_input_intent_v1",
      "terminal_state_binary_v1",
      "terminal_viewport_projection_v1",
    ],
  };
  const structuredTerminalRecords = new Map();
  const structuredTerminalWaiters = new Map();
  const commandCounts = {};
  let hmuxSessionCreated = false;
  window.__DURE_FRONTEND_PERF_MOCK__ = { commandCounts };

  function decodeTerminalRecord(base64) {
    const binary = atob(base64);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
  }

  function attachStructuredTerminal(observerId) {
    const records = (
      fixture.structuredTerminalRecords ?? defaultStructuredTerminalRecords
    ).map(decodeTerminalRecord);
    structuredTerminalRecords.set(observerId, records);
    return {
      terminalEpoch: hmuxSession.terminalEpoch,
      throughOutputSeq: hmuxSession.outputSeq,
      stateRevision: "1",
      initialDeliveryRecordCount: records.length,
      selectedCapabilities: [...hmuxSession.capabilities],
      session: hmuxSession,
    };
  }

  function nextStructuredTerminalRecord(observerId) {
    const records = structuredTerminalRecords.get(observerId) ?? [];
    const record = records.shift();
    if (record) return record;
    return new Promise((resolveRecord) => {
      structuredTerminalWaiters.set(observerId, resolveRecord);
    });
  }

  function enqueueStructuredTerminalRecord(observerId, record) {
    const waiter = structuredTerminalWaiters.get(observerId);
    if (waiter) {
      structuredTerminalWaiters.delete(observerId);
      waiter(record);
      return;
    }
    const records = structuredTerminalRecords.get(observerId) ?? [];
    records.push(record);
    structuredTerminalRecords.set(observerId, records);
  }

  function applyStructuredTerminalResize(observerId) {
    for (const record of (
      fixture.structuredTerminalResizeRecords ??
      defaultStructuredTerminalResizeRecords
    ).map(decodeTerminalRecord)) {
      enqueueStructuredTerminalRecord(observerId, record);
    }
    return "1";
  }

  // Canned results for the invoke commands the app hits. Unknown commands
  // resolve to null — most call sites are `.catch()`-wrapped and tolerate it.
  function result(cmd, args) {
    commandCounts[cmd] = (commandCounts[cmd] ?? 0) + 1;
    switch (cmd) {
      case "app_caps":
        return {
          name: "dure-perf-mock",
          packageVersion: "0.1.4",
          protocolVersion: 1,
          buildId: "perf-mock-build",
          runtimeFingerprint: null,
          features: [
            "hmux.managed-create-advance-v1",
            "hmux.standalone-terminal-surface-v1",
            "hmux.terminal-state-binary-v1",
          ],
        };
      case "home_dir":
        return "/Users/jwan";
      case "control_plane_census":
        return { sessions: [], observers: [] };
      case "usage_recent":
        return { claude: { total: 0 }, codex: { total: 0, usedPercent: null } };
      case "hebbian_read":
        return "";
      case "spawn_receipts_list_running":
        return [];
      case "read_file": {
        // A realistic ~600-line source file so CodeMirror does real work.
        const path = (args && (args.path || args.name)) || "sample.ts";
        const lines = [];
        for (let i = 1; i <= 600; i++) {
          lines.push(`export const value${i} = ${i}; // line ${i} of the perf sample file`);
        }
        return { name: path.split("/").pop(), path, kind: "text", content: lines.join("\n") };
      }
      case "hmux_list_sessions":
      case "hmux_probe_sessions":
        return hmuxSessionCreated ? [hmuxSession] : [];
      case "hmux_standalone_create":
        hmuxSessionCreated = true;
        return hmuxSession;
      case "hmux_structured_terminal_attach":
        return attachStructuredTerminal(args?.observerId);
      case "hmux_structured_terminal_next":
        return nextStructuredTerminalRecord(args?.observerId);
      case "hmux_structured_terminal_detach":
        structuredTerminalRecords.delete(args?.observerId);
        structuredTerminalWaiters.delete(args?.observerId);
        return null;
      case "hmux_structured_terminal_upstream":
        return applyStructuredTerminalResize(args?.observerId);
      case "hmux_standalone_abandon_unpresented":
        return { state: "retirement_armed" };
      case "hmux_control_plane_census":
        return {
          policy: {
            currentBuildId: "perf-mock-build",
            activation: "local_bundled_or_installed_current",
            signedReleaseFetch: "not_implemented",
            signedPackageInstall: "blocked_missing_trust_root",
          },
          sessions: hmuxSessionCreated ? [hmuxSession] : [],
          protectedBuildIds: [],
        };
      case "git_status":
        return { branch: "agent/perf", ahead: 0, behind: 0, dirty: false, staged: 0 };
      default:
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback(cb, once) {
      const id = ++cbId;
      callbacks.set(id, { cb, once });
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    convertFileSrc(p) {
      return p;
    },
    invoke(cmd, args) {
      try {
        return Promise.resolve(result(cmd, args));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  // @tauri-apps/api/event removes its local callback through this bridge
  // before issuing plugin:event|unlisten. The canned backend has no events,
  // but it must still implement the listener lifecycle contract so workspace
  // eviction is tested without mock-only page errors.
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener() {},
  };
  // Some plugins read the older global name.
  window.__TAURI__ = window.__TAURI__ || {};
})();
