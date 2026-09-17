export interface LargeViewReturnTransactionClock {
	setTimer(
		callback: () => void,
		delayMs: number,
	): ReturnType<typeof setTimeout>;
	clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: LargeViewReturnTransactionClock = {
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer) => clearTimeout(timer),
};

const LARGE_VIEW_RETURN_FAIL_OPEN_MS = 4_000;

/**
 * Drains every Host-detachment receipt reported during one mounted large-view
 * lifetime. A later successful attachment must not erase uncertainty from a
 * predecessor that failed to retire.
 */
export class LargeViewSurfaceRetirementDrain {
	private tail: Promise<void> = Promise.resolve();
	private failure: { readonly cause: unknown } | undefined;

	report(retirement: Promise<void>): void {
		const settled = retirement.catch((cause) => {
			this.failure ??= { cause };
		});
		this.tail = Promise.all([this.tail, settled]).then(() => undefined);
	}

	async wait(): Promise<void> {
		while (true) {
			const tail = this.tail;
			await tail;
			if (tail !== this.tail) continue;
			if (this.failure) throw this.failure.cause;
			return;
		}
	}
}

/**
 * Keeps the source terminal concealed while the large structured surface
 * retires and the source proposal becomes visible. Completion is
 * generation-fenced so an old receipt cannot reveal a newer transaction.
 */
export class LargeViewReturnSourceTransaction {
	private generation: string | undefined;
	private failOpenTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly visibility: {
			conceal(): void;
			reveal(): void;
		},
		private readonly clock: LargeViewReturnTransactionClock = systemClock,
		private readonly failOpenMs = LARGE_VIEW_RETURN_FAIL_OPEN_MS,
	) {
		if (failOpenMs <= 0) throw new Error("invalid large-view return fail-open");
	}

	prepare(generation: string): boolean {
		if (this.disposed || generation.length === 0) return false;
		if (this.generation === generation) return true;
		const alreadyConcealed = this.generation !== undefined;
		this.clearTimer();
		this.generation = generation;
		if (!alreadyConcealed) this.visibility.conceal();
		this.failOpenTimer = this.clock.setTimer(
			() => this.complete(generation),
			this.failOpenMs,
		);
		return true;
	}

	currentGeneration(): string | undefined {
		return this.generation;
	}

	complete(generation: string | undefined): boolean {
		if (generation === undefined || generation !== this.generation)
			return false;
		this.clearTimer();
		this.generation = undefined;
		this.visibility.reveal();
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.clearTimer();
		if (this.generation !== undefined) {
			this.generation = undefined;
			this.visibility.reveal();
		}
	}

	private clearTimer(): void {
		if (this.failOpenTimer !== undefined) {
			this.clock.clearTimer(this.failOpenTimer);
		}
		this.failOpenTimer = undefined;
	}
}
