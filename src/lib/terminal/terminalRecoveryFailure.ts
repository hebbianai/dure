import { isManagedCreateStoreBusy } from "@/lib/hmux/managed/managedCreateResolution";

export type TerminalRecoveryOperation = "resume" | "recreate";

/** A refused recovery action. The visible line names a reason the user can act
 * on; the raw cause stays in the error details they can open or copy. */
export interface TerminalRecoveryFailure {
	readonly operation: TerminalRecoveryOperation;
	readonly detail: string;
	/** The backend was too busy to start the session and changed nothing. */
	readonly busy: boolean;
}

export function terminalRecoveryFailure(
	operation: TerminalRecoveryOperation,
	cause: unknown,
): TerminalRecoveryFailure {
	return {
		operation,
		detail: cause instanceof Error ? cause.message : String(cause),
		busy: isManagedCreateStoreBusy(cause),
	};
}

export function terminalRecoveryFailureMessageId(
	failure: TerminalRecoveryFailure | undefined,
	reconnects: boolean,
): string {
	if (failure?.operation === "recreate") {
		return "terminal.recovery.worktreeRecreateFailed";
	}
	if (reconnects) return "terminal.recovery.reconnectFailed";
	return failure?.busy
		? "terminal.recovery.resumeBusy"
		: "terminal.recovery.resumeFailed";
}
