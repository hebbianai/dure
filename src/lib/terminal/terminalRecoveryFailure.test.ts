import { describe, expect, it } from "vitest";
import {
	managedCreateInvokeOutcomeUnknown,
	ManagedCreateRetrySameError,
} from "@/lib/hmux/managed/managedCreateResolution";
import {
	terminalRecoveryFailure,
	terminalRecoveryFailureMessageId,
} from "./terminalRecoveryFailure";

const busy = new ManagedCreateRetrySameError(
	"create_retryable",
	"session_checkout_store_busy",
	"store is busy during prepare_session_checkout",
);

describe("terminal recovery failure presentation", () => {
	it("names a busy backend and keeps the raw cause for the details", () => {
		const failure = terminalRecoveryFailure("resume", busy);
		expect(failure).toEqual({
			operation: "resume",
			detail: "store is busy during prepare_session_checkout",
			busy: true,
		});
		expect(terminalRecoveryFailureMessageId(failure, false)).toBe(
			"terminal.recovery.resumeBusy",
		);
	});

	it.each([
		["an unknown create outcome", managedCreateInvokeOutcomeUnknown(new Error("store is busy"))],
		["another retryable code", new ManagedCreateRetrySameError("pending", "hmux_managed_create_pending", "pending")],
		["a plain error", new Error("launch failed")],
		["a string", "launch failed"],
	])("keeps the general Resume failure for %s", (_, cause) => {
		const failure = terminalRecoveryFailure("resume", cause);
		expect(failure.busy).toBe(false);
		expect(terminalRecoveryFailureMessageId(failure, false)).toBe(
			"terminal.recovery.resumeFailed",
		);
	});

	it("keeps the operation's own message for worktree and reconnect failures", () => {
		expect(
			terminalRecoveryFailureMessageId(terminalRecoveryFailure("recreate", busy), false),
		).toBe("terminal.recovery.worktreeRecreateFailed");
		expect(
			terminalRecoveryFailureMessageId(terminalRecoveryFailure("resume", busy), true),
		).toBe("terminal.recovery.reconnectFailed");
		expect(terminalRecoveryFailureMessageId(undefined, false)).toBe(
			"terminal.recovery.resumeFailed",
		);
	});
});
