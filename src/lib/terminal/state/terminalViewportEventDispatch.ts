import type {
	ExecutionMarkerEvent,
	TerminalEvent,
} from "@/contracts/terminalStateProtocol";

export interface TerminalViewportEventSink {
	readonly bell: () => void;
	readonly writeClipboard: (text: string) => void;
	readonly notify: (title: string, body: string, eventId: bigint) => void;
	readonly executionMarker: (marker: ExecutionMarkerEvent) => void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function dispatchTerminalViewportEvent(
	event: TerminalEvent,
	sink: TerminalViewportEventSink,
): void {
	switch (event.event.case) {
		case "bell":
			sink.bell();
			return;
		case "clipboardWriteRequest":
			sink.writeClipboard(utf8.decode(event.event.value.content));
			return;
		case "notification":
			sink.notify(
				event.event.value.title,
				event.event.value.body,
				event.eventId,
			);
			return;
		case "executionMarker":
			sink.executionMarker(event.event.value);
			return;
		default:
			throw new Error("structured terminal event payload is missing");
	}
}
