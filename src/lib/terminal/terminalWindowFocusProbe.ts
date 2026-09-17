import type { TerminalQaBufferState } from "@/lib/terminal/terminalViewContracts";

export type TerminalWindowFocusControlState =
	| "viewing"
	| "waiting"
	| "controlling"
	| "error";

export interface TerminalQaInputReceipt {
	requestId: string;
	attachmentIdentity: string;
	state: "written_to_pty";
	inputStartedAtMs: number;
	hostReceiptAtMs: number;
}

export interface TerminalWindowFocusProbeSurface {
	focus(): Promise<void>;
	releaseKeyboardControl(): Promise<void>;
	writeMarker(marker: string, input?: string): Promise<TerminalQaInputReceipt>;
	/** Requests a Host-owned viewport move; positive rows move toward history. */
	scrollRows(rows: number): bigint | undefined;
	markerCounts(): Record<string, number>;
	/** Latest complete client projection, independent of a suspended hidden paint. */
	projectionMarkerCounts?(): Record<string, number>;
	bufferState(logicalMarker?: string): TerminalQaBufferState;
	renderMetrics(): {
		queuedWrites: number;
		queuedBytes: number;
		activeBytes: number;
		activeWriteAgeMs: number | null;
		completedWrites: number;
		snapshotCollapses: number;
		maxWriteLatencyMs: number;
	};
}

export interface TerminalWindowFocusProbe {
	connect(surface: TerminalWindowFocusProbeSurface): () => void;
	/** Records the exact source-pane conceal boundary of a large-view return. */
	onLargeViewReturnPrepared?(): void;
	/** Tracks the transport effect's exact live observer generation. */
	onSurfaceAttachmentStarted?(attachmentId: string): void;
	/** Observes the transport's own exact Host-detachment promise. */
	onSurfaceRetirement?(attachmentId: string, retirement: Promise<void>): void;
	onHydrationChange(hydrating: boolean): void;
	onSynchronized(): void;
	onPresented(state: TerminalQaBufferState): void;
	onError(error: unknown): void;
}
