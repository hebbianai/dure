import {
	ClipboardFormat,
	InputFailureReason,
	type InputIntent,
	type InputReceipt,
	InputRefusalReason,
	MarkerKind,
	type PointerInputIntent,
	PointerKind,
	ResizeFailureReason,
	type ResizeReceipt,
	ResizeRefusalReason,
	type TerminalEvent,
} from "../../../contracts/terminalStateProtocol";
import { TerminalStateProtocolError } from "./terminalStateLimits";
import {
	validateEnumNumber,
	validateInt32,
	validateUint32,
	validateUint64,
} from "./terminalStateNumericValidation";

const MAX_COLUMNS = 1024;
const MAX_GRID_ROWS = 512;
const MAX_EVENT_TEXT_BYTES = 4096;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_AGENT_PROMPT_ADMISSION_WAIT_MS = 10_000;

export function validateTerminalEvent(event: TerminalEvent): void {
	validateUint64(event.eventId, "event id is not a uint64");
	if (event.eventId === 0n) fail("event id must be nonzero");
	switch (event.event.case) {
		case "bell":
			return;
		case "clipboardWriteRequest":
			validateEnumNumber(
				event.event.value.format,
				[ClipboardFormat.UTF8_TEXT],
				"clipboard format is invalid",
			);
			validateBytes(
				event.event.value.content,
				0,
				MAX_INPUT_BYTES,
				"clipboard content is oversized",
			);
			return;
		case "notification":
			validateText(
				event.event.value.title,
				0,
				MAX_EVENT_TEXT_BYTES,
				"notification title is oversized",
			);
			validateText(
				event.event.value.body,
				0,
				MAX_EVENT_TEXT_BYTES,
				"notification body is oversized",
			);
			return;
		case "executionMarker":
			validateText(
				event.event.value.markerId,
				1,
				128,
				"marker id is empty or oversized",
			);
			validateEnumNumber(
				event.event.value.kind,
				[
					MarkerKind.PROMPT,
					MarkerKind.COMMAND,
					MarkerKind.OUTPUT,
					MarkerKind.FINISHED,
				],
				"marker kind is invalid",
			);
			validateText(
				event.event.value.label,
				0,
				MAX_EVENT_TEXT_BYTES,
				"marker label is oversized",
			);
			return;
		default:
			fail("typed terminal event is required");
	}
}

export function validateTerminalInputIntent(intent: InputIntent): void {
	switch (intent.intent.case) {
		case "text":
			validateBytes(
				intent.intent.value.utf8,
				1,
				MAX_INPUT_BYTES,
				"text input is empty or oversized",
			);
			return;
		case "agentPrompt": {
			const prompt = intent.intent.value;
			validateBytes(
				prompt.utf8,
				1,
				MAX_INPUT_BYTES - 1,
				"agent prompt is empty or oversized",
			);
			validateUtf8(prompt.utf8, "agent prompt is not UTF-8");
			validateUint32(
				prompt.admissionWaitMs,
				"agent prompt admission wait is not a uint32",
			);
			if (prompt.admissionWaitMs > MAX_AGENT_PROMPT_ADMISSION_WAIT_MS) {
				fail("agent prompt admission wait is oversized");
			}
			switch (prompt.target.case) {
				case "freshAgent":
				case undefined:
					return;
				case "existingConversation":
					if (prompt.admissionWaitMs !== 0) {
						fail("existing conversation prompt cannot wait before admission");
					}
					validateText(
						prompt.target.value.expectedProviderId,
						1,
						256,
						"agent prompt provider id is empty or oversized",
					);
					validateText(
						prompt.target.value.expectedConversationId,
						1,
						256,
						"agent prompt conversation id is empty or oversized",
					);
					return;
				default:
					fail("agent prompt target is invalid");
			}
			return;
		}
		case "key":
			validateText(
				intent.intent.value.key,
				1,
				128,
				"key is empty or oversized",
			);
			validateText(intent.intent.value.code, 0, 128, "key code is oversized");
			validateUint32(
				intent.intent.value.modifiers,
				"key modifiers are not a uint32",
			);
			return;
		case "paste":
			validateBytes(
				intent.intent.value.utf8,
				0,
				MAX_INPUT_BYTES,
				"paste input is oversized",
			);
			return;
		case "pointer":
			validateTerminalPointerInput(intent.intent.value);
			return;
		case "focus":
			return;
		case "resize":
			validateUint32(
				intent.intent.value.columns,
				"resize columns are not a uint32",
			);
			validateUint32(intent.intent.value.rows, "resize rows are not a uint32");
			validateUint64(
				intent.intent.value.geometryGeneration,
				"resize geometry generation is not a uint64",
			);
			if (
				intent.intent.value.columns === 0 ||
				intent.intent.value.columns > MAX_COLUMNS ||
				intent.intent.value.rows === 0 ||
				intent.intent.value.rows > MAX_GRID_ROWS
			) {
				fail("terminal geometry is outside caps");
			}
			if (intent.intent.value.geometryGeneration === 0n) {
				fail("resize geometry generation must be nonzero");
			}
			return;
		default:
			fail("typed input intent is required");
	}
}

export function validateTerminalPointerInput(
	pointer: PointerInputIntent,
): void {
	validateEnumNumber(
		pointer.kind,
		[PointerKind.DOWN, PointerKind.UP, PointerKind.MOVE, PointerKind.WHEEL],
		"pointer kind is invalid",
	);
	validateUint32(pointer.column, "pointer column is not a uint32");
	validateUint32(pointer.row, "pointer row is not a uint32");
	validateUint32(pointer.button, "pointer button is not a uint32");
	validateUint32(pointer.modifiers, "pointer modifiers are not a uint32");
	validateUint32(
		pointer.pressedButtons,
		"pointer pressed buttons are not a uint32",
	);
	validateInt32(pointer.wheelDeltaX, "pointer wheel X is not an int32");
	validateInt32(pointer.wheelDeltaY, "pointer wheel Y is not an int32");
	if (pointer.column >= MAX_COLUMNS || pointer.row >= MAX_GRID_ROWS) {
		fail("pointer position exceeds grid cap");
	}
	if (
		pointer.button > 4 ||
		(pointer.modifiers & ~0x0f) !== 0 ||
		(pointer.pressedButtons & ~0x1f) !== 0
	) {
		fail("pointer button or modifiers are invalid");
	}
	if (pointer.kind === PointerKind.WHEEL) {
		if (
			(pointer.wheelDeltaX === 0 && pointer.wheelDeltaY === 0) ||
			Math.abs(pointer.wheelDeltaX) > 64 ||
			Math.abs(pointer.wheelDeltaY) > 64
		) {
			fail("pointer wheel delta is empty or oversized");
		}
	} else if (pointer.wheelDeltaX !== 0 || pointer.wheelDeltaY !== 0) {
		fail("non-wheel pointer intent carries wheel delta");
	}
	validatePointerGeometry(pointer);
}

export function validateTerminalInputReceipt(receipt: InputReceipt): void {
	validateUint64(
		receipt.inReplyToRecordId,
		"input receipt correlation id is not a uint64",
	);
	if (receipt.inReplyToRecordId === 0n) {
		fail("input receipt correlation id must be nonzero");
	}
	switch (receipt.outcome.case) {
		case "writtenToPty":
			if (receipt.outcome.value.inputBaselineOutputSequence !== undefined) {
				validateUint64(
					receipt.outcome.value.inputBaselineOutputSequence,
					"input receipt write baseline is not a uint64",
				);
			}
			if (receipt.outcome.value.agentRuntimeRevision !== undefined) {
				validateUint64(
					receipt.outcome.value.agentRuntimeRevision,
					"agent runtime revision is not a uint64",
				);
				if (receipt.outcome.value.agentRuntimeRevision === 0n) {
					fail("agent runtime revision must be nonzero");
				}
				if (receipt.outcome.value.inputBaselineOutputSequence === undefined) {
					fail("agent runtime revision requires an input baseline");
				}
			}
			return;
		case "refused":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					InputRefusalReason.STALE_TERMINAL_EPOCH,
					InputRefusalReason.AUTHORIZATION_DENIED,
					InputRefusalReason.INPUT_TOO_LARGE,
					InputRefusalReason.RESOURCE_LIMIT,
					InputRefusalReason.HOST_EXITING,
					InputRefusalReason.AGENT_RUNTIME_CHANGED,
				],
				"input refusal reason is invalid",
			);
			return;
		case "failed":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					InputFailureReason.PTY_WRITE_FAILED,
					InputFailureReason.RESOURCE_LIMIT,
					InputFailureReason.HOST_EXITING,
				],
				"input failure reason is invalid",
			);
			return;
		default:
			fail("input receipt final outcome is required");
	}
}

export function validateTerminalResizeReceipt(receipt: ResizeReceipt): void {
	validateUint64(
		receipt.inReplyToRecordId,
		"resize receipt correlation id is not a uint64",
	);
	if (receipt.inReplyToRecordId === 0n) {
		fail("resize receipt correlation id must be nonzero");
	}
	switch (receipt.outcome.case) {
		case "appliedToTerminal":
			validateUint32(
				receipt.outcome.value.columns,
				"resize receipt columns are not a uint32",
			);
			validateUint32(
				receipt.outcome.value.rows,
				"resize receipt rows are not a uint32",
			);
			if (
				receipt.outcome.value.columns === 0 ||
				receipt.outcome.value.columns > MAX_COLUMNS ||
				receipt.outcome.value.rows === 0 ||
				receipt.outcome.value.rows > MAX_GRID_ROWS
			) {
				fail("resize receipt geometry is outside caps");
			}
			return;
		case "refused":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					ResizeRefusalReason.STALE_TERMINAL_EPOCH,
					ResizeRefusalReason.STALE_GEOMETRY_GENERATION,
					ResizeRefusalReason.AUTHORIZATION_DENIED,
					ResizeRefusalReason.INVALID_TERMINAL_DIMENSIONS,
					ResizeRefusalReason.RESOURCE_LIMIT,
					ResizeRefusalReason.HOST_EXITING,
				],
				"resize refusal reason is invalid",
			);
			return;
		case "failed":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					ResizeFailureReason.PLATFORM_RESIZE_FAILED,
					ResizeFailureReason.RESOURCE_LIMIT,
					ResizeFailureReason.HOST_EXITING,
				],
				"resize failure reason is invalid",
			);
			return;
		default:
			fail("resize receipt final outcome is required");
	}
}

function validatePointerGeometry(pointer: PointerInputIntent): void {
	const maximumSurfacePixels = 1_048_576;
	for (const [value, message] of [
		[pointer.pixelX, "pointer pixel X is not a uint32"],
		[pointer.pixelY, "pointer pixel Y is not a uint32"],
		[pointer.surfaceWidth, "pointer surface width is not a uint32"],
		[pointer.surfaceHeight, "pointer surface height is not a uint32"],
		[pointer.cellWidth, "pointer cell width is not a uint32"],
		[pointer.cellHeight, "pointer cell height is not a uint32"],
		[pointer.paddingTop, "pointer top padding is not a uint32"],
		[pointer.paddingBottom, "pointer bottom padding is not a uint32"],
		[pointer.paddingRight, "pointer right padding is not a uint32"],
		[pointer.paddingLeft, "pointer left padding is not a uint32"],
	] as const) {
		validateUint32(value, message);
	}
	if (
		pointer.surfaceWidth === 0 ||
		pointer.surfaceHeight === 0 ||
		pointer.surfaceWidth > maximumSurfacePixels ||
		pointer.surfaceHeight > maximumSurfacePixels ||
		pointer.cellWidth === 0 ||
		pointer.cellHeight === 0 ||
		pointer.cellWidth > 65_535 ||
		pointer.cellHeight > 65_535
	) {
		fail("pointer surface geometry is invalid");
	}
	const horizontalPadding = pointer.paddingLeft + pointer.paddingRight;
	const verticalPadding = pointer.paddingTop + pointer.paddingBottom;
	if (
		horizontalPadding >= pointer.surfaceWidth ||
		verticalPadding >= pointer.surfaceHeight ||
		pointer.pixelX < pointer.paddingLeft ||
		pointer.pixelY < pointer.paddingTop ||
		pointer.pixelX >= pointer.surfaceWidth - pointer.paddingRight ||
		pointer.pixelY >= pointer.surfaceHeight - pointer.paddingBottom ||
		Math.floor((pointer.pixelX - pointer.paddingLeft) / pointer.cellWidth) !==
			pointer.column ||
		Math.floor((pointer.pixelY - pointer.paddingTop) / pointer.cellHeight) !==
			pointer.row
	) {
		fail("pointer pixel and cell positions disagree");
	}
}

function validateText(
	value: string,
	minimum: number,
	maximum: number,
	message: string,
): void {
	validateBytes(new TextEncoder().encode(value), minimum, maximum, message);
}

function validateBytes(
	value: Uint8Array,
	minimum: number,
	maximum: number,
	message: string,
): void {
	if (value.byteLength < minimum || value.byteLength > maximum) fail(message);
}

function validateUtf8(value: Uint8Array, message: string): void {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(value);
	} catch {
		fail(message);
	}
}

function fail(message: string): never {
	throw new TerminalStateProtocolError("invalid_record", message);
}
