import { invoke } from "@tauri-apps/api/core";
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
  WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import {
  assertNativeInteractionWindowRequest,
  nativeWindowDeclarations,
  nativeWindowPlan,
} from "./window-contract.mjs";
import {
  nativeWindowBridgeResponse,
  parseNativeWindowBridgeRequest,
} from "./window-bridge.mjs";

const CREATION_TIMEOUT_MS = 5_000;

function waitForCreation(window) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("native interaction window creation timed out")),
      CREATION_TIMEOUT_MS,
    );
    void window.once("tauri://created", () => {
      clearTimeout(timer);
      resolve();
    });
    void window.once("tauri://error", (event) => {
      clearTimeout(timer);
      reject(event.payload);
    });
  });
}

async function createInteractionWindow({ options, proof, scenarioId, surface }) {
  if (surface !== "desktop") {
    throw new Error("native interaction windows must originate in the desktop");
  }
  const identity = assertNativeInteractionWindowRequest({
    label: options?.label,
    options,
    scenarioId,
  });
  if (await WebviewWindow.getByLabel(identity.label)) {
    return { label: identity.label, state: "existing" };
  }
  const declared = nativeWindowPlan({ proof, scenarioId }).find(
    ({ label }) => label === identity.label,
  );
  if (!declared || declared.create !== false) {
    throw new Error("native interaction window plan is missing");
  }
  const window = new WebviewWindow(identity.label, {
    acceptFirstMouse: options.acceptFirstMouse,
    backgroundThrottling: options.backgroundThrottling,
    dragDropEnabled: false,
    focus: true,
    height: declared.height,
    hiddenTitle: true,
    minHeight: options.minHeight,
    minWidth: options.minWidth,
    title: declared.title,
    titleBarStyle: options.titleBarStyle,
    transparent: false,
    url: declared.url,
    width: declared.width,
    x: declared.x,
    y: declared.y,
  });
  await waitForCreation(window);
  return {
    label: identity.label,
    requestKind: "agent-session-window-v1",
    state: "created",
  };
}

async function targetInteractionWindow(command, args, scenarioId) {
  const declaration = nativeWindowDeclarations(scenarioId).find(
    ({ create, label }) => create === false && label === args?.label,
  );
  if (!declaration) {
    throw new Error("native interaction window target is not declared");
  }
  const window = await WebviewWindow.getByLabel(declaration.label);
  if (!window) throw new Error("native interaction window is unavailable");
  if (command === "plugin:window|show") await window.show();
  if (command === "plugin:window|unminimize") await window.unminimize();
  if (command === "plugin:window|set_focus") await window.setFocus();
  return null;
}

export function installNativeWindowBridgeHost({
  frame,
  proof,
  scenarioId,
  surface,
}) {
  const declaredLabels = new Set(
    nativeWindowDeclarations(scenarioId).map(({ label }) => label),
  );
  const execute = async (request) => {
    if (request.command === "plugin:window|get_all_windows") {
      const windows = await getAllWebviewWindows();
      return windows
        .map(({ label }) => label)
        .filter((label) => declaredLabels.has(label));
    }
    if (request.command === "plugin:webview|create_webview_window") {
      return createInteractionWindow({
        options: request.args.options,
        proof,
        scenarioId,
        surface,
      });
    }
    if (request.command === "toggle_window_maximize_atomic") {
      if (surface !== "session") {
        throw new Error("native maximize must originate in the session window");
      }
      const window = getCurrentWebviewWindow();
      const before = await window.isMaximized();
      await invoke("toggle_window_maximize_atomic");
      const maximized = await window.isMaximized();
      if (before === maximized) {
        throw new Error("native maximize state did not change");
      }
      return { maximized };
    }
    return targetInteractionWindow(request.command, request.args, scenarioId);
  };

  const receive = (event) => {
    if (event.source !== frame.contentWindow || event.origin !== location.origin) {
      return;
    }
    let request;
    try {
      request = parseNativeWindowBridgeRequest(event.data, proof);
    } catch {
      return;
    }
    void execute(request).then(
      (result) =>
        frame.contentWindow?.postMessage(
          nativeWindowBridgeResponse({
            proof,
            requestId: request.requestId,
            result,
          }),
          location.origin,
        ),
      (error) =>
        frame.contentWindow?.postMessage(
          nativeWindowBridgeResponse({
            error: String(error).slice(0, 1_024),
            proof,
            requestId: request.requestId,
          }),
          location.origin,
        ),
    );
  };
  window.addEventListener("message", receive);
  return () => window.removeEventListener("message", receive);
}
