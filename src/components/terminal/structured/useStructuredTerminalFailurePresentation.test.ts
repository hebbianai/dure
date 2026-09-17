// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TERMINAL_CONNECTION_FAILURE_MESSAGE_ID } from "@/lib/terminal/state/terminalFailurePresentation";
import type {
	PendingAttachmentRecoveryFailure,
	UpstreamSequence,
} from "./structuredTerminalViewportTransportContract";
import { useStructuredTerminalFailurePresentation } from "./useStructuredTerminalFailurePresentation";

function renderFailurePresentation() {
	const options = {
		isCurrentAttachment: () => true,
		pendingRecoveryFailureRef: {
			current: null as PendingAttachmentRecoveryFailure | null,
		},
		upstreamSequenceRef: { current: undefined as UpstreamSequence | undefined },
	};
	return renderHook(() => useStructuredTerminalFailurePresentation(options));
}

describe("terminal notice acknowledgement", () => {
	it("acknowledges a receipt refusal without consuming a later receipt", () => {
		const { result } = renderFailurePresentation();
		const attachment = {
			observerId: "observer-a",
			attachmentKey: "session-a",
			attachmentToken: "attachment-a",
			replacementAttachmentToken: "attachment-b",
		};
		act(() =>
			result.current.controller.failReceipt(attachment, "input", 1n, "refused"),
		);
		expect(result.current.dismissError).toBeTypeOf("function");
		act(() => result.current.dismissError?.());
		expect(result.current.error).toBeUndefined();
		act(() =>
			result.current.controller.failReceipt(attachment, "input", 2n, "refused"),
		);
		expect(result.current.error).toBe("refused");
	});

	it.each(["operation", "connection", "recovering"] as const)(
		"does not let a stale dismiss action clear a newer %s failure",
		(kind) => {
			const { result } = renderFailurePresentation();
			act(() => result.current.controller.report("failure"));
			const dismiss = result.current.dismissError;
			expect(dismiss).toBeTypeOf("function");
			act(() => {
				result.current.controller.report(
					"failure",
					kind === "recovering",
					kind === "connection"
						? TERMINAL_CONNECTION_FAILURE_MESSAGE_ID
						: undefined,
				);
				dismiss?.();
			});
			expect(result.current.error).toBe("failure");
			if (kind === "operation") {
				act(() => result.current.dismissError?.());
				expect(result.current.error).toBeUndefined();
			} else {
				expect(result.current.dismissError).toBeUndefined();
			}
		},
	);
});
