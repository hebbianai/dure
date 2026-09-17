import type { PersistStorage, StorageValue } from "zustand/middleware";
import { t } from "@/lib/i18n";
import {
	convergePersistedStorageValues,
	type DurableStateConvergence,
	type DurableWriteCoordinator,
	durableWriteCoordinator,
} from "@/lib/persistence/durableWriteCoordinator";
import { reportPersistenceStatus } from "@/lib/persistence/persistenceStatus";

const RETIRED_INTERACTION_INBOX_PROJECTION_KEY =
	"dure-interaction-inbox-projection-v1";

/** Removes the browser-only cache left by the retired Decision Inbox. */
export function removeRetiredInteractionInboxProjection(
	storage: Pick<Storage, "removeItem"> = localStorage,
): void {
	try {
		storage.removeItem(RETIRED_INTERACTION_INBOX_PROJECTION_KEY);
	} catch {
		// A retired cache must never block app startup when storage is unavailable.
	}
}

function shallowReferenceEqual(
	left: Record<string, unknown> | undefined,
	right: Record<string, unknown>,
): boolean {
	if (!left) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		rightKeys.every((key) => Object.is(left[key], right[key]))
	);
}

/**
 * Zustand persist invokes storage after every store update, including updates
 * excluded by partialize. Compare the durable slice by member reference before
 * JSON serialization so runtime-only activity never rewrites localStorage.
 */
interface DurableStorageTransaction<S, R> {
	readonly value: StorageValue<S> | null;
	readonly result: R;
}

export interface ReferenceAwarePersistStorage<S extends Record<string, unknown>>
	extends PersistStorage<S, void> {
	flush(): Promise<void>;
	reconcile(name: string): Promise<void>;
	freezeProjectionAncestor(): () => void;
	read<R>(
		name: string,
		reader: (current: StorageValue<S> | null) => R,
	): Promise<R>;
	transact<R>(
		name: string,
		mutation: (
			current: StorageValue<S> | null,
		) => DurableStorageTransaction<S, R>,
	): Promise<R>;
}

interface ReferenceAwareLocalStorageOptions<S extends Record<string, unknown>> {
	readonly coordinator?: DurableWriteCoordinator;
	readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	readonly convergeState?: DurableStateConvergence<S>;
	readonly onCommitted?: (name: string) => void;
}

interface ParsedStoredValue<S> {
	readonly value: StorageValue<S> | null;
	readonly corrupt: boolean;
}

interface LocalProjection<S> {
	readonly id: number;
	readonly value: StorageValue<S> | null;
	readonly serialized: string | null;
	readonly ancestorFrozen: boolean;
	ancestorValue: StorageValue<S> | null;
	ancestorSerialized: string | null;
	ancestorKnown: boolean;
}

function parseStoredValue<S>(raw: string): ParsedStoredValue<S> {
	try {
		return {
			value: JSON.parse(raw) as StorageValue<S>,
			corrupt: false,
		};
	} catch {
		return { value: null, corrupt: true };
	}
}

function recoverCorruptStoredValue(
	name: string,
	raw: string,
	storage: Pick<Storage, "setItem" | "removeItem">,
	onCommitted: (name: string) => void,
): void {
	try {
		storage.setItem(`${name}:corrupt-backup`, raw);
		storage.removeItem(name);
		onCommitted(name);
		reportPersistenceStatus(
			"error",
			t("persistence.recovery.corruptBackupKept", { name }),
		);
	} catch (error) {
		reportPersistenceStatus(
			"error",
			t("persistence.recovery.failed", { error: String(error) }),
		);
		throw error;
	}
}

export function createReferenceAwareLocalStorage<
	S extends Record<string, unknown>,
>(
	options: ReferenceAwareLocalStorageOptions<S> = {},
): ReferenceAwarePersistStorage<S> {
	const coordinator = options.coordinator ?? durableWriteCoordinator;
	const storage = options.storage ?? localStorage;
	const convergeState = options.convergeState;
	const notifyCommitted = (name: string): void => {
		try {
			options.onCommitted?.(name);
		} catch {
			// The durable write already committed; notification is best effort.
		}
	};
	const failureScope = {};
	let lastObservedValue: StorageValue<S> | null = null;
	let lastObservedSerialized: string | null = null;
	let confirmedValue: StorageValue<S> | null = null;
	let confirmedSerialized: string | null = null;
	let confirmedKnown = false;
	let localAncestorValue: StorageValue<S> | null = null;
	let localAncestorSerialized: string | null = null;
	let localAncestorKnown = false;
	let nextProjectionId = 0;
	let dirtyProjection: LocalProjection<S> | null = null;
	let dirtyProjectionStatus: "pending" | "failed" | null = null;
	let projectionAncestorHolds = 0;
	let frozenAncestorValue: StorageValue<S> | null = null;
	let frozenAncestorSerialized: string | null = null;
	let frozenAncestorKnown = false;

	const readStoredValue = (
		name: string,
	): { value: StorageValue<S> | null; serialized: string | null } => {
		const serialized = storage.getItem(name);
		if (!serialized) return { value: null, serialized: null };
		const parsed = parseStoredValue<S>(serialized);
		if (parsed.corrupt) {
			recoverCorruptStoredValue(name, serialized, storage, notifyCommitted);
			return { value: null, serialized: null };
		}
		return { value: parsed.value, serialized };
	};

	const commitProjection = (
		name: string,
		candidate: LocalProjection<S>,
	): void => {
		const remote = readStoredValue(name);
		let committed = candidate.value;
		let serialized = candidate.serialized;
		const remoteIsAncestor = candidate.ancestorKnown
			? remote.serialized === candidate.ancestorSerialized
			: remote.serialized === null;
		if (!remoteIsAncestor && remote.serialized !== candidate.serialized) {
			const ancestor = candidate.ancestorSerialized
				? (JSON.parse(candidate.ancestorSerialized) as StorageValue<S>)
				: candidate.ancestorValue;
			const local = candidate.serialized
				? (JSON.parse(candidate.serialized) as StorageValue<S>)
				: null;
			committed = convergePersistedStorageValues(
				ancestor,
				local,
				remote.value,
				convergeState,
			);
			serialized = committed ? JSON.stringify(committed) : null;
		}
		if (serialized !== remote.serialized) {
			if (serialized === null) storage.removeItem(name);
			else storage.setItem(name, serialized);
			notifyCommitted(name);
		}
		confirmedValue = committed;
		confirmedSerialized = serialized;
		confirmedKnown = true;
	};

	const refreshProjectionAncestor = (candidate: LocalProjection<S>): void => {
		if (candidate.ancestorFrozen) return;
		candidate.ancestorValue = localAncestorKnown
			? localAncestorValue
			: confirmedValue;
		candidate.ancestorSerialized = localAncestorKnown
			? localAncestorSerialized
			: confirmedSerialized;
		candidate.ancestorKnown = localAncestorKnown || confirmedKnown;
	};

	const enqueueProjection = (
		name: string,
		candidate: LocalProjection<S>,
	): Promise<void> =>
		coordinator
			.run(
				name,
				() => {
					refreshProjectionAncestor(candidate);
					commitProjection(name, candidate);
					localAncestorValue = candidate.value;
					localAncestorSerialized = candidate.serialized;
					localAncestorKnown = true;
					if (dirtyProjection?.id === candidate.id) {
						dirtyProjection = null;
						dirtyProjectionStatus = null;
					}
					reportPersistenceStatus("saved");
				},
				{
					failureScope,
					failureDomain: "projection",
					clearsFailureDomains: ["projection", "corrupt-recovery"],
				},
			)
			.catch((error) => {
				if (dirtyProjection?.id === candidate.id) {
					dirtyProjectionStatus = "failed";
				}
				refreshProjectionAncestor(candidate);
				reportPersistenceStatus("error", String(error));
				throw error;
			});

	const projectionFrom = (
		value: StorageValue<S> | null,
		serialized: string | null,
	): LocalProjection<S> => {
		const ancestorFrozen = projectionAncestorHolds > 0;
		return {
			id: ++nextProjectionId,
			value,
			serialized,
			ancestorFrozen,
			ancestorValue: ancestorFrozen
				? frozenAncestorValue
				: localAncestorKnown
					? localAncestorValue
					: confirmedValue,
			ancestorSerialized: ancestorFrozen
				? frozenAncestorSerialized
				: localAncestorKnown
					? localAncestorSerialized
					: confirmedSerialized,
			ancestorKnown: ancestorFrozen
				? frozenAncestorKnown
				: localAncestorKnown || confirmedKnown,
		};
	};

	return {
		getItem: (name) => {
			let raw: string | null;
			try {
				raw = storage.getItem(name);
			} catch (error) {
				reportPersistenceStatus("error", String(error));
				return null;
			}
			confirmedKnown = true;
			if (!raw) {
				lastObservedValue = null;
				lastObservedSerialized = null;
				confirmedValue = null;
				confirmedSerialized = null;
				localAncestorValue = null;
				localAncestorSerialized = null;
				localAncestorKnown = true;
				dirtyProjection = null;
				dirtyProjectionStatus = null;
				return null;
			}
			const parsed = parseStoredValue<S>(raw);
			if (parsed.corrupt) {
				const corruptRaw = raw;
				void coordinator
					.run(
						name,
						() => {
							if (storage.getItem(name) !== corruptRaw) return;
							recoverCorruptStoredValue(
								name,
								corruptRaw,
								storage,
								notifyCommitted,
							);
						},
						{ failureScope, failureDomain: "corrupt-recovery" },
					)
					.catch((error) => reportPersistenceStatus("error", String(error)));
			}
			lastObservedValue = parsed.value;
			lastObservedSerialized = parsed.value ? raw : null;
			confirmedValue = parsed.value;
			confirmedSerialized = parsed.value ? raw : null;
			localAncestorValue = parsed.value;
			localAncestorSerialized = parsed.value ? raw : null;
			localAncestorKnown = true;
			dirtyProjection = null;
			dirtyProjectionStatus = null;
			return parsed.value;
		},
		setItem: (name, value) => {
			if (
				dirtyProjectionStatus !== "failed" &&
				lastObservedValue?.version === value.version &&
				shallowReferenceEqual(
					lastObservedValue?.state as Record<string, unknown> | undefined,
					value.state as Record<string, unknown>,
				)
			) {
				return;
			}
			let serialized: string;
			try {
				serialized = JSON.stringify(value);
			} catch (error) {
				reportPersistenceStatus("error", String(error));
				throw error;
			}
			// Rehydration normalizes a few nested objects, so references can differ
			// even when another window wrote identical durable content.
			if (dirtyProjection === null && serialized === lastObservedSerialized) {
				lastObservedValue = value;
				return;
			}
			const localProjection = projectionFrom(value, serialized);
			dirtyProjection = localProjection;
			dirtyProjectionStatus = "pending";
			lastObservedValue = value;
			lastObservedSerialized = serialized;
			reportPersistenceStatus("saving");
			void enqueueProjection(name, localProjection).catch(() => undefined);
		},
		removeItem: (name) => {
			const localProjection = projectionFrom(null, null);
			dirtyProjection = localProjection;
			dirtyProjectionStatus = "pending";
			lastObservedValue = null;
			lastObservedSerialized = null;
			reportPersistenceStatus("saving");
			void enqueueProjection(name, localProjection).catch(() => undefined);
		},
		flush: () => coordinator.flush(failureScope),
		reconcile: async (name) => {
			const candidate = dirtyProjection;
			await coordinator.run(
				name,
				() => {
					if (candidate && dirtyProjection?.id === candidate.id) {
						commitProjection(name, candidate);
						localAncestorValue = candidate.value;
						localAncestorSerialized = candidate.serialized;
						localAncestorKnown = true;
						dirtyProjection = null;
						dirtyProjectionStatus = null;
					} else {
						const remote = readStoredValue(name);
						confirmedValue = remote.value;
						confirmedSerialized = remote.serialized;
						confirmedKnown = true;
					}
					reportPersistenceStatus("saved");
				},
				{
					failureScope,
					failureDomain: "projection",
					clearsFailureDomains: ["projection", "corrupt-recovery"],
				},
			);
			await coordinator.flush(failureScope);
		},
		freezeProjectionAncestor: () => {
			if (projectionAncestorHolds === 0) {
				frozenAncestorValue = localAncestorKnown
					? localAncestorValue
					: confirmedValue;
				frozenAncestorSerialized = localAncestorKnown
					? localAncestorSerialized
					: confirmedSerialized;
				frozenAncestorKnown = localAncestorKnown || confirmedKnown;
			}
			projectionAncestorHolds += 1;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				projectionAncestorHolds -= 1;
				if (projectionAncestorHolds === 0) {
					frozenAncestorValue = null;
					frozenAncestorSerialized = null;
					frozenAncestorKnown = false;
				}
			};
		},
		read: async (name, reader) =>
			coordinator.run(
				name,
				() => reader(readStoredValue(name).value),
				{ failureScope, failureDomain: "read" },
			),
		transact: async (name, mutation) => {
			return coordinator.run(
				name,
				() => {
					const remote = readStoredValue(name);
					const current = remote.value;
					const transaction = mutation(current);
					const nextSerialized = transaction.value
						? JSON.stringify(transaction.value)
						: null;
					if (nextSerialized !== remote.serialized) {
						if (nextSerialized === null) storage.removeItem(name);
						else storage.setItem(name, nextSerialized);
						notifyCommitted(name);
					}
					confirmedValue = transaction.value;
					confirmedSerialized = nextSerialized;
					confirmedKnown = true;
					return transaction.result;
				},
				{ failureScope, failureDomain: "transaction" },
			);
		},
	};
}
