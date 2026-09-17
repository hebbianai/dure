/**
 * Module-singleton pub/sub primitives.
 *
 * ~15 lib modules each hand-rolled `const listeners = new Set()` plus
 * subscribe/publish. Two flavors cover them without over-abstracting:
 * a payload event bus, and a current-value store shaped for
 * `useSyncExternalStore` (no-arg listeners, `Object.is` equality skip).
 * Modules that project a snapshot from richer internal records keep that
 * projection local and use `createBroadcast<void>` for their listener set.
 */

export interface Broadcast<T> {
	publish(value: T): void;
	subscribe(listener: (value: T) => void): () => void;
}

export function createBroadcast<T = void>(): Broadcast<T> {
	const listeners = new Set<(value: T) => void>();
	return {
		publish(value) {
			for (const listener of listeners) listener(value);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

export interface ValueStore<T> {
	get(): T;
	/** No-op (and no notify) when the next value `Object.is` the current one. */
	set(value: T): void;
	subscribe(listener: () => void): () => void;
}

export function createValueStore<T>(initial: T): ValueStore<T> {
	let current = initial;
	const changed = createBroadcast<void>();
	return {
		get: () => current,
		set(value) {
			if (Object.is(current, value)) return;
			current = value;
			changed.publish();
		},
		subscribe: (listener) => changed.subscribe(listener),
	};
}
