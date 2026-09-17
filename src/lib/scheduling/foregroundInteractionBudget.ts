export type ForegroundInteractionKind =
	| "input"
	| "desktop-switch-start"
	| "desktop-switch-settled";

export interface ForegroundInteractionBudgetHost {
	now(): number;
}

export interface ForegroundInteractionBudgetOptions {
	inputPauseMs: number;
	desktopSwitchPauseMaxMs: number;
	desktopSwitchSettleTailMs: number;
}

const DEFAULT_OPTIONS: ForegroundInteractionBudgetOptions = {
	inputPauseMs: 100,
	desktopSwitchPauseMaxMs: 2_000,
	desktopSwitchSettleTailMs: 250,
};

/**
 * Single renderer-local authority for the period in which background work
 * must yield to focus, input, or a workspace transition.
 *
 * Consumers keep their own queue policy. This object owns only the shared
 * interaction deadline, so adding another background producer does not create
 * another subtly different pause clock.
 */
export class ForegroundInteractionBudget {
	private pauseUntilMs = 0;
	private readonly listeners = new Set<() => void>();
	private readonly options: ForegroundInteractionBudgetOptions;

	constructor(
		private readonly host: ForegroundInteractionBudgetHost,
		options: Partial<ForegroundInteractionBudgetOptions> = {},
	) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	note(kind: ForegroundInteractionKind): void {
		const now = this.host.now();
		if (kind === "input") {
			this.pauseUntilMs = Math.max(
				this.pauseUntilMs,
				now + this.options.inputPauseMs,
			);
		} else if (kind === "desktop-switch-start") {
			this.pauseUntilMs = Math.max(
				this.pauseUntilMs,
				now + this.options.desktopSwitchPauseMaxMs,
			);
		} else {
			// Settling shortens the lost-signal safety ceiling to one quiet tail.
			this.pauseUntilMs = now + this.options.desktopSwitchSettleTailMs;
		}
		for (const listener of this.listeners) listener();
	}

	backgroundPauseRemainingMs(): number {
		return Math.max(0, this.pauseUntilMs - this.host.now());
	}

	isBackgroundPaused(): boolean {
		return this.backgroundPauseRemainingMs() > 0;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}

let sharedBudget: ForegroundInteractionBudget | undefined;

/** One interaction budget per renderer/WebView global. */
export function getForegroundInteractionBudget(): ForegroundInteractionBudget {
	sharedBudget ??= new ForegroundInteractionBudget({
		now: () => performance.now(),
	});
	return sharedBudget;
}

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		sharedBudget = undefined;
	});
}
