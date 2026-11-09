import { create } from "@bufbuild/protobuf";
import {
	FindInHistorySchema,
	type FindStep,
	FollowTailSchema,
	ScrollRowsSchema,
	SetViewportRowsSchema,
	TerminalDefaultColorsSchema,
	TerminalStateRecordSchema,
	type ViewportIntent,
	ViewportIntentSchema,
} from "@/contracts/terminalStateProtocol";
import {
	TERMINAL_STATE_DEFAULT_COLORS_PROTOCOL_MINOR,
	TERMINAL_STATE_HISTORY_FIND_PROTOCOL_MINOR,
} from "../protocol/terminalStateLimits";
import { encodeTerminalStateRecord } from "../protocol/terminalStateProtocol";
import type { TerminalDefaultColors } from "./terminalDefaultColors";
import type { TerminalInputFence } from "./terminalInputIntent";
import type { TerminalViewportIntentFence } from "./terminalViewportFrameReplica";

export function encodeTerminalViewportRowsIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	rows: number,
): Uint8Array {
	return encodeTerminalViewportIntent(recordId, inputFence, viewportFence, {
		case: "setViewportRows",
		value: create(SetViewportRowsSchema, { rows }),
	});
}

export function encodeTerminalViewportScrollRowsIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	rows: number,
): Uint8Array {
	return encodeTerminalViewportIntent(recordId, inputFence, viewportFence, {
		case: "scrollRows",
		value: create(ScrollRowsSchema, { rows }),
	});
}

export function encodeTerminalViewportFollowTailIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
): Uint8Array {
	return encodeTerminalViewportIntent(recordId, inputFence, viewportFence, {
		case: "followTail",
		value: create(FollowTailSchema),
	});
}

export function encodeTerminalDefaultColorsIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	colors: TerminalDefaultColors,
): Uint8Array {
	return encodeTerminalViewportIntent(
		recordId,
		{
			...inputFence,
			schemaMinor: TERMINAL_STATE_DEFAULT_COLORS_PROTOCOL_MINOR,
		},
		viewportFence,
		{
			case: "terminalDefaultColors",
			value: create(TerminalDefaultColorsSchema, colors),
		},
	);
}

export interface TerminalFindIntent {
	readonly query: string;
	readonly caseSensitive: boolean;
	readonly regex: boolean;
	readonly step: FindStep;
}

/** Host-side find over retained history; an empty query ends the find. */
export function encodeTerminalFindIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	find: TerminalFindIntent,
): Uint8Array {
	return encodeTerminalViewportIntent(
		recordId,
		{
			...inputFence,
			schemaMinor: TERMINAL_STATE_HISTORY_FIND_PROTOCOL_MINOR,
		},
		viewportFence,
		{
			case: "findInHistory",
			value: create(FindInHistorySchema, find),
		},
	);
}

function encodeTerminalViewportIntent(
	recordId: bigint,
	inputFence: TerminalInputFence,
	viewportFence: TerminalViewportIntentFence,
	intent: ViewportIntent["intent"],
): Uint8Array {
	if (inputFence.terminalEpoch === null) {
		throw new Error("terminal viewport intent requires an installed epoch");
	}
	return encodeTerminalStateRecord(
		recordId,
		create(TerminalStateRecordSchema, {
			schemaMinor: inputFence.schemaMinor,
			terminalEpoch: inputFence.terminalEpoch,
			throughOutputSeq: inputFence.throughOutputSeq,
			stateRevision: inputFence.stateRevision,
			body: {
				case: "viewportIntent",
				value: create(ViewportIntentSchema, {
					observedProjectionRevision: viewportFence.observedProjectionRevision,
					intentSeq: viewportFence.intentSeq,
					intent,
				}),
			},
		}),
	);
}
