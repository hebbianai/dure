export interface WindowEventLoopLagSnapshot {
	visible: boolean;
	focused: boolean;
	contextChangedAtMs: number;
	lastSampleAtMs: number | null;
	sampleCount: number;
	recentP95Ms: number | null;
	recentMaxMs: number | null;
}

const SAMPLE_INTERVAL_MS = 250;
const MAX_SAMPLES = 64;

interface WindowEventLoopContext {
	readonly visible: boolean;
	readonly focused: boolean;
}

interface WindowEventLoopLagSample {
	readonly observedAtMs: number;
	readonly lagMs: number;
}

function percentile95(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

export class WindowEventLoopLagTracker {
	private readonly samples: WindowEventLoopLagSample[] = [];
	private initialized = false;
	private visible = false;
	private focused = false;
	private contextChangedAtMs = 0;
	private lastSampleAtMs: number | null = null;
	private expectedAtMs: number | null = null;

	begin(
		context: WindowEventLoopContext,
		monotonicNowMs: number,
		epochNowMs: number,
	): void {
		this.samples.length = 0;
		this.initialized = true;
		this.visible = context.visible;
		this.focused = context.focused;
		this.contextChangedAtMs = epochNowMs;
		this.lastSampleAtMs = null;
		this.expectedAtMs =
			context.visible && context.focused
				? monotonicNowMs + SAMPLE_INTERVAL_MS
				: null;
	}

	record(delayMs: number, observedAtMs: number): void {
		if (!Number.isFinite(delayMs) || !Number.isFinite(observedAtMs)) return;
		this.samples.push({
			lagMs: Math.max(0, delayMs),
			observedAtMs,
		});
		if (this.samples.length > MAX_SAMPLES) this.samples.shift();
		this.lastSampleAtMs = observedAtMs;
	}

	noteContext(
		context: WindowEventLoopContext,
		monotonicNowMs: number,
		epochNowMs: number,
	): boolean {
		if (!this.initialized) {
			this.begin(context, monotonicNowMs, epochNowMs);
			return true;
		}
		if (context.visible === this.visible && context.focused === this.focused) {
			return false;
		}
		const wasForeground = this.visible && this.focused;
		this.visible = context.visible;
		this.focused = context.focused;
		this.contextChangedAtMs = epochNowMs;
		this.expectedAtMs = null;
		if (!wasForeground && this.visible && this.focused) {
			this.samples.length = 0;
			this.lastSampleAtMs = null;
		}
		return true;
	}

	sample(
		context: WindowEventLoopContext,
		monotonicNowMs: number,
		epochNowMs: number,
	): void {
		if (this.noteContext(context, monotonicNowMs, epochNowMs)) {
			if (this.visible && this.focused) {
				this.expectedAtMs = monotonicNowMs + SAMPLE_INTERVAL_MS;
			}
			return;
		}
		if (!this.visible || !this.focused) {
			this.expectedAtMs = null;
			return;
		}
		if (this.expectedAtMs === null) {
			this.expectedAtMs = monotonicNowMs + SAMPLE_INTERVAL_MS;
			return;
		}
		// The interval owns the cadence. Skipping an early callback turns normal
		// timer jitter into a false full-interval stall on the next callback.
		this.record(monotonicNowMs - this.expectedAtMs, epochNowMs);
		this.expectedAtMs = monotonicNowMs + SAMPLE_INTERVAL_MS;
	}

	snapshot(): WindowEventLoopLagSnapshot {
		const lags = this.samples.map((sample) => sample.lagMs);
		return {
			visible: this.visible,
			focused: this.focused,
			contextChangedAtMs: this.contextChangedAtMs,
			lastSampleAtMs: this.lastSampleAtMs,
			sampleCount: this.samples.length,
			recentP95Ms: percentile95(lags),
			recentMaxMs: this.samples.length === 0 ? null : Math.max(...lags),
		};
	}
}

const tracker = new WindowEventLoopLagTracker();
let installedMonitor: { readonly timer: number } | undefined;

function currentContext(): WindowEventLoopContext {
	return {
		visible: document.visibilityState === "visible",
		focused: document.hasFocus(),
	};
}

function epochTime(monotonicNowMs: number): number {
	return performance.timeOrigin + monotonicNowMs;
}

export function installWindowEventLoopLagMonitor(): () => void {
	if (installedMonitor) return () => {};
	const beginAt = performance.now();
	tracker.begin(currentContext(), beginAt, epochTime(beginAt));
	const noteContext = () => {
		const now = performance.now();
		tracker.noteContext(currentContext(), now, epochTime(now));
	};
	document.addEventListener("visibilitychange", noteContext);
	window.addEventListener("focus", noteContext);
	window.addEventListener("blur", noteContext);
	const monitor = {
		timer: window.setInterval(() => {
			const now = performance.now();
			tracker.sample(currentContext(), now, epochTime(now));
		}, SAMPLE_INTERVAL_MS),
	};
	installedMonitor = monitor;
	return () => {
		if (installedMonitor !== monitor) return;
		window.clearInterval(monitor.timer);
		installedMonitor = undefined;
		document.removeEventListener("visibilitychange", noteContext);
		window.removeEventListener("focus", noteContext);
		window.removeEventListener("blur", noteContext);
	};
}

export function readWindowEventLoopLag(): WindowEventLoopLagSnapshot {
	const now = performance.now();
	tracker.noteContext(currentContext(), now, epochTime(now));
	return tracker.snapshot();
}
