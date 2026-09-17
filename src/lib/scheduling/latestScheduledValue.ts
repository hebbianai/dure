export interface LatestScheduledValueOptions<T> {
	schedule(task: () => void): () => void;
	publish(value: T): void;
}

/**
 * Publishes the newest value at a caller-owned scheduling boundary.
 *
 * Pane focus, selection, and preview updates often replace one another before
 * a frame commits. Keeping the coalescing here avoids one timer/ref pair in
 * every component and makes cancellation reusable across React effect replay.
 */
export class LatestScheduledValue<T> {
	private pending: T | undefined;
	private hasPending = false;
	private cancelScheduled: (() => void) | undefined;
	private generation = 0;

	constructor(private readonly options: LatestScheduledValueOptions<T>) {}

	request(value: T): void {
		this.pending = value;
		this.hasPending = true;
		if (this.cancelScheduled) return;
		const generation = ++this.generation;
		this.cancelScheduled = this.options.schedule(() => {
			if (generation !== this.generation) return;
			this.cancelScheduled = undefined;
			if (!this.hasPending) return;
			const next = this.pending as T;
			this.pending = undefined;
			this.hasPending = false;
			this.options.publish(next);
		});
	}

	cancel(): void {
		this.generation += 1;
		this.cancelScheduled?.();
		this.cancelScheduled = undefined;
		this.pending = undefined;
		this.hasPending = false;
	}
}
