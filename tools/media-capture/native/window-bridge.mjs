export const NATIVE_WINDOW_BRIDGE_SCHEMA_VERSION = 1;

const CHANNEL = "dure-native-media-window-v1";
const PROOF = /^[0-9a-f]{32}$/u;
const COMMANDS = new Set([
  "plugin:webview|create_webview_window",
  "plugin:window|get_all_windows",
  "plugin:window|set_focus",
  "plugin:window|show",
  "plugin:window|unminimize",
  "toggle_window_maximize_atomic",
]);

export function nativeWindowBridgeHandles(command) {
  return COMMANDS.has(command);
}

function assertProof(proof) {
  if (typeof proof !== "string" || !PROOF.test(proof)) {
    throw new Error("native window bridge proof is invalid");
  }
}

export function parseNativeWindowBridgeRequest(value, proof) {
  assertProof(proof);
  if (
    value?.schemaVersion !== NATIVE_WINDOW_BRIDGE_SCHEMA_VERSION ||
    value.channel !== CHANNEL ||
    value.proof !== proof ||
    !Number.isSafeInteger(value.requestId) ||
    value.requestId < 1 ||
    !nativeWindowBridgeHandles(value.command) ||
    !value.args ||
    typeof value.args !== "object" ||
    Array.isArray(value.args)
  ) {
    throw new Error("native window bridge request is invalid");
  }
  return value;
}

export function nativeWindowBridgeResponse({
  error,
  proof,
  requestId,
  result,
}) {
  assertProof(proof);
  if (!Number.isSafeInteger(requestId) || requestId < 1) {
    throw new Error("native window bridge response identity is invalid");
  }
  return {
    schemaVersion: NATIVE_WINDOW_BRIDGE_SCHEMA_VERSION,
    channel: CHANNEL,
    proof,
    requestId,
    ...(error === undefined ? { result: result ?? null } : { error: String(error) }),
  };
}

export function createNativeWindowBridgeClient({
  proof,
  sourceWindow = window,
  targetWindow = parent,
  timeoutMs = 5_000,
}) {
  assertProof(proof);
  const pending = new Map();
  const commandCounts = new Map();
  const completedCounts = new Map();
  const lastResults = new Map();
  let nextRequestId = 0;

  const receive = (event) => {
    const message = event.data;
    if (
      event.source !== targetWindow ||
      event.origin !== location.origin ||
      message?.schemaVersion !== NATIVE_WINDOW_BRIDGE_SCHEMA_VERSION ||
      message.channel !== CHANNEL ||
      message.proof !== proof ||
      !Number.isSafeInteger(message.requestId)
    ) {
      return;
    }
    const request = pending.get(message.requestId);
    if (!request) return;
    pending.delete(message.requestId);
    clearTimeout(request.timer);
    if (message.error !== undefined) {
      request.reject(new Error(String(message.error)));
      return;
    }
    completedCounts.set(
      request.command,
      (completedCounts.get(request.command) ?? 0) + 1,
    );
    lastResults.set(request.command, message.result ?? null);
    request.resolve(message.result ?? null);
  };
  sourceWindow.addEventListener("message", receive);

  return {
    diagnostics() {
      return {
        commandCounts: Object.fromEntries(commandCounts),
        completedCounts: Object.fromEntries(completedCounts),
        lastResults: Object.fromEntries(lastResults),
        pending: pending.size,
      };
    },
    handles: nativeWindowBridgeHandles,
    invoke(command, args = {}) {
      if (!nativeWindowBridgeHandles(command)) {
        throw new Error(`native window bridge command is unsupported: ${command}`);
      }
      const requestId = ++nextRequestId;
      commandCounts.set(command, (commandCounts.get(command) ?? 0) + 1);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`native window bridge timed out: ${command}`));
        }, timeoutMs);
        pending.set(requestId, { command, reject, resolve, timer });
        targetWindow.postMessage(
          {
            schemaVersion: NATIVE_WINDOW_BRIDGE_SCHEMA_VERSION,
            channel: CHANNEL,
            proof,
            requestId,
            command,
            args,
          },
          location.origin,
        );
      });
    },
  };
}
