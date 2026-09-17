import { describe, expect, it } from "vitest";
import { isRetiredStructuredTerminalAttachment } from "./structuredTerminalUpstreamFailure";

describe("structured terminal upstream failure classification", () => {
	it.each([
		new Error("structured terminal connection is not attached"),
		"structured terminal connection is not attached",
	])("classifies a retired observer generation as an attachment fault", (cause) => {
		expect(isRetiredStructuredTerminalAttachment(cause)).toBe(true);
	});

	it.each([
		new Error(
			"hmux_structured_upstream_backpressure: structured terminal upstream queue is full",
		),
		new Error("Host refused semantic input"),
	])("keeps a real input refusal visible after later output", (cause) => {
		expect(isRetiredStructuredTerminalAttachment(cause)).toBe(false);
	});
});
