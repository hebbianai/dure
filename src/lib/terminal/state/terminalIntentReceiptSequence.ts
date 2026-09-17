export type TerminalIntentReceiptKind = "input" | "resize" | "wheel";

interface TerminalIntentReceiptHighWater {
	highestIssuedRecordId: bigint;
	highestAcknowledgedRecordId: bigint;
	highestCanceledRecordId: bigint;
}

export interface TerminalIntentReceiptPendingKinds {
	readonly input: boolean;
	readonly resize: boolean;
	readonly wheel: boolean;
}

interface LatestResizeReceiptToken<TResizeToken> {
	readonly recordId: bigint;
	readonly token: TResizeToken;
}

/**
 * Attachment-local receipt authority. Input and wheel need only monotonic
 * correlation. Resize additionally retains the one fallible presentation
 * callback that still owns the latest requested geometry.
 */
export interface TerminalIntentReceiptSequence<TResizeToken> {
	readonly input: TerminalIntentReceiptHighWater;
	readonly resize: TerminalIntentReceiptHighWater;
	readonly wheel: TerminalIntentReceiptHighWater;
	latestResize?: LatestResizeReceiptToken<TResizeToken>;
	/**
	 * The newest input record the user originated (a key, a paste). Focus and
	 * pointer intents share the input receipt lane but never move it, so only
	 * a receipt for this record proves the user's own input was accepted.
	 */
	latestUserInputRecordId: bigint;
}

export type TerminalIntentReceiptAcknowledgement<TResizeToken> =
	| { readonly status: "unissued" }
	| { readonly status: "duplicate" }
	| {
			readonly status: "acknowledged";
			readonly resizeToken?: TResizeToken;
			/** True when this receipt answers the user's newest own input. */
			readonly userInput?: true;
	  };

export function createTerminalIntentReceiptSequence<
	TResizeToken,
>(): TerminalIntentReceiptSequence<TResizeToken> {
	const highWater = (): TerminalIntentReceiptHighWater => ({
		highestIssuedRecordId: 0n,
		highestAcknowledgedRecordId: 0n,
		highestCanceledRecordId: 0n,
	});
	return {
		input: highWater(),
		resize: highWater(),
		wheel: highWater(),
		latestUserInputRecordId: 0n,
	};
}

export function issueTerminalIntentReceipt<TResizeToken>(
	sequence: TerminalIntentReceiptSequence<TResizeToken>,
	kind: TerminalIntentReceiptKind,
	recordId: bigint,
	resizeToken?: TResizeToken,
): void {
	const highWater = sequence[kind];
	if (recordId <= highWater.highestIssuedRecordId) {
		throw new Error("terminal intent record id did not advance");
	}
	highWater.highestIssuedRecordId = recordId;
	if (kind === "resize") {
		sequence.latestResize =
			resizeToken === undefined ? undefined : { recordId, token: resizeToken };
	}
}

/** Issues an input receipt for input the user originated. */
export function issueTerminalUserInputReceipt<TResizeToken>(
	sequence: TerminalIntentReceiptSequence<TResizeToken>,
	recordId: bigint,
): void {
	issueTerminalIntentReceipt(sequence, "input", recordId);
	sequence.latestUserInputRecordId = recordId;
}

export function cancelTerminalIntentReceipt<TResizeToken>(
	sequence: TerminalIntentReceiptSequence<TResizeToken>,
	kind: TerminalIntentReceiptKind,
	recordId: bigint,
): void {
	const highWater = sequence[kind];
	if (recordId > highWater.highestCanceledRecordId) {
		highWater.highestCanceledRecordId = recordId;
	}
	if (kind === "resize" && sequence.latestResize?.recordId === recordId) {
		sequence.latestResize = undefined;
	}
}

export function terminalIntentReceiptPendingKinds<TResizeToken>(
	sequence: TerminalIntentReceiptSequence<TResizeToken>,
): TerminalIntentReceiptPendingKinds {
	const pending = (kind: TerminalIntentReceiptKind) => {
		const highWater = sequence[kind];
		return (
			highWater.highestIssuedRecordId >
			(highWater.highestAcknowledgedRecordId > highWater.highestCanceledRecordId
				? highWater.highestAcknowledgedRecordId
				: highWater.highestCanceledRecordId)
		);
	};
	return {
		input: pending("input"),
		resize: pending("resize"),
		wheel: pending("wheel"),
	};
}

export function acknowledgeTerminalIntentReceipt<TResizeToken>(
	sequence: TerminalIntentReceiptSequence<TResizeToken>,
	kind: TerminalIntentReceiptKind,
	recordId: bigint,
): TerminalIntentReceiptAcknowledgement<TResizeToken> {
	const highWater = sequence[kind];
	if (recordId === 0n || recordId > highWater.highestIssuedRecordId) {
		return { status: "unissued" };
	}
	if (recordId <= highWater.highestAcknowledgedRecordId) {
		return { status: "duplicate" };
	}
	highWater.highestAcknowledgedRecordId = recordId;
	if (kind === "input" && recordId === sequence.latestUserInputRecordId) {
		return { status: "acknowledged", userInput: true };
	}
	if (kind !== "resize" || sequence.latestResize?.recordId !== recordId) {
		return { status: "acknowledged" };
	}
	const resizeToken = sequence.latestResize.token;
	sequence.latestResize = undefined;
	return { status: "acknowledged", resizeToken };
}
