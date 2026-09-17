import { describe, expect, it } from "vitest";
import { currentWebviewInstanceIdentity } from "./webviewInstanceIdentity";

describe("WebView instance identity", () => {
	it("replaces reload A without changing the live identity of window B", () => {
		const bootA1: Record<string, unknown> = {};
		const bootB1: Record<string, unknown> = {};
		const oldA = currentWebviewInstanceIdentity(bootA1, 100);
		const oldB = currentWebviewInstanceIdentity(bootB1, 100);

		const newA = currentWebviewInstanceIdentity({}, 200);
		const currentB = currentWebviewInstanceIdentity(bootB1, 200);

		expect(newA.instanceId).not.toBe(oldA.instanceId);
		expect(currentB.instanceId).toBe(oldB.instanceId);
		expect(currentB.startedAt).toBe(oldB.startedAt);
		expect(Object.keys(bootB1)).toHaveLength(2);
	});

	it("returns one stable owner throughout a JavaScript realm", () => {
		const scope: Record<string, unknown> = {};
		const first = currentWebviewInstanceIdentity(scope, 100);
		const later = currentWebviewInstanceIdentity(scope, 5_100);

		expect(later.instanceId).toBe(first.instanceId);
		expect(later.startedAt).toBe(first.startedAt);
		expect(later.uptimeMs).toBe(5_000);
		expect(Object.keys(scope).sort()).toEqual([
			"__dureHmuxDiagnosticWebviewInstanceV1",
			"__dureHmuxDiagnosticWebviewStartedAtV1",
		]);
	});

	it("migrates a pre-rename realm identity without changing its generation", () => {
		const scope: Record<string, unknown> = {
			__hebbianHmuxDiagnosticWebviewInstanceV1: "legacy-webview",
			__hebbianHmuxDiagnosticWebviewStartedAtV1: 1_000,
		};

		expect(currentWebviewInstanceIdentity(scope, 6_000)).toEqual({
			instanceId: "legacy-webview",
			startedAt: new Date(1_000).toISOString(),
			uptimeMs: 5_000,
		});
		expect(Object.keys(scope).sort()).toEqual([
			"__dureHmuxDiagnosticWebviewInstanceV1",
			"__dureHmuxDiagnosticWebviewStartedAtV1",
		]);
	});
});
