import { isTauri } from "@/lib/ipc/core";
import { appendWebviewDiagnostics } from "@/lib/ipc/webviewDiagnostics";
import { installWebviewDiagnostics } from "@/lib/platform/webviewDiagnostics";

// Imported before the application graph, in every desktop window. Keep this
// independent of stores, React, CLI startup and per-window selection state.
const stop = isTauri()
	? installWebviewDiagnostics(window, console, appendWebviewDiagnostics)
	: undefined;
if (import.meta.hot) import.meta.hot.dispose(() => stop?.());
