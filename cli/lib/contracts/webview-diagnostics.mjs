// One bounded public projection for the desktop producer and CLI reader.
export const WEBVIEW_DIAGNOSTIC_CODES = Object.freeze([
  "redacted", "client_space_window_changed", "client_space_not_found",
  "client_space_mount_timeout", "client_source_pane_changed", "client_space_changed",
  "client_presentation_not_authorized",
]);
export const WEBVIEW_DIAGNOSTIC_SOURCES = Object.freeze([
  "console", "window_error", "unhandled_rejection", "render_boundary", "entry_import",
]);
export const MAX_WEBVIEW_DIAGNOSTIC_EVENTS = 256;

export function parseWebviewDiagnostics(value) {
  if (value?.schemaVersion !== 1 || !["available", "unavailable"].includes(value.state) ||
      !Array.isArray(value.events) || value.events.length > MAX_WEBVIEW_DIAGNOSTIC_EVENTS ||
      (value.state === "unavailable" && value.events.length !== 0)) return null;
  const events = [];
  for (const event of value.events) {
    if (!event || !["warn", "error"].includes(event.level) ||
        !WEBVIEW_DIAGNOSTIC_CODES.includes(event.code) ||
        !WEBVIEW_DIAGNOSTIC_SOURCES.includes(event.source) ||
        typeof event.windowLabel !== "string" || event.windowLabel.length > 128 ||
        !/^(?:main|win-source-control|win-\d+-\d+|window-[a-f0-9]{64})$/.test(event.windowLabel) ||
        !Number.isSafeInteger(event.firstSeenMs) || event.firstSeenMs < 0 ||
        !Number.isSafeInteger(event.lastSeenMs) || event.lastSeenMs < event.firstSeenMs ||
        !Number.isInteger(event.count) || event.count < 1 || event.count > 0xffff_ffff) return null;
    // Never forward arbitrary console text, URLs, stacks or extra object fields.
    events.push({ level: event.level, source: event.source, code: event.code,
      windowLabel: event.windowLabel, firstSeenMs: event.firstSeenMs,
      lastSeenMs: event.lastSeenMs, count: event.count });
  }
  return { schemaVersion: 1, state: value.state, events };
}
