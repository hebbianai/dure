export type HmuxStructuredTerminalRetryDirective =
	| "never"
	| "reconnect"
	| "retry_after_resync";

export interface HmuxStructuredTerminalAttachFailure {
	readonly code: string;
	readonly message: string;
	readonly retryDirective: HmuxStructuredTerminalRetryDirective;
}

export class HmuxStructuredTerminalAttachError extends Error {
	readonly code: string;
	readonly retryDirective: HmuxStructuredTerminalRetryDirective;

	constructor(failure: HmuxStructuredTerminalAttachFailure) {
		super(failure.message);
		this.name = "HmuxStructuredTerminalAttachError";
		this.code = failure.code;
		this.retryDirective = failure.retryDirective;
	}
}

export const isRetryDirective = (
	value: unknown,
): value is HmuxStructuredTerminalRetryDirective =>
	value === "never" ||
	value === "reconnect" ||
	value === "retry_after_resync";

/** Decode the typed rejection serialized by the desktop Hmux adapter. */
export function hmuxStructuredTerminalAttachError(
	cause: unknown,
): HmuxStructuredTerminalAttachError | undefined {
	if (cause instanceof HmuxStructuredTerminalAttachError) return cause;
	if (typeof cause !== "object" || cause === null) return undefined;
	const candidate = cause as Partial<HmuxStructuredTerminalAttachFailure>;
	if (
		typeof candidate.code !== "string" ||
		typeof candidate.message !== "string" ||
		!isRetryDirective(candidate.retryDirective)
	) {
		return undefined;
	}
	return new HmuxStructuredTerminalAttachError({
		code: candidate.code,
		message: candidate.message,
		retryDirective: candidate.retryDirective,
	});
}

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;
/**
 * Client automation budget for one attachment episode. The Host still owns
 * whether a failure permits reconnect; this bound only prevents an older or
 * repeatedly failing Host from consuming resources forever. Ten successors
 * cover 27.75 seconds with the schedule below, including brief Host lifecycle
 * convergence races, without returning to the former permanent four-second loop.
 */
const MAX_CONSECUTIVE_RECONNECTS = 10;

/** Back off repeated first-frame refusals, or stop after one bounded episode. */
export function structuredTerminalAttachReconnectDelay(
	failures: number,
): number | undefined {
	const attempts = Math.max(0, Math.floor(failures));
	if (attempts >= MAX_CONSECUTIVE_RECONNECTS) return undefined;
	const exponent = Math.min(attempts, 4);
	return Math.min(
		MAX_RECONNECT_DELAY_MS,
		INITIAL_RECONNECT_DELAY_MS * 2 ** exponent,
	);
}

/**
 * Wait for the next backoff slot. False means the attachment retired or this
 * episode exhausted its automatic reconnect budget.
 */
export function waitForStructuredTerminalAttachReconnect(
	failures: number,
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted) return Promise.resolve(false);
	const delay = structuredTerminalAttachReconnectDelay(failures);
	if (delay === undefined) return Promise.resolve(false);
	return new Promise((resolve) => {
		let timer: ReturnType<typeof globalThis.setTimeout>;
		const finish = (shouldReconnect: boolean) => {
			globalThis.clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			resolve(shouldReconnect);
		};
		const abort = () => finish(false);
		signal.addEventListener("abort", abort, { once: true });
		timer = globalThis.setTimeout(() => finish(true), delay);
	});
}
