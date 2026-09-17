export const CAPTURE_STAGE_SCHEMA_VERSION = 1;

const DURE_DUSK_BACKGROUND =
  "radial-gradient(circle at 18% 8%, rgba(113, 94, 221, 0.44), transparent 34%), radial-gradient(circle at 82% 82%, rgba(205, 83, 139, 0.30), transparent 38%), linear-gradient(145deg, #0b1322 0%, #17243c 48%, #34203b 100%)";

export const FULL_FRAME_CAPTURE_STAGE = Object.freeze({
  schemaVersion: CAPTURE_STAGE_SCHEMA_VERSION,
  mode: "full-frame",
});

export const DURE_DESKTOP_CAPTURE_STAGE = Object.freeze({
  schemaVersion: CAPTURE_STAGE_SCHEMA_VERSION,
  mode: "desktop-window",
  backdrop: "dure-dusk",
  menuBar: true,
  window: Object.freeze({
    left: 54,
    top: 50,
    width: 1_812,
    height: 982,
    borderRadius: 14,
  }),
});

const finitePositiveInteger = (value) =>
  Number.isInteger(value) && Number.isFinite(value) && value > 0;

export function captureStageClockLabel(clock) {
  const timestamp = new Date(clock);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error("captureStage clock must be a valid timestamp");
  }
  const hour = timestamp.getUTCHours();
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${weekday[timestamp.getUTCDay()]} ${month[timestamp.getUTCMonth()]} ${timestamp.getUTCDate()}  ${hour % 12 || 12}:${String(timestamp.getUTCMinutes()).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
}

export function validateCaptureStage(stage, viewport) {
  const errors = [];
  if (stage?.schemaVersion !== CAPTURE_STAGE_SCHEMA_VERSION) {
    errors.push(
      `captureStage.schemaVersion must be ${CAPTURE_STAGE_SCHEMA_VERSION}`,
    );
  }
  if (!new Set(["desktop-window", "full-frame"]).has(stage?.mode)) {
    errors.push("captureStage.mode must be desktop-window or full-frame");
    return errors;
  }
  if (stage.mode === "full-frame") return errors;
  if (stage.backdrop !== "dure-dusk") {
    errors.push("captureStage.backdrop must be dure-dusk");
  }
  if (stage.menuBar !== true) {
    errors.push("captureStage.menuBar must be true for desktop-window mode");
  }
  for (const key of ["left", "top", "width", "height", "borderRadius"]) {
    if (!finitePositiveInteger(stage.window?.[key])) {
      errors.push(`captureStage.window.${key} must be a positive integer`);
    }
  }
  if (
    finitePositiveInteger(stage.window?.left) &&
    finitePositiveInteger(stage.window?.width) &&
    stage.window.left + stage.window.width >= viewport?.width
  ) {
    errors.push("captureStage.window must leave desktop pixels on both sides");
  }
  if (
    finitePositiveInteger(stage.window?.top) &&
    finitePositiveInteger(stage.window?.height) &&
    stage.window.top + stage.window.height >= viewport?.height
  ) {
    errors.push("captureStage.window must leave desktop pixels above and below");
  }
  if (
    finitePositiveInteger(stage.window?.borderRadius) &&
    finitePositiveInteger(stage.window?.width) &&
    finitePositiveInteger(stage.window?.height) &&
    stage.window.borderRadius * 2 >=
      Math.min(stage.window.width, stage.window.height)
  ) {
    errors.push("captureStage.window.borderRadius is too large");
  }
  return errors;
}

export function captureStageBootstrapCss(scenario) {
  const stage = scenario.captureStage;
  if (stage.mode !== "desktop-window") return "";
  const window = stage.window;
  const menuFont =
    "-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif";
  return `
    html[data-dure-capture-stage="desktop-window"] {
      background: ${DURE_DUSK_BACKGROUND} !important;
      overflow: hidden !important;
    }
    html[data-dure-capture-stage="desktop-window"] body {
      background: transparent !important;
      overflow: hidden !important;
    }
    html[data-dure-capture-stage="desktop-window"]::before,
    html[data-dure-capture-stage="desktop-window"]::after {
      color: rgba(255, 255, 255, 0.88);
      font: 12px ${menuFont};
      font-weight: 650;
      letter-spacing: 0.01em;
      line-height: 28px;
      pointer-events: none;
      position: fixed;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.38);
      top: 0;
      z-index: 3;
    }
    html[data-dure-capture-stage="desktop-window"]::before {
      content: "Dure";
      left: 16px;
    }
    html[data-dure-capture-stage="desktop-window"]::after {
      content: "${captureStageClockLabel(scenario.clock)}";
      right: 16px;
    }
    html[data-dure-capture-stage="desktop-window"] #root {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: ${window.borderRadius}px;
      box-shadow: 0 34px 90px rgba(0, 0, 0, 0.48), 0 8px 28px rgba(0, 0, 0, 0.34);
      box-sizing: border-box;
      contain: layout paint;
      height: ${window.height}px;
      isolation: isolate;
      left: ${window.left}px;
      overflow: hidden;
      position: fixed;
      top: ${window.top}px;
      width: ${window.width}px;
      z-index: 2;
    }
    html[data-dure-capture-stage="desktop-window"] #root > :first-child {
      height: 100% !important;
      max-height: 100% !important;
      max-width: 100% !important;
      width: 100% !important;
    }
  `;
}

export async function assertCaptureStageBootstrap(page, scenario) {
  const stage = scenario.captureStage;
  if (stage.mode !== "desktop-window") return;
  await page.waitForFunction(
    (expected) => {
      const root = document.getElementById("root");
      if (!root) return false;
      const bounds = root.getBoundingClientRect();
      return (
        document.documentElement.dataset.dureCaptureStage ===
          "desktop-window" &&
        document.querySelector("[data-dure-capture-stage-bootstrap]") !== null &&
        Math.round(bounds.left) === expected.left &&
        Math.round(bounds.top) === expected.top &&
        Math.round(bounds.width) === expected.width &&
        Math.round(bounds.height) === expected.height
      );
    },
    stage.window,
    { timeout: 5_000 },
  );
}

export async function installCaptureStage(page, scenario) {
  await page.evaluate(
    ({ background, menuClockLabel, stage }) => {
      document.querySelector("[data-dure-capture-backdrop]")?.remove();
      document.querySelector("[data-dure-capture-menu-bar]")?.remove();
      document.querySelector("[data-dure-capture-stage-style]")?.remove();
      document.querySelector("[data-dure-capture-stage-bootstrap]")?.remove();
      const root = document.getElementById("root");
      if (!root) throw new Error("capture stage could not find the app root");
      document.documentElement.dataset.dureCaptureStage = stage.mode;
      if (stage.mode === "full-frame") return;

      const backdrop = document.createElement("div");
      backdrop.dataset.dureCaptureBackdrop = stage.backdrop;
      backdrop.setAttribute("aria-hidden", "true");
      Object.assign(backdrop.style, {
        background,
        inset: "0",
        pointerEvents: "none",
        position: "fixed",
        zIndex: "0",
      });

      const menu = document.createElement("div");
      menu.dataset.dureCaptureMenuBar = "macos";
      menu.setAttribute("aria-hidden", "true");
      const appName = document.createElement("span");
      appName.textContent = "Dure";
      appName.style.fontWeight = "650";
      const timeLabel = document.createElement("span");
      timeLabel.textContent = menuClockLabel;
      menu.append(appName, timeLabel);
      Object.assign(menu.style, {
        alignItems: "center",
        boxSizing: "border-box",
        color: "rgba(255, 255, 255, 0.88)",
        display: "flex",
        font: "12px -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif",
        height: "28px",
        justifyContent: "space-between",
        left: "0",
        letterSpacing: "0.01em",
        padding: "0 16px",
        pointerEvents: "none",
        position: "fixed",
        right: "0",
        textShadow: "0 1px 2px rgba(0, 0, 0, 0.38)",
        top: "0",
        zIndex: "3",
      });

      const style = document.createElement("style");
      style.dataset.dureCaptureStageStyle = "desktop-window";
      style.textContent = `
        html[data-dure-capture-stage="desktop-window"],
        html[data-dure-capture-stage="desktop-window"] body {
          background: #0b1322 !important;
          overflow: hidden !important;
        }
        html[data-dure-capture-stage="desktop-window"] #root > :first-child {
          height: 100% !important;
          max-height: 100% !important;
          max-width: 100% !important;
          width: 100% !important;
        }
      `;

      Object.assign(root.style, {
        background: "transparent",
        border: "1px solid rgba(255, 255, 255, 0.14)",
        borderRadius: `${stage.window.borderRadius}px`,
        boxShadow:
          "0 34px 90px rgba(0, 0, 0, 0.48), 0 8px 28px rgba(0, 0, 0, 0.34)",
        boxSizing: "border-box",
        contain: "layout paint",
        height: `${stage.window.height}px`,
        isolation: "isolate",
        left: `${stage.window.left}px`,
        overflow: "hidden",
        position: "fixed",
        top: `${stage.window.top}px`,
        width: `${stage.window.width}px`,
        zIndex: "2",
      });
      document.head.append(style);
      document.body.prepend(backdrop);
      document.body.append(menu);
    },
    {
      background: DURE_DUSK_BACKGROUND,
      menuClockLabel: captureStageClockLabel(scenario.clock),
      stage: scenario.captureStage,
    },
  );
}
