import { describe, expect, it } from "vitest";
import {
	TERMINAL_CARRIER_CLOSE_PENDING_INPUT_NOTE,
	terminalCarrierClose,
} from "./terminalCarrierCloseDisposition";

describe("terminal carrier close", () => {
	it("recovers a close the Host declared reconnectable", () => {
		expect(
			terminalCarrierClose({
				code: "hmux_resource_limit",
				message: "Hmux subscriber output backlog requires snapshot recovery",
				retryDirective: "reconnect",
				pendingInput: false,
			}),
		).toEqual({
			disposition: "recoverable",
			cause: "Hmux subscriber output backlog requires snapshot recovery",
		});
	});

	// Same code as the recoverable case above, opposite posture — which is why
	// the decision cannot be keyed off the code.
	it("does not recover a close the Host declared terminal", () => {
		expect(
			terminalCarrierClose({
				code: "hmux_resource_limit",
				message: "complete viewport requires 20000000 encoded bytes",
				retryDirective: "never",
				pendingInput: false,
			}).disposition,
		).toBe("permanent");
	});

	// Regression: a subscriber dropped for an output backlog while the user was
	// typing was reported as a dead process, and Resume then replaced the live
	// provider mid-turn. Unacknowledged input is a note on the cause; the
	// Host's posture alone decides whether the pane reattaches.
	it("still recovers a reconnectable close while input is unacknowledged", () => {
		expect(
			terminalCarrierClose({
				code: "hmux_resource_limit",
				message: "Hmux subscriber output backlog requires snapshot recovery",
				retryDirective: "reconnect",
				pendingInput: true,
			}),
		).toEqual({
			disposition: "recoverable",
			cause: `Hmux subscriber output backlog requires snapshot recovery; ${TERMINAL_CARRIER_CLOSE_PENDING_INPUT_NOTE}`,
		});
	});

	it("treats a resync directive as permanent until a producer exists", () => {
		expect(
			terminalCarrierClose({
				retryDirective: "retry_after_resync",
				pendingInput: false,
			}).disposition,
		).toBe("permanent");
	});

	it("falls back to the code, then a fixed sentence, for its cause", () => {
		expect(
			terminalCarrierClose({
				code: "hmux_stream_desynchronized",
				retryDirective: "never",
				pendingInput: false,
			}).cause,
		).toBe("hmux_stream_desynchronized");
		expect(
			terminalCarrierClose({ retryDirective: "never", pendingInput: false })
				.cause,
		).toBe("structured terminal closed");
	});
});
