export const TERMINAL_STATE_PROTOCOL_MAJOR = 1;
export const TERMINAL_STATE_PROTOCOL_MINOR = 6;
export const TERMINAL_STATE_BASE_PROTOCOL_MINOR = 4;
export const TERMINAL_STATE_WHEEL_PROTOCOL_MINOR = 5;
export const TERMINAL_STATE_DEFAULT_COLORS_PROTOCOL_MINOR = 6;
export const TERMINAL_VIEWPORT_WHEEL_CAPABILITY = "terminal_viewport_wheel_v1";
export const TERMINAL_DEFAULT_COLORS_CAPABILITY = "terminal_default_colors_v1";
export const TERMINAL_STATE_ENVELOPE_HEADER_BYTES = 20;
export const TERMINAL_STATE_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const TERMINAL_STATE_MAX_ENVELOPE_BYTES =
	TERMINAL_STATE_ENVELOPE_HEADER_BYTES + TERMINAL_STATE_MAX_PAYLOAD_BYTES;
export const TERMINAL_STATE_MAX_VIEWPORT_FRAME_BYTES = 4 * 1024 * 1024;
export const TERMINAL_STATE_MAX_VIEWPORT_FRAME_PARTS = 32;
export const TERMINAL_STATE_MAX_BATCH_ID_BYTES = 64;
// The Host rolls terminalEpoch before the revision space is exhausted.
export const TERMINAL_STATE_MAX_REVISION = 0xffff_ffff_ffff_fffen;

export class TerminalStateProtocolError extends Error {
	constructor(
		readonly code:
			| "frame_too_large"
			| "invalid_envelope"
			| "invalid_protobuf"
			| "invalid_record",
		message: string,
	) {
		super(message);
		this.name = "TerminalStateProtocolError";
	}
}
