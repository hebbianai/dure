import type { HmuxSessionFailure } from "@/lib/ipc/hmuxContracts";

function sessionFailureMessage(failure: HmuxSessionFailure): string {
	return `${failure.summary} Correlation: ${failure.correlationId}`;
}

export class HmuxSessionFailureError extends Error {
	readonly failure: HmuxSessionFailure;

	constructor(failure: HmuxSessionFailure) {
		super(sessionFailureMessage(failure));
		this.name = "HmuxSessionFailureError";
		this.failure = failure;
	}
}

export function isHmuxSessionFailureError(
	cause: unknown,
): cause is HmuxSessionFailureError {
	return cause instanceof HmuxSessionFailureError;
}
