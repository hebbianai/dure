import {
	type PostPaintOptions,
	schedulePostPaint,
} from "@/lib/scheduling/postPaint";

export interface PaneDragTimingSample {
	sequence: number;
	eventType: "dragenter" | "dragover";
	receivedAt: number;
	trusted: boolean;
	/** Browser event creation to handler entry, not hardware pointer latency. */
	eventAgeMs: number | null;
	/** Includes stationary-pointer time and native event coalescing. */
	receivedGapMs: number | null;
	/** A queued task checkpoint, not exclusive drag-handler execution time. */
	receiptToTaskMs: number | null;
	receiptToFrameMs: number | null;
	/** Post-frame task checkpoint; does not prove preview pixels were painted. */
	receiptToPostFrameTaskMs: number | null;
	frameProbe: "pending" | "complete" | "coalesced" | "cancelled";
	/** Coalesced events share the earlier probe; their own latency stays null. */
	frameProbeSequence: number;
}

export interface PaneDragPerformanceSnapshot {
	timeOriginMs: number;
	/** Known only for drags started by this window's pane handler. */
	startedAt: number | null;
	recent: readonly PaneDragTimingSample[];
}

export const MAX_PANE_DRAG_SAMPLES = 128;
type Schedule = (callback: () => void, options: PostPaintOptions) => () => void;

/** Content-free window-local observations; never controls drag/drop behavior. */
export class PaneDragPerformanceTracker {
	private samples: PaneDragTimingSample[] = [];
	private active = false;
	private seenEvents = new WeakSet<Event>();
	private pending: PaneDragTimingSample | undefined;
	private cancelProbe: (() => void) | undefined;
	private sequence = 0;
	private startedAt: number | null = null;

	constructor(
		private readonly now = () => performance.now(),
		private readonly schedule: Schedule = (callback, options) =>
			schedulePostPaint(window, callback, options),
		private readonly timeOriginMs = performance.timeOrigin,
	) {}

	begin(startedAt: number | null = this.now()): void {
		this.end();
		this.samples = [];
		this.seenEvents = new WeakSet();
		this.sequence = 0;
		this.startedAt = startedAt;
		this.active = true;
	}

	record(event: DragEvent): void {
		if (
			(event.type !== "dragover" && event.type !== "dragenter") ||
			this.seenEvents.has(event)
		)
			return;
		if (!this.active) this.begin(null);
		this.seenEvents.add(event);
		const receivedAt = this.now();
		const previous = this.samples[this.samples.length - 1];
		const sample: PaneDragTimingSample = {
			sequence: ++this.sequence,
			eventType: event.type,
			receivedAt,
			trusted: event.isTrusted,
			eventAgeMs:
				event.isTrusted &&
				Number.isFinite(event.timeStamp) &&
				event.timeStamp > 0 &&
				event.timeStamp <= receivedAt
					? receivedAt - event.timeStamp
					: null,
			receivedGapMs: previous
				? Math.max(0, receivedAt - previous.receivedAt)
				: null,
			receiptToTaskMs: null,
			receiptToFrameMs: null,
			receiptToPostFrameTaskMs: null,
			frameProbe: this.pending ? "coalesced" : "pending",
			frameProbeSequence: this.pending?.sequence ?? this.sequence,
		};
		this.samples.push(sample);
		// Keep drag entry and the pending probe as well as the recent tail; stalls must survive
		// a longer gesture. No event payloads, pane names, or DOM nodes are retained.
		if (this.samples.length > MAX_PANE_DRAG_SAMPLES) {
			const oldest = this.samples.findIndex(
				(entry, index) => index > 0 && entry !== this.pending,
			);
			this.samples.splice(oldest, 1);
		}
		if (this.pending) return;
		this.pending = sample;
		const elapsed = () => Math.max(0, this.now() - receivedAt);
		this.cancelProbe = this.schedule(
			() => {
				if (this.pending !== sample) return;
				sample.receiptToPostFrameTaskMs = elapsed();
				sample.frameProbe = "complete";
				this.pending = undefined;
				this.cancelProbe = undefined;
			},
			{
				onTask: () => {
					if (this.pending === sample) sample.receiptToTaskMs = elapsed();
				},
				onFrame: () => {
					if (this.pending === sample) sample.receiptToFrameMs = elapsed();
				},
			},
		);
	}

	end(): void {
		this.cancelProbe?.();
		if (this.pending) this.pending.frameProbe = "cancelled";
		this.pending = undefined;
		this.cancelProbe = undefined;
		this.active = false;
	}

	snapshot(): PaneDragPerformanceSnapshot {
		return {
			timeOriginMs: this.timeOriginMs,
			startedAt: this.startedAt,
			recent: this.samples.map((sample) => ({ ...sample })),
		};
	}
}

export const paneDragPerformance = new PaneDragPerformanceTracker();
