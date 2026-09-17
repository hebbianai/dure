import { asRecord, nonEmptyString } from "@/lib/payloadGuards";

export type ManagedCreateRetrySameReason =
	| "pending"
	| "authority_unavailable"
	| "create_retryable"
	| "reconcile_failed"
	| "authority_inconsistent";

type ManagedCreateAdvanceRetrySameReason =
	| "pending"
	| "authority_unavailable"
	| "create_retryable";

export type ManagedCreateAdvanceResolution<T> =
	| { state: "current"; receipt: T }
	| { state: "advanced"; receipt: T }
	| {
			state: "retry_same";
			reason: ManagedCreateAdvanceRetrySameReason;
			code: string;
			message: string;
	  }
	| { state: "rejected"; code: string; message: string };

export class ManagedCreateRetrySameError extends Error {
	readonly code = "managed_create_retry_same";

	constructor(
		readonly reason: ManagedCreateRetrySameReason,
		readonly backendCode: string,
		message: string,
	) {
		super(message);
		this.name = "ManagedCreateRetrySameError";
	}
}

export class ManagedCreateRejectedError extends Error {
	readonly code = "managed_create_rejected";

	constructor(
		readonly backendCode: string,
		message: string,
	) {
		super(message);
		this.name = "ManagedCreateRejectedError";
	}
}

/** A create transport can fail after the Host accepted the request. Keep the
 * exact idempotent identity so the durable authority can resolve that outcome. */
export function managedCreateInvokeOutcomeUnknown(
	error: unknown,
): ManagedCreateRetrySameError {
	return new ManagedCreateRetrySameError(
		"create_retryable",
		"managed_create_outcome_unknown",
		error instanceof Error ? error.message : String(error),
	);
}

const advanceRetrySameReasons = new Set<ManagedCreateAdvanceRetrySameReason>([
	"pending",
	"authority_unavailable",
	"create_retryable",
]);

/** The explicit advance command has no terminal or normalization escape hatch:
 * Hmux either returns the current/ledger successor or a closed failure. */
export function parseManagedCreateAdvanceResolution<T>(
	value: unknown,
	parseReceipt: (
		candidate: unknown,
		state: "current" | "advanced",
	) => T | undefined,
): ManagedCreateAdvanceResolution<T> | undefined {
	const resolution = asRecord(value);
	if (!resolution) return undefined;
	switch (resolution.state) {
		case "current":
		case "advanced": {
			const state = resolution.state;
			const receipt = parseReceipt(resolution.receipt, state);
			return receipt === undefined ? undefined : { state, receipt };
		}
		case "retry_same":
			return typeof resolution.reason === "string" &&
				advanceRetrySameReasons.has(
					resolution.reason as ManagedCreateAdvanceRetrySameReason,
				) &&
				nonEmptyString(resolution.code) &&
				nonEmptyString(resolution.message)
				? {
						state: "retry_same",
						reason: resolution.reason as ManagedCreateAdvanceRetrySameReason,
						code: resolution.code,
						message: resolution.message,
					}
				: undefined;
		case "rejected":
			return nonEmptyString(resolution.code) &&
				nonEmptyString(resolution.message)
				? {
						state: "rejected",
						code: resolution.code,
						message: resolution.message,
					}
				: undefined;
		default:
			return undefined;
	}
}

export function assertNeverManagedCreateAdvanceResolution(value: never): never {
	throw new Error(
		`unhandled managed create advance resolution: ${String(value)}`,
	);
}
