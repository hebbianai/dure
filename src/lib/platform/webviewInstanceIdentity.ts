import { LEGACY_PRODUCT_COMPATIBILITY } from "@/lib/platform/legacyProductCompatibility";

const WEBVIEW_INSTANCE_KEY = "__dureHmuxDiagnosticWebviewInstanceV1";
const WEBVIEW_STARTED_AT_KEY = "__dureHmuxDiagnosticWebviewStartedAtV1";

export interface WebviewInstanceIdentity {
	instanceId: string;
	startedAt: string;
	uptimeMs: number;
}

/** Returns one identity for the lifetime of the current JavaScript realm. */
export function currentWebviewInstanceIdentity(
	scope: Record<string, unknown> = globalThis as unknown as Record<
		string,
		unknown
	>,
	now = Date.now(),
): WebviewInstanceIdentity {
	const storedInstanceId =
		scope[WEBVIEW_INSTANCE_KEY] ??
		scope[LEGACY_PRODUCT_COMPATIBILITY.webviewInstanceKey];
	const instanceId =
		typeof storedInstanceId === "string" && storedInstanceId.length > 0
			? storedInstanceId
			: (globalThis.crypto?.randomUUID?.() ??
				`webview-${now}-${Math.random().toString(16).slice(2)}`);
	if (scope[WEBVIEW_INSTANCE_KEY] !== instanceId) {
		scope[WEBVIEW_INSTANCE_KEY] = instanceId;
	}
	Reflect.deleteProperty(scope, LEGACY_PRODUCT_COMPATIBILITY.webviewInstanceKey);
	const storedStartedAtMs =
		scope[WEBVIEW_STARTED_AT_KEY] ??
		scope[LEGACY_PRODUCT_COMPATIBILITY.webviewStartedAtKey];
	const startedAtMs =
		typeof storedStartedAtMs === "number" &&
		Number.isFinite(storedStartedAtMs) &&
		storedStartedAtMs <= now
			? storedStartedAtMs
			: now;
	if (scope[WEBVIEW_STARTED_AT_KEY] !== startedAtMs) {
		scope[WEBVIEW_STARTED_AT_KEY] = startedAtMs;
	}
	Reflect.deleteProperty(scope, LEGACY_PRODUCT_COMPATIBILITY.webviewStartedAtKey);
	return {
		instanceId,
		startedAt: new Date(startedAtMs).toISOString(),
		uptimeMs: Math.max(0, now - startedAtMs),
	};
}
