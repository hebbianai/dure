const MAGIC = Buffer.from("DCR1", "ascii");
const PREFIX_BYTES = 20;

export const CLAUDE_PROCESS_RELAY_PROTOCOL_VERSION = 1;
export const MAX_RELAY_FRAME_BYTES = 256 * 1024;
export const MAX_RELAY_METADATA_BYTES = 16 * 1024;
export const MAX_RELAY_STREAM_BYTES = 64 * 1024;
export const MAX_RELAY_STDERR_BYTES = 2 * 1024;
export const RELAY_SUPPORTED_SIGNALS = Object.freeze([
	"SIGHUP",
	"SIGINT",
	"SIGKILL",
	"SIGTERM",
]);

export const RelayFrameKind = Object.freeze({
	hello: 1,
	ready: 2,
	stdin: 3,
	stdinAck: 4,
	stdinEof: 5,
	stdinEofAck: 6,
	stdout: 7,
	stdoutAck: 8,
	stdoutEof: 9,
	signal: 10,
	signalAck: 11,
	exit: 12,
	error: 13,
	abort: 14,
	abortAck: 15,
});

const relayFrameKinds = new Set(Object.values(RelayFrameKind));

function contractError(reason) {
	const error = new Error(`dure_claude_process_relay_${reason}`);
	error.code = "DURE_CLAUDE_PROCESS_RELAY_CONTRACT";
	return error;
}

function relayIdentity(identity) {
	if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
		throw contractError("identity_invalid");
	}
	const parsed = {};
	for (const key of ["runtimeGeneration", "queryEpoch", "relayId"]) {
		const value = identity[key];
		if (
			typeof value !== "string" ||
			value.length === 0 ||
			value.length > 128 ||
			/[\u0000-\u001f\u007f]/u.test(value)
		) {
			throw contractError(`${key}_invalid`);
		}
		parsed[key] = value;
	}
	return parsed;
}

function sequenceNumber(sequence) {
	if (!Number.isSafeInteger(sequence) || sequence <= 0) {
		throw contractError("sequence_invalid");
	}
	return sequence;
}

function payloadBuffer(payload) {
	if (payload === undefined) return Buffer.alloc(0);
	if (Buffer.isBuffer(payload)) return payload;
	if (payload instanceof Uint8Array) {
		return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
	}
	throw contractError("payload_invalid");
}

export function encodeRelayFrame({ kind, sequence, identity, metadata = {}, payload }) {
	if (!relayFrameKinds.has(kind)) throw contractError("kind_invalid");
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		throw contractError("metadata_invalid");
	}
	const parsedIdentity = relayIdentity(identity);
	const parsedSequence = sequenceNumber(sequence);
	const metadataBytes = Buffer.from(
		JSON.stringify({ ...metadata, ...parsedIdentity }),
		"utf8",
	);
	if (metadataBytes.length > MAX_RELAY_METADATA_BYTES) {
		throw contractError("metadata_too_large");
	}
	const payloadBytes = payloadBuffer(payload);
	if (
		[RelayFrameKind.stdin, RelayFrameKind.stdout].includes(kind) &&
		payloadBytes.length > MAX_RELAY_STREAM_BYTES
	) {
		throw contractError("stream_payload_too_large");
	}
	const bodyBytes = PREFIX_BYTES - 8 + metadataBytes.length + payloadBytes.length;
	const totalBytes = bodyBytes + 8;
	if (totalBytes > MAX_RELAY_FRAME_BYTES) throw contractError("frame_too_large");

	const frame = Buffer.allocUnsafe(totalBytes);
	MAGIC.copy(frame, 0);
	frame.writeUInt32BE(bodyBytes, 4);
	frame.writeUInt8(kind, 8);
	frame.writeUInt8(0, 9);
	frame.writeUInt16BE(metadataBytes.length, 10);
	frame.writeBigUInt64BE(BigInt(parsedSequence), 12);
	metadataBytes.copy(frame, PREFIX_BYTES);
	payloadBytes.copy(frame, PREFIX_BYTES + metadataBytes.length);
	return frame;
}

function decodeFrame(frame) {
	if (frame.length < PREFIX_BYTES || !frame.subarray(0, 4).equals(MAGIC)) {
		throw contractError("frame_prefix_invalid");
	}
	const bodyBytes = frame.readUInt32BE(4);
	if (bodyBytes + 8 !== frame.length || frame.length > MAX_RELAY_FRAME_BYTES) {
		throw contractError("frame_length_invalid");
	}
	const kind = frame.readUInt8(8);
	if (!relayFrameKinds.has(kind) || frame.readUInt8(9) !== 0) {
		throw contractError("frame_kind_invalid");
	}
	const metadataLength = frame.readUInt16BE(10);
	if (
		metadataLength > MAX_RELAY_METADATA_BYTES ||
		PREFIX_BYTES + metadataLength > frame.length
	) {
		throw contractError("frame_metadata_length_invalid");
	}
	const sequence = Number(frame.readBigUInt64BE(12));
	sequenceNumber(sequence);
	let metadata;
	try {
		metadata = JSON.parse(
			frame.subarray(PREFIX_BYTES, PREFIX_BYTES + metadataLength).toString("utf8"),
		);
	} catch {
		throw contractError("frame_metadata_json_invalid");
	}
	const identity = relayIdentity(metadata);
	return {
		kind,
		sequence,
		identity,
		metadata,
		payload: frame.subarray(PREFIX_BYTES + metadataLength),
	};
}

export class RelayFrameDecoder {
	#buffer = Buffer.alloc(0);

	push(chunk) {
		const bytes = payloadBuffer(chunk);
		if (this.#buffer.length + bytes.length > MAX_RELAY_FRAME_BYTES * 2) {
			throw contractError("receive_buffer_too_large");
		}
		this.#buffer =
			this.#buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.#buffer, bytes]);
		const frames = [];
		while (this.#buffer.length >= 8) {
			if (!this.#buffer.subarray(0, 4).equals(MAGIC)) {
				throw contractError("frame_magic_invalid");
			}
			const totalBytes = this.#buffer.readUInt32BE(4) + 8;
			if (totalBytes < PREFIX_BYTES || totalBytes > MAX_RELAY_FRAME_BYTES) {
				throw contractError("frame_length_invalid");
			}
			if (this.#buffer.length < totalBytes) break;
			frames.push(decodeFrame(this.#buffer.subarray(0, totalBytes)));
			this.#buffer = this.#buffer.subarray(totalBytes);
		}
		return frames;
	}

	finish() {
		if (this.#buffer.length !== 0) throw contractError("truncated_frame");
	}
}

export function relayIdentityMatches(left, right) {
	const parsedLeft = relayIdentity(left);
	const parsedRight = relayIdentity(right);
	return ["runtimeGeneration", "queryEpoch", "relayId"].every(
		(key) => parsedLeft[key] === parsedRight[key],
	);
}

export function relayProtocolError(reason) {
	return contractError(reason);
}
