import type { StorageValue } from "zustand/middleware";

export interface ExclusiveLockAuthority {
	request<T>(name: string, operation: () => Promise<T> | T): Promise<T>;
}

export interface DurableWriteRunOptions {
	readonly failureScope?: object;
	readonly failureDomain?: string;
	readonly clearsFailureDomains?: readonly string[];
}

class BrowserWebLockAuthority implements ExclusiveLockAuthority {
	request<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
		const locks = globalThis.navigator?.locks;
		if (!locks) {
			throw new Error("durable_storage_web_locks_unavailable");
		}
		return locks.request(name, { mode: "exclusive" }, operation);
	}
}

/**
 * A realm FIFO prevents a later local projection from overtaking an earlier
 * one. The Web Lock is the origin-wide authority that extends the same order
 * across independently running WebViews.
 */
export class DurableWriteCoordinator {
	private tail: Promise<void> = Promise.resolve();
	private readonly failuresByScope = new Map<object, Map<string, unknown>>();
	private readonly defaultFailureScopes = new Map<string, object>();

	constructor(
		private readonly authority: ExclusiveLockAuthority = new BrowserWebLockAuthority(),
	) {}

	run<T>(
		storageKey: string,
		operation: () => Promise<T> | T,
		options: DurableWriteRunOptions = {},
	): Promise<T> {
		const existingDefaultScope = this.defaultFailureScopes.get(storageKey);
		const failureScope = options.failureScope ?? existingDefaultScope ?? {};
		if (!options.failureScope && !existingDefaultScope) {
			this.defaultFailureScopes.set(storageKey, failureScope);
		}
		const failureDomain = options.failureDomain ?? "default";
		const clearsFailureDomains = options.clearsFailureDomains ?? [
			failureDomain,
		];
		const pending = this.tail.then(() =>
			this.authority.request(`dure:durable-store:${storageKey}`, operation),
		);
		this.tail = pending.then(
			() => {
				const failures = this.failuresByScope.get(failureScope);
				for (const domain of clearsFailureDomains) failures?.delete(domain);
				if (failures?.size === 0) this.failuresByScope.delete(failureScope);
			},
			(error) => {
				const failures =
					this.failuresByScope.get(failureScope) ?? new Map<string, unknown>();
				failures.set(failureDomain, error);
				this.failuresByScope.set(failureScope, failures);
			},
		);
		return pending;
	}

	async flush(failureScope?: object): Promise<void> {
		let observed: Promise<void>;
		do {
			observed = this.tail;
			await observed;
		} while (observed !== this.tail);
		if (failureScope) {
			const failure = this.failuresByScope.get(failureScope)?.values().next();
			if (failure && !failure.done) throw failure.value;
			return;
		}
		for (const failures of this.failuresByScope.values()) {
			const failure = failures.values().next();
			if (!failure.done) throw failure.value;
		}
	}
}

export const DURABLE_FIELD_MISSING = Symbol("durable-field-missing");
export type DurableFieldValue<T> = T | typeof DURABLE_FIELD_MISSING;
export type DurableFieldConvergence<T> = (
	base: DurableFieldValue<T>,
	local: DurableFieldValue<T>,
	remote: DurableFieldValue<T>,
) => DurableFieldValue<T>;
export type DurableStateConvergence<S extends Record<string, unknown>> = (
	base: S | undefined,
	local: S,
	remote: S,
) => S;
export type DurableFieldPolicies<S extends Record<string, unknown>> = {
	[K in keyof S]-?: DurableFieldConvergence<S[K]>;
};

function sameJsonValue<T>(
	left: DurableFieldValue<T>,
	right: DurableFieldValue<T>,
): boolean {
	if (left === DURABLE_FIELD_MISSING || right === DURABLE_FIELD_MISSING) {
		return left === right;
	}
	return JSON.stringify(left) === JSON.stringify(right);
}

export function convergeDurableCas<T>(
	base: DurableFieldValue<T>,
	local: DurableFieldValue<T>,
	remote: DurableFieldValue<T>,
): DurableFieldValue<T> {
	if (sameJsonValue(local, base)) return remote;
	if (sameJsonValue(remote, base)) return local;
	if (sameJsonValue(local, remote)) return local;
	// The remote value committed under the same origin-wide writer authority
	// after this realm's base. Preserve it when both sides touched one identity.
	return remote;
}

function durableObjectRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function owns(value: object, key: PropertyKey): boolean {
	return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function keyedEntities(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = new Set<string>();
	const entities: Record<string, unknown>[] = [];
	for (const candidate of value) {
		const entity = durableObjectRecord(candidate);
		if (!entity || typeof entity.id !== "string" || ids.has(entity.id)) {
			return undefined;
		}
		ids.add(entity.id);
		entities.push(entity);
	}
	return entities;
}

function mergeEntityFields(
	base: Record<string, unknown> | undefined,
	local: Record<string, unknown>,
	remote: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const key of new Set([
		...Object.keys(base ?? {}),
		...Object.keys(remote),
		...Object.keys(local),
	])) {
		const selected = convergeDurableCas(
			base && owns(base, key) ? base[key] : DURABLE_FIELD_MISSING,
			owns(local, key) ? local[key] : DURABLE_FIELD_MISSING,
			owns(remote, key) ? remote[key] : DURABLE_FIELD_MISSING,
		);
		if (selected !== DURABLE_FIELD_MISSING) merged[key] = selected;
	}
	return merged;
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function mergeOrder(
	baseOrder: readonly string[],
	localOrder: readonly string[],
	remoteOrder: readonly string[],
): string[] {
	const baseIds = new Set(baseOrder);
	const baseInLocal = baseOrder.filter((id) => localOrder.includes(id));
	const baseInRemote = baseOrder.filter((id) => remoteOrder.includes(id));
	const localBaseOrder = localOrder.filter((id) => baseIds.has(id));
	const remoteBaseOrder = remoteOrder.filter((id) => baseIds.has(id));
	const localReordered = !sameOrder(localBaseOrder, baseInLocal);
	const remoteReordered = !sameOrder(remoteBaseOrder, baseInRemote);
	let order: string[];
	if (localReordered && !remoteReordered) order = [...localOrder];
	else if (remoteReordered && !localReordered) order = [...remoteOrder];
	else {
		const selected = convergeDurableCas(baseOrder, localOrder, remoteOrder);
		order = Array.isArray(selected) ? [...selected] : [...remoteOrder];
	}
	for (const id of [...remoteOrder, ...localOrder, ...baseOrder]) {
		if (!order.includes(id)) order.push(id);
	}
	return order;
}

export function convergeDurableIdEntities<T extends { id: string }>(
	baseValue: DurableFieldValue<T[]>,
	localValue: DurableFieldValue<T[]>,
	remoteValue: DurableFieldValue<T[]>,
): DurableFieldValue<T[]> {
	if (
		localValue === DURABLE_FIELD_MISSING ||
		remoteValue === DURABLE_FIELD_MISSING
	) {
		return convergeDurableCas(baseValue, localValue, remoteValue);
	}
	const base =
		baseValue === DURABLE_FIELD_MISSING ? [] : keyedEntities(baseValue);
	const local = keyedEntities(localValue);
	const remote = keyedEntities(remoteValue);
	if (!base || !local || !remote) return remoteValue;
	const baseById = new Map(base.map((entity) => [entity.id as string, entity]));
	const localById = new Map(
		local.map((entity) => [entity.id as string, entity]),
	);
	const remoteById = new Map(
		remote.map((entity) => [entity.id as string, entity]),
	);
	const localOrder = local.map((entity) => entity.id as string);
	const remoteOrder = remote.map((entity) => entity.id as string);
	const baseOrder = base.map((entity) => entity.id as string);
	const order = mergeOrder(baseOrder, localOrder, remoteOrder);
	return order.flatMap((id) => {
		const baseEntity = baseById.get(id);
		const localEntity = localById.get(id);
		const remoteEntity = remoteById.get(id);
		if (localEntity && remoteEntity) {
			return [mergeEntityFields(baseEntity, localEntity, remoteEntity) as T];
		}
		const selected = convergeDurableCas(
			baseEntity ?? DURABLE_FIELD_MISSING,
			localEntity ?? DURABLE_FIELD_MISSING,
			remoteEntity ?? DURABLE_FIELD_MISSING,
		);
		return selected === DURABLE_FIELD_MISSING ? [] : [selected as T];
	});
}

export function convergeDurableRecord<T extends Record<string, unknown>>(
	baseValue: DurableFieldValue<T>,
	localValue: DurableFieldValue<T>,
	remoteValue: DurableFieldValue<T>,
): DurableFieldValue<T> {
	if (
		localValue === DURABLE_FIELD_MISSING ||
		remoteValue === DURABLE_FIELD_MISSING
	) {
		return convergeDurableCas(baseValue, localValue, remoteValue);
	}
	const base =
		baseValue === DURABLE_FIELD_MISSING ? {} : durableObjectRecord(baseValue);
	const local = durableObjectRecord(localValue);
	const remote = durableObjectRecord(remoteValue);
	if (!base || !local || !remote) return remoteValue;
	const merged: Record<string, unknown> = {};
	for (const key of new Set([
		...Object.keys(base),
		...Object.keys(remote),
		...Object.keys(local),
	])) {
		const selected = convergeDurableCas(
			owns(base, key) ? base[key] : DURABLE_FIELD_MISSING,
			owns(local, key) ? local[key] : DURABLE_FIELD_MISSING,
			owns(remote, key) ? remote[key] : DURABLE_FIELD_MISSING,
		);
		if (selected !== DURABLE_FIELD_MISSING) merged[key] = selected;
	}
	return merged as T;
}

export function convergeDurableOrderedStrings(
	baseValue: DurableFieldValue<string[]>,
	localValue: DurableFieldValue<string[]>,
	remoteValue: DurableFieldValue<string[]>,
): DurableFieldValue<string[]> {
	if (
		localValue === DURABLE_FIELD_MISSING ||
		remoteValue === DURABLE_FIELD_MISSING
	) {
		return convergeDurableCas(baseValue, localValue, remoteValue);
	}
	const valid = (value: unknown): value is string[] =>
		Array.isArray(value) &&
		new Set(value).size === value.length &&
		value.every((entry) => typeof entry === "string");
	const base = baseValue === DURABLE_FIELD_MISSING ? [] : baseValue;
	if (!valid(base) || !valid(localValue) || !valid(remoteValue)) {
		return remoteValue;
	}
	const order = mergeOrder(base, localValue, remoteValue);
	return order.filter((id) => {
		const selected = convergeDurableCas(
			base.includes(id) ? id : DURABLE_FIELD_MISSING,
			localValue.includes(id) ? id : DURABLE_FIELD_MISSING,
			remoteValue.includes(id) ? id : DURABLE_FIELD_MISSING,
		);
		return selected !== DURABLE_FIELD_MISSING;
	});
}

export function createFieldwiseDurableStateConvergence<
	S extends Record<string, unknown>,
>(policies: DurableFieldPolicies<S>): DurableStateConvergence<S> {
	return (base, local, remote) => {
		const state: Partial<S> = {};
		for (const key of Object.keys(policies) as (keyof S)[]) {
			const selected = policies[key](
				base && owns(base, key) ? base[key] : DURABLE_FIELD_MISSING,
				owns(local, key) ? local[key] : DURABLE_FIELD_MISSING,
				owns(remote, key) ? remote[key] : DURABLE_FIELD_MISSING,
			);
			if (selected !== DURABLE_FIELD_MISSING) state[key] = selected;
		}
		return state as S;
	};
}

const convergeDynamicState: DurableStateConvergence<Record<string, unknown>> = (
	base,
	local,
	remote,
) => {
	const state: Record<string, unknown> = {};
	for (const key of new Set([
		...Object.keys(base ?? {}),
		...Object.keys(remote),
		...Object.keys(local),
	])) {
		const selected = convergeDurableCas(
			base && owns(base, key) ? base[key] : DURABLE_FIELD_MISSING,
			owns(local, key) ? local[key] : DURABLE_FIELD_MISSING,
			owns(remote, key) ? remote[key] : DURABLE_FIELD_MISSING,
		);
		if (selected !== DURABLE_FIELD_MISSING) state[key] = selected;
	}
	return state;
};

/** Pure three-way convergence for a stale Zustand durable projection. */
export function convergePersistedStorageValues<
	S extends Record<string, unknown>,
>(
	base: StorageValue<S> | null,
	local: StorageValue<S> | null,
	remote: StorageValue<S> | null,
	convergeState: DurableStateConvergence<S> = convergeDynamicState as DurableStateConvergence<S>,
): StorageValue<S> | null {
	if (!local) {
		if (!remote) return null;
		if (!base) return remote;
		return sameJsonValue(base, remote) ? null : remote;
	}
	if (!remote) return base ? null : local;
	if (
		local.version !== remote.version ||
		(base && base.version !== local.version)
	) {
		return remote;
	}
	return {
		state: convergeState(base?.state, local.state, remote.state),
		...(local.version === undefined ? {} : { version: local.version }),
	};
}

export const durableWriteCoordinator = new DurableWriteCoordinator();
