import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire";
import {
	type TerminalStateRecord,
	TerminalStateRecordSchema,
	type ViewportFrame,
} from "../../../contracts/terminalStateProtocol";
import {
	TERMINAL_STATE_ENVELOPE_HEADER_BYTES,
	TERMINAL_STATE_MAX_ENVELOPE_BYTES,
	TERMINAL_STATE_MAX_PAYLOAD_BYTES,
	TERMINAL_STATE_PROTOCOL_MAJOR,
	TERMINAL_STATE_PROTOCOL_MINOR,
	TerminalStateProtocolError,
} from "./terminalStateLimits";
import { validateUint32 } from "./terminalStateNumericValidation";
import {
	type TerminalInputIngressAuthority,
	validateTerminalInputIngress,
	validateTerminalSurfaceRecord,
} from "./terminalStateSemanticValidation";

export * from "./terminalStateLimits";
export { validateTerminalInputIngress } from "./terminalStateSemanticValidation";
export type { TerminalStateRecord };

const MAGIC = Uint8Array.of(0x54, 0x53, 0x50, 0x42);

export function hasTerminalStateEnvelopeMagic(bytes: Uint8Array): boolean {
	return MAGIC.every((byte, index) => bytes[index] === byte);
}

type TerminalStateRecordKind =
	| "event"
	| "input_intent"
	| "viewport_frame"
	| "viewport_intent"
	| "input_receipt"
	| "resize_receipt"
	| "viewport_frame_part"
	| "wheel_receipt";

interface TerminalStateEnvelopeMetadata {
	readonly protocolMinor: number;
	readonly recordId: bigint;
	readonly kind: TerminalStateRecordKind;
}

export interface DecodedTerminalStateRecord {
	readonly metadata: TerminalStateEnvelopeMetadata;
	readonly record: TerminalStateRecord;
}

export interface TerminalViewportFrameBinaryDecoder {
	decode(bytes: Uint8Array): ViewportFrame;
	/** Commits only after the carrier accepts the decoded transition. */
	commit(): void;
	discard(): void;
}

export function encodeTerminalStateRecord(
	recordId: bigint,
	record: TerminalStateRecord,
): Uint8Array {
	return encodeTerminalStateRecordForMinor(
		record.schemaMinor,
		recordId,
		record,
	);
}

function encodeTerminalStateRecordForMinor(
	negotiatedMinor: number,
	recordId: bigint,
	record: TerminalStateRecord,
): Uint8Array {
	validateUint32(negotiatedMinor, "negotiated minor is not a uint32");
	if (negotiatedMinor > TERMINAL_STATE_PROTOCOL_MINOR) {
		fail("invalid_envelope", "negotiated minor is unsupported");
	}
	if (record.schemaMinor > negotiatedMinor) {
		fail("invalid_envelope", "schema minor exceeds negotiated minor");
	}
	if (recordId <= 0n || recordId > 0xffff_ffff_ffff_ffffn) {
		fail("invalid_envelope", "record id must be a nonzero uint64");
	}
	validateTerminalSurfaceRecord(record);
	const payload = toBinary(TerminalStateRecordSchema, record);
	if (payload.byteLength > TERMINAL_STATE_MAX_PAYLOAD_BYTES) {
		fail("frame_too_large", "terminal state payload exceeds one MiB");
	}
	const output = new Uint8Array(
		TERMINAL_STATE_ENVELOPE_HEADER_BYTES + payload.byteLength,
	);
	output.set(MAGIC);
	output[4] = TERMINAL_STATE_PROTOCOL_MAJOR;
	output[5] = negotiatedMinor;
	output[6] = recordKindByte(record);
	output[7] = 0;
	const view = new DataView(output.buffer);
	view.setUint32(8, payload.byteLength, true);
	view.setBigUint64(12, recordId, true);
	output.set(payload, TERMINAL_STATE_ENVELOPE_HEADER_BYTES);
	return output;
}

/** Rechecks controller and resize authority at the serialized writer edge. */
export function encodeTerminalInputAtWriter(
	negotiatedMinor: number,
	recordId: bigint,
	record: TerminalStateRecord,
	authority: TerminalInputIngressAuthority,
): Uint8Array {
	validateTerminalInputIngress(record, authority);
	return encodeTerminalStateRecordForMinor(negotiatedMinor, recordId, record);
}

export function decodeTerminalStateRecord(
	bytes: Uint8Array,
	viewportFrameDecoder?: TerminalViewportFrameBinaryDecoder,
): DecodedTerminalStateRecord {
	if (bytes.byteLength > TERMINAL_STATE_MAX_ENVELOPE_BYTES) {
		fail("frame_too_large", "terminal state envelope exceeds its byte cap");
	}
	if (bytes.byteLength < TERMINAL_STATE_ENVELOPE_HEADER_BYTES) {
		fail("invalid_envelope", "truncated terminal state header");
	}
	for (let index = 0; index < MAGIC.length; index += 1) {
		if (bytes[index] !== MAGIC[index]) {
			fail("invalid_envelope", "terminal state magic does not match");
		}
	}
	if (bytes[4] !== TERMINAL_STATE_PROTOCOL_MAJOR) {
		fail("invalid_envelope", "terminal state major version is unsupported");
	}
	const protocolMinor = bytes[5] ?? 0;
	if (protocolMinor > TERMINAL_STATE_PROTOCOL_MINOR) {
		fail("invalid_envelope", "terminal state minor version is unsupported");
	}
	if (bytes[7] !== 0) {
		fail("invalid_envelope", "terminal state reserved flags are nonzero");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const payloadLength = view.getUint32(8, true);
	if (payloadLength > TERMINAL_STATE_MAX_PAYLOAD_BYTES) {
		fail(
			"frame_too_large",
			"peer-declared terminal state payload is too large",
		);
	}
	if (
		bytes.byteLength !==
		TERMINAL_STATE_ENVELOPE_HEADER_BYTES + payloadLength
	) {
		fail("invalid_envelope", "terminal state payload length does not match");
	}
	const recordId = view.getBigUint64(12, true);
	if (recordId === 0n) fail("invalid_envelope", "record id must be nonzero");

	let record: TerminalStateRecord;
	let stagedViewport = false;
	try {
		const payload = bytes.subarray(TERMINAL_STATE_ENVELOPE_HEADER_BYTES);
		const viewport = viewportFrameDecoder
			? splitSingleViewportBody(payload)
			: undefined;
		if (viewport && viewportFrameDecoder) {
			record = fromBinary(TerminalStateRecordSchema, viewport.metadata);
			stagedViewport = true;
			record.body = {
				case: "viewportFrame",
				value: viewportFrameDecoder.decode(viewport.frame),
			};
		} else {
			record = fromBinary(TerminalStateRecordSchema, payload);
		}
	} catch {
		if (stagedViewport) viewportFrameDecoder?.discard();
		fail("invalid_protobuf", "terminal state protobuf could not be decoded");
	}
	try {
		validateTerminalSurfaceRecord(record);
		if (record.schemaMinor > protocolMinor) {
			fail("invalid_envelope", "schema minor exceeds envelope minor");
		}
		const kind = recordKind(record);
		if (recordKindFromByte(bytes[6] ?? 0) !== kind) {
			fail("invalid_envelope", "envelope kind does not match protobuf body");
		}
		return { metadata: { protocolMinor, recordId, kind }, record };
	} catch (cause) {
		if (stagedViewport) viewportFrameDecoder?.discard();
		throw cause;
	}
}

function splitSingleViewportBody(
	payload: Uint8Array,
): { readonly metadata: Uint8Array; readonly frame: Uint8Array } | undefined {
	const reader = new BinaryReader(payload);
	const retained: Uint8Array[] = [];
	let retainedBytes = 0;
	let frame: Uint8Array | undefined;
	let bodyFields = 0;
	while (reader.pos < reader.len) {
		const fieldStart = reader.pos;
		const [fieldNumber, wireType] = reader.tag();
		if (fieldNumber >= 10 && fieldNumber <= 22) bodyFields += 1;
		if (fieldNumber === 17) {
			if (wireType !== WireType.LengthDelimited || frame !== undefined) {
				return undefined;
			}
			frame = reader.bytes();
			continue;
		}
		reader.skip(wireType, fieldNumber);
		const field = payload.subarray(fieldStart, reader.pos);
		retained.push(field);
		retainedBytes += field.byteLength;
	}
	if (bodyFields !== 1 || frame === undefined) return undefined;
	return { metadata: concatenateFields(retained, retainedBytes), frame };
}

function concatenateFields(
	fields: readonly Uint8Array[],
	byteLength: number,
): Uint8Array {
	const joined = new Uint8Array(byteLength);
	let offset = 0;
	for (const field of fields) {
		joined.set(field, offset);
		offset += field.byteLength;
	}
	return joined;
}

function recordKind(record: TerminalStateRecord): TerminalStateRecordKind {
	switch (record.body.case) {
		case "event":
			return "event";
		case "inputIntent":
			return "input_intent";
		case "viewportFrame":
			return "viewport_frame";
		case "viewportIntent":
			return "viewport_intent";
		case "inputReceipt":
			return "input_receipt";
		case "resizeReceipt":
			return "resize_receipt";
		case "viewportFramePart":
			return "viewport_frame_part";
		case "wheelReceipt":
			return "wheel_receipt";
		default:
			return fail("invalid_record", "terminal state record body is required");
	}
}

function recordKindByte(record: TerminalStateRecord): number {
	return {
		event: 4,
		input_intent: 5,
		viewport_frame: 8,
		viewport_intent: 9,
		input_receipt: 10,
		resize_receipt: 11,
		viewport_frame_part: 12,
		wheel_receipt: 13,
	}[recordKind(record)];
}

function recordKindFromByte(value: number): TerminalStateRecordKind {
	switch (value) {
		case 4:
			return "event";
		case 5:
			return "input_intent";
		case 8:
			return "viewport_frame";
		case 9:
			return "viewport_intent";
		case 10:
			return "input_receipt";
		case 11:
			return "resize_receipt";
		case 12:
			return "viewport_frame_part";
		case 13:
			return "wheel_receipt";
		default:
			return fail("invalid_envelope", "terminal state record kind is unknown");
	}
}

function fail(
	code: TerminalStateProtocolError["code"],
	message: string,
): never {
	throw new TerminalStateProtocolError(code, message);
}
