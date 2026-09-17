import type { TerminalStateRecord } from "../../../contracts/terminalStateProtocol";
import { validateTerminalText } from "./terminalStateGridValidation";
import {
	validateTerminalEvent,
	validateTerminalInputIntent,
	validateTerminalInputReceipt,
	validateTerminalResizeReceipt,
} from "./terminalStateInteractionValidation";
import {
	TERMINAL_STATE_MAX_REVISION,
	TERMINAL_STATE_PROTOCOL_MINOR,
	TERMINAL_STATE_WHEEL_PROTOCOL_MINOR,
	TerminalStateProtocolError,
} from "./terminalStateLimits";
import {
	validateUint32,
	validateUint64,
} from "./terminalStateNumericValidation";
import {
	validateTerminalViewportFrame,
	validateTerminalViewportFramePart,
	validateTerminalViewportIntent,
	validateTerminalWheelReceipt,
} from "./terminalViewportValidation";

const MAX_TERMINAL_EPOCH_BYTES = 128;

/** Validates the one complete-frame profile shared by desktop and mobile. */
export function validateTerminalSurfaceRecord(
	record: TerminalStateRecord,
): void {
	validateUint32(record.schemaMinor, "schema minor is not a uint32");
	validateUint64(record.throughOutputSeq, "output sequence is not a uint64");
	validateUint64(record.stateRevision, "state revision is not a uint64");
	if (record.schemaMinor > TERMINAL_STATE_PROTOCOL_MINOR) {
		fail("schema minor is unsupported");
	}
	validateTerminalText(
		record.terminalEpoch,
		1,
		MAX_TERMINAL_EPOCH_BYTES,
		"terminal epoch is empty or oversized",
	);
	if (record.stateRevision === 0n) fail("state revision must be nonzero");
	if (record.stateRevision > TERMINAL_STATE_MAX_REVISION) {
		fail("state revision is exhausted; roll terminal epoch");
	}
	switch (record.body.case) {
		case "event":
			validateTerminalEvent(record.body.value);
			return;
		case "inputIntent":
			validateTerminalInputIntent(record.body.value);
			return;
		case "viewportFrame":
			validateTerminalViewportFrame(record.schemaMinor, record.body.value);
			if (
				record.body.value.inputOutputTiming?.firstOutputSequence !==
					undefined &&
				record.body.value.inputOutputTiming.firstOutputSequence >
					record.throughOutputSeq
			) {
				fail("viewport input/output timing exceeds its output high-water");
			}
			return;
		case "viewportIntent":
			validateTerminalViewportIntent(record.schemaMinor, record.body.value);
			return;
		case "inputReceipt":
			validateTerminalInputReceipt(record.body.value);
			if (
				record.body.value.outcome.case === "writtenToPty" &&
				record.body.value.outcome.value.inputBaselineOutputSequence !==
					undefined &&
				record.body.value.outcome.value.inputBaselineOutputSequence >
					record.throughOutputSeq
			) {
				fail("input receipt write baseline exceeds its output high-water");
			}
			return;
		case "resizeReceipt":
			validateTerminalResizeReceipt(record.body.value);
			return;
		case "viewportFramePart":
			validateTerminalViewportFramePart(record.schemaMinor, record.body.value);
			return;
		case "wheelReceipt":
			if (record.schemaMinor < TERMINAL_STATE_WHEEL_PROTOCOL_MINOR) {
				fail("wheel receipt requires the wheel protocol minor");
			}
			validateTerminalWheelReceipt(record.body.value);
			return;
		default:
			fail("record body is outside the TerminalSurface profile");
	}
}

export interface TerminalInputIngressAuthority {
	readonly terminalEpoch: string;
	readonly geometryGeneration: bigint;
}

/** Pure fence invoked again at the future Host's serialized PTY writer. */
export function validateTerminalInputIngress(
	record: TerminalStateRecord,
	authority: TerminalInputIngressAuthority,
): void {
	validateTerminalSurfaceRecord(record);
	if (record.terminalEpoch !== authority.terminalEpoch) {
		fail("input terminal epoch is not current");
	}
	if (record.body.case !== "inputIntent") {
		fail("input ingress requires an input intent record");
	}
	if (
		record.body.value.intent.case === "resize" &&
		record.body.value.intent.value.geometryGeneration !==
			authority.geometryGeneration
	) {
		fail("resize geometry generation is not current");
	}
}

function fail(message: string): never {
	throw new TerminalStateProtocolError("invalid_record", message);
}
