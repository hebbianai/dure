/**
 * Coalescing for a question every remote pane asks before it attaches:
 * "is this box's host key enrolled".
 *
 * A workspace with four remote panes asked it four times within the same
 * few hundred milliseconds — four `ssh-keygen` processes for one answer.
 * Identical questions in flight now share one answer. Nothing is kept once
 * it settles: a settled answer may predate the mutation the next asker just
 * made, and the pane that asks last must see the box as it is now.
 */

export class RemoteHmuxRequestCoalescer<V> {
	private readonly inFlight = new Map<string, Promise<V>>();

	run(key: string, request: () => Promise<V>): Promise<V> {
		const existing = this.inFlight.get(key);
		if (existing) return existing;
		const promise = request();
		this.inFlight.set(key, promise);
		const settled = () => {
			if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
		};
		promise.then(settled, settled);
		return promise;
	}
}

/** The unit separator cannot appear in a host name, id or port. */
export function remoteHmuxHostRequestKey(
	parts: readonly (string | number)[],
): string {
	return parts.map(String).join("");
}
