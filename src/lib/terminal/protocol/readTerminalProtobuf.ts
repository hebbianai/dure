import {
	type DescMessage,
	fromBinary,
	type MessageShape,
} from "@bufbuild/protobuf";
import {
	configureTextEncoding,
	getTextEncoding,
} from "@bufbuild/protobuf/wire";

// Independent of both the peer's bytes and protobuf's shared encoder.
const CANARY = Uint8Array.of(
	0x44,
	0x75,
	0x72,
	0x65,
	0x20,
	0xed,
	0x95,
	0x9c,
	0xf0,
	0x9f,
	0x99,
	0x82,
);
const CANARY_TEXT = "Dure 한🙂";

function canDecode(
	decode: ReturnType<typeof getTextEncoding>["decodeUtf8"],
): boolean {
	try {
		return (
			decode(CANARY, true) === CANARY_TEXT &&
			decode(CANARY, false) === CANARY_TEXT
		);
	} catch {
		return false;
	}
}

function repairFailedTextDecoder(): boolean {
	const previous = getTextEncoding();
	// Malformed protobuf/UTF-8 is not evidence that a decoder is broken. Only
	// replace shared state when it cannot decode our fixed, known-valid probe.
	if (canDecode(previous.decodeUtf8)) return false;
	try {
		const strict = new TextDecoder("utf-8", { fatal: true });
		const loose = new TextDecoder();
		const decodeUtf8 = (bytes: Uint8Array, fatal?: boolean) =>
			(fatal ? strict : loose).decode(bytes);
		if (!canDecode(decodeUtf8)) return false;
		configureTextEncoding({ ...previous, decodeUtf8 });
		return true;
	} catch {
		return false;
	}
}

/** A new attachment still uses protobuf's realm-wide text decoder. Recover a
 * demonstrably failed context without reloading the UI or replacing a Host.
 * Retry only the same bounded read, once; all protocol validation still applies. */
export function readTerminalProtobuf<Desc extends DescMessage>(
	schema: Desc,
	bytes: Uint8Array,
): MessageShape<Desc> {
	try {
		return fromBinary(schema, bytes);
	} catch (cause) {
		if (!repairFailedTextDecoder()) throw cause;
		return fromBinary(schema, bytes);
	}
}
