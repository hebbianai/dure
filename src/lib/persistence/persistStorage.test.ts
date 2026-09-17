import { describe, expect, it, vi } from "vitest";
import type { StorageValue } from "zustand/middleware";
import {
	convergeDurableIdEntities,
	convergeDurableRecord,
	createFieldwiseDurableStateConvergence,
	DurableWriteCoordinator,
	type ExclusiveLockAuthority,
} from "@/lib/persistence/durableWriteCoordinator";
import { recoverDurableProjection } from "@/lib/persistence/durableProjectionRecovery";
import {
	normalizePersistedState,
	type PersistedAppState,
} from "@/lib/persistence/persistedAppState";
import {
	convergeDurableLayouts,
	convergePersistedAppState,
} from "@/lib/persistence/persistedAppStateConvergence";
import {
	createReferenceAwareLocalStorage,
	removeRetiredInteractionInboxProjection,
	type ReferenceAwarePersistStorage,
} from "@/lib/persistence/persistStorage";
import { hmuxLocalBinding } from "@/lib/terminal/terminalBinding";
import { removePanelIdsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";
import {
	managedAgentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent } from "@/types";

type TestState = {
	agents: Array<{ id: string; generation: string }>;
	layouts: Record<string, unknown>;
	stats: { agentsStarted: number };
};

const convergeTestFields = createFieldwiseDurableStateConvergence<TestState>({
	agents: convergeDurableIdEntities,
	layouts: convergeDurableLayouts,
	stats: convergeDurableRecord,
});

const convergeTestState = convergeTestFields;

class MemoryStorage {
	readonly values = new Map<string, string>();
	readonly writes: Array<{ key: string; value: string }> = [];

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
		this.writes.push({ key, value });
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

class FailingRecoveryStorage extends MemoryStorage {
	failRecovery = true;

	override setItem(key: string, value: string): void {
		if (this.failRecovery && key.endsWith(":corrupt-backup")) {
			throw new Error("backup write failed");
		}
		super.setItem(key, value);
	}
}

class SharedTestLockAuthority implements ExclusiveLockAuthority {
	private readonly tails = new Map<string, Promise<void>>();
	requests = 0;

	request<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		const predecessor = this.tails.get(name) ?? Promise.resolve();
		const pending = predecessor.then(operation);
		this.tails.set(
			name,
			pending.then(
				() => undefined,
				() => undefined,
			),
		);
		return pending;
	}
}

class DelayedFirstLockAuthority implements ExclusiveLockAuthority {
	private release: (() => void) | undefined;
	requests = 0;

	request<T>(_name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		if (this.requests !== 1) return Promise.resolve().then(operation);
		return new Promise<T>((resolve, reject) => {
			this.release = () => {
				Promise.resolve().then(operation).then(resolve, reject);
			};
		});
	}

	releaseFirst(): void {
		const release = this.release;
		this.release = undefined;
		if (!release) throw new Error("first lock request is not pending");
		release();
	}
}

describe("retired browser projections", () => {
	it("removes the Decision Inbox cache without touching durable app state", () => {
		const storage = new MemoryStorage();
		storage.values.set("dure-interaction-inbox-projection-v1", "cached inbox");
		storage.values.set("agent-ide", "durable app state");

		removeRetiredInteractionInboxProjection(storage);

		expect(storage.values.has("dure-interaction-inbox-projection-v1")).toBe(false);
		expect(storage.values.get("agent-ide")).toBe("durable app state");
	});

	it("does not block startup when browser storage is unavailable", () => {
		expect(() =>
			removeRetiredInteractionInboxProjection({
				removeItem: () => {
					throw new Error("storage unavailable");
				},
			}),
		).not.toThrow();
	});
});

class PausedFirstSuccessfulLockAuthority implements ExclusiveLockAuthority {
	private readonly tails = new Map<string, Promise<void>>();
	private release: (() => void) | undefined;
	private firstCompletedResolve: (() => void) | undefined;
	readonly firstCompleted = new Promise<void>((resolve) => {
		this.firstCompletedResolve = resolve;
	});
	requests = 0;

	request<T>(name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		const requestNumber = this.requests;
		const predecessor = this.tails.get(name) ?? Promise.resolve();
		const pending = predecessor.then(async () => {
			const result = await operation();
			if (requestNumber === 1) {
				this.firstCompletedResolve?.();
				this.firstCompletedResolve = undefined;
				await new Promise<void>((resolve) => {
					this.release = resolve;
				});
			}
			return result;
		});
		this.tails.set(
			name,
			pending.then(
				() => undefined,
				() => undefined,
			),
		);
		return pending;
	}

	releaseFirst(): void {
		const release = this.release;
		this.release = undefined;
		if (!release) throw new Error("first lock request is not pending");
		release();
	}
}

class RejectOnceLockAuthority implements ExclusiveLockAuthority {
	requests = 0;
	readonly failure = new Error("lock request rejected");

	request<T>(_name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		if (this.requests === 1) return Promise.reject(this.failure);
		return Promise.resolve().then(operation);
	}
}

class RejectTwiceLockAuthority implements ExclusiveLockAuthority {
	requests = 0;
	readonly failure = new Error("lock request rejected");

	request<T>(_name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		if (this.requests <= 2) return Promise.reject(this.failure);
		return Promise.resolve().then(operation);
	}
}

class RejectSecondLockAuthority implements ExclusiveLockAuthority {
	requests = 0;
	readonly failure = new Error("second lock request rejected");

	request<T>(_name: string, operation: () => Promise<T> | T): Promise<T> {
		this.requests += 1;
		if (this.requests === 2) return Promise.reject(this.failure);
		return Promise.resolve().then(operation);
	}
}

function createTestStorage(
	authority: SharedTestLockAuthority,
	storage: MemoryStorage,
) {
	return createReferenceAwareLocalStorage<TestState>({
		coordinator: new DurableWriteCoordinator(authority),
		storage,
		convergeState: convergeTestState,
	});
}

function createAppStorage(
	authority: SharedTestLockAuthority,
	storage: MemoryStorage,
) {
	return createReferenceAwareLocalStorage<PersistedAppState>({
		coordinator: new DurableWriteCoordinator(authority),
		storage,
		convergeState: convergePersistedAppState,
	});
}

async function writeDurably<S extends Record<string, unknown>>(
	persisted: ReferenceAwarePersistStorage<S>,
	name: string,
	value: StorageValue<S>,
): Promise<void> {
	persisted.setItem(name, value);
	await persisted.flush();
}

function value(state: TestState) {
	return { state, version: 7 };
}

function sourceState(): TestState {
	return {
		agents: [{ id: "agent-a", generation: "source" }],
		layouts: {
			"space-a": { panels: { "agent:agent-a": { id: "agent:agent-a" } } },
		},
		stats: { agentsStarted: 1 },
	};
}

function dockviewLayout(
	panelIds: readonly string[],
	options: { width?: number; baseSize?: number } = {},
): Record<string, unknown> {
	const width = options.width ?? 600;
	const panelSize = options.baseSize ?? width / Math.max(1, panelIds.length);
	return {
		grid: {
			root: {
				type: "branch",
				data: panelIds.map((panelId) => ({
					type: "leaf",
					data: {
						id: `group:${panelId}`,
						views: [panelId],
						activeView: panelId,
					},
					size: panelSize,
				})),
				size: 400,
			},
			width,
			height: 400,
			orientation: "HORIZONTAL",
		},
		panels: Object.fromEntries(
			panelIds.map((panelId) => [
				panelId,
				{
					id: panelId,
					// Legacy Agent fixtures still carry explicit content, without agentRef.
					...(panelId.startsWith("agent:") ? { contentComponent: "agent" } : {}),
				},
			]),
		),
		activeGroup: panelIds.length > 0 ? `group:${panelIds[0]}` : undefined,
	};
}

function layoutPanelIds(layout: unknown): string[] {
	return Object.keys(
		(layout as { panels: Record<string, unknown> }).panels,
	).sort();
}

function read(storage: MemoryStorage): TestState {
	return (
		JSON.parse(storage.getItem("agent-ide") ?? "null") as {
			state: TestState;
		}
	).state;
}

function readApp(storage: MemoryStorage): PersistedAppState {
	return (
		JSON.parse(storage.getItem("agent-ide") ?? "null") as {
			state: PersistedAppState;
		}
	).state;
}

function appState(
	agents: Agent[],
	layouts: Record<string, unknown>,
): PersistedAppState {
	return {
		...normalizePersistedState({}),
		agents,
		layouts,
	};
}

function exactManagedAgent(
	generation: "source" | "successor",
	patch: Partial<Agent> = {},
): Agent {
	const suffix = generation === "source" ? "1" : "2";
	const sessionId = `session-${suffix}`;
	return managedAgentFixture({
		id: "agent-a",
		name: "agent-a",
		sessionId,
		canonicalSpawn: {
			schemaVersion: 1,
			backendProfileId: "local",
			operationId: `operation-${suffix}`,
		},
		runtimeBinding: managedBindingFixture({
			sessionId,
			workspaceId: `workspace-${suffix}`,
			createIdempotencyKey: `create-${suffix}`,
			backendProfileId: "local",
			stopFence: stopFenceFixture({
				channelEpoch: suffix,
				terminalEpoch: `terminal-${suffix}`,
			}),
		}),
		executionProfile: {
			kind: "credential_reference",
			reference_id: "hebbian98",
			credential_generation: `credential-${suffix}`,
		},
		...patch,
	});
}

describe("reference-aware durable storage", () => {
	it("does not let delayed corrupt recovery remove newer valid bytes", async () => {
		const authority = new DelayedFirstLockAuthority();
		const storage = new MemoryStorage();
		const coordinator = new DurableWriteCoordinator(authority);
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator,
			storage,
			convergeState: convergeTestState,
		});
		storage.setItem("agent-ide", "{broken");
		storage.writes.length = 0;

		expect(persisted.getItem("agent-ide")).toBeNull();
		await vi.waitFor(() => expect(authority.requests).toBe(1));
		const valid = JSON.stringify(value(sourceState()));
		await new DurableWriteCoordinator(authority).run("agent-ide", () => {
			storage.setItem("agent-ide", valid);
		});
		authority.releaseFirst();
		await persisted.flush();

		expect(storage.getItem("agent-ide")).toBe(valid);
		expect(storage.getItem("agent-ide:corrupt-backup")).toBeNull();
	});

	it("surfaces failed corrupt recovery until that recovery succeeds", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new FailingRecoveryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		storage.setItem("agent-ide", "{broken");

		expect(persisted.getItem("agent-ide")).toBeNull();
		await expect(persisted.flush()).rejects.toThrow("backup write failed");
		expect(storage.getItem("agent-ide")).toBe("{broken");

		storage.failRecovery = false;
		expect(persisted.getItem("agent-ide")).toBeNull();
		await expect(persisted.flush()).resolves.toBeUndefined();
		expect(storage.getItem("agent-ide")).toBeNull();
		expect(storage.getItem("agent-ide:corrupt-backup")).toBe("{broken");
	});

	it("announces authoritative removal after corrupt recovery", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const committed = vi.fn();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
			onCommitted: committed,
		});
		storage.setItem("agent-ide", "{broken");

		expect(persisted.getItem("agent-ide")).toBeNull();
		await persisted.flush();

		expect(storage.getItem("agent-ide")).toBeNull();
		expect(committed).toHaveBeenCalledOnce();
		expect(committed).toHaveBeenCalledWith("agent-ide");
	});

	it("keeps the runtime-only no-op path ahead of JSON and the writer lock", () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createTestStorage(authority, storage);
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");

		persisted.setItem("agent-ide", {
			state: { ...initial.state },
			version: initial.version,
		});

		expect(authority.requests).toBe(0);
		expect(storage.writes).toEqual([]);
	});

	it("announces only completed durable changes", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const committed: Array<{ name: string; value: string | null }> = [];
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
			onCommitted: (name) => {
				committed.push({ name, value: storage.getItem(name) });
			},
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");

		persisted.setItem("agent-ide", initial);
		await persisted.flush();
		expect(committed).toEqual([]);

		const changed = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		persisted.setItem("agent-ide", changed);
		await persisted.flush();
		expect(committed).toEqual([
			{ name: "agent-ide", value: JSON.stringify(changed) },
		]);

		await persisted.transact("agent-ide", (current) => ({
			value: current,
			result: undefined,
		}));
		expect(committed).toHaveLength(1);
	});

	it("coalesces runtime-only no-ops while a durable projection is pending", async () => {
		const authority = new DelayedFirstLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");
		const changed = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});

		persisted.setItem("agent-ide", changed);
		await vi.waitFor(() => expect(authority.requests).toBe(1));
		persisted.setItem("agent-ide", {
			state: { ...changed.state },
			version: changed.version,
		});
		authority.releaseFirst();
		await persisted.flush();

		expect(authority.requests).toBe(1);
		expect(storage.writes).toHaveLength(1);
	});

	it("preserves a projection queued before later writes were suspended", async () => {
		const authority = new DelayedFirstLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");
		persisted.setItem(
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);
		await vi.waitFor(() => expect(authority.requests).toBe(1));

		const release = persisted.freezeProjectionAncestor();
		authority.releaseFirst();
		await persisted.flush();
		release();

		expect(read(storage)).toEqual({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
	});

	it("rebases a pre-fence unrelated edit over an authoritative Agent removal", async () => {
		const projectionAuthority = new DelayedFirstLockAuthority();
		const storage = new MemoryStorage();
		const projection = createReferenceAwareLocalStorage<PersistedAppState>({
			coordinator: new DurableWriteCoordinator(projectionAuthority),
			storage,
			convergeState: convergePersistedAppState,
		});
		const removal = createAppStorage(new SharedTestLockAuthority(), storage);
		const source = exactManagedAgent("source");
		const initialState = appState(
			[source],
			{ "space-a": dockviewLayout([`agent:${source.id}`]) },
		);
		const initial = { state: initialState, version: 13 };
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		projection.getItem("agent-ide");
		projection.setItem("agent-ide", {
			...initial,
			state: {
				...initialState,
				stats: { ...initialState.stats, activeMs: initialState.stats.activeMs + 1 },
			},
		});
		await vi.waitFor(() => expect(projectionAuthority.requests).toBe(1));
		await removal.transact("agent-ide", (current) => {
			if (!current) return { value: current, result: undefined };
			const state = normalizePersistedState(current.state);
			return {
				value: {
					...current,
					state: {
						...state,
						agents: [],
						layouts: {
							"space-a": removePanelIdsFromLayout(
								state.layouts["space-a"],
								new Set([`agent:${source.id}`]),
							),
						},
					},
				},
				result: undefined,
			};
		});

		const release = projection.freezeProjectionAncestor();
		projectionAuthority.releaseFirst();
		await projection.flush();
		release();

		const final = readApp(storage);
		expect(final.agents).toEqual([]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual([]);
		expect(final.stats.activeMs).toBe(initialState.stats.activeMs + 1);
	});

	it("rebases an unrelated edit created during recovery over an authoritative Agent removal", async () => {
		const storage = new MemoryStorage();
		const projection = createAppStorage(new SharedTestLockAuthority(), storage);
		const removal = createAppStorage(new SharedTestLockAuthority(), storage);
		const source = exactManagedAgent("source");
		const initialState = appState(
			[source],
			{ "space-a": dockviewLayout([`agent:${source.id}`]) },
		);
		const initial = { state: initialState, version: 13 };
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		projection.getItem("agent-ide");
		const release = projection.freezeProjectionAncestor();
		await removal.transact("agent-ide", (current) => {
			if (!current) return { value: current, result: undefined };
			const state = normalizePersistedState(current.state);
			return {
				value: {
					...current,
					state: {
						...state,
						agents: [],
						layouts: {
							"space-a": removePanelIdsFromLayout(
								state.layouts["space-a"],
								new Set([`agent:${source.id}`]),
							),
						},
					},
				},
				result: undefined,
			};
		});
		await projection.reconcile("agent-ide");

		projection.setItem("agent-ide", {
			...initial,
			state: {
				...initialState,
				stats: { ...initialState.stats, activeMs: initialState.stats.activeMs + 1 },
			},
		});
		await projection.flush();
		release();

		const final = readApp(storage);
		expect(final.agents).toEqual([]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual([]);
		expect(final.stats.activeMs).toBe(initialState.stats.activeMs + 1);
	});

	it("accepts writes while nested ancestor freezes release independently", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createTestStorage(authority, storage);
		const initial = value(sourceState());
		const changed = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");
		const releaseFirst = persisted.freezeProjectionAncestor();
		const releaseSecond = persisted.freezeProjectionAncestor();

		releaseFirst();
		releaseFirst();
		persisted.setItem("agent-ide", changed);
		await persisted.flush();
		expect(read(storage)).toEqual(changed.state);

		releaseSecond();
		releaseSecond();
	});

	it.each([
		{
			label: "returns without navigation",
			reload: () => undefined,
		},
		{
			label: "throws",
			reload: () => {
				throw new Error("reload failed");
			},
		},
	])(
		"releases a failed recovery fence when reload $label so a later canonical addition can be removed",
		async ({ reload }) => {
			vi.useFakeTimers();
			try {
				const authority = new SharedTestLockAuthority();
				const storage = new MemoryStorage();
				const projection = createTestStorage(authority, storage);
				const remote = createTestStorage(authority, storage);
				const initial = value({ ...sourceState(), agents: [] });
				storage.setItem("agent-ide", JSON.stringify(initial));
				projection.getItem("agent-ide");

				await expect(
					recoverDurableProjection({
						project: vi
							.fn<() => Promise<void>>()
							.mockRejectedValue(new Error("projection failed")),
						freezeAncestor: projection.freezeProjectionAncestor,
						reload,
					}),
				).resolves.toBe(false);

				await remote.transact("agent-ide", (current) => {
					if (!current) throw new Error("durable state is unavailable");
					return {
						value: {
							...current,
							state: {
								...current.state,
								agents: [{ id: "agent-added", generation: "remote" }],
							},
						},
						result: undefined,
					};
				});

				await vi.runOnlyPendingTimersAsync();
				await expect(
					recoverDurableProjection({
						project: async () => {
							projection.getItem("agent-ide");
						},
						freezeAncestor: projection.freezeProjectionAncestor,
					}),
				).resolves.toBe(true);

				const recovered = await projection.getItem("agent-ide");
				if (!recovered) throw new Error("recovered state is unavailable");
				projection.setItem("agent-ide", {
					...recovered,
					state: { ...recovered.state, agents: [] },
				});
				await projection.flush();

				expect(read(storage).agents).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("writes once on the common revision-match path", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createTestStorage(authority, storage);
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");

		persisted.setItem(
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);
		await persisted.flush();

		expect(authority.requests).toBe(1);
		expect(storage.writes).toHaveLength(1);
		expect(read(storage).stats.agentsStarted).toBe(2);
	});

	it("surfaces a failed projection and allows the identical retry to commit", async () => {
		const authority = new RejectOnceLockAuthority();
		const storage = new MemoryStorage();
		const coordinator = new DurableWriteCoordinator(authority);
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator,
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		const next = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");

		persisted.setItem("agent-ide", next);
		await expect(persisted.flush()).rejects.toBe(authority.failure);
		persisted.setItem("agent-ide", next);
		await expect(persisted.flush()).resolves.toBeUndefined();

		expect(authority.requests).toBe(2);
		expect(storage.writes).toHaveLength(1);
		expect(read(storage).stats.agentsStarted).toBe(2);
	});

	it("reconciles a dirty full projection after a durable transaction", async () => {
		const authority = new RejectOnceLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");
		const dirty = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});

		persisted.setItem("agent-ide", dirty);
		await expect(persisted.flush()).rejects.toBe(authority.failure);
		await persisted.transact("agent-ide", (current) => ({
			value: current
				? {
						...current,
						state: {
							...current.state,
							agents: [],
							layouts: { "space-a": { panels: {} } },
						},
					}
				: null,
			result: undefined,
		}));
		await expect(persisted.flush()).rejects.toBe(authority.failure);

		await persisted.reconcile("agent-ide");

		await expect(persisted.flush()).resolves.toBeUndefined();
		expect(read(storage)).toEqual({
			agents: [],
			layouts: { "space-a": { panels: {} } },
			stats: { agentsStarted: 2 },
		});
	});

	it("reads canonical state after earlier queued projections without rewriting it", async () => {
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(new SharedTestLockAuthority()),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		const changed = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");
		persisted.setItem("agent-ide", changed);

		await expect(
			persisted.read("agent-ide", (current) => current?.state.stats),
		).resolves.toEqual({ agentsStarted: 2 });

		expect(storage.writes).toHaveLength(1);
	});

	it("does not replay a captured projection that succeeded before reconciliation", async () => {
		const authority = new PausedFirstSuccessfulLockAuthority();
		const storage = new MemoryStorage();
		const local = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const remote = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		local.getItem("agent-ide");
		remote.getItem("agent-ide");

		local.setItem(
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);
		const reconciliation = local.reconcile("agent-ide");
		const remoteReplacement = remote.transact("agent-ide", (current) => ({
			value: current
				? {
						...current,
						state: {
							...current.state,
							stats: { agentsStarted: 1 },
						},
					}
				: null,
			result: undefined,
		}));
		await authority.firstCompleted;
		await vi.waitFor(() => expect(authority.requests).toBe(2));
		authority.releaseFirst();

		await Promise.all([remoteReplacement, reconciliation]);
		expect(read(storage).stats.agentsStarted).toBe(1);
	});

	it("reconciles a dirty projection with a later external write", async () => {
		const authority = new RejectOnceLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");
		const localAgent = { id: "agent-local", generation: "local" };
		const remoteAgent = { id: "agent-remote", generation: "remote" };

		persisted.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [...initial.state.agents, localAgent],
			}),
		);
		await expect(persisted.flush()).rejects.toBe(authority.failure);
		storage.setItem(
			"agent-ide",
			JSON.stringify(
				value({
					...initial.state,
					agents: [...initial.state.agents, remoteAgent],
				}),
			),
		);

		await persisted.reconcile("agent-ide");

		expect(read(storage).agents).toEqual([
			...initial.state.agents,
			remoteAgent,
			localAgent,
		]);
	});

	it("rebases a failed queued projection from the last successful local projection", async () => {
		const authority = new RejectSecondLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");
		const firstProjection = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		const localAgent = { id: "agent-local", generation: "local" };
		const secondProjection = value({
			...firstProjection.state,
			agents: [...firstProjection.state.agents, localAgent],
		});

		persisted.setItem("agent-ide", firstProjection);
		persisted.setItem("agent-ide", secondProjection);
		await expect(persisted.flush()).rejects.toBe(authority.failure);
		await persisted.transact("agent-ide", (current) => ({
			value: current
				? {
						...current,
						state: {
							...current.state,
							stats: { agentsStarted: 1 },
						},
					}
				: null,
			result: undefined,
		}));

		await persisted.reconcile("agent-ide");

		expect(read(storage).stats.agentsStarted).toBe(1);
		expect(read(storage).agents).toEqual([...initial.state.agents, localAgent]);
	});

	it("clears a projection failure only after reconciliation succeeds", async () => {
		const authority = new RejectTwiceLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		const dirty = value({
			...initial.state,
			stats: { agentsStarted: 2 },
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");

		persisted.setItem("agent-ide", dirty);
		await expect(persisted.flush()).rejects.toBe(authority.failure);
		await expect(persisted.reconcile("agent-ide")).rejects.toBe(
			authority.failure,
		);
		await expect(persisted.flush()).rejects.toBe(authority.failure);

		await persisted.reconcile("agent-ide");

		await expect(persisted.flush()).resolves.toBeUndefined();
		expect(read(storage)).toEqual(dirty.state);
	});

	it("does not let reconciliation hide a transaction failure", async () => {
		const authority = new RejectOnceLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		persisted.getItem("agent-ide");
		const noChange = (current: StorageValue<TestState> | null) => ({
			value: current,
			result: undefined,
		});

		await expect(persisted.transact("agent-ide", noChange)).rejects.toBe(
			authority.failure,
		);
		await expect(persisted.reconcile("agent-ide")).rejects.toBe(
			authority.failure,
		);

		await persisted.transact("agent-ide", noChange);
		await expect(persisted.reconcile("agent-ide")).resolves.toBeUndefined();
	});

	it("rebases a queued full projection from the last confirmed durable base", async () => {
		const authority = new RejectOnceLockAuthority();
		const storage = new MemoryStorage();
		const persisted = createReferenceAwareLocalStorage<TestState>({
			coordinator: new DurableWriteCoordinator(authority),
			storage,
			convergeState: convergeTestState,
		});
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		storage.writes.length = 0;
		persisted.getItem("agent-ide");
		const firstProjection = value({
			...initial.state,
			agents: [{ id: "agent-a", generation: "first" }],
		});
		const fullSecondProjection = value({
			...firstProjection.state,
			stats: { agentsStarted: 2 },
		});

		persisted.setItem("agent-ide", firstProjection);
		persisted.setItem("agent-ide", fullSecondProjection);

		await expect(persisted.flush()).resolves.toBeUndefined();
		expect(authority.requests).toBe(2);
		expect(read(storage)).toEqual(fullSecondProjection.state);
	});

	it("keeps a remote merge across a later projection derived from this realm's local ancestor", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const local = createTestStorage(authority, storage);
		const remote = createTestStorage(authority, storage);
		local.getItem("agent-ide");
		remote.getItem("agent-ide");
		const localFirst = value({
			...initial.state,
			agents: [
				...initial.state.agents,
				{ id: "agent-local", generation: "local" },
			],
		});

		remote.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [
					...initial.state.agents,
					{ id: "agent-remote", generation: "remote" },
				],
			}),
		);
		await remote.flush();
		local.setItem("agent-ide", localFirst);
		await local.flush();
		local.setItem(
			"agent-ide",
			value({
				...localFirst.state,
				stats: { agentsStarted: 2 },
			}),
		);
		await local.flush();

		expect(read(storage).agents.map((agent) => agent.id)).toEqual([
			"agent-a",
			"agent-remote",
			"agent-local",
		]);
	});

	it.each(["cleanup-first", "replacement-first"] as const)(
		"persists replacement content and its pin across another writer's Agent cleanup (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const initial = {
				state: appState([exactManagedAgent("source")], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			initial.state.pinnedPanes[`space-a:${panelId}`] = true;
			storage.setItem("agent-ide", JSON.stringify(initial));
			const cleanup = createAppStorage(authority, storage);
			const replacing = createAppStorage(authority, storage);
			cleanup.getItem("agent-ide");
			replacing.getItem("agent-ide");
			const replacement = structuredClone(initial);
			const snapshot = replacement.state.layouts["space-a"] as {
				panels: Record<string, unknown>;
			};
			snapshot.panels[panelId] = {
				id: panelId,
				contentComponent: "terminal",
				params: {
					binding: hmuxLocalBinding("current-shell", "current-workspace"),
				},
			};
			const removeSource = () =>
				writeDurably(cleanup, "agent-ide", {
					...initial,
					state: {
						...initial.state,
						agents: [],
						pinnedPanes: {},
						layouts: {
							"space-a": removePanelIdsFromLayout(
								initial.state.layouts["space-a"],
								new Set([panelId]),
							),
						},
					},
				});
			const replaceContent = () =>
				writeDurably(replacing, "agent-ide", replacement);
			for (const commit of order === "cleanup-first"
				? [removeSource, replaceContent]
				: [replaceContent, removeSource]) {
				await commit();
			}

			const final = readApp(storage);
			expect(final).toEqual({ ...replacement.state, agents: [] });
			const reopened = createAppStorage(authority, storage);
			expect(await reopened.getItem("agent-ide")).toEqual({
				state: final,
				version: 7,
			});
		},
	);

	it.each(["cleanup-first", "successor-first"] as const)(
		"keeps an exact same-id successor and its pane across cleanup (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const source = exactManagedAgent("source");
			const successor = exactManagedAgent("successor");
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const cleanup = createAppStorage(authority, storage);
			const replacing = createAppStorage(authority, storage);
			cleanup.getItem("agent-ide");
			replacing.getItem("agent-ide");
			const removeSource = () =>
				writeDurably(cleanup, "agent-ide", {
					...initial,
					state: {
						...initial.state,
						agents: [],
						layouts: {
							"space-a": removePanelIdsFromLayout(
								initial.state.layouts["space-a"],
								new Set([panelId]),
							),
						},
					},
				});
			const addSuccessor = () =>
				writeDurably(replacing, "agent-ide", {
					...initial,
					state: {
						...initial.state,
						agents: [successor],
					},
				});

			if (order === "cleanup-first") {
				await removeSource();
				await addSuccessor();
			} else {
				await addSuccessor();
				await removeSource();
			}

			const final = readApp(storage);
			expect(final.agents).toEqual([successor]);
			expect(layoutPanelIds(final.layouts["space-a"])).toEqual([
				panelId,
				"file:base",
			]);
		},
	);

	it.each(["legacy", "managed"] as const)(
		"keeps a queued %s same-id replacement and its pane after exact cleanup",
		async (runtime) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const source: Agent =
				runtime === "managed"
					? exactManagedAgent("source")
					: {
							id: "agent-a",
							name: "agent-a",
							provider: "codex",
							projectId: "project-1",
							worktreePath: "/repo",
							branch: "agent/agent-a",
							sessionId: "session-1",
							sessionKind: "pty",
							runtimeBinding: {
								schemaVersion: 1,
								runtime: "legacy_session_v1",
								source: "local",
								hostId: "local",
								sessionId: "session-1",
							} as unknown as Agent["runtimeBinding"],
						};
			const successor: Agent =
				runtime === "managed"
					? exactManagedAgent("successor")
					: {
							...source,
							sessionId: "session-2",
							runtimeBinding: {
								...source.runtimeBinding,
								sessionId: "session-2",
							} as Agent["runtimeBinding"],
						};
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const persisted = createAppStorage(authority, storage);
			persisted.getItem("agent-ide");

			const removal = persisted.transact("agent-ide", (current) => ({
				value: current
					? {
							...current,
							state: {
								...current.state,
								agents: [],
								layouts: {
									"space-a": removePanelIdsFromLayout(
										current.state.layouts["space-a"],
										new Set([panelId]),
									),
								},
							},
						}
					: null,
				result: undefined,
			}));
			persisted.setItem("agent-ide", {
				...initial,
				state: { ...initial.state, agents: [successor] },
			});

			await removal;
			await persisted.flush();

			const final = readApp(storage);
			expect(final.agents).toEqual([successor]);
			expect(layoutPanelIds(final.layouts["space-a"])).toEqual([
				panelId,
				"file:base",
			]);
		},
	);

	it.each([
		["Native-to-Chat", "cleanup-first"],
		["Native-to-Chat", "transition-first"],
		["Chat-to-Native", "cleanup-first"],
		["Chat-to-Native", "transition-first"],
	] as const)(
		"keeps an exact %s successor and its pane across cleanup (%s)",
		async (transition, order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const native = exactManagedAgent("source");
			const structured: Agent = {
				...native,
				runtimeBinding: undefined,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: "local",
					interactionSessionId: "interaction-2",
				},
			};
			const source = transition === "Native-to-Chat" ? native : structured;
			const successor =
				transition === "Native-to-Chat"
					? structured
					: exactManagedAgent("successor");
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const cleanup = createAppStorage(authority, storage);
			const transitioning = createAppStorage(authority, storage);
			cleanup.getItem("agent-ide");
			transitioning.getItem("agent-ide");
			const removeSource = () =>
				writeDurably(cleanup, "agent-ide", {
					...initial,
					state: {
						...initial.state,
						agents: [],
						layouts: {
							"space-a": removePanelIdsFromLayout(
								initial.state.layouts["space-a"],
								new Set([panelId]),
							),
						},
					},
				});
			const commitTransition = () =>
				writeDurably(transitioning, "agent-ide", {
					...initial,
					state: { ...initial.state, agents: [successor] },
				});

			if (order === "cleanup-first") {
				await removeSource();
				await commitTransition();
			} else {
				await commitTransition();
				await removeSource();
			}

			const final = readApp(storage);
			expect(final.agents).toEqual([successor]);
			expect(layoutPanelIds(final.layouts["space-a"])).toEqual([
				panelId,
				"file:base",
			]);
		},
	);

	it("treats an exact credential generation replacement as a successor", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const panelId = "agent:agent-a";
		const source = exactManagedAgent("source");
		const successor: Agent = {
			...source,
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "local",
				operationId: "operation-credential-2",
			},
			executionProfile: {
				kind: "credential_reference",
				reference_id: "hebbian98",
				credential_generation: "credential-2",
			},
		};
		const initial = {
			state: appState([source], {
				"space-a": dockviewLayout([panelId, "file:base"]),
			}),
			version: 7,
		};
		storage.setItem("agent-ide", JSON.stringify(initial));
		const cleanup = createAppStorage(authority, storage);
		const replacing = createAppStorage(authority, storage);
		cleanup.getItem("agent-ide");
		replacing.getItem("agent-ide");

		await writeDurably(cleanup, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				agents: [],
				layouts: {
					"space-a": removePanelIdsFromLayout(
						initial.state.layouts["space-a"],
						new Set([panelId]),
					),
				},
			},
		});
		await writeDurably(replacing, "agent-ide", {
			...initial,
			state: { ...initial.state, agents: [successor] },
		});

		const final = readApp(storage);
		expect(final.agents).toEqual([successor]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual([
			panelId,
			"file:base",
		]);
	});

	it.each(["canonical-operation", "managed-runtime"] as const)(
		"accepts independent exact generation evidence from %s",
		async (evidence) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const source = exactManagedAgent("source");
			const successor =
				evidence === "canonical-operation"
					? {
							...source,
							canonicalSpawn: {
								...source.canonicalSpawn!,
								operationId: "operation-2",
							},
						}
					: exactManagedAgent("successor", {
							canonicalSpawn: source.canonicalSpawn,
						});
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const cleanup = createAppStorage(authority, storage);
			const replacing = createAppStorage(authority, storage);
			cleanup.getItem("agent-ide");
			replacing.getItem("agent-ide");

			await writeDurably(cleanup, "agent-ide", {
				...initial,
				state: {
					...initial.state,
					agents: [],
					layouts: {
						"space-a": removePanelIdsFromLayout(
							initial.state.layouts["space-a"],
							new Set([panelId]),
						),
					},
				},
			});
			await writeDurably(replacing, "agent-ide", {
				...initial,
				state: { ...initial.state, agents: [successor] },
			});

			const final = readApp(storage);
			expect(final.agents).toEqual([successor]);
			expect(layoutPanelIds(final.layouts["space-a"])).toEqual([
				panelId,
				"file:base",
			]);
		},
	);

	it.each(["operation-first", "runtime-first"] as const)(
		"keeps the already durable managed generation snapshot atomic (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const source = exactManagedAgent("source");
			const operationSuccessor: Agent = {
				...source,
				canonicalSpawn: {
					...source.canonicalSpawn!,
					operationId: "operation-2",
				},
			};
			const runtimeSuccessor = exactManagedAgent("successor", {
				canonicalSpawn: source.canonicalSpawn,
				executionProfile: source.executionProfile,
			});
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout(["agent:agent-a"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const firstWriter = createAppStorage(authority, storage);
			const secondWriter = createAppStorage(authority, storage);
			firstWriter.getItem("agent-ide");
			secondWriter.getItem("agent-ide");
			const first =
				order === "operation-first" ? operationSuccessor : runtimeSuccessor;
			const second =
				order === "operation-first" ? runtimeSuccessor : operationSuccessor;

			await writeDurably(firstWriter, "agent-ide", {
				...initial,
				state: { ...initial.state, agents: [first] },
			});
			await writeDurably(secondWriter, "agent-ide", {
				...initial,
				state: {
					...initial.state,
					agents: [{ ...second, displayName: "Concurrent label" }],
				},
			});

			expect(readApp(storage).agents).toEqual([
				{ ...first, displayName: "Concurrent label" },
			]);
		},
	);

	it("merges only display metadata into an exact managed snapshot", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const source = exactManagedAgent("source");
		const durable: Agent = { ...source, started: false };
		const stale: Agent = {
			...source,
			accountId: "account-stale",
			displayName: "Concurrent label",
		};
		const initial = {
			state: appState([source], {
				"space-a": dockviewLayout(["agent:agent-a"]),
			}),
			version: 7,
		};
		storage.setItem("agent-ide", JSON.stringify(initial));
		const durableWriter = createAppStorage(authority, storage);
		const staleWriter = createAppStorage(authority, storage);
		durableWriter.getItem("agent-ide");
		staleWriter.getItem("agent-ide");

		await writeDurably(durableWriter, "agent-ide", {
			...initial,
			state: { ...initial.state, agents: [durable] },
		});
		await writeDurably(staleWriter, "agent-ide", {
			...initial,
			state: { ...initial.state, agents: [stale] },
		});

		expect(readApp(storage).agents).toEqual([
			{ ...durable, displayName: "Concurrent label" },
		]);
	});

	it("preserves a unilateral same-generation workflow update", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const source = exactManagedAgent("source");
		const initial = {
			state: appState([source], {
				"space-a": dockviewLayout(["agent:agent-a"]),
			}),
			version: 7,
		};
		storage.setItem("agent-ide", JSON.stringify(initial));
		const statsWriter = createAppStorage(authority, storage);
		const workflowWriter = createAppStorage(authority, storage);
		statsWriter.getItem("agent-ide");
		workflowWriter.getItem("agent-ide");

		await writeDurably(statsWriter, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				stats: { ...initial.state.stats, agentsStarted: 2 },
			},
		});
		await writeDurably(workflowWriter, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				agents: [{ ...source, started: false }],
			},
		});

		const final = readApp(storage);
		expect(final.stats).toEqual({
			...initial.state.stats,
			agentsStarted: 2,
		});
		expect(final.agents).toEqual([{ ...source, started: false }]);
	});

	it.each(["cleanup-first", "execution-first"] as const)(
		"does not treat an execution-profile-only edit as a successor (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const panelId = "agent:agent-a";
			const source = exactManagedAgent("source");
			const executionEdit: Agent = {
				...source,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "hebbian98",
					credential_generation: "credential-stale",
				},
			};
			const initial = {
				state: appState([source], {
					"space-a": dockviewLayout([panelId, "file:base"]),
				}),
				version: 7,
			};
			storage.setItem("agent-ide", JSON.stringify(initial));
			const cleanup = createAppStorage(authority, storage);
			const editing = createAppStorage(authority, storage);
			cleanup.getItem("agent-ide");
			editing.getItem("agent-ide");
			const removeSource = () =>
				writeDurably(cleanup, "agent-ide", {
					...initial,
					state: {
						...initial.state,
						agents: [],
						layouts: {
							"space-a": removePanelIdsFromLayout(
								initial.state.layouts["space-a"],
								new Set([panelId]),
							),
						},
					},
				});
			const editExecution = () =>
				writeDurably(editing, "agent-ide", {
					...initial,
					state: { ...initial.state, agents: [executionEdit] },
				});

			if (order === "cleanup-first") {
				await removeSource();
				await editExecution();
			} else {
				await editExecution();
				await removeSource();
			}

			const final = readApp(storage);
			expect(final.agents).toEqual([]);
			expect(layoutPanelIds(final.layouts["space-a"])).toEqual(["file:base"]);
		},
	);

	it("lets cleanup remove an unchanged generation with an ordinary rename", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const panelId = "agent:agent-a";
		const source = exactManagedAgent("source");
		const initial = {
			state: appState([source], {
				"space-a": dockviewLayout([panelId, "file:base"]),
			}),
			version: 7,
		};
		storage.setItem("agent-ide", JSON.stringify(initial));
		const cleanup = createAppStorage(authority, storage);
		const renaming = createAppStorage(authority, storage);
		cleanup.getItem("agent-ide");
		renaming.getItem("agent-ide");

		await writeDurably(cleanup, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				agents: [],
				layouts: {
					"space-a": removePanelIdsFromLayout(
						initial.state.layouts["space-a"],
						new Set([panelId]),
					),
				},
			},
		});
		await writeDurably(renaming, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				agents: [{ ...source, displayName: "Renamed" }],
			},
		});

		const final = readApp(storage);
		expect(final.agents).toEqual([]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual(["file:base"]);
	});

	it("keeps a user pane deletion when the exact Agent generation is unchanged", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const panelId = "agent:agent-a";
		const source = exactManagedAgent("source");
		const initial = {
			state: appState([source], {
				"space-a": dockviewLayout([panelId, "file:base"]),
			}),
			version: 7,
		};
		storage.setItem("agent-ide", JSON.stringify(initial));
		const closing = createAppStorage(authority, storage);
		const updating = createAppStorage(authority, storage);
		closing.getItem("agent-ide");
		updating.getItem("agent-ide");

		await writeDurably(updating, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				agents: [{ ...source, displayName: "Renamed" }],
			},
		});
		await writeDurably(closing, "agent-ide", {
			...initial,
			state: {
				...initial.state,
				layouts: {
					"space-a": removePanelIdsFromLayout(
						initial.state.layouts["space-a"],
						new Set([panelId]),
					),
				},
			},
		});

		const final = readApp(storage);
		expect(final.agents).toEqual([{ ...source, displayName: "Renamed" }]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual(["file:base"]);
	});

	it("does not let an unrelated success clear another failure domain", async () => {
		const authority = new RejectOnceLockAuthority();
		const coordinator = new DurableWriteCoordinator(authority);
		const failureScope = {};

		await expect(
			coordinator.run("agent-ide", () => undefined, {
				failureScope,
				failureDomain: "projection",
			}),
		).rejects.toBe(authority.failure);
		await coordinator.run("agent-ide", () => undefined, {
			failureScope,
			failureDomain: "transaction",
		});

		await expect(coordinator.flush(failureScope)).rejects.toBe(
			authority.failure,
		);
		await coordinator.run("agent-ide", () => undefined, {
			failureScope,
			failureDomain: "projection",
		});
		await expect(coordinator.flush(failureScope)).resolves.toBeUndefined();
	});

	it("does not resurrect a deleted Agent from a delayed stale writer", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const removing = createTestStorage(authority, storage);
		const stale = createTestStorage(authority, storage);
		removing.getItem("agent-ide");
		stale.getItem("agent-ide");

		removing.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [],
				layouts: { "space-a": { panels: {} } },
			}),
		);
		await Promise.resolve();
		stale.setItem(
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);
		await Promise.all([removing.flush(), stale.flush()]);

		expect(read(storage)).toEqual({
			agents: [],
			layouts: { "space-a": { panels: {} } },
			stats: { agentsStarted: 2 },
		});
	});

	it.each(["removal-first", "layout-first"] as const)(
		"keeps an exact pane removal and unrelated same-Space layout edits (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const initial = value({
				...sourceState(),
				layouts: {
					"space-a": {
						width: 600,
						panels: {
							"agent:agent-a": { id: "agent:agent-a" },
							"file:base": { id: "file:base" },
						},
					},
				},
			});
			storage.setItem("agent-ide", JSON.stringify(initial));
			const removing = createTestStorage(authority, storage);
			const editing = createTestStorage(authority, storage);
			removing.getItem("agent-ide");
			editing.getItem("agent-ide");
			const removeExact = () =>
				removing.transact("agent-ide", (current) => ({
					value: current
						? {
								...current,
								state: {
									...current.state,
									agents: [],
									layouts: {
										...current.state.layouts,
										"space-a": removePanelIdsFromLayout(
											current.state.layouts["space-a"],
											new Set(["agent:agent-a"]),
										),
									},
								},
							}
						: null,
					result: undefined,
				}));
			const editLayout = () =>
				writeDurably(
					editing,
					"agent-ide",
					value({
						...initial.state,
						layouts: {
							"space-a": {
								width: 900,
								panels: {
									...(
										initial.state.layouts["space-a"] as {
											panels: Record<string, unknown>;
										}
									).panels,
									"file:added": { id: "file:added" },
								},
							},
						},
					}),
				);

			if (order === "removal-first") {
				await removeExact();
				await editLayout();
			} else {
				await editLayout();
				await removeExact();
			}

			const final = read(storage);
			const layout = final.layouts["space-a"] as {
				width: number;
				panels: Record<string, unknown>;
			};
			expect(final.agents).toEqual([]);
			expect(layout.width).toBe(900);
			expect(layout.panels).not.toHaveProperty("agent:agent-a");
			expect(layout.panels).toHaveProperty("file:base");
			expect(layout.panels).toHaveProperty("file:added");
		},
	);

	it("does not give an unchanged predecessor authority to restore its stopped pane", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const panelId = "agent:agent-a";
		const initial = value({
			...sourceState(),
			layouts: { "space-a": dockviewLayout([panelId, "file:base"]) },
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		const stopping = createTestStorage(authority, storage);
		const stale = createTestStorage(authority, storage);
		stopping.getItem("agent-ide");
		stale.getItem("agent-ide");

		await writeDurably(
			stopping,
			"agent-ide",
			value({
				...initial.state,
				agents: [],
				layouts: {
					"space-a": removePanelIdsFromLayout(
						initial.state.layouts["space-a"],
						new Set([panelId]),
					),
				},
			}),
		);
		await writeDurably(
			stale,
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);

		const final = read(storage);
		expect(final.agents).toEqual([]);
		expect(layoutPanelIds(final.layouts["space-a"])).toEqual(["file:base"]);
	});

	it("does not resurrect a user-closed pane from an unrelated stale projection", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const closedPanelId = "file:closed";
		const initial = value({
			...sourceState(),
			layouts: {
				"space-a": dockviewLayout(["file:base", closedPanelId]),
			},
		});
		storage.setItem("agent-ide", JSON.stringify(initial));
		const closing = createTestStorage(authority, storage);
		const stale = createTestStorage(authority, storage);
		closing.getItem("agent-ide");
		stale.getItem("agent-ide");

		await writeDurably(
			closing,
			"agent-ide",
			value({
				...initial.state,
				layouts: {
					"space-a": removePanelIdsFromLayout(
						initial.state.layouts["space-a"],
						new Set([closedPanelId]),
					),
				},
			}),
		);
		await writeDurably(
			stale,
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);

		expect(layoutPanelIds(read(storage).layouts["space-a"])).toEqual([
			"file:base",
		]);
	});

	it.each(["first-then-second", "second-then-first"] as const)(
		"merges concurrent pane additions in one existing Space (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const initial = value({
				...sourceState(),
				layouts: { "space-a": dockviewLayout(["file:base"]) },
			});
			storage.setItem("agent-ide", JSON.stringify(initial));
			const first = createTestStorage(authority, storage);
			const second = createTestStorage(authority, storage);
			first.getItem("agent-ide");
			second.getItem("agent-ide");
			const addFirst = () =>
				writeDurably(
					first,
					"agent-ide",
					value({
						...initial.state,
						layouts: {
							"space-a": dockviewLayout(["file:base", "file:first"]),
						},
					}),
				);
			const addSecond = () =>
				writeDurably(
					second,
					"agent-ide",
					value({
						...initial.state,
						layouts: {
							"space-a": dockviewLayout(["file:base", "file:second"]),
						},
					}),
				);

			if (order === "first-then-second") {
				await addFirst();
				await addSecond();
			} else {
				await addSecond();
				await addFirst();
			}

			expect(layoutPanelIds(read(storage).layouts["space-a"])).toEqual([
				"file:base",
				"file:first",
				"file:second",
			]);
		},
	);

	it.each(["first-then-second", "second-then-first"] as const)(
		"merges concurrent first panes in a newly created Space (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const initial = value({ ...sourceState(), layouts: {} });
			storage.setItem("agent-ide", JSON.stringify(initial));
			const first = createTestStorage(authority, storage);
			const second = createTestStorage(authority, storage);
			first.getItem("agent-ide");
			second.getItem("agent-ide");
			const addFirst = () =>
				writeDurably(
					first,
					"agent-ide",
					value({
						...initial.state,
						layouts: { "space-new": dockviewLayout(["file:first"]) },
					}),
				);
			const addSecond = () =>
				writeDurably(
					second,
					"agent-ide",
					value({
						...initial.state,
						layouts: { "space-new": dockviewLayout(["file:second"]) },
					}),
				);

			if (order === "first-then-second") {
				await addFirst();
				await addSecond();
			} else {
				await addSecond();
				await addFirst();
			}

			expect(layoutPanelIds(read(storage).layouts["space-new"])).toEqual([
				"file:first",
				"file:second",
			]);
		},
	);

	it.each(["resize-then-add", "add-then-resize"] as const)(
		"keeps an existing Space resize and concurrent pane addition (%s)",
		async (order) => {
			const authority = new SharedTestLockAuthority();
			const storage = new MemoryStorage();
			const initial = value({
				...sourceState(),
				layouts: { "space-a": dockviewLayout(["file:base"]) },
			});
			storage.setItem("agent-ide", JSON.stringify(initial));
			const resizing = createTestStorage(authority, storage);
			const adding = createTestStorage(authority, storage);
			resizing.getItem("agent-ide");
			adding.getItem("agent-ide");
			const resize = () =>
				writeDurably(
					resizing,
					"agent-ide",
					value({
						...initial.state,
						layouts: {
							"space-a": dockviewLayout(["file:base"], {
								width: 900,
								baseSize: 900,
							}),
						},
					}),
				);
			const add = () =>
				writeDurably(
					adding,
					"agent-ide",
					value({
						...initial.state,
						layouts: {
							"space-a": dockviewLayout(["file:base", "file:added"]),
						},
					}),
				);

			if (order === "resize-then-add") {
				await resize();
				await add();
			} else {
				await add();
				await resize();
			}

			const layout = read(storage).layouts["space-a"] as {
				grid: { width: number };
			};
			expect(layout.grid.width).toBe(900);
			expect(layoutPanelIds(layout)).toEqual(["file:added", "file:base"]);
		},
	);

	it("does not let a stale removeItem erase a newer remote projection", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const newer = createTestStorage(authority, storage);
		const stale = createTestStorage(authority, storage);
		newer.getItem("agent-ide");
		stale.getItem("agent-ide");
		const successor = { id: "agent-a", generation: "successor" };

		newer.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [successor],
			}),
		);
		await Promise.resolve();
		stale.removeItem("agent-ide");
		await Promise.all([newer.flush(), stale.flush()]);

		expect(read(storage).agents).toEqual([successor]);
	});

	it("does not resurrect a stale Agent from a durable update queued after removal", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const persisted = createTestStorage(authority, storage);
		persisted.getItem("agent-ide");

		const removal = persisted.transact("agent-ide", (current) => ({
			value: current
				? {
						...current,
						state: { ...current.state, agents: [] },
					}
				: null,
			result: undefined,
		}));
		await removal;
		persisted.setItem(
			"agent-ide",
			value({
				...initial.state,
				stats: { agentsStarted: 2 },
			}),
		);
		await persisted.flush();

		expect(read(storage)).toEqual({
			agents: [],
			layouts: initial.state.layouts,
			stats: { agentsStarted: 2 },
		});
	});

	it("keeps runtime-only updates as no-ops while a transaction is pending", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const persisted = createTestStorage(authority, storage);
		persisted.getItem("agent-ide");
		storage.writes.length = 0;

		const removal = persisted.transact("agent-ide", (current) => ({
			value: current
				? {
						...current,
						state: { ...current.state, agents: [] },
					}
				: null,
			result: undefined,
		}));
		persisted.setItem("agent-ide", {
			...initial,
			state: { ...initial.state },
		});
		await removal;
		await persisted.flush();

		expect(read(storage).agents).toEqual([]);
		expect(storage.writes).toHaveLength(1);
	});

	it("flush includes a write enqueued while the observed tail is pending", async () => {
		const authority = new SharedTestLockAuthority();
		const coordinator = new DurableWriteCoordinator(authority);
		let releaseFirst: (() => void) | undefined;
		const first = coordinator.run(
			"agent-ide",
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = resolve;
				}),
		);
		await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
		const flushing = coordinator.flush();
		let secondFinished = false;
		const second = coordinator.run("agent-ide", () => {
			secondFinished = true;
		});
		releaseFirst?.();

		await flushing;

		expect(secondFinished).toBe(true);
		await Promise.all([first, second]);
	});

	it("merges unrelated Agent and Space layout changes from two coordinators", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const initial = value(sourceState());
		storage.setItem("agent-ide", JSON.stringify(initial));
		const first = createTestStorage(authority, storage);
		const second = createTestStorage(authority, storage);
		first.getItem("agent-ide");
		second.getItem("agent-ide");

		first.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [
					...initial.state.agents,
					{ id: "agent-first", generation: "first" },
				],
				layouts: {
					...initial.state.layouts,
					"space-first": { panels: { "agent:agent-first": {} } },
				},
			}),
		);
		await Promise.resolve();
		second.setItem(
			"agent-ide",
			value({
				...initial.state,
				agents: [
					...initial.state.agents,
					{ id: "agent-second", generation: "second" },
				],
				layouts: {
					...initial.state.layouts,
					"space-second": { panels: { "agent:agent-second": {} } },
				},
			}),
		);
		await Promise.all([first.flush(), second.flush()]);

		expect(read(storage).agents.map((agent) => agent.id)).toEqual([
			"agent-a",
			"agent-first",
			"agent-second",
		]);
		expect(Object.keys(read(storage).layouts).sort()).toEqual([
			"space-a",
			"space-first",
			"space-second",
		]);
	});

	it("merges concurrent first projections without an existing base", async () => {
		const authority = new SharedTestLockAuthority();
		const storage = new MemoryStorage();
		const first = createTestStorage(authority, storage);
		const second = createTestStorage(authority, storage);
		first.getItem("agent-ide");
		second.getItem("agent-ide");

		first.setItem(
			"agent-ide",
			value({
				agents: [{ id: "agent-first", generation: "first" }],
				layouts: { "space-first": { panels: {} } },
				stats: { agentsStarted: 1 },
			}),
		);
		await Promise.resolve();
		second.setItem(
			"agent-ide",
			value({
				agents: [{ id: "agent-second", generation: "second" }],
				layouts: { "space-second": { panels: {} } },
				stats: { agentsStarted: 1 },
			}),
		);
		await Promise.all([first.flush(), second.flush()]);

		expect(read(storage).agents.map((agent) => agent.id)).toEqual([
			"agent-first",
			"agent-second",
		]);
		expect(Object.keys(read(storage).layouts).sort()).toEqual([
			"space-first",
			"space-second",
		]);
	});
});
