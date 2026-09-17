type ChatInputLatencyOutcome = "complete" | "timed_out";

interface ChatInputLatencySample {
	sequence: number;
	startedAt: number;
	commitMs: number | null;
	commitToFrameMs: number | null;
	frameToPostPaintMs: number | null;
	paintMs: number | null;
	commitToPaintMs: number | null;
	outcome: ChatInputLatencyOutcome;
}

export interface ChatInputLatencySnapshot {
	samples: readonly ChatInputLatencySample[];
	inFlightCount: number;
	latestSampleAgeMs: number | null;
}

export interface ChatInputLatencyHandle {
	readonly sequence: number;
}

interface ActiveSample extends ChatInputLatencySample {
	committedAt: number | null;
	frameAt: number | null;
}

interface CompletedSample {
	sample: ChatInputLatencySample;
	completedAt: number;
}

interface ChatInputLatencyOptions {
	now?: () => number;
	sampleIntervalMs?: number;
	timeoutMs?: number;
	maxSamples?: number;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SAMPLES = 128;

/**
 * Samples the existing Structured Chat draft boundary through React commit and
 * browser paint. It retains timing only: prompt text and session identity never
 * enter the tracker.
 */
export class ChatInputLatencyTracker {
	private readonly now: () => number;
	private readonly sampleIntervalMs: number;
	private readonly timeoutMs: number;
	private readonly maxSamples: number;
	private active: ActiveSample | null = null;
	private readonly completed: CompletedSample[] = [];
	private lastSampleAt = Number.NEGATIVE_INFINITY;
	private nextSequence = 1;

	constructor(options: ChatInputLatencyOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.sampleIntervalMs = finiteNonNegative(
			options.sampleIntervalMs,
			DEFAULT_SAMPLE_INTERVAL_MS,
		);
		this.timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
		this.maxSamples = Math.max(
			1,
			Math.floor(finitePositive(options.maxSamples, DEFAULT_MAX_SAMPLES)),
		);
	}

	beginInput(): ChatInputLatencyHandle | undefined {
		const now = this.now();
		this.expireStale(now);
		if (this.active || now - this.lastSampleAt < this.sampleIntervalMs) {
			return undefined;
		}
		this.lastSampleAt = now;
		this.active = {
			sequence: this.nextSequence++,
			startedAt: now,
			committedAt: null,
			frameAt: null,
			commitMs: null,
			commitToFrameMs: null,
			frameToPostPaintMs: null,
			paintMs: null,
			commitToPaintMs: null,
			outcome: "complete",
		};
		return { sequence: this.active.sequence };
	}

	markCommitted(handle: ChatInputLatencyHandle): boolean {
		const sample = this.match(handle);
		if (!sample || sample.committedAt !== null) return false;
		const now = this.now();
		sample.committedAt = now;
		sample.commitMs = Math.max(0, now - sample.startedAt);
		return true;
	}

	markFrame(handle: ChatInputLatencyHandle): boolean {
		const sample = this.match(handle);
		if (!sample || sample.committedAt === null || sample.frameAt !== null) {
			return false;
		}
		const now = this.now();
		if (now < sample.committedAt) return false;
		sample.frameAt = now;
		sample.commitToFrameMs = now - sample.committedAt;
		return true;
	}

	markPaint(handle: ChatInputLatencyHandle): void {
		const sample = this.match(handle);
		if (
			!sample ||
			sample.committedAt === null ||
			sample.frameAt === null
		) {
			return;
		}
		const now = this.now();
		if (now < sample.frameAt) return;
		sample.paintMs = Math.max(0, now - sample.startedAt);
		sample.commitToPaintMs = Math.max(0, now - sample.committedAt);
		sample.frameToPostPaintMs = now - sample.frameAt;
		this.complete(sample, now);
	}

	cancel(handle: ChatInputLatencyHandle): void {
		if (this.match(handle)) this.active = null;
	}

	resetMeasurements(): void {
		this.active = null;
		this.completed.length = 0;
		this.lastSampleAt = Number.NEGATIVE_INFINITY;
		this.nextSequence = 1;
	}

	snapshot(): ChatInputLatencySnapshot {
		const now = this.now();
		this.expireStale(now);
		const latest = this.completed[this.completed.length - 1];
		return {
			samples: this.completed.map(({ sample }) => ({ ...sample })),
			inFlightCount: this.active ? 1 : 0,
			latestSampleAgeMs: latest ? Math.max(0, now - latest.completedAt) : null,
		};
	}

	private match(handle: ChatInputLatencyHandle): ActiveSample | undefined {
		return this.active?.sequence === handle.sequence ? this.active : undefined;
	}

	private expireStale(now: number): void {
		if (!this.active || now - this.active.startedAt < this.timeoutMs) return;
		this.active.outcome = "timed_out";
		this.complete(this.active, now);
	}

	private complete(sample: ActiveSample, completedAt: number): void {
		if (this.active !== sample) return;
		this.active = null;
		const completed: ChatInputLatencySample = {
			sequence: sample.sequence,
			startedAt: sample.startedAt,
			commitMs: sample.commitMs,
			commitToFrameMs: sample.commitToFrameMs,
			frameToPostPaintMs: sample.frameToPostPaintMs,
			paintMs: sample.paintMs,
			commitToPaintMs: sample.commitToPaintMs,
			outcome: sample.outcome,
		};
		this.completed.push({ sample: completed, completedAt });
		if (this.completed.length > this.maxSamples) this.completed.shift();
	}
}

function finiteNonNegative(
	value: number | undefined,
	fallback: number,
): number {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

export const chatInputLatency = new ChatInputLatencyTracker();
