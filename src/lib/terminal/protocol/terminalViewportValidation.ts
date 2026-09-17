import {
	CursorShape,
	PointerKind,
	type TerminalColorOverrides,
	ViewportAnchorStatus,
	type ViewportFrame,
	type ViewportFramePart,
	type ViewportIntent,
	WheelFailureReason,
	type WheelReceipt,
	WheelRefusalReason,
} from "@/contracts/terminalStateProtocol";
import {
	MAX_EVENT_TEXT_BYTES,
	MAX_GRID_ROWS,
	MAX_URI_BYTES,
	validateTerminalBufferId,
	validateTerminalBytes,
	validateTerminalGeometry,
	validateTerminalInputModes,
	validateTerminalRows,
	validateTerminalTables,
	validateTerminalText,
	validateTerminalUnicodeWidth,
} from "./terminalStateGridValidation";
import { validateTerminalPointerInput } from "./terminalStateInteractionValidation";
import {
	TERMINAL_STATE_DEFAULT_COLORS_PROTOCOL_MINOR,
	TERMINAL_STATE_MAX_BATCH_ID_BYTES,
	TERMINAL_STATE_MAX_PAYLOAD_BYTES,
	TERMINAL_STATE_MAX_REVISION,
	TERMINAL_STATE_MAX_VIEWPORT_FRAME_BYTES,
	TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS,
	TERMINAL_STATE_WHEEL_PROTOCOL_MINOR,
	TerminalStateProtocolError,
} from "./terminalStateLimits";
import {
	validateEnumNumber,
	validateInt32,
	validateUint32,
	validateUint64,
} from "./terminalStateNumericValidation";

export function validateTerminalViewportFrame(
	schemaMinor: number,
	frame: ViewportFrame,
): void {
	validateUint64(
		frame.projectionRevision,
		"viewport projection revision is not a uint64",
	);
	validateUint64(
		frame.damageBaseProjectionRevision,
		"viewport damage base is not a uint64",
	);
	validateUint64(
		frame.appliedIntentSeq,
		"viewport applied intent sequence is not a uint64",
	);
	validateUint64(frame.throughEventId, "viewport event id is not a uint64");
	if (
		frame.projectionRevision === 0n ||
		frame.projectionRevision > TERMINAL_STATE_MAX_REVISION
	) {
		fail("viewport projection revision is invalid");
	}
	if (
		frame.damageBaseProjectionRevision !== 0n &&
		frame.damageBaseProjectionRevision >= frame.projectionRevision
	) {
		fail("viewport damage base must precede its projection revision");
	}
	if (frame.appliedIntentSeq > TERMINAL_STATE_MAX_REVISION) {
		fail("viewport applied intent sequence is invalid");
	}
	validateTerminalGeometry(frame.canonicalColumns, frame.viewportRows);
	validateTerminalBufferId(frame.activeBuffer);
	if (frame.rows.length === 0 || frame.rows.length > frame.viewportRows) {
		fail("viewport frame row count is outside its requested height");
	}
	if (!frame.tables) fail("viewport frame-local tables are required");
	validateTerminalTables(frame.tables);
	validateTerminalRows(
		frame.rows,
		frame.canonicalColumns,
		frame.tables,
		schemaMinor,
	);
	if (frame.cursor) validateViewportCursor(frame);
	if (!frame.inputModes) fail("viewport input modes are required");
	validateTerminalInputModes(frame.inputModes);
	if (!frame.colorOverrides) {
		fail("viewport terminal color overrides are required");
	}
	validateTerminalColorOverrides(frame.colorOverrides);
	if (!frame.unicodeWidth) fail("viewport Unicode width profile is required");
	validateTerminalUnicodeWidth(frame.unicodeWidth);
	validateTerminalText(
		frame.title,
		0,
		MAX_EVENT_TEXT_BYTES,
		"viewport title is oversized",
	);
	validateTerminalText(
		frame.workingDirectoryUri,
		0,
		MAX_URI_BYTES,
		"viewport working directory URI is oversized",
	);
	if (frame.followTail && frame.hasMoreAfter) {
		fail("follow-tail viewport cannot have rows after it");
	}
	const timing = frame.inputOutputTiming;
	if (timing) {
		validateUint64(
			timing.inputBaselineOutputSequence,
			"viewport input baseline sequence is not a uint64",
		);
		validateUint64(
			timing.firstOutputSequence,
			"viewport first output sequence is not a uint64",
		);
		validateUint64(
			timing.inputToOutputMicros,
			"viewport input-to-output timing is not a uint64",
		);
		validateUint64(
			timing.outputToProjectionStartMicros,
			"viewport output-to-projection timing is not a uint64",
		);
		validateUint64(
			timing.inputRecordId,
			"viewport input record id is not a uint64",
		);
		if (timing.inputRecordId === 0n) {
			fail("viewport input/output timing record ID is missing");
		}
		if (timing.firstOutputSequence <= timing.inputBaselineOutputSequence) {
			fail("viewport input/output timing sequences are invalid");
		}
	}
	validateViewportAnchor(frame);
	let previous = -1;
	for (const index of frame.changedRowIndices) {
		validateUint32(index, "viewport changed row is not a uint32");
		if (index >= frame.rows.length || index <= previous) {
			fail("viewport changed rows are invalid or unordered");
		}
		previous = index;
	}
}

export function validateTerminalViewportIntent(
	schemaMinor: number,
	intent: ViewportIntent,
): void {
	validateUint64(
		intent.observedProjectionRevision,
		"observed viewport revision is not a uint64",
	);
	validateUint64(intent.intentSeq, "viewport intent sequence is not a uint64");
	if (
		intent.intentSeq === 0n ||
		intent.intentSeq > TERMINAL_STATE_MAX_REVISION
	) {
		fail("viewport intent sequence is invalid");
	}
	switch (intent.intent.case) {
		case "scrollRows": {
			const rows = validateInt32(
				intent.intent.value.rows,
				"viewport scroll rows are not an int32",
			);
			if (
				intent.observedProjectionRevision === 0n ||
				rows === 0 ||
				Math.abs(rows) > MAX_GRID_ROWS
			) {
				fail("viewport scroll distance or revision is invalid");
			}
			return;
		}
		case "followTail":
			if (intent.observedProjectionRevision === 0n) {
				fail("follow-tail requires an observed projection revision");
			}
			return;
		case "setViewportRows":
			validateTerminalGeometry(1, intent.intent.value.rows);
			return;
		case "wheel":
			if (schemaMinor < TERMINAL_STATE_WHEEL_PROTOCOL_MINOR) {
				fail("wheel intent requires the wheel protocol minor");
			}
			if (intent.observedProjectionRevision === 0n) {
				fail("wheel requires an observed projection revision");
			}
			validateTerminalPointerInput(intent.intent.value);
			if (intent.intent.value.kind !== PointerKind.WHEEL) {
				fail("wheel viewport intent requires a wheel pointer");
			}
			return;
		case "terminalDefaultColors":
			if (schemaMinor < TERMINAL_STATE_DEFAULT_COLORS_PROTOCOL_MINOR) {
				fail("terminal default colors require their protocol minor");
			}
			if (intent.observedProjectionRevision === 0n) {
				fail("terminal default colors require an observed projection revision");
			}
			for (const color of [
				intent.intent.value.foregroundRgb,
				intent.intent.value.backgroundRgb,
			]) {
				validateUint32(color, "terminal default color is not a uint32");
				if (color > 0x00ffffff) {
					fail("terminal default color exceeds 24-bit sRGB");
				}
			}
			return;
		default:
			fail("typed viewport intent is required");
	}
}

export function validateTerminalWheelReceipt(receipt: WheelReceipt): void {
	validateUint64(
		receipt.inReplyToRecordId,
		"wheel receipt correlation id is not a uint64",
	);
	if (receipt.inReplyToRecordId === 0n) {
		fail("wheel receipt correlation id must be nonzero");
	}
	switch (receipt.outcome.case) {
		case "writtenToPty":
		case "appliedToViewport":
			validateUint64(
				receipt.outcome.value.appliedIntentSeq,
				"wheel receipt intent sequence is not a uint64",
			);
			if (
				receipt.outcome.value.appliedIntentSeq === 0n ||
				receipt.outcome.value.appliedIntentSeq > TERMINAL_STATE_MAX_REVISION
			) {
				fail("wheel receipt intent sequence is invalid");
			}
			return;
		case "refused":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					WheelRefusalReason.AUTHORIZATION_DENIED,
					WheelRefusalReason.HOST_EXITING,
				],
				"wheel refusal reason is invalid",
			);
			return;
		case "failed":
			validateEnumNumber(
				receipt.outcome.value.reason,
				[
					WheelFailureReason.PTY_WRITE_FAILED,
					WheelFailureReason.VIEWPORT_FAILED,
				],
				"wheel failure reason is invalid",
			);
			return;
		default:
			fail("wheel receipt final outcome is required");
	}
}

export function validateTerminalViewportFramePart(
	schemaMinor: number,
	part: ViewportFramePart,
): void {
	if (schemaMinor < 5) fail("viewport frame parts require schema minor 5");
	validateTerminalBytes(
		part.batchId,
		1,
		TERMINAL_STATE_MAX_BATCH_ID_BYTES,
		"viewport frame batch id is empty or oversized",
	);
	validateUint32(part.partIndex, "viewport frame part index is not a uint32");
	validateUint32(part.partCount, "viewport frame part count is not a uint32");
	validateUint32(
		part.totalFrameBytes,
		"viewport frame total bytes is not a uint32",
	);
	if (
		part.partCount === 0 ||
		part.partCount > TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS ||
		part.partIndex >= part.partCount
	) {
		fail("viewport frame part index or count is invalid");
	}
	if (
		part.totalFrameBytes === 0 ||
		part.totalFrameBytes > TERMINAL_STATE_MAX_VIEWPORT_FRAME_BYTES
	) {
		fail("viewport frame batch total is outside caps");
	}
	validateTerminalBytes(
		part.frameChunk,
		1,
		TERMINAL_STATE_MAX_PAYLOAD_BYTES,
		"viewport frame chunk is empty or oversized",
	);
	if (part.frameChunk.byteLength > part.totalFrameBytes) {
		fail("viewport frame chunk exceeds its declared total");
	}
	validateUint64(
		part.projectionRevision,
		"viewport frame part projection revision is not a uint64",
	);
	if (
		part.projectionRevision === 0n ||
		part.projectionRevision > TERMINAL_STATE_MAX_REVISION
	) {
		fail("viewport frame part projection revision is invalid");
	}
	validateUint64(
		part.appliedIntentSeq,
		"viewport frame part intent sequence is not a uint64",
	);
	if (part.appliedIntentSeq > TERMINAL_STATE_MAX_REVISION) {
		fail("viewport frame part intent sequence is invalid");
	}
}

function validateViewportCursor(frame: ViewportFrame): void {
	const cursor = frame.cursor;
	const tables = frame.tables;
	if (!cursor || !tables) return;
	validateUint32(cursor.row, "viewport cursor row is not a uint32");
	validateUint32(cursor.column, "viewport cursor column is not a uint32");
	validateUint32(
		cursor.styleIndex,
		"viewport cursor style index is not a uint32",
	);
	validateEnumNumber(
		cursor.shape,
		[CursorShape.BLOCK, CursorShape.UNDERLINE, CursorShape.BAR],
		"viewport cursor shape is invalid",
	);
	if (
		cursor.row >= frame.rows.length ||
		cursor.column >= frame.canonicalColumns ||
		cursor.styleIndex >= tables.styles.length
	) {
		fail("viewport-relative cursor is invalid");
	}
}

function validateTerminalColorOverrides(
	overrides: TerminalColorOverrides,
): void {
	for (const rgb of [
		overrides.defaultForegroundRgb,
		overrides.defaultBackgroundRgb,
		overrides.cursorRgb,
	]) {
		if (rgb === undefined) continue;
		validateUint32(rgb, "viewport terminal color override is not a uint32");
		if (rgb > 0x00ff_ffff) {
			fail("viewport terminal color override is invalid");
		}
	}
	let previous = -1;
	for (const entry of overrides.indexed) {
		validateUint32(entry.index, "viewport color index is not a uint32");
		validateUint32(entry.rgb, "viewport color RGB is not a uint32");
		if (
			entry.index > 0xff ||
			entry.rgb > 0x00ff_ffff ||
			entry.index <= previous
		) {
			fail("viewport indexed color overrides are invalid or unordered");
		}
		previous = entry.index;
	}
}

function validateViewportAnchor(frame: ViewportFrame): void {
	validateEnumNumber(
		frame.anchorStatus,
		[
			ViewportAnchorStatus.FOLLOW_TAIL,
			ViewportAnchorStatus.ANCHORED,
			ViewportAnchorStatus.CLAMPED_START,
			ViewportAnchorStatus.CLAMPED_TAIL,
			ViewportAnchorStatus.PRUNED_TO_TAIL,
		],
		"viewport anchor status is required",
	);
	if (frame.rowsFromTail !== undefined) {
		validateUint64(
			frame.rowsFromTail,
			"viewport tail distance is not a uint64",
		);
	}
	const validStatus = frame.followTail
		? [
				ViewportAnchorStatus.FOLLOW_TAIL,
				ViewportAnchorStatus.CLAMPED_START,
				ViewportAnchorStatus.CLAMPED_TAIL,
				ViewportAnchorStatus.PRUNED_TO_TAIL,
			].includes(frame.anchorStatus)
		: [
				ViewportAnchorStatus.ANCHORED,
				ViewportAnchorStatus.CLAMPED_START,
			].includes(frame.anchorStatus);
	if (
		!validStatus ||
		(frame.followTail && frame.rowsFromTail !== 0n) ||
		(!frame.followTail && frame.rowsFromTail === 0n)
	) {
		fail("viewport anchor outcome and tail position disagree");
	}
}

function fail(message: string): never {
	throw new TerminalStateProtocolError("invalid_record", message);
}
