#!/usr/bin/env node

import tauriSchema from "@tauri-apps/cli/config.schema.json" with { type: "json" };

const LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_URL = /^(?:index\.html|tools\/media-capture\/native\/window\.html)(?:\?[^#]*)?$/u;
const WINDOW_KEYS = new Set([
  "acceptFirstMouse",
  "create",
  "focus",
  "focusable",
  "height",
  "hiddenTitle",
  "label",
  "title",
  "titleBarStyle",
  "transparent",
  "url",
  "visible",
  "width",
  "windowEffects",
  "x",
  "y",
]);

function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedText(value, label, maximum) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be printable text of at most ${maximum} characters`);
  }
  return value;
}

function optionalBoolean(value, label, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function windowEffects(value, index) {
  const label = `window plan entry ${index} windowEffects`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.keys(value).some((key) => !["effects", "state", "radius"].includes(key))) {
    throw new Error(`${label} has unsupported fields`);
  }
  // The installed Tauri schema owns material/state names. Keep this adapter
  // bounded without maintaining a second enum that drifts from the native CLI.
  const allows = (definition, item) => tauriSchema.definitions[definition].oneOf
    .some((variant) => variant.enum.includes(item));
  if (!Array.isArray(value.effects) || value.effects.length > 8 ||
    !value.effects.every((effect) => allows("WindowEffect", effect))) {
    throw new Error(`${label}.effects must contain supported Tauri effects`);
  }
  if (value.state !== undefined && !allows("WindowEffectState", value.state)) {
    throw new Error(`${label}.state is unsupported`);
  }
  if (value.radius !== undefined &&
    (!Number.isFinite(value.radius) || value.radius < 0 || value.radius > 4_096)) {
    throw new Error(`${label}.radius must be a finite number from 0 to 4096`);
  }
  return {
    effects: [...value.effects],
    ...(value.state === undefined ? {} : { state: value.state }),
    ...(value.radius === undefined ? {} : { radius: value.radius }),
  };
}

function normalizeWindow(input, index) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`window plan entry ${index} must be an object`);
  }
  const unknown = Object.keys(input).filter((key) => !WINDOW_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`window plan entry ${index} has unknown fields: ${unknown.join(", ")}`);
  }
  const label = boundedText(input.label, `window plan entry ${index} label`, 64);
  if (!LABEL.test(label)) {
    throw new Error(`window plan entry ${index} label is not filesystem-safe`);
  }
  const url = boundedText(input.url, `window plan entry ${index} url`, 2_048);
  if (
    !SAFE_URL.test(url) ||
    url.includes("..") ||
    url.includes("\\") ||
    /%(?:2e|2f|5c)/iu.test(url)
  ) {
    throw new Error(`window plan entry ${index} URL is outside the QA allowlist`);
  }
  const titleBarStyle = input.titleBarStyle ?? "Overlay";
  if (!["Overlay", "Visible"].includes(titleBarStyle)) {
    throw new Error(`window plan entry ${index} titleBarStyle is unsupported`);
  }
  return {
    label,
    title: boundedText(input.title, `window plan entry ${index} title`, 160),
    url,
    create: optionalBoolean(input.create, `window plan entry ${index} create`, true),
    width: boundedInteger(input.width, `window plan entry ${index} width`, 320, 3_840),
    height: boundedInteger(input.height, `window plan entry ${index} height`, 240, 2_160),
    ...(input.x === undefined
      ? {}
      : { x: boundedInteger(input.x, `window plan entry ${index} x`, -4_096, 8_192) }),
    ...(input.y === undefined
      ? {}
      : { y: boundedInteger(input.y, `window plan entry ${index} y`, -4_096, 8_192) }),
    visible: optionalBoolean(input.visible, `window plan entry ${index} visible`, true),
    focus: optionalBoolean(input.focus, `window plan entry ${index} focus`, false),
    focusable: optionalBoolean(input.focusable, `window plan entry ${index} focusable`, true),
    ...(input.acceptFirstMouse === undefined ? {} : {
      acceptFirstMouse: optionalBoolean(input.acceptFirstMouse, `window plan entry ${index} acceptFirstMouse`),
    }),
    titleBarStyle,
    hiddenTitle: optionalBoolean(
      input.hiddenTitle,
      `window plan entry ${index} hiddenTitle`,
      true,
    ),
    transparent: optionalBoolean(
      input.transparent,
      `window plan entry ${index} transparent`,
      false,
    ),
    ...(input.windowEffects === undefined ? {} : {
      windowEffects: windowEffects(input.windowEffects, index),
    }),
    dragDropEnabled: false,
    backgroundThrottling: "disabled",
  };
}

export function qaWindowPlan({ serialized, title, url }) {
  if (!serialized) {
    return [
      {
        label: "main",
        title,
        url,
        width: 480,
        height: 240,
        visible: false,
        focus: false,
        focusable: false,
        backgroundThrottling: "disabled",
      },
    ];
  }
  if (Buffer.byteLength(serialized, "utf8") > 32 * 1024) {
    throw new Error("DURE_QA_WINDOW_PLAN_JSON exceeds 32 KiB");
  }
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("DURE_QA_WINDOW_PLAN_JSON is invalid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 3) {
    throw new Error("DURE_QA_WINDOW_PLAN_JSON must contain one to three windows");
  }
  const windows = parsed.map(normalizeWindow);
  if (new Set(windows.map(({ label }) => label)).size !== windows.length) {
    throw new Error("DURE_QA_WINDOW_PLAN_JSON window labels must be unique");
  }
  return windows;
}

export function qaTauriConfig({ layer, port, serializedWindows, title, url }) {
  if (!/^[a-z0-9_]+$/u.test(layer)) throw new Error("QA layer is invalid");
  const normalizedPort = boundedInteger(Number(port), "Vite port", 1, 65_535);
  const windows = qaWindowPlan({ serialized: serializedWindows, title, url });
  return {
    build: {
      devUrl: `http://127.0.0.1:${normalizedPort}`,
      // The runner reserves an ephemeral port and releases the probe socket
      // before Tauri starts Vite. Under concurrent QA another process can win
      // that short gap. Vite's default is to silently bind the next port while
      // Tauri keeps polling the original one for 180 seconds. Fail immediately
      // so the owning runner reports the actual bind collision and can retry a
      // fresh isolated generation instead of looking like a product timeout.
      // Run the repository-pinned entry point directly. Nesting `pnpm exec`
      // under the generation-tracking QA supervisor can leave the package
      // manager waiting while Tauri polls a server that was never started.
      // QA does not need package-manager command resolution here: the runner
      // has already asserted the checkout and its installed dependencies.
      beforeDevCommand: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${normalizedPort} --strictPort`,
    },
    app: {
      windows,
      ...(serializedWindows
        ? {
            security: {
              capabilities: [
                "default",
                {
                  identifier: `${layer.replaceAll("_", "-")}-window-title-proof`,
                  windows: windows.map(({ label }) => label),
                  permissions: ["core:window:allow-set-title"],
                },
              ],
            },
          }
        : {}),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(
      JSON.stringify(
        qaTauriConfig({
          layer: process.env.DURE_QA_LAYER ?? "exclusive_focus",
          port: process.env.DURE_QA_VITE_PORT,
          serializedWindows: process.env.DURE_QA_WINDOW_PLAN_JSON,
          title: process.env.DURE_QA_WINDOW_TITLE ?? "Dure QA",
          url: process.env.DURE_QA_WINDOW_URL ?? "index.html",
        }),
      ),
    );
  } catch (error) {
    process.stderr.write(`tauri-window-config: ${error.message}\n`);
    process.exitCode = 1;
  }
}
