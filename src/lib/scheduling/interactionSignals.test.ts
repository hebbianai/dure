import { describe, expect, it } from "vitest";
import { createInputInteractionNotifier } from "./interactionSignals";

describe("createInputInteractionNotifier", () => {
	it("throttles bursts and notifies again after the window", () => {
		let nowMs = 0;
		let notified = 0;
		const note = createInputInteractionNotifier(
			() => {
				notified += 1;
			},
			() => nowMs,
		);
		note();
		note();
		nowMs = 49;
		note();
		expect(notified).toBe(1);
		nowMs = 50;
		note();
		expect(notified).toBe(2);
	});
});
