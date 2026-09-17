import { invoke } from "@tauri-apps/api/core";

const WINDOW_FOCUS_QA_PLUGIN = "plugin:window-focus-qa";

export function reportWindowFocusQa(report: unknown): Promise<void> {
	return invoke(`${WINDOW_FOCUS_QA_PLUGIN}|report_window`, { report });
}

export function windowFocusQaContext<T>(proof: string): Promise<T> {
	return invoke<T>(`${WINDOW_FOCUS_QA_PLUGIN}|window_context`, { proof });
}

export function webviewStorageQaSnapshot(
	proof: string,
): Promise<number[] | null> {
	return invoke(`${WINDOW_FOCUS_QA_PLUGIN}|storage_snapshot`, { proof });
}

export function openWebviewStorageQaNativePeer(proof: string): Promise<void> {
	return invoke(`${WINDOW_FOCUS_QA_PLUGIN}|storage_native_peer`, { proof });
}
