type QaRuntimeErrorKind =
	| "window_error"
	| "unhandled_rejection"
	| "fatal_console";

export type QaRuntimeErrorInput = {
	kind: QaRuntimeErrorKind;
	message: string;
	filename?: string;
	line?: number;
	column?: number;
	stack?: string;
};

type QaRuntimeError = QaRuntimeErrorInput & {
	sequence: number;
};

export type QaRuntimeErrorCursor = {
	sequence: number;
};

export type QaRuntimeErrorSnapshot = {
	cursor: QaRuntimeErrorCursor;
	total: number;
	dropped: number;
	errors: QaRuntimeError[];
};

export type QaRuntimeErrorLedger = {
	beginScope: () => QaRuntimeErrorCursor;
	record: (error: QaRuntimeErrorInput) => QaRuntimeError;
	snapshot: (cursor?: QaRuntimeErrorCursor) => QaRuntimeErrorSnapshot;
};

const DEFAULT_CAPACITY = 32;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_FILENAME_LENGTH = 2_048;
const MAX_STACK_LENGTH = 16_384;

function boundedText(
	value: string | undefined,
	limit: number,
): string | undefined {
	if (value === undefined) return undefined;
	return value.length <= limit ? value : value.slice(0, limit);
}

function finiteCoordinate(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value)
		? Math.max(0, value)
		: undefined;
}

function copyError(error: QaRuntimeError): QaRuntimeError {
	return { ...error };
}

/**
 * Keeps a small window-local history while retaining exact per-run totals.
 * A cursor scopes one QA run without clearing errors owned by another run.
 */
export function createQaRuntimeErrorLedger(
	capacity = DEFAULT_CAPACITY,
): QaRuntimeErrorLedger {
	if (!Number.isInteger(capacity) || capacity <= 0) {
		throw new Error("qa_runtime_error_capacity_invalid");
	}

	let latestSequence = 0;
	const errors: QaRuntimeError[] = [];

	const beginScope = (): QaRuntimeErrorCursor => ({ sequence: latestSequence });

	const record = (input: QaRuntimeErrorInput): QaRuntimeError => {
		const error: QaRuntimeError = {
			sequence: ++latestSequence,
			kind: input.kind,
			message: boundedText(input.message, MAX_MESSAGE_LENGTH) ?? "",
			filename: boundedText(input.filename, MAX_FILENAME_LENGTH),
			line: finiteCoordinate(input.line),
			column: finiteCoordinate(input.column),
			stack: boundedText(input.stack, MAX_STACK_LENGTH),
		};
		errors.push(error);
		if (errors.length > capacity) errors.splice(0, errors.length - capacity);
		return copyError(error);
	};

	const snapshot = (
		cursor: QaRuntimeErrorCursor = { sequence: 0 },
	): QaRuntimeErrorSnapshot => {
		const startSequence =
			Number.isSafeInteger(cursor.sequence) &&
			cursor.sequence >= 0 &&
			cursor.sequence <= latestSequence
				? cursor.sequence
				: 0;
		const scopedErrors = errors
			.filter((error) => error.sequence > startSequence)
			.map(copyError);
		const total = latestSequence - startSequence;
		return {
			cursor: { sequence: latestSequence },
			total,
			dropped: total - scopedErrors.length,
			errors: scopedErrors,
		};
	};

	return { beginScope, record, snapshot };
}

/** One module instance is one WebView, so this ledger is naturally window-local. */
export const qaRuntimeErrorLedger = createQaRuntimeErrorLedger();
