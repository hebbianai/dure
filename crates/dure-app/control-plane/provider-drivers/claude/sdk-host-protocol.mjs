const HOST_FRAME_MAGIC = Buffer.from("DCH1", "ascii");
const HOST_FRAME_HEADER_BYTES = 8;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
export const MAX_HOST_FRAME_BYTES = 256 * 1024;

export function hostProtocolError(reason) {
	const error = new Error(`dure_claude_sdk_host_protocol_${reason}`);
	error.code = "DURE_CLAUDE_SDK_HOST_PROTOCOL";
	return error;
}

function plainObject(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function encodeHostFrame(value) {
	if (!plainObject(value)) throw hostProtocolError("frame_invalid");
	let body;
	try {
		const source = JSON.stringify(value);
		if (typeof source !== "string") throw hostProtocolError("frame_not_serializable");
		body = Buffer.from(source, "utf8");
	} catch {
		throw hostProtocolError("frame_not_serializable");
	}
	if (body.length === 0 || body.length > MAX_HOST_FRAME_BYTES) {
		throw hostProtocolError("frame_size_invalid");
	}
	const frame = Buffer.allocUnsafe(HOST_FRAME_HEADER_BYTES + body.length);
	HOST_FRAME_MAGIC.copy(frame, 0);
	frame.writeUInt32BE(body.length, 4);
	body.copy(frame, HOST_FRAME_HEADER_BYTES);
	return frame;
}

export class HostFrameDecoder {
	#buffer = Buffer.alloc(0);

	push(chunk) {
		if (!(chunk instanceof Uint8Array)) throw hostProtocolError("chunk_invalid");
		if (chunk.byteLength > MAX_HOST_FRAME_BYTES + HOST_FRAME_HEADER_BYTES) {
			throw hostProtocolError("chunk_too_large");
		}
		this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
		const frames = [];
		while (this.#buffer.length >= HOST_FRAME_HEADER_BYTES) {
			if (!this.#buffer.subarray(0, 4).equals(HOST_FRAME_MAGIC)) {
				throw hostProtocolError("magic_invalid");
			}
			const bodyLength = this.#buffer.readUInt32BE(4);
			if (bodyLength === 0 || bodyLength > MAX_HOST_FRAME_BYTES) {
				throw hostProtocolError("frame_size_invalid");
			}
			const frameLength = HOST_FRAME_HEADER_BYTES + bodyLength;
			if (this.#buffer.length < frameLength) break;
			const source = this.#buffer.subarray(HOST_FRAME_HEADER_BYTES, frameLength);
			let value;
			try {
				value = JSON.parse(UTF8_DECODER.decode(source));
			} catch {
				throw hostProtocolError("json_invalid");
			}
			if (!plainObject(value)) throw hostProtocolError("frame_invalid");
			frames.push(value);
			this.#buffer = this.#buffer.subarray(frameLength);
		}
		if (this.#buffer.length > MAX_HOST_FRAME_BYTES + HOST_FRAME_HEADER_BYTES) {
			throw hostProtocolError("buffer_too_large");
		}
		return frames;
	}

	finish() {
		if (this.#buffer.length !== 0) throw hostProtocolError("truncated_frame");
	}
}
