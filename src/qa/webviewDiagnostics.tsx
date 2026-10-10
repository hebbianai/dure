import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import type { BackgroundThrottlingPolicy } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { webviewStorageOptions } from "@/lib/ipc/core";
import { qaLog } from "@/lib/qa/qaLog";

const proof = new URLSearchParams(location.search).get("qaWebviewDiagnostics");
const label = getCurrentWebviewWindow().label;
function BrokenRender(): never {
	throw new Error("diagnostic-fixture-secret-render");
}

export function WebviewDiagnosticsQaRoot() {
	useEffect(() => {
		void (async () => {
			if (!proof || !import.meta.env.DEV)
				throw new Error("Missing diagnostic QA proof");
			const options = await webviewStorageOptions();
			if (!options.dataStoreIdentifier)
				throw new Error("Missing isolated WebView store");
			// Synthetic canaries: no user content is involved, including dev QA logs.
			console.warn("diagnostic-fixture-secret-console", {
				token: "diagnostic-fixture-secret-token",
			});
			console.error(
				"client_space_window_changed",
				new Error(
					"https://user:diagnostic-fixture-secret-password@example.invalid/private",
				),
			);
			setTimeout(() => {
				throw new Error("diagnostic-fixture-secret-runtime");
			}, 0);
			void Promise.reject(new Error("diagnostic-fixture-secret-rejection"));
			if (label === "main") {
				new WebviewWindow("win-195-1", {
					...options,
					url: `index.html?qaWebviewDiagnostics=${encodeURIComponent(proof)}`,
					visible: false,
					focus: false,
					focusable: false,
					backgroundThrottling: "disabled" as BackgroundThrottlingPolicy,
				});
			}
			// Native writes are asynchronous; the external client reads the real
			// on-disk journal separately instead of trusting this receipt.
			setTimeout(
				() => qaLog("webview-diagnostics", { proof, label, result: "emitted" }),
				3_000,
			);
		})();
	}, []);
	return (
		<AppErrorBoundary>
			<BrokenRender />
		</AppErrorBoundary>
	);
}
