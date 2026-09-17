import {
	type FrameBudgetScheduler,
	getFrameBudgetScheduler,
} from "@/lib/scheduling/frameBudgetScheduler";
import { noteUserInput } from "@/lib/scheduling/interactionSignals";
import { schedulePostPaint } from "@/lib/scheduling/postPaint";
import { projectTerminalDeliveryTiming } from "../qa/terminalDeliveryTiming";
import type { TerminalReplicaTiming } from "../terminalDeliveryTimingFacts";

type TerminalInputLatencyOutcome =
	| "complete"
	| "correlation_superseded"
	| "failed"
	| "timed_out";

export interface TerminalInputLatencySample {
	sequence: number;
	terminalId: string;
	desktopId: string | null;
	source: "keydown" | "input";
	startedAt: number;
	dispatchMs: number;
	captureToSemanticHandlerMs: number | null;
	semanticHandlerToDispatchMs: number | null;
	semanticHandlerToDecisionMs: number | null;
	semanticDecisionToDispatchMs: number | null;
	replacementChainActiveAtCapture: boolean | null;
	transportConfirmationMs: number | null;
	hostReceiptBeforeTransportConfirmation: boolean | null;
	hostReceiptMs: number | null;
	successorOutputObserved: boolean;
	hostInputAcceptedToOutputMs: number | null;
	hostOutputToProjectionStartMs: number | null;
	outputReceivedMs: number | null;
	carrierFirstResolvedMs?: number;
	carrierLastResolvedMs?: number;
	carrierDecodeStartedMs?: number;
	carrierDecodedMs?: number;
	carrierDecodeWorkMs?: number;
	carrierPartCount?: number;
	carrierBytes?: number;
	replicaApplyStartedMs?: number;
	replicaAppliedMs?: number;
	projectionStartedMs: number | null;
	projectionCommittedMs: number | null;
	echoTaskMs: number | null;
	echoFrameMs: number | null;
	frameBeforeTask: boolean | null;
	/** Shared work completed only when the task probe precedes the frame probe. */
	taskToFrameSchedulerActivity: TerminalInputSchedulerActivity | null;
	echoPaintMs: number | null;
	receiptToOutputMs: number | null;
	outputToPaintMs: number | null;
	receiptToPaintMs: number | null;
	outcome: TerminalInputLatencyOutcome;
}

interface TerminalInputSchedulerActivity {
	unitsRun: number;
	msSpent: number;
	terminalPresentationUnitsRun: number;
	terminalPresentationMsSpent: number;
}

export interface TerminalInputLatencySnapshot {
	samples: readonly TerminalInputLatencySample[];
	inFlightCount: number;
}

export interface TerminalInputLatencyHandle {
	readonly sequence: number;
	readonly terminalId: string;
}

interface ActiveSample extends TerminalInputLatencySample {
	dispatchedAt: number;
	paintPending: boolean;
	outputReceivedAt: number | null;
	earlyEchoPaintAt: number | null;
	schedulerActivityAtTask: SchedulerActivityReading | null;
}

interface SchedulerActivityReading {
	scheduler: FrameBudgetScheduler;
	activity: TerminalInputSchedulerActivity;
}

interface PendingSemanticDecision {
	readonly kind: "semantic" | "native_text";
	readonly at: number;
}

interface PendingInputIntent {
	startedAt: number;
	source: TerminalInputLatencySample["source"];
	bypassSamplingThrottle: boolean;
	semanticHandlerStartedAt: number | null;
	semanticDecision: PendingSemanticDecision | null;
	replacementChainActiveAtCapture: boolean | null;
}

interface TerminalInputLatencyOptions {
	now?: () => number;
	sampleIntervalMs?: number;
	keydownWindowMs?: number;
	timeoutMs?: number;
	maxSamples?: number;
}

interface TerminalBrowserInputSample {
	terminalId: string;
	at: number;
	type: string;
	keyKind: "text" | "space" | "editing" | "ime" | "other" | null;
	inputType: string | null;
	isComposing: boolean | null;
	defaultPrevented: boolean;
	focused: boolean;
	valueLength: number;
}

function browserKeyKind(event: KeyboardEvent): TerminalBrowserInputSample["keyKind"] {
	if (event.keyCode === 229 || event.key === "Process") return "ime";
	if (event.key === " ") return "space";
	if (event.key.length === 1) return "text";
	if (event.key === "Backspace" || event.key === "Delete") return "editing";
	return "other";
}

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_KEYDOWN_WINDOW_MS = 250;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_SAMPLES = 128;
const TERMINAL_PRESENTATION_SOURCE = "structured-terminal-presentation";

/**
 * Samples the real focused-terminal input path without retaining input bytes.
 * Only one input per terminal is measured at a time and sampling is rate
 * limited, so receipt confirmation cannot turn ordinary typing into an
 * unbounded waiter workload.
 */
export class TerminalInputLatencyTracker {
	private readonly now: () => number;
	private readonly sampleIntervalMs: number;
	private readonly keydownWindowMs: number;
	private readonly timeoutMs: number;
	private readonly maxSamples: number;
	private readonly pendingIntents = new Map<string, PendingInputIntent>();
	private readonly lastSampleAt = new Map<string, number>();
	private readonly active = new Map<string, ActiveSample>();
	private readonly samples: TerminalInputLatencySample[] = [];
	private readonly browserInputs: TerminalBrowserInputSample[] = [];
	private nextSequence = 1;

	constructor(options: TerminalInputLatencyOptions = {}) {
		this.now = options.now ?? (() => performance.now());
		this.sampleIntervalMs = finiteNonNegative(
			options.sampleIntervalMs,
			DEFAULT_SAMPLE_INTERVAL_MS,
		);
		this.keydownWindowMs = finiteNonNegative(
			options.keydownWindowMs,
			DEFAULT_KEYDOWN_WINDOW_MS,
		);
		this.timeoutMs = finitePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
		this.maxSamples = Math.max(
			1,
			Math.floor(finitePositive(options.maxSamples, DEFAULT_MAX_SAMPLES)),
		);
	}

	noteKeydown(
		terminalId: string,
		replacementChainActiveAtCapture = false,
	) {
		this.noteIntent(
			terminalId,
			"keydown",
			false,
			replacementChainActiveAtCapture,
		);
	}

	/** Observe delivery before dispatch without retaining keys, text, or DOM nodes. */
	noteBrowserInput(terminalId: string, event: Event) {
		const host = event.currentTarget as HTMLTextAreaElement;
		const keyboard = event.type === "keydown" ? (event as KeyboardEvent) : null;
		const input =
			event.type === "input" || event.type === "beforeinput"
				? (event as InputEvent)
				: null;
		this.browserInputs.push({
			terminalId,
			at: this.now(),
			type: event.type,
			keyKind: keyboard ? browserKeyKind(keyboard) : null,
			inputType: input?.inputType ?? null,
			isComposing: (input ?? keyboard)?.isComposing ?? null,
			defaultPrevented: event.defaultPrevented,
			focused: host.ownerDocument.activeElement === host,
			valueLength: host.value.length,
		});
		if (this.browserInputs.length > this.maxSamples) this.browserInputs.shift();
	}

	browserInputSnapshot(terminalId: string): readonly TerminalBrowserInputSample[] {
		return this.browserInputs
			.filter((sample) => sample.terminalId === terminalId)
			.map((sample) => ({ ...sample }));
	}

	markSemanticKeydown(terminalId: string) {
		const intent = this.pendingIntents.get(terminalId);
		if (
			intent?.source !== "keydown" ||
			intent.semanticHandlerStartedAt !== null
		) {
			return;
		}
		intent.semanticHandlerStartedAt = this.now();
	}

	markSemanticKeydownDecision(terminalId: string) {
		const intent = this.pendingIntents.get(terminalId);
		if (
			intent?.source !== "keydown" ||
			intent.semanticHandlerStartedAt === null ||
			intent.semanticDecision !== null
		) {
			return;
		}
		intent.semanticDecision = { kind: "semantic", at: this.now() };
	}

	markNativeTextInputExpected(terminalId: string) {
		const intent = this.pendingIntents.get(terminalId);
		if (
			intent?.source !== "keydown" ||
			intent.semanticHandlerStartedAt === null ||
			intent.semanticDecision !== null
		) {
			return;
		}
		intent.semanticDecision = { kind: "native_text", at: this.now() };
	}

	/** Explicit non-keyboard intent such as paste or an IME replacement. */
	noteInput(
		terminalId: string,
		options: { bypassSamplingThrottle?: boolean } = {},
	) {
		this.noteIntent(
			terminalId,
			"input",
			options.bypassSamplingThrottle ?? false,
			null,
		);
	}

	/** Continues a printable keydown completed by the browser's native text path. */
	noteNativeTextInput(terminalId: string) {
		const intent = this.pendingIntents.get(terminalId);
		if (
			intent?.source === "keydown" &&
			intent.semanticHandlerStartedAt !== null &&
			intent.semanticDecision?.kind === "native_text" &&
			this.now() - intent.startedAt <= this.keydownWindowMs
		) {
			return;
		}
		this.noteInput(terminalId);
	}

	beginInput(input: {
		terminalId: string;
		desktopId?: string;
		/** Trusted semantic user-input boundary when no earlier DOM marker exists. */
		fallbackSource?: TerminalInputLatencySample["source"];
	}): TerminalInputLatencyHandle | undefined {
		const now = this.now();
		this.expireStale(now);
		let intent = this.pendingIntents.get(input.terminalId);
		this.pendingIntents.delete(input.terminalId);
		// xterm's onData also carries automatic terminal-protocol replies (DA,
		// DSR, cursor reports). Only data preceded by a real DOM user intent is
		// input latency; treating protocol traffic as typing both corrupts the
		// metric and keeps the global interaction scheduler permanently paused.
		if (!intent && input.fallbackSource) {
			noteUserInput();
			intent = {
				startedAt: now,
				source: input.fallbackSource,
				bypassSamplingThrottle: false,
				semanticHandlerStartedAt: null,
				semanticDecision: null,
				replacementChainActiveAtCapture: null,
			};
		}
		if (!intent) return undefined;
		if (this.active.has(input.terminalId)) return undefined;
		const lastSampleAt = this.lastSampleAt.get(input.terminalId);
		if (
			!intent.bypassSamplingThrottle &&
			lastSampleAt !== undefined &&
			now - lastSampleAt < this.sampleIntervalMs
		) {
			return undefined;
		}
		const startedAt = intent.startedAt;
		const semanticHandlerStartedAt = intent.semanticHandlerStartedAt;
		const semanticDecisionAt = intent.semanticDecision?.at ?? null;
		const sample: ActiveSample = {
			sequence: this.nextSequence++,
			terminalId: input.terminalId,
			desktopId: input.desktopId ?? null,
			source: intent.source,
			startedAt,
			dispatchedAt: now,
			paintPending: false,
			outputReceivedAt: null,
			earlyEchoPaintAt: null,
			schedulerActivityAtTask: null,
			dispatchMs: Math.max(0, now - startedAt),
			captureToSemanticHandlerMs:
				semanticHandlerStartedAt === null
					? null
					: Math.max(0, semanticHandlerStartedAt - startedAt),
			semanticHandlerToDispatchMs:
				semanticHandlerStartedAt === null
					? null
					: Math.max(0, now - semanticHandlerStartedAt),
			semanticHandlerToDecisionMs:
				semanticHandlerStartedAt === null || semanticDecisionAt === null
					? null
					: Math.max(0, semanticDecisionAt - semanticHandlerStartedAt),
			semanticDecisionToDispatchMs:
				semanticDecisionAt === null
					? null
					: Math.max(0, now - semanticDecisionAt),
			replacementChainActiveAtCapture:
				intent.replacementChainActiveAtCapture,
			transportConfirmationMs: null,
			hostReceiptBeforeTransportConfirmation: null,
			hostReceiptMs: null,
			successorOutputObserved: false,
			hostInputAcceptedToOutputMs: null,
			hostOutputToProjectionStartMs: null,
			outputReceivedMs: null,
			projectionStartedMs: null,
			projectionCommittedMs: null,
			echoTaskMs: null,
			echoFrameMs: null,
			frameBeforeTask: null,
			taskToFrameSchedulerActivity: null,
			echoPaintMs: null,
			receiptToOutputMs: null,
			outputToPaintMs: null,
			receiptToPaintMs: null,
			outcome: "complete",
		};
		this.lastSampleAt.set(input.terminalId, now);
		this.active.set(input.terminalId, sample);
		return { sequence: sample.sequence, terminalId: sample.terminalId };
	}

	markHostReceipt(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample || sample.hostReceiptMs !== null) return;
		sample.hostReceiptMs = Math.max(0, this.now() - sample.startedAt);
		this.updateTransportOrdering(sample);
		this.updateOutputSegments(sample);
		if (sample.earlyEchoPaintAt !== null) {
			sample.echoPaintMs = Math.max(
				0,
				sample.earlyEchoPaintAt - sample.startedAt,
			);
			sample.receiptToPaintMs = Math.max(
				0,
				sample.echoPaintMs - sample.hostReceiptMs,
			);
			this.updateOutputSegments(sample);
			this.complete(sample);
		}
	}

	/** Records when the existing native upstream command confirms queue admission. */
	markTransportConfirmation(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample || sample.transportConfirmationMs !== null) return;
		sample.transportConfirmationMs = Math.max(
			0,
			this.now() - sample.startedAt,
		);
		this.updateTransportOrdering(sample);
	}

	/** Records content-free durations measured on the Host's monotonic clock. */
	markHostInputOutputTiming(
		handle: TerminalInputLatencyHandle,
		timing: {
			readonly inputAcceptedToOutputMs: number;
			readonly outputToProjectionStartMs: number;
		},
	) {
		const sample = this.match(handle);
		if (
			!sample ||
			sample.hostInputAcceptedToOutputMs !== null ||
			!Number.isFinite(timing.inputAcceptedToOutputMs) ||
			timing.inputAcceptedToOutputMs < 0 ||
			!Number.isFinite(timing.outputToProjectionStartMs) ||
			timing.outputToProjectionStartMs < 0
		) {
			return;
		}
		sample.hostInputAcceptedToOutputMs = timing.inputAcceptedToOutputMs;
		sample.hostOutputToProjectionStartMs =
			timing.outputToProjectionStartMs;
	}

	/** Records only that the Host output high-water advanced past dispatch. */
	markSuccessorOutputObserved(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample) return;
		sample.successorOutputObserved = true;
	}

	/** Separates replaceable Host timing loss from a true no-successor timeout. */
	markCorrelationSuperseded(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (
			!sample?.successorOutputObserved ||
			sample.hostReceiptMs === null
		) {
			return;
		}
		sample.outcome = "correlation_superseded";
		this.complete(sample);
	}

	/** Reads the existing sample without allocating a snapshot or a new registry. */
	deliverySampleSequence(terminalId: string): number | undefined {
		if (import.meta.env.MODE !== "perf") return undefined;
		const sample = this.active.get(terminalId);
		if (!sample || sample.outputReceivedAt !== null) return undefined;
		return this.now() - sample.dispatchedAt < this.timeoutMs
			? sample.sequence
			: undefined;
	}

	/** Records an accepted frame after decode/replica work, before DOM admission. */
	markOutputReceived(terminalId: string, deliveryTiming?: TerminalReplicaTiming) {
		const sample = this.active.get(terminalId);
		if (!sample || sample.outputReceivedAt !== null) return;
		if (import.meta.env.MODE === "perf" && deliveryTiming) {
			Object.assign(
				sample,
				projectTerminalDeliveryTiming(deliveryTiming, sample.sequence, sample.startedAt),
			);
		}
		sample.successorOutputObserved = true;
		sample.outputReceivedAt = this.now();
		sample.outputReceivedMs = Math.max(
			0,
			sample.outputReceivedAt - sample.startedAt,
		);
		this.updateOutputSegments(sample);
	}

	/** Records one ordered DOM projection without changing paint ownership. */
	markProjectionCommitted(
		handle: TerminalInputLatencyHandle,
		timing: {
			readonly projectionStartedAt: number;
			readonly projectionCommittedAt: number;
		},
	) {
		const sample = this.match(handle);
		if (
			!sample ||
			sample.outputReceivedAt === null ||
			sample.projectionStartedMs !== null ||
			!Number.isFinite(timing.projectionStartedAt) ||
			!Number.isFinite(timing.projectionCommittedAt) ||
			timing.projectionStartedAt < sample.outputReceivedAt ||
			timing.projectionCommittedAt < timing.projectionStartedAt
		) {
			return;
		}
		sample.projectionStartedMs = timing.projectionStartedAt - sample.startedAt;
		sample.projectionCommittedMs =
			timing.projectionCommittedAt - sample.startedAt;
	}

	/** Claims one browser paint after xterm commits output following Host receipt. */
	claimOutputPaint(terminalId: string) {
		const sample = this.active.get(terminalId);
		// A renderer commit can belong to hydration or an earlier snapshot. It is
		// evidence for this input only after the transport has delivered output
		// observed after the input dispatch.
		if (!sample || sample.paintPending || sample.outputReceivedAt === null) return;
		sample.paintPending = true;
		return { sequence: sample.sequence, terminalId: sample.terminalId };
	}

	/** Records shared browser-task availability independently of frame eligibility. */
	markOutputTask(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample?.paintPending || sample.echoTaskMs !== null) return;
		const now = this.now();
		if (now < sample.dispatchedAt) return;
		sample.echoTaskMs = Math.max(0, now - sample.startedAt);
		if (sample.echoFrameMs !== null) {
			sample.frameBeforeTask = true;
			return;
		}
		sample.schedulerActivityAtTask = readSchedulerActivity();
	}

	/** Records the rendering callback that follows the correlated DOM commit. */
	markOutputFrame(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample?.paintPending || sample.echoFrameMs !== null) return;
		const now = this.now();
		if (now < sample.dispatchedAt) return;
		sample.echoFrameMs = Math.max(0, now - sample.startedAt);
		if (sample.echoTaskMs !== null) {
			sample.frameBeforeTask = false;
			if (sample.schedulerActivityAtTask !== null) {
				const currentActivity = readSchedulerActivity();
				if (
					sample.schedulerActivityAtTask.scheduler ===
					currentActivity.scheduler
				) {
					sample.taskToFrameSchedulerActivity = schedulerActivityDelta(
						sample.schedulerActivityAtTask.activity,
						currentActivity.activity,
					);
				}
			}
		}
	}

	markOutputPaint(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample?.paintPending) return;
		const now = this.now();
		if (now < sample.dispatchedAt) return;
		if (sample.hostReceiptMs === null) {
			sample.earlyEchoPaintAt = now;
			sample.paintPending = false;
			return;
		}
		sample.echoPaintMs = Math.max(0, now - sample.startedAt);
		sample.receiptToPaintMs = Math.max(
			0,
			sample.echoPaintMs - sample.hostReceiptMs,
		);
		this.updateOutputSegments(sample);
		this.complete(sample);
	}

	markFailed(handle: TerminalInputLatencyHandle) {
		const sample = this.match(handle);
		if (!sample) return;
		sample.outcome = "failed";
		this.complete(sample);
	}

	cancelTerminal(terminalId: string) {
		this.pendingIntents.delete(terminalId);
		this.active.delete(terminalId);
	}

	/** Starts a new measurement phase after an explicit benchmark warm-up. */
	resetMeasurements() {
		this.pendingIntents.clear();
		this.lastSampleAt.clear();
		this.active.clear();
		this.samples.length = 0;
		this.browserInputs.length = 0;
		this.nextSequence = 1;
	}

	snapshot(): TerminalInputLatencySnapshot {
		this.expireStale(this.now());
		return {
			samples: this.samples.map((sample) => ({ ...sample })),
			inFlightCount: this.active.size,
		};
	}

	private match(handle: TerminalInputLatencyHandle) {
		const sample = this.active.get(handle.terminalId);
		return sample?.sequence === handle.sequence ? sample : undefined;
	}

	private expireStale(now: number) {
		for (const sample of this.active.values()) {
			if (now - sample.dispatchedAt < this.timeoutMs) continue;
			sample.outcome = "timed_out";
			this.complete(sample);
		}
		for (const [terminalId, intent] of this.pendingIntents) {
			// Keydown correlation is browser-event-local. Explicit input can own
			// asynchronous clipboard work, so it shares the active sample lifetime.
			const lifetimeMs =
				intent.source === "keydown" ? this.keydownWindowMs : this.timeoutMs;
			if (now - intent.startedAt > lifetimeMs) {
				this.pendingIntents.delete(terminalId);
			}
		}
	}

	private noteIntent(
		terminalId: string,
		source: TerminalInputLatencySample["source"],
		bypassSamplingThrottle = false,
		replacementChainActiveAtCapture: boolean | null = null,
	) {
		// This is the single boundary where actual user intent reaches both the
		// latency tracker and the shared foreground scheduler.
		noteUserInput();
		this.pendingIntents.set(terminalId, {
			startedAt: this.now(),
			source,
			bypassSamplingThrottle,
			semanticHandlerStartedAt: null,
			semanticDecision: null,
			replacementChainActiveAtCapture,
		});
	}

	private complete(sample: ActiveSample) {
		if (this.active.get(sample.terminalId) !== sample) return;
		this.active.delete(sample.terminalId);
		const {
			dispatchedAt: _,
			paintPending: __,
			outputReceivedAt: ___,
			earlyEchoPaintAt: ____,
			schedulerActivityAtTask: _____,
			...completed
		} = sample;
		this.samples.push(completed);
		if (this.samples.length > this.maxSamples) this.samples.shift();
	}

	private updateOutputSegments(sample: ActiveSample) {
		if (sample.outputReceivedMs === null) return;
		if (sample.hostReceiptMs !== null) {
			sample.receiptToOutputMs = Math.max(
				0,
				sample.outputReceivedMs - sample.hostReceiptMs,
			);
		}
		if (sample.echoPaintMs !== null) {
			sample.outputToPaintMs = Math.max(
				0,
				sample.echoPaintMs - sample.outputReceivedMs,
			);
		}
	}

	private updateTransportOrdering(sample: ActiveSample) {
		if (
			sample.transportConfirmationMs === null ||
			sample.hostReceiptMs === null
		) {
			return;
		}
		sample.hostReceiptBeforeTransportConfirmation =
			sample.hostReceiptMs < sample.transportConfirmationMs;
	}
}

function finiteNonNegative(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value >= 0
		? value
		: fallback;
}

function finitePositive(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0
		? value
		: fallback;
}

function readSchedulerActivity(): SchedulerActivityReading {
	const scheduler = getFrameBudgetScheduler();
	const telemetry = scheduler.getTelemetry();
	const activity: TerminalInputSchedulerActivity = {
		unitsRun: 0,
		msSpent: 0,
		terminalPresentationUnitsRun: 0,
		terminalPresentationMsSpent: 0,
	};
	for (const lane of Object.values(telemetry)) {
		activity.unitsRun += lane.unitsRun;
		activity.msSpent += lane.msSpent;
		for (const [source, sourceActivity] of Object.entries(lane.sources)) {
			if (
				source !== TERMINAL_PRESENTATION_SOURCE &&
				!source.startsWith(`${TERMINAL_PRESENTATION_SOURCE}.`)
			) {
				continue;
			}
			activity.terminalPresentationUnitsRun += sourceActivity.unitsRun;
			activity.terminalPresentationMsSpent += sourceActivity.msSpent;
		}
	}
	return { scheduler, activity };
}

function schedulerActivityDelta(
	start: TerminalInputSchedulerActivity,
	end: TerminalInputSchedulerActivity,
): TerminalInputSchedulerActivity | null {
	if (
		end.unitsRun < start.unitsRun ||
		end.msSpent < start.msSpent ||
		end.terminalPresentationUnitsRun < start.terminalPresentationUnitsRun ||
		end.terminalPresentationMsSpent < start.terminalPresentationMsSpent
	) {
		return null;
	}
	return {
		unitsRun: end.unitsRun - start.unitsRun,
		msSpent: end.msSpent - start.msSpent,
		terminalPresentationUnitsRun:
			end.terminalPresentationUnitsRun - start.terminalPresentationUnitsRun,
		terminalPresentationMsSpent:
			end.terminalPresentationMsSpent - start.terminalPresentationMsSpent,
	};
}

export const terminalInputLatency = new TerminalInputLatencyTracker();

export function markTerminalOutputReceived(
	terminalId: string,
	deliveryTiming?: TerminalReplicaTiming,
) {
	if (import.meta.env.MODE === "perf") {
		terminalInputLatency.markOutputReceived(terminalId, deliveryTiming);
	} else {
		terminalInputLatency.markOutputReceived(terminalId);
	}
}

/** Schedules at most one real paint probe for the active sample. */
export function markTerminalOutputCommitted(
	terminalId: string,
	onPaint?: (handle: TerminalInputLatencyHandle) => void,
) {
	const handle = terminalInputLatency.claimOutputPaint(terminalId);
	if (!handle) return;
	schedulePostPaint(
		window,
		() => {
			terminalInputLatency.markOutputPaint(handle);
			onPaint?.(handle);
		},
		{
			onTask: () => {
				terminalInputLatency.markOutputTask(handle);
			},
			onFrame: () => {
				terminalInputLatency.markOutputFrame(handle);
			},
		},
	);
	return handle;
}
