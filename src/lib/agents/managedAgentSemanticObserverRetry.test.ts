import { describe, expect, it } from "vitest";
import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import {
	semanticObserverFailureEvidence,
	semanticObserverRetry,
} from "./managedAgentSemanticObserverRetry";

describe("managed agent semantic observer retry", () => {
	it("backs off from one second to a thirty second ceiling", () => {
		expect(semanticObserverRetry(0).delayMs).toBe(1_000);
		expect(semanticObserverRetry(3).delayMs).toBe(8_000);
		expect(semanticObserverRetry(5).delayMs).toBe(30_000);
		expect(semanticObserverRetry(50).delayMs).toBe(30_000);
	});

	it("keeps retrying while a first attach could still be racing a spawn", () => {
		for (const failures of [0, 1, 2, 5, 9]) {
			expect(semanticObserverRetry(failures).exhausted).toBe(false);
		}
	});

	// A binding whose session no longer exists in any discovery root can never
	// succeed. Measured on a live machine: three such bindings retried every 30s
	// for 82 minutes and filled both pane-diagnostics tiers with one code,
	// destroying the evidence for every other connection failure.
	it("gives up once an observation has failed too many times in a row", () => {
		expect(semanticObserverRetry(10).exhausted).toBe(true);
		expect(semanticObserverRetry(200).exhausted).toBe(true);
	});
});

describe("retired managed session failure classification", () => {
	it("recognizes local and remote retired-source codes at the boundary", () => {
		expect(
			semanticObserverFailureEvidence(
				new Error(
					'hmux_session_not_found: Hmux session "s" was not found in workspace "w"',
				),
			).retiredSource,
		).toBe(true);
		for (const code of [
			"hmux_session_exited",
			"remote_hmux_session_not_found",
			"remote_hmux_session_exited",
			"remote_hmux_session_class_mismatch",
			"remote_hmux_managed_attach_generation_changed",
			"managed_agent_semantic_attach_generation_changed",
		]) {
			expect(
				semanticObserverFailureEvidence(new Error(code)).retiredSource,
			).toBe(true);
		}
		// Unavailability is not proof of absence — those must keep the budget.
		expect(
			semanticObserverFailureEvidence(
				new Error("hmux_observer_activation_stale: superseded"),
			).retiredSource,
		).toBe(false);
		expect(
			semanticObserverFailureEvidence(new Error("connection refused"))
				.retiredSource,
		).toBe(false);
	});

	it("reads a retired-source code from typed attach evidence, not prose", () => {
		const failure = semanticObserverFailureEvidence(
			new HmuxStructuredTerminalAttachError({
				code: "hmux_session_not_found",
				message: 'Hmux session "session-a" was not found',
				retryDirective: "never",
			}),
		);
		expect(failure).toEqual({
			code: "hmux_session_not_found",
			retryDirective: "never",
			retiredSource: true,
		});
	});
});
