import { describe, expect, it } from "vitest";
import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { structuredTerminalAttachPreparationError } from "@/lib/terminal/structuredTerminalAttachPreparation";

function backendFailure(
	disposition: "retry_same" | "terminal" | "stale_generation",
) {
	return new DureBackendRequestError(
		"agent_runtime_native_rehost_unavailable",
		"native rehost unavailable",
		{ kind: "operation", disposition },
	);
}

describe("structured terminal attach preparation", () => {
	it("maps retry-same backend work onto the bounded reconnect directive", () => {
		const failure = structuredTerminalAttachPreparationError(
			backendFailure("retry_same"),
		);

		expect(failure).toBeInstanceOf(HmuxStructuredTerminalAttachError);
		expect(failure).toMatchObject({
			code: "agent_runtime_native_rehost_unavailable",
			message: "native rehost unavailable",
			retryDirective: "reconnect",
		});
	});

	it.each(["terminal", "stale_generation"] as const)(
		"preserves a %s backend refusal as the original fail-closed error",
		(disposition) => {
			const failure = backendFailure(disposition);

			expect(structuredTerminalAttachPreparationError(failure)).toBe(failure);
		},
	);
});
