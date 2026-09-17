type MicrotaskScheduler = (operation: () => void) => void;

/** Coalesces storage events without dropping one that arrives during hydrate. */
export class DurableRehydrationCoordinator {
	private pending = false;
	private running = false;
	private disposed = false;

	constructor(
		private readonly rehydrate: () => Promise<void>,
		private readonly onError: (error: unknown) => void = () => undefined,
		private readonly schedule: MicrotaskScheduler = globalThis.queueMicrotask.bind(
			globalThis,
		),
	) {}

	request(): void {
		if (this.disposed) return;
		this.pending = true;
		if (this.running) return;
		this.running = true;
		this.schedule(() => void this.drain());
	}

	dispose(): void {
		this.disposed = true;
		this.pending = false;
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending && !this.disposed) {
				this.pending = false;
				try {
					await this.rehydrate();
				} catch (error) {
					this.onError(error);
				}
			}
		} finally {
			this.running = false;
			if (this.pending && !this.disposed) this.request();
		}
	}
}
