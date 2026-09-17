import { create } from "@bufbuild/protobuf";
import {
	FocusInputIntentSchema,
	type InputIntent,
	InputIntentSchema,
	KeyInputIntentSchema,
	PasteInputIntentSchema,
	type PointerInputIntent,
	PointerInputIntentSchema,
	type PointerKind,
	ResizeInputIntentSchema,
	TerminalStateRecordSchema,
	TextInputIntentSchema,
	ViewportIntentSchema,
} from "@/contracts/terminalStateProtocol";
import { TERMINAL_STATE_WHEEL_PROTOCOL_MINOR } from "../protocol/terminalStateLimits";
import { encodeTerminalStateRecord } from "../protocol/terminalStateProtocol";
import type { TerminalViewportIntentFence } from "./terminalViewportFrameReplica";

const textEncoder = new TextEncoder();

export interface TerminalInputFence {
	readonly schemaMinor: number;
	readonly terminalEpoch: string | null;
	readonly throughOutputSeq: bigint;
	readonly stateRevision: bigint;
}

export type TerminalKeyEvent = Pick<
	KeyboardEvent,
	| "key"
	| "code"
	| "shiftKey"
	| "altKey"
	| "ctrlKey"
	| "metaKey"
	| "repeat"
	| "getModifierState"
> & { readonly isComposing?: boolean };

export interface TerminalPointerIntent {
	readonly kind:
		| PointerKind.DOWN
		| PointerKind.UP
		| PointerKind.MOVE
		| PointerKind.WHEEL;
	readonly column: number;
	readonly row: number;
	readonly button: number;
	readonly buttons: number;
	readonly shiftKey: boolean;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly wheelDeltaX: number;
	readonly wheelDeltaY: number;
	readonly pixelX: number;
	readonly pixelY: number;
	readonly surfaceWidth: number;
	readonly surfaceHeight: number;
	readonly cellWidth: number;
	readonly cellHeight: number;
	readonly paddingTop: number;
	readonly paddingBottom: number;
	readonly paddingRight: number;
	readonly paddingLeft: number;
}

export function shouldSendTerminalKey(event: TerminalKeyEvent): boolean {
	if (event.isComposing || event.key === "Process") return false;
	if (event.metaKey && !event.ctrlKey) return false;
	return event.key.length !== 1 || event.ctrlKey || event.altKey;
}

export function encodeTerminalTextIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	text: string,
): Uint8Array {
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "text",
				value: create(TextInputIntentSchema, {
					utf8: textEncoder.encode(text),
				}),
			},
		}),
	);
}

export function encodeTerminalKeyIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	event: TerminalKeyEvent,
): Uint8Array {
	let modifiers = 0;
	if (event.shiftKey) modifiers |= 1 << 0;
	if (event.altKey) modifiers |= 1 << 1;
	if (event.ctrlKey) modifiers |= 1 << 2;
	if (event.metaKey) modifiers |= 1 << 3;
	if (event.getModifierState("CapsLock")) modifiers |= 1 << 4;
	if (event.getModifierState("NumLock")) modifiers |= 1 << 5;
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "key",
				value: create(KeyInputIntentSchema, {
					key: event.key,
					code: event.code,
					modifiers,
					repeat: event.repeat,
				}),
			},
		}),
	);
}

export function encodeTerminalPasteIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	text: string,
): Uint8Array {
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "paste",
				value: create(PasteInputIntentSchema, {
					utf8: textEncoder.encode(text),
				}),
			},
		}),
	);
}

export function encodeTerminalFocusIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	focused: boolean,
): Uint8Array {
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "focus",
				value: create(FocusInputIntentSchema, { focused }),
			},
		}),
	);
}

export function encodeTerminalResizeIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	columns: number,
	rows: number,
): Uint8Array {
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "resize",
				value: create(ResizeInputIntentSchema, {
					columns,
					rows,
					geometryGeneration: recordId,
				}),
			},
		}),
	);
}

export function encodeTerminalPointerIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	pointer: TerminalPointerIntent,
): Uint8Array {
	return encodeIntent(
		recordId,
		fence,
		create(InputIntentSchema, {
			intent: {
				case: "pointer",
				value: createTerminalPointerInput(pointer),
			},
		}),
	);
}

export function encodeTerminalViewportWheelIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	pointer: TerminalPointerIntent & { readonly kind: PointerKind.WHEEL },
): Uint8Array {
	if (fence.terminalEpoch === null) {
		throw new Error("structured terminal wheel requires an installed epoch");
	}
	return encodeTerminalStateRecord(
		recordId,
		create(TerminalStateRecordSchema, {
			schemaMinor: TERMINAL_STATE_WHEEL_PROTOCOL_MINOR,
			terminalEpoch: fence.terminalEpoch,
			throughOutputSeq: fence.throughOutputSeq,
			stateRevision: fence.stateRevision,
			body: {
				case: "viewportIntent",
				value: create(ViewportIntentSchema, {
					observedProjectionRevision: viewportFence.observedProjectionRevision,
					intentSeq: viewportFence.intentSeq,
					intent: {
						case: "wheel",
						value: createTerminalPointerInput(pointer),
					},
				}),
			},
		}),
	);
}

function createTerminalPointerInput(
	pointer: TerminalPointerIntent,
): PointerInputIntent {
	let modifiers = 0;
	if (pointer.shiftKey) modifiers |= 1 << 0;
	if (pointer.altKey) modifiers |= 1 << 1;
	if (pointer.ctrlKey) modifiers |= 1 << 2;
	if (pointer.metaKey) modifiers |= 1 << 3;
	return create(PointerInputIntentSchema, {
		kind: pointer.kind,
		column: pointer.column,
		row: pointer.row,
		button: pointer.button,
		modifiers,
		wheelDeltaX: pointer.wheelDeltaX,
		wheelDeltaY: pointer.wheelDeltaY,
		pixelX: pointer.pixelX,
		pixelY: pointer.pixelY,
		surfaceWidth: pointer.surfaceWidth,
		surfaceHeight: pointer.surfaceHeight,
		cellWidth: pointer.cellWidth,
		cellHeight: pointer.cellHeight,
		paddingTop: pointer.paddingTop,
		paddingBottom: pointer.paddingBottom,
		paddingRight: pointer.paddingRight,
		paddingLeft: pointer.paddingLeft,
		pressedButtons: pointer.buttons,
	});
}

function encodeIntent(
	recordId: bigint,
	fence: TerminalInputFence,
	inputIntent: InputIntent,
): Uint8Array {
	if (fence.terminalEpoch === null) {
		throw new Error("structured terminal input requires an installed epoch");
	}
	return encodeTerminalStateRecord(
		recordId,
		create(TerminalStateRecordSchema, {
			schemaMinor: fence.schemaMinor,
			terminalEpoch: fence.terminalEpoch,
			throughOutputSeq: fence.throughOutputSeq,
			stateRevision: fence.stateRevision,
			body: { case: "inputIntent", value: inputIntent },
		}),
	);
}
