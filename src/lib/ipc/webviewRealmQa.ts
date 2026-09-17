import { invoke } from "@tauri-apps/api/core";

/** Replay only a disposable QA realm's retained identity through the real command. */
export function attachPredecessorRealmForQa(request: {
	webviewInstanceId: string;
	sessionId: string;
	workspaceId: string;
}) {
	if (
		!import.meta.env.DEV ||
		!new URLSearchParams(location.search).has("qaWebviewRealm")
	)
		throw new Error("WebView realm replay requires explicit development QA");
	return invoke("hmux_structured_terminal_attach", {
		...request,
		observerId: `qa-predecessor-${crypto.randomUUID()}`,
		surfaceId: `qa-predecessor-${crypto.randomUUID()}`,
		access: "read_only",
	});
}
