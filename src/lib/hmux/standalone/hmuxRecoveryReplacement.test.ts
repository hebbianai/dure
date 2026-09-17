import { describe, expect, it } from "vitest";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { isWritableHealthyStandaloneReplacement } from "@/lib/hmux/standalone/hmuxRecoveryReplacement";

function replacement(
	patch: Partial<HmuxSessionSummary> = {},
): HmuxSessionSummary {
	return {
		sessionId: "replacement",
		workspaceId: "workspace",
		sessionClass: "standalone",
		lifecycle: "ready",
		manifestLifecycle: "ready",
		health: "current_healthy",
		inputAllowed: true,
		detachOnly: false,
		terminalEpoch: "terminal",
		outputSeq: "0",
		capabilities: [],
		...patch,
	};
}

describe("Hmux recovery replacement validation", () => {
	it("accepts only a fresh writable standalone projection", () => {
		expect(isWritableHealthyStandaloneReplacement(replacement())).toBe(true);
		expect(
			isWritableHealthyStandaloneReplacement(
				replacement({ health: "compatible_old_healthy" }),
			),
		).toBe(true);
		expect(
			isWritableHealthyStandaloneReplacement(
				replacement({
					lifecycle: "unavailable",
					health: "stale_transport",
					inputAllowed: false,
					detachOnly: true,
				}),
			),
		).toBe(false);
		expect(
			isWritableHealthyStandaloneReplacement(
				replacement({ inputAllowed: false, detachOnly: true }),
			),
		).toBe(false);
	});
});
