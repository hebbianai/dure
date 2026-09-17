import { describe, expect, it, vi } from "vitest";
import {
	HmuxStructuredTerminalAttachError,
	hmuxStructuredTerminalAttachError,
	structuredTerminalAttachReconnectDelay,
	waitForStructuredTerminalAttachReconnect,
} from "./structuredTerminalAttachFailure";

describe("structured terminal attach failure", () => {
	it("decodes the desktop adapter's retry authority", () => {
		const failure = hmuxStructuredTerminalAttachError({
			code: "hmux_transport_closed",
			message: "structured terminal projection is inconsistent",
			retryDirective: "reconnect",
		});

		expect(failure).toBeInstanceOf(HmuxStructuredTerminalAttachError);
		expect(failure).toMatchObject({
			code: "hmux_transport_closed",
			message: "structured terminal projection is inconsistent",
			retryDirective: "reconnect",
		});
	});

	it("does not infer retry authority from an untyped message", () => {
		expect(
			hmuxStructuredTerminalAttachError(
				"Hmux Host refused attach (TransportClosed)",
			),
		).toBeUndefined();
	});

	it("backs off successive reconnects within a short presentation bound", () => {
		expect(
			[0, 1, 2, 3, 4, 9, 10, 20].map(structuredTerminalAttachReconnectDelay),
		).toEqual([250, 500, 1_000, 2_000, 4_000, 4_000, undefined, undefined]);
	});

	it("cancels a pending reconnect with its retired attachment", async () => {
		const controller = new AbortController();
		const reconnect = waitForStructuredTerminalAttachReconnect(
			0,
			controller.signal,
		);

		controller.abort();

		await expect(reconnect).resolves.toBe(false);
	});

	it("stops admitting reconnects after ten automatic successors", async () => {
		vi.useFakeTimers();
		try {
			const reconnect = waitForStructuredTerminalAttachReconnect(
				10,
				new AbortController().signal,
			);
			await vi.advanceTimersByTimeAsync(4_000);

			await expect(reconnect).resolves.toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
