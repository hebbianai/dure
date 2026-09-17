import { describe, expect, it, vi } from "vitest";
import {
	beginManagedCredentialSwitchTransition,
	getManagedCredentialSwitchTransition,
	presentManagedCredentialSwitchHealthState,
	shouldPresentManagedCredentialSwitchTransition,
	subscribeManagedCredentialSwitchTransition,
	withManagedCredentialSwitchTransition,
} from "@/lib/sessions/managed/managedCredentialSwitchTransition";

describe("managedCredentialSwitchTransition", () => {
	it("publishes only the active replacement boundary and ref-counts overlap", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeManagedCredentialSwitchTransition(
			"agent-1",
			listener,
		);
		const endFirst = beginManagedCredentialSwitchTransition("agent-1");
		const endSecond = beginManagedCredentialSwitchTransition("agent-1");

		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		endFirst();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(true);
		expect(listener).toHaveBeenCalledTimes(1);
		endFirst();
		endSecond();
		expect(getManagedCredentialSwitchTransition("agent-1")).toBe(false);
		expect(listener).toHaveBeenCalledTimes(2);
		unsubscribe();
	});

	it("uses only a successful durable completion checkpoint across reload", () => {
		expect(shouldPresentManagedCredentialSwitchTransition(false)).toBe(false);
		expect(
			shouldPresentManagedCredentialSwitchTransition(false, {
				completionRuntimeRevision: "12",
			}),
		).toBe(false);
		expect(
			shouldPresentManagedCredentialSwitchTransition(false, {
				completionRuntimeRevision: "12",
				completionTurnCompletedCount: "7",
			}),
		).toBe(true);
		expect(
			shouldPresentManagedCredentialSwitchTransition(false, {
				completionRuntimeRevision: "12",
				completionTurnCompletedCount: "7",
				lastError: "replacement_failed",
			}),
		).toBe(false);
	});

	it("turns only transient hard health into connecting", () => {
		expect(presentManagedCredentialSwitchHealthState("error", true)).toBe(
			"connecting",
		);
		expect(presentManagedCredentialSwitchHealthState("stale", true)).toBe(
			"connecting",
		);
		expect(presentManagedCredentialSwitchHealthState("error", false)).toBe(
			"error",
		);
		expect(presentManagedCredentialSwitchHealthState("live", true)).toBe(
			"live",
		);
	});

	it("clears the transition after a failed replacement", async () => {
		await expect(
			withManagedCredentialSwitchTransition("agent-failed", async () => {
				expect(getManagedCredentialSwitchTransition("agent-failed")).toBe(true);
				throw new Error("replacement failed");
			}),
		).rejects.toThrow("replacement failed");
		expect(getManagedCredentialSwitchTransition("agent-failed")).toBe(false);
	});
});
