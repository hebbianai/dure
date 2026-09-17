// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
	onQuickDispatchProgress,
	publishQuickDispatchProgress,
} from "@/lib/agents/quickDispatch/quickDispatchProgress";

describe("quick-dispatch progress bus", () => {
	it("delivers published progress to subscribers", () => {
		const seen = vi.fn();
		const off = onQuickDispatchProgress(seen);
		publishQuickDispatchProgress({ intentId: "qd_1", stage: "naming" });
		expect(seen).toHaveBeenCalledWith({ intentId: "qd_1", stage: "naming" });
		off();
	});

	it("stops delivering after unsubscribe", () => {
		const seen = vi.fn();
		const off = onQuickDispatchProgress(seen);
		off();
		publishQuickDispatchProgress({ intentId: "qd_1", stage: "done" });
		expect(seen).not.toHaveBeenCalled();
	});

	it("ignores events with malformed detail", () => {
		const seen = vi.fn();
		const off = onQuickDispatchProgress(seen);
		window.dispatchEvent(
			new CustomEvent("dure:quick-dispatch-progress", {
				detail: { stage: 42 },
			}),
		);
		expect(seen).not.toHaveBeenCalled();
		off();
	});
});
