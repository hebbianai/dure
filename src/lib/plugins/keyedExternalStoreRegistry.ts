export interface KeyedExternalStoreResource<Snapshot> {
	active: boolean;
	listeners: Set<() => void>;
	snapshot: Snapshot;
}

const NOOP = () => {};
type ResourceSeed<Resource> = Omit<Resource, "active" | "listeners">;

/** Disposal grace. Without it a resource dies the moment its last listener
 * leaves, and dockview unmounts a hidden pane before the next one mounts, so
 * every pane tab switch and every Space switch cold-started the resource
 * (foreground query plus watcher). With `graceMs`, the last unsubscribe
 * calls `suspend` at once (the consumer releases anything that costs while
 * hidden, such as a backend watcher lease) and keeps the snapshot; a
 * subscriber returning inside the grace gets `resume` instead of
 * create/start, and the resource is disposed only when the grace elapses
 * with no listener. */
export interface KeyedExternalStoreGrace<Resource> {
	graceMs: number;
	suspend?: (resource: Resource) => void;
	resume?: (resource: Resource) => void;
}

export class KeyedExternalStoreRegistry<
	Snapshot,
	Resource extends KeyedExternalStoreResource<Snapshot>,
> {
	readonly #resources = new Map<string, Resource>();
	readonly #graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly emptySnapshot: Snapshot) {}

	get(key: string): Resource | undefined {
		return this.#resources.get(key);
	}

	values(): IterableIterator<Resource> {
		return this.#resources.values();
	}

	publish(resource: Resource, snapshot: Snapshot): void {
		if (!resource.active) return;
		resource.snapshot = snapshot;
		for (const listener of resource.listeners) listener();
	}

	snapshot(key: string | null): Snapshot {
		return key
			? (this.#resources.get(key)?.snapshot ?? this.emptySnapshot)
			: this.emptySnapshot;
	}

	subscribe<Input>(
		key: string | null,
		input: Input | null,
		listener: () => void,
		create: (input: Input) => ResourceSeed<Resource>,
		start: (resource: Resource) => void | Promise<void>,
		dispose: (resource: Resource) => void | Promise<void> = NOOP,
		grace?: KeyedExternalStoreGrace<Resource>,
	): () => void {
		if (!key || input === null) return NOOP;
		const resource = this.#ensure(key, input, create, start, grace);
		resource.listeners.add(listener);
		listener();
		return () => {
			resource.listeners.delete(listener);
			queueMicrotask(() => {
				if (
					resource.listeners.size > 0 ||
					this.#resources.get(key) !== resource
				) {
					return;
				}
				if (!grace || grace.graceMs <= 0) {
					this.#dispose(key, resource, dispose);
					return;
				}
				grace.suspend?.(resource);
				this.#graceTimers.set(
					key,
					setTimeout(() => {
						this.#graceTimers.delete(key);
						if (
							resource.listeners.size > 0 ||
							this.#resources.get(key) !== resource
						) {
							return;
						}
						this.#dispose(key, resource, dispose);
					}, grace.graceMs),
				);
			});
		};
	}

	reset(dispose: (resource: Resource) => void | Promise<void> = NOOP): void {
		for (const timer of this.#graceTimers.values()) clearTimeout(timer);
		this.#graceTimers.clear();
		for (const resource of this.#resources.values()) {
			resource.active = false;
			resource.listeners.clear();
			void dispose(resource);
		}
		this.#resources.clear();
	}

	#dispose(
		key: string,
		resource: Resource,
		dispose: (resource: Resource) => void | Promise<void>,
	): void {
		resource.active = false;
		void dispose(resource);
		this.#resources.delete(key);
	}

	#ensure<Input>(
		key: string,
		input: Input,
		create: (input: Input) => ResourceSeed<Resource>,
		start: (resource: Resource) => void | Promise<void>,
		grace?: KeyedExternalStoreGrace<Resource>,
	): Resource {
		const existing = this.#resources.get(key);
		if (existing) {
			const timer = this.#graceTimers.get(key);
			if (timer !== undefined) {
				clearTimeout(timer);
				this.#graceTimers.delete(key);
				grace?.resume?.(existing);
			}
			return existing;
		}
		const resource = {
			...create(input),
			active: true,
			listeners: new Set<() => void>(),
		} as Resource;
		this.#resources.set(key, resource);
		void start(resource);
		return resource;
	}
}
