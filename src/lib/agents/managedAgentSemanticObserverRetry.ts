import { isHmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import {
	hmuxStructuredTerminalAttachError,
	type HmuxStructuredTerminalRetryDirective,
} from "@/lib/hmux/failure/structuredTerminalAttachFailure";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * Consecutive failures tolerated before an observation stops retrying.
 *
 * With the backoff below this is roughly three minutes of trying, which covers
 * a first attach racing a provider spawn, and bounds a binding whose session no
 * longer exists in any discovery root — that case can never succeed and used to
 * retry for the life of the app.
 */
const MAX_CONSECUTIVE_FAILURES = 10;

export interface SemanticObserverRetry {
	readonly delayMs: number;
	/** True once this observation has failed too many times in a row to keep trying. */
	readonly exhausted: boolean;
}

export interface SemanticObserverFailureEvidence {
	readonly code?: string;
	readonly retryDirective?: HmuxStructuredTerminalRetryDirective;
	readonly retiredSource: boolean;
}

const FAILURE_CODE = /^[a-z][a-z0-9_]{0,191}$/i;
const MESSAGE_FAILURE_CODE =
	/\b(?:managed_agent_semantic|hmux|remote_hmux)_[a-z0-9_]{1,160}\b/i;
const RETIRED_SESSION_FAILURE_CODES = new Set([
	"hmux_session_not_found",
	"hmux_session_exited",
	"remote_hmux_session_not_found",
	"remote_hmux_session_exited",
	"remote_hmux_session_class_mismatch",
	"remote_hmux_managed_attach_generation_changed",
	"managed_agent_semantic_attach_generation_changed",
]);

function normalizedFailureCode(value: unknown): string | undefined {
	return typeof value === "string" && FAILURE_CODE.test(value)
		? value.toLowerCase()
		: undefined;
}

function failureEvidence(
	value: unknown,
	retryDirective?: HmuxStructuredTerminalRetryDirective,
): SemanticObserverFailureEvidence {
	const code = normalizedFailureCode(value);
	return {
		code,
		retryDirective,
		retiredSource: code !== undefined && RETIRED_SESSION_FAILURE_CODES.has(code),
	};
}

/** Parse typed adapter evidence once, falling back to legacy message tokens. */
export function semanticObserverFailureEvidence(
	cause: unknown,
): SemanticObserverFailureEvidence {
	if (isHmuxSessionFailureError(cause)) {
		return failureEvidence(cause.failure.code);
	}
	const attachFailure = hmuxStructuredTerminalAttachError(cause);
	if (attachFailure) {
		return failureEvidence(attachFailure.code, attachFailure.retryDirective);
	}
	const message = cause instanceof Error ? cause.message : String(cause);
	return failureEvidence(message.match(MESSAGE_FAILURE_CODE)?.[0]);
}

/**
 * How long to wait before the next semantic-observer attach, and whether to
 * stop trying at all.
 */
export function semanticObserverRetry(failures: number): SemanticObserverRetry {
	const attempts = Math.max(0, Math.floor(failures));
	return {
		delayMs: Math.min(
			MAX_RECONNECT_DELAY_MS,
			INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(attempts, 5),
		),
		exhausted: attempts >= MAX_CONSECUTIVE_FAILURES,
	};
}
