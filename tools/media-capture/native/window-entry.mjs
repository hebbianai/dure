import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  nativeWindowErrorTitle,
  nativeWindowReadyTitle,
  nativeWindowReplayCompleteTitle,
} from "./window-contract.mjs";
import { installNativeWindowBridgeHost } from "./window-bridge-host.mjs";

const params = new URLSearchParams(location.search);
const expectedLabel = params.get("label") ?? "";
const desktopId = params.get("desktop") ?? "";
const proof = params.get("proof") ?? "";
const scenarioId = params.get("scenario") ?? "";
const surface = params.get("surface") ?? "";
const nativeInvoke = window.__TAURI_INTERNALS__?.invoke?.bind(
  window.__TAURI_INTERNALS__,
);
const actualWindow = getCurrentWebviewWindow();

async function setNativeTitle(value) {
  if (!nativeInvoke) throw new Error("native Tauri invoke is unavailable");
  await nativeInvoke("plugin:window|set_title", {
    label: actualWindow.label,
    value,
  });
}

function showFailure(message) {
  document.body.innerHTML = "";
  const failure = document.createElement("main");
  failure.style.cssText =
    "display:grid;height:100vh;place-items:center;background:#0b0e14;color:#f87171;font:14px ui-monospace;padding:32px";
  failure.textContent = message;
  document.body.append(failure);
}

function waitForFixtureFrame(frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("native media fixture frame timed out"));
    }, 30_000);
    const receive = (event) => {
      if (event.source !== frame.contentWindow || event.origin !== location.origin) {
        return;
      }
      const message = event.data;
      if (
        message?.schemaVersion !== 1 ||
        message.proof !== proof ||
        message.label !== expectedLabel ||
        message.desktopId !== desktopId
      ) {
        return;
      }
      clearTimeout(timer);
      if (message.state === "ready") {
        resolve();
      } else if (message.state === "replay-complete") {
        void setNativeTitle(
          nativeWindowReplayCompleteTitle({
            desktopId,
            label: expectedLabel,
            proof,
            scenarioId,
          }),
        );
      } else {
        const error = new Error(`native media fixture frame failed: ${message.error}`);
        void setNativeTitle(
          nativeWindowErrorTitle({
            label: expectedLabel,
            proof,
            scenarioId,
          }),
        );
        showFailure(`Native media setup failed:\n${String(error)}`);
        reject(error);
      }
    };
    window.addEventListener("message", receive);
  });
}

async function boot() {
  if (actualWindow.label !== expectedLabel) {
    throw new Error(
      `native Tauri label mismatch: expected ${expectedLabel}, observed ${actualWindow.label}`,
    );
  }
  nativeWindowReadyTitle({
    desktopId,
    label: actualWindow.label,
    proof,
    scenarioId,
  });
  const frame = document.createElement("iframe");
  frame.title = `Dure ${desktopId} product fixture`;
  frame.src = `./frame.html?${params.toString()}`;
  frame.style.cssText =
    "display:block;width:100%;height:100vh;border:0;background:#0b0e14";
  const removeBridgeHost = installNativeWindowBridgeHost({
    frame,
    proof,
    scenarioId,
    surface,
  });
  window.addEventListener("beforeunload", removeBridgeHost, { once: true });
  document.body.replaceChildren(frame);
  await waitForFixtureFrame(frame);
  const bounds = frame.getBoundingClientRect();
  if (
    document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== frame ||
    bounds.width < 320 ||
    bounds.height < 240
  ) {
    throw new Error("native media fixture frame is not center-hit-testable");
  }
  await setNativeTitle(
    nativeWindowReadyTitle({
      desktopId,
      label: actualWindow.label,
      proof,
      scenarioId,
    }),
  );
}

boot().catch(async (error) => {
  showFailure(
    `Native media setup failed:\n${String(error)}\n${error?.stack ?? ""}`,
  );
  try {
    await setNativeTitle(
      nativeWindowErrorTitle({ label: expectedLabel, proof, scenarioId }),
    );
  } catch {
    // The external exact-title probe still fails closed when title publication fails.
  }
  console.error(error);
});
