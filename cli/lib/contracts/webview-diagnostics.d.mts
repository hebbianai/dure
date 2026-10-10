export type WebviewDiagnosticCode = "redacted" | "client_space_window_changed" |
  "client_space_not_found" | "client_space_mount_timeout" | "client_source_pane_changed" |
  "client_space_changed" | "client_presentation_not_authorized";
export type WebviewDiagnosticSource = "console" | "window_error" | "unhandled_rejection" |
  "render_boundary" | "entry_import";
export interface WebviewDiagnosticInput {
  level: "warn" | "error";
  source: WebviewDiagnosticSource;
  code: WebviewDiagnosticCode;
}
export interface WebviewDiagnosticEvent extends WebviewDiagnosticInput {
  windowLabel: string;
  firstSeenMs: number;
  lastSeenMs: number;
  count: number;
}
export interface WebviewDiagnostics {
  schemaVersion: 1;
  state: "available" | "unavailable";
  events: WebviewDiagnosticEvent[];
}
export const WEBVIEW_DIAGNOSTIC_CODES: readonly WebviewDiagnosticCode[];
export const WEBVIEW_DIAGNOSTIC_SOURCES: readonly WebviewDiagnosticSource[];
export const MAX_WEBVIEW_DIAGNOSTIC_EVENTS: 256;
export function parseWebviewDiagnostics(value: unknown): WebviewDiagnostics | null;
