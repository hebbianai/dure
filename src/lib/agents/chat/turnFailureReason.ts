/** The shared turn-failure vocabulary (dure_app::AgentTurnFailureReasonV1),
 * carried by both provider bridges as the `turn_failed` lifecycle detail.
 * Parsed once here; every surface keys copy and recovery on the parsed
 * reason and never on prose or on a generic failure token — the composer
 * once inferred "sign in again" from provider_failed and was removed twice
 * for guessing. */

export type TurnFailureReason =
	| "usage_limit"
	| "rate_limit"
	| "authentication_failed"
	| "context_window_exceeded"
	| "provider_error"
	| "runtime_replaced";

const REASONS: ReadonlySet<string> = new Set<TurnFailureReason>([
	"usage_limit",
	"rate_limit",
	"authentication_failed",
	"context_window_exceeded",
	"provider_error",
	"runtime_replaced",
]);

export function parseTurnFailureReason(
	detail: string | null | undefined,
): TurnFailureReason | undefined {
	return detail !== null && detail !== undefined && REASONS.has(detail)
		? (detail as TurnFailureReason)
		: undefined;
}

/** i18n keys use lowerCamel segments: snake_case segments fall out of the
 * semantic-ID pattern and would bypass the catalogs. */
export const TURN_FAILURE_REASON_COPY: Readonly<
	Record<TurnFailureReason, string>
> = {
	usage_limit: "agents.chat.turnFailure.usageLimit",
	rate_limit: "agents.chat.turnFailure.rateLimit",
	authentication_failed: "agents.chat.turnFailure.authenticationFailed",
	context_window_exceeded: "agents.chat.turnFailure.contextWindowExceeded",
	provider_error: "agents.chat.turnFailure.providerError",
	runtime_replaced: "agents.chat.turnFailure.runtimeReplaced",
};

export type TurnFailureRecovery = "switch_account" | "sign_in";

/** The recoveries a reason justifies. Only credential-class reasons offer
 * any; a provider or context error has no account to switch to. */
export function turnFailureRecoveries(
	reason: TurnFailureReason,
): readonly TurnFailureRecovery[] {
	switch (reason) {
		case "usage_limit":
		case "rate_limit":
			return ["switch_account"];
		case "authentication_failed":
			return ["sign_in", "switch_account"];
		default:
			return [];
	}
}

export interface LatestTurnFailure {
	readonly reason: TurnFailureReason;
	readonly recoveries: readonly TurnFailureRecovery[];
	/** Identity of the failed lifecycle row, so a dismissal is scoped to it. */
	readonly itemId: string;
	/** Provider timestamp of the failure; stable across history replay into a
	 * new session, which is what a once-per-episode fence must key on. */
	readonly createdAtMs: number;
	/** The user message that opened the failed turn, so it can be resent
	 * verbatim after a recovery; absent when the turn had no user row. */
	readonly userInput?: string;
}

/** Store-derived current failure, independent of the displayed row window. */
export interface AgentTimelineFailureV1 {
	readonly itemId: string;
	readonly createdAtMs: number;
	readonly reason: TurnFailureReason;
	readonly userInput: string | null;
}

/** Add presentation actions to the authoritative failure without rereading rows. */
export function latestTurnFailure(
	failure: AgentTimelineFailureV1 | null | undefined,
): LatestTurnFailure | undefined {
	if (!failure) return undefined;
	return {
		reason: failure.reason,
		recoveries: turnFailureRecoveries(failure.reason),
		itemId: failure.itemId,
		createdAtMs: failure.createdAtMs,
		...(failure.userInput !== null ? { userInput: failure.userInput } : {}),
	};
}
