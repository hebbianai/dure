import { describe, expect, it } from "vitest";
import { HmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import {
	presentTerminalFailure,
	presentTerminalReceiptFailure,
	resolveTerminalFailureWithCompleteFrame,
	resolveTerminalReceiptFailure,
	TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
} from "./terminalFailurePresentation";

describe("terminal failure presentation authority", () => {
	it("renders the sanitized runtime summary and stable correlation identity", () => {
		const failure = presentTerminalFailure(
			new HmuxSessionFailureError({
				correlationId: "failure_0123456789abcdef",
				sessionId: "session-1",
				workspaceId: "workspace-1",
				terminalEpoch: "terminal-1",
				code: "provider_exited_before_conversation_identity",
				phase: "conversation_identity",
				summary:
					"Managed provider exited before conversation identity was established.",
				exitKind: "provider_error",
				exitCode: 1,
				occurredUnixMs: "3000",
				retryPosture: "never",
			}),
		);

		expect(failure).toEqual({
			kind: "general",
			recoveryAvailable: true,
			message:
				"Managed provider exited before conversation identity was established. Correlation: failure_0123456789abcdef",
			retiredByCompleteFrame: false,
		});
	});

	it("retires an older resize failure after a newer exact-attachment success", () => {
		const failure = presentTerminalReceiptFailure(
			new Error("platform_resize_failed"),
			"resize",
			"attachment-a",
			41n,
		);

		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-a", 42n),
		).toBeUndefined();
	});

	it("does not let an older or same request retire a newer resize failure", () => {
		const failure = presentTerminalReceiptFailure(
			new Error("platform_resize_failed"),
			"resize",
			"attachment-a",
			42n,
		);

		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-a", 41n),
		).toBe(failure);
		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-a", 42n),
		).toBe(failure);
	});

	it("does not let another attachment retire the failure", () => {
		const failure = presentTerminalReceiptFailure(
			new Error("platform_resize_failed"),
			"resize",
			"attachment-a",
			41n,
		);

		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-b", 42n),
		).toBe(failure);
	});

	it("retires a connection failure once a complete frame proves recovery", () => {
		const failure = presentTerminalFailure(
			new Error("transport closed"),
			true,
			TERMINAL_CONNECTION_FAILURE_MESSAGE_ID,
		);

		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-a"),
		).toBeUndefined();
		expect(failure).toMatchObject({
			messageId: "terminal.failure.connection",
			recoveryAvailable: true,
		});
	});

	it("keeps a refused input notice that a later frame does not undo", () => {
		const failure = presentTerminalFailure(
			new Error("hmux_structured_upstream_backpressure"),
		);

		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-a"),
		).toBe(failure);
		expect(failure).not.toMatchObject({ recoveryAvailable: true });
	});

	it("keeps a resize refusal awaiting its own receipt when a frame arrives", () => {
		const failure = presentTerminalReceiptFailure(
			new Error("platform_resize_failed"),
			"resize",
			"attachment-a",
			41n,
		);

		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-a"),
		).toBe(failure);
		expect(failure).not.toMatchObject({ recoveryAvailable: true });
	});

	it("does not let resize success hide a general transport failure", () => {
		const failure = presentTerminalFailure(new Error("transport closed"));

		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-a", 42n),
		).toBe(failure);
	});

	it("retires a refused input once a later input of its own kind is accepted", () => {
		const failure = presentTerminalReceiptFailure(
			new Error("terminal input refused: resource_limit"),
			"input",
			"attachment-a",
			41n,
		);

		expect(failure).toMatchObject({ kind: "receipt", operation: "input" });
		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-a"),
		).toBe(failure);
		expect(
			resolveTerminalReceiptFailure(failure, "resize", "attachment-a", 42n),
		).toBe(failure);
		expect(
			resolveTerminalReceiptFailure(failure, "input", "attachment-a", 42n),
		).toBeUndefined();
	});

	it("retires a refused receipt once a complete frame arrives from a later attachment", () => {
		// Review of #705: a pane closed and resumed keeps its session, so the
		// session-change clear never runs; the refusal must not outlive the
		// attachment that refused it.
		const failure = presentTerminalReceiptFailure(
			new Error("terminal input refused: resource_limit"),
			"input",
			"attachment-a",
			41n,
		);

		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-a"),
		).toBe(failure);
		expect(
			resolveTerminalFailureWithCompleteFrame(failure, "attachment-b"),
		).toBeUndefined();
	});
});
