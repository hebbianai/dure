/**
 * The unattended sweep that keeps every paired box's `hmux` current
 * (`useFleetHmuxCurrency`) used to visit boxes one after another, starting
 * the moment the host set was known. Each visit is at least two SSH round
 * trips, and an unreachable box holds its turn for the full connect timeout,
 * so a laptop that moved networks was waited on before any other box was
 * looked at — and the sweep competed with the panes attaching on the same
 * startup.
 */

/** Boxes visited at once. Enough to hide one unreachable box; few enough
 * that the sweep never rivals the panes a person is actually opening. */
export const FLEET_SWEEP_CONCURRENCY = 3;

/** How long after the host set settles the sweep begins. Startup attaches
 * get the connection budget first; currency can wait a few seconds. */
export const FLEET_SWEEP_START_DELAY_MS = 5_000;

export interface FleetSweepOptions {
	concurrency: number;
	/** Whether this pass is still the one that should be running. Checked
	 * before each visit; a stale pass stops taking new boxes. */
	isCurrent: () => boolean;
}

/**
 * Visit every item with at most `concurrency` visits in flight, abandoning
 * items not yet started once the pass is stale. A visit's rejection ends
 * only that visit.
 */
export async function sweepFleet<T>(
	items: readonly T[],
	visit: (item: T) => Promise<void>,
	options: FleetSweepOptions,
): Promise<void> {
	const workers = Math.max(1, Math.min(options.concurrency, items.length));
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			if (!options.isCurrent()) return;
			const item = items[next];
			next += 1;
			try {
				await visit(item);
			} catch {
				// The box is unreachable or refused; the pairing screen is where
				// somebody who is watching reads the reason.
			}
		}
	};
	await Promise.all(Array.from({ length: workers }, worker));
}
