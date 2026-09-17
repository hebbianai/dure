import type { TerminalPresentationRole } from "./presentation/terminalPresentationRoleStore";

export type TerminalRecoveryAdmissionEvent =
	| { state: "queued"; role: TerminalPresentationRole }
	| { state: "admitted"; role: TerminalPresentationRole; waited: boolean }
	| { state: "cancelled" };
export type TerminalRecoveryEvent =
	| TerminalRecoveryAdmissionEvent
	| { state: "backend_attach" }
	| {
			state: "exhausted";
			reason: "no_progress" | "reconnect_limit" | "replacement_failed";
	  };
export interface TerminalRecoveryTimingEvent {
	phase: "recovery";
	correlationId: string;
	event: TerminalRecoveryEvent;
}
interface RecoveryDetail {
	attachmentSequence: number;
	/** Frontend monotonic time relative to this capture's start. */
	atMs: number;
	event: TerminalRecoveryEvent;
	queueWaitMs: number | null;
	admissionToBackendMs: number | null;
}
interface RecoveryProgress {
	sequence: number;
	queuedAt?: number;
	admittedAt?: number;
}
interface RecoveryCapture {
	sequence: number;
	startedAt: number;
	state: "recording" | "stopped" | "expired" | "full";
	samples: RecoveryDetail[];
	byCorrelation: Map<string, RecoveryProgress>;
}

const CAPTURE_MS = 60_000;
const MAX_DETAIL_EVENTS = 96;

/** Low-frequency recovery counters; opaque correlation ids are retained only
 * during an explicit, bounded capture. No payloads, persistence or polling. */
export class TerminalRecoveryPerformanceTracker {
	private readonly counts = {
		queued: 0,
		admitted: 0,
		cancelled: 0,
		backendAttachRequests: 0,
		exhausted: 0,
	};
	private lastEventAt: number | undefined;
	private capture: RecoveryCapture | undefined;
	private captureSequence = 0;

	constructor(private readonly now: () => number) {}

	startDetailCapture(): () => void {
		this.capture?.byCorrelation.clear();
		if (this.capture) this.capture.samples.length = 0;
		const capture: RecoveryCapture = {
			sequence: ++this.captureSequence,
			startedAt: this.now(),
			state: "recording",
			samples: [],
			byCorrelation: new Map(),
		};
		this.capture = capture;
		return () => {
			if (this.capture !== capture) return;
			this.activeCapture(this.now());
			if (capture.state === "recording") capture.state = "stopped";
			capture.byCorrelation.clear();
		};
	}

	record(correlationId: string, event: TerminalRecoveryEvent) {
		const now = this.now();
		this.lastEventAt = now;
		if (event.state === "backend_attach")
			this.counts.backendAttachRequests += 1;
		else this.counts[event.state] += 1;
		const capture = this.activeCapture(now);
		if (!capture) return;
		const progress = capture.byCorrelation.get(correlationId) ?? {
			sequence: capture.byCorrelation.size + 1,
		};
		capture.byCorrelation.set(correlationId, progress);
		if (event.state === "queued") progress.queuedAt = now;
		if (event.state === "admitted") progress.admittedAt = now;
		capture.samples.push({
			attachmentSequence: progress.sequence,
			atMs: now - capture.startedAt,
			event: { ...event },
			queueWaitMs:
				event.state !== "admitted"
					? null
					: !event.waited
						? 0
						: progress.queuedAt === undefined
							? null
							: now - progress.queuedAt,
			admissionToBackendMs:
				event.state === "backend_attach" && progress.admittedAt !== undefined
					? now - progress.admittedAt
					: null,
		});
		if (capture.samples.length === MAX_DETAIL_EVENTS) {
			capture.state = "full";
			capture.byCorrelation.clear();
		}
	}

	snapshot() {
		const now = this.now();
		this.activeCapture(now);
		return {
			scope: "window_lifetime" as const,
			/** Counts are window-lifetime events, not distinct sessions or episodes. */
			counts: { ...this.counts },
			lastEventAgeMs:
				this.lastEventAt === undefined ? null : now - this.lastEventAt,
			detail: {
				captureSequence: this.capture?.sequence ?? null,
				clock: "frontend_monotonic_relative_to_capture" as const,
				state: this.capture?.state ?? ("disabled" as const),
				maxDurationMs: CAPTURE_MS,
				maxEvents: MAX_DETAIL_EVENTS,
				samples:
					this.capture?.samples.map((sample) => ({
						...sample,
						event: { ...sample.event },
					})) ?? [],
			},
		};
	}

	private activeCapture(now: number) {
		const capture = this.capture;
		if (capture?.state !== "recording") return undefined;
		if (now - capture.startedAt >= CAPTURE_MS) {
			capture.state = "expired";
			capture.byCorrelation.clear();
			return undefined;
		}
		return capture;
	}
}

export type TerminalRecoveryPerformanceSnapshot = ReturnType<
	TerminalRecoveryPerformanceTracker["snapshot"]
>;
