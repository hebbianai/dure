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

/** The runtime's typed cause for a managed provider that exited at its
 * sign-in screen: the provider's own adapter reported a signed-out account
 * before any conversation. Recovery keys on this code, never on the summary
 * prose or on terminal output. */
export const HMUX_PROVIDER_EXITED_AT_SIGN_IN = "provider_exited_at_sign_in";

export function isHmuxSignInFailure(
	failure: HmuxSessionFailure | undefined,
): boolean {
	return failure?.code === HMUX_PROVIDER_EXITED_AT_SIGN_IN;
}
