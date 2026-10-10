import { invoke } from "@tauri-apps/api/core";

import type {
	WebviewDiagnosticInput,
	WebviewDiagnostics,
} from "../../../cli/lib/contracts/webview-diagnostics.mjs";

export type {
	WebviewDiagnosticInput,
	WebviewDiagnostics,
} from "../../../cli/lib/contracts/webview-diagnostics.mjs";

export const appendWebviewDiagnostics = (events: WebviewDiagnosticInput[]) =>
	invoke<void>("append_webview_diagnostics", { events });

export const readWebviewDiagnostics = (): Promise<WebviewDiagnostics> =>
	invoke<WebviewDiagnostics>("read_webview_diagnostics").catch(() => ({
		schemaVersion: 1,
		state: "unavailable",
		events: [],
	}));
