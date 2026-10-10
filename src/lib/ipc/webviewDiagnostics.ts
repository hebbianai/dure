import { invoke } from "@tauri-apps/api/core";

export interface WebviewDiagnosticInput {
	level: "warn" | "error";
	source:
		| "console"
		| "window_error"
		| "unhandled_rejection"
		| "render_boundary"
		| "entry_import";
	code:
		| "redacted"
		| "client_space_window_changed"
		| "client_space_not_found"
		| "client_space_mount_timeout"
		| "client_source_pane_changed"
		| "client_space_changed"
		| "client_presentation_not_authorized";
}

interface WebviewDiagnosticEvent extends WebviewDiagnosticInput {
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

export const appendWebviewDiagnostics = (events: WebviewDiagnosticInput[]) =>
	invoke<void>("append_webview_diagnostics", { events });

export const readWebviewDiagnostics = (): Promise<WebviewDiagnostics> =>
	invoke<WebviewDiagnostics>("read_webview_diagnostics").catch(() => ({
		schemaVersion: 1,
		state: "unavailable",
		events: [],
	}));
