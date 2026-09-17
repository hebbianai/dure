import type { TerminalEvent } from "@/contracts/terminalStateProtocol";

export interface TerminalViewportEventCursor {
	readonly terminalEpoch: string | null;
	readonly throughEventId: bigint;
}

export type TerminalViewportEventReduction =
	| {
			readonly status: "applied";
			readonly cursor: TerminalViewportEventCursor;
			readonly event: TerminalEvent;
	  }
	| {
			readonly status: "duplicate";
			readonly cursor: TerminalViewportEventCursor;
	  }
	| {
			readonly status: "reattach_required";
			readonly cursor: TerminalViewportEventCursor;
			readonly reason?: string;
	  };

export function createTerminalViewportEventCursor(): TerminalViewportEventCursor {
	return { terminalEpoch: null, throughEventId: 0n };
}

export function observeTerminalViewportEventHighWater(
	cursor: TerminalViewportEventCursor,
	terminalEpoch: string,
	throughEventId: bigint,
): TerminalViewportEventCursor {
	if (terminalEpoch.length === 0 || throughEventId < 0n) {
		throw new Error("terminal viewport event high-water is invalid");
	}
	if (cursor.terminalEpoch === null || cursor.terminalEpoch !== terminalEpoch) {
		return { terminalEpoch, throughEventId };
	}
	if (throughEventId !== cursor.throughEventId) {
		throw new Error(
			"terminal viewport event high-water skipped an ordered event",
		);
	}
	return { terminalEpoch, throughEventId };
}

export function reduceTerminalViewportEvent(
	cursor: TerminalViewportEventCursor,
	terminalEpoch: string,
	event: TerminalEvent,
): TerminalViewportEventReduction {
	if (cursor.terminalEpoch !== terminalEpoch || terminalEpoch.length === 0) {
		return {
			status: "reattach_required",
			cursor,
			reason: "terminal viewport event epoch is not current",
		};
	}
	if (event.eventId <= cursor.throughEventId) {
		return { status: "duplicate", cursor };
	}
	if (event.eventId !== cursor.throughEventId + 1n) {
		return {
			status: "reattach_required",
			cursor,
			reason: "terminal viewport event sequence has a gap",
		};
	}
	return {
		status: "applied",
		cursor: { terminalEpoch, throughEventId: event.eventId },
		event,
	};
}
