import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClientViewAuthorityV1,
	type ClientViewIdentityV1,
	type ClientViewNamespaceV1,
	type ClientViewPresentationV1,
	type ClientViewRecordV1,
	type ClientViewStateTransport,
	type ClientViewTransportError,
	type ClientViewTransportResult,
	type ClientViewWriteRequestV1,
	EMPTY_CLIENT_VIEW_PRESENTATION_V1,
} from "@/lib/workspace/clientViewState";
import { createClientViewStateSync } from "@/lib/workspace/clientViewStateSync";

afterEach(() => {
	vi.useRealTimers();
});

const namespace = (clientId = "client-1"): ClientViewNamespaceV1 => ({
	tenantId: "tenant-1",
	userId: "user-1",
	clientId,
});

const presentation = (
	selectedSessionId: string | null = null,
): ClientViewPresentationV1 => ({
	...EMPTY_CLIENT_VIEW_PRESENTATION_V1,
	selectedSessionId,
	selectedSpaceId: "space-1",
});

const authority = (
	clientInstanceId = "instance-1",
	clientGeneration = 1,
	clientId = "client-1",
): ClientViewAuthorityV1 => ({
	schemaVersion: 1,
	namespace: namespace(clientId),
	clientGeneration,
	clientInstanceId,
	updatedAtMs: 1_000 + clientGeneration,
});

const identity = (
	clientInstanceId = "instance-1",
	clientGeneration = 1,
	clientId = "client-1",
): ClientViewIdentityV1 => ({
	namespace: namespace(clientId),
	clientGeneration,
	clientInstanceId,
	viewId: "workspace-main",
});

const record = (
	revision: number,
	state: ClientViewPresentationV1,
	viewIdentity = identity(),
): ClientViewRecordV1 => ({
	schemaVersion: 1,
	identity: viewIdentity,
	revision,
	presentation: state,
	updatedAtMs: 2_000 + revision,
});

const ok = <T>(value: T): ClientViewTransportResult<T> => ({
	ok: true,
	value,
});

const failure = <T>(
	error: ClientViewTransportError,
): ClientViewTransportResult<T> => ({
	ok: false,
	error,
});

function transportWith(
	overrides: Partial<ClientViewStateTransport> = {},
): ClientViewStateTransport {
	return {
		readAuthority: async () => ok(authority()),
		advanceGeneration: async () =>
			failure({ kind: "fatal", message: "unexpected generation advance" }),
		readView: async () => ok(null),
		writeView: async (request) =>
			ok({
				schemaVersion: 1,
				idempotencyKey: request.idempotencyKey,
				record: record(
					request.expectedRevision + 1,
					request.presentation,
					request.identity,
				),
			}),
		...overrides,
	};
}

function memoryTransport(): {
	transport: ClientViewStateTransport;
	writes: ReturnType<typeof vi.fn<ClientViewStateTransport["writeView"]>>;
} {
	const authorities = new Map<string, ClientViewAuthorityV1>();
	const records = new Map<string, ClientViewRecordV1>();
	const namespaceKey = (value: ClientViewNamespaceV1) => JSON.stringify(value);
	const recordKey = (value: ClientViewIdentityV1) => JSON.stringify(value);

	const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
		async (request) => {
			const current = records.get(recordKey(request.identity));
			const actualRevision = current?.revision ?? 0;
			if (request.expectedRevision !== actualRevision) {
				return failure({
					kind: "revision_conflict",
					actualRevision,
					message: "revision changed",
				});
			}
			const next = record(
				actualRevision + 1,
				request.presentation,
				request.identity,
			);
			records.set(recordKey(request.identity), next);
			return ok({
				schemaVersion: 1 as const,
				idempotencyKey: request.idempotencyKey,
				record: next,
			});
		},
	);

	return {
		transport: {
			readAuthority: async (value) =>
				ok(authorities.get(namespaceKey(value)) ?? null),
			advanceGeneration: async (request) => {
				const nextAuthority: ClientViewAuthorityV1 = {
					schemaVersion: 1,
					namespace: request.namespace,
					clientGeneration: request.expectedGeneration + 1,
					clientInstanceId: request.nextInstanceId,
					updatedAtMs: 1_000,
				};
				authorities.set(namespaceKey(request.namespace), nextAuthority);
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					authority: nextAuthority,
				});
			},
			readView: async (value) => ok(records.get(recordKey(value)) ?? null),
			writeView,
		},
		writes: writeView,
	};
}

function createSync(
	transport: ClientViewStateTransport,
	overrides: Partial<Parameters<typeof createClientViewStateSync>[0]> = {},
) {
	let key = 0;
	return createClientViewStateSync({
		namespace: namespace(),
		viewId: "workspace-main",
		clientInstanceId: "instance-1",
		initialPresentation: presentation(),
		transport,
		debounceMs: 10,
		retryDelayMs: () => 5,
		makeIdempotencyKey: () => `request-${++key}`,
		...overrides,
	});
}

describe("client view state synchronization", () => {
	it("isolates client namespaces and coalesces each local burst", async () => {
		vi.useFakeTimers();
		const memory = memoryTransport();
		const first = createSync(memory.transport);
		const second = createSync(memory.transport, {
			namespace: namespace("client-2"),
			clientInstanceId: "instance-2",
		});
		await Promise.all([first.start(), second.start()]);

		first.update((current) => ({
			...current,
			selectedSessionId: "session-first-old",
		}));
		first.update((current) => ({
			...current,
			selectedSessionId: "session-first-final",
		}));
		second.update((current) => ({
			...current,
			selectedSessionId: "session-second",
		}));

		expect(first.getSnapshot().presentation.selectedSessionId).toBe(
			"session-first-final",
		);
		expect(second.getSnapshot().presentation.selectedSessionId).toBe(
			"session-second",
		);
		expect(memory.writes).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(10);

		expect(memory.writes).toHaveBeenCalledTimes(2);
		const requests = memory.writes.mock.calls.map(([request]) => request);
		expect(requests).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					identity: expect.objectContaining({
						namespace: namespace("client-1"),
					}),
					presentation: expect.objectContaining({
						selectedSessionId: "session-first-final",
					}),
				}),
				expect.objectContaining({
					identity: expect.objectContaining({
						namespace: namespace("client-2"),
					}),
					presentation: expect.objectContaining({
						selectedSessionId: "session-second",
					}),
				}),
			]),
		);
		expect(first.getSnapshot()).toMatchObject({ dirty: false, revision: 1 });
		expect(second.getSnapshot()).toMatchObject({ dirty: false, revision: 1 });
	});

	it("bounds automatic reconnect retries and reuses the idempotency key", async () => {
		vi.useFakeTimers();
		let unavailable = true;
		const requests: ClientViewWriteRequestV1[] = [];
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) => {
				requests.push(request);
				if (unavailable) {
					return failure({ kind: "unavailable", message: "backend offline" });
				}
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(1, request.presentation, request.identity),
				});
			},
		);
		const sync = createSync(transportWith({ writeView }), {
			maxAutomaticRetries: 2,
		});
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-offline",
		}));

		await vi.advanceTimersByTimeAsync(20);

		expect(writeView).toHaveBeenCalledTimes(3);
		expect(new Set(requests.map((request) => request.idempotencyKey))).toEqual(
			new Set(["request-1"]),
		);
		expect(sync.getSnapshot()).toMatchObject({
			phase: "offline",
			dirty: true,
			automaticRetryCount: 3,
		});

		unavailable = false;
		expect(await sync.retry()).toEqual({ status: "synced", revision: 1 });
		expect(writeView).toHaveBeenCalledTimes(4);
		expect(requests[3].idempotencyKey).toBe("request-1");
		expect(sync.getSnapshot()).toMatchObject({ phase: "ready", dirty: false });
	});

	it("keeps the offline phase stable while local input continues", async () => {
		vi.useFakeTimers();
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(async () =>
			failure({ kind: "unavailable", message: "backend offline" }),
		);
		const sync = createSync(transportWith({ writeView }), {
			maxAutomaticRetries: 0,
		});
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "first-input",
		}));
		await sync.flush();
		expect(sync.getSnapshot()).toMatchObject({
			phase: "offline",
			lastError: { kind: "unavailable" },
		});

		expect(
			sync.update((current) => ({
				...current,
				selectedSessionId: "input-while-offline",
			})),
		).toBe(true);
		expect(sync.getSnapshot()).toMatchObject({
			phase: "offline",
			presentation: { selectedSessionId: "input-while-offline" },
			lastError: { kind: "unavailable" },
		});
		expect(writeView).toHaveBeenCalledTimes(1);
	});

	it("reinitializes instead of mixing revisions after a backend change", async () => {
		vi.useFakeTimers();
		const readView = vi
			.fn<ClientViewStateTransport["readView"]>()
			.mockResolvedValueOnce(ok(record(4, presentation("remote-a"))))
			.mockResolvedValueOnce(ok(record(7, presentation("remote-b"))));
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(async () =>
			failure({
				kind: "backend_changed",
				message: "selected backend changed",
			}),
		);
		const sync = createSync(transportWith({ readView, writeView }));
		expect(await sync.start()).toEqual({ status: "synced", revision: 4 });
		sync.update(presentation("local-edit"));

		expect(await sync.flush()).toMatchObject({
			status: "deferred",
			reason: "transport",
		});
		expect(sync.getSnapshot()).toMatchObject({
			phase: "offline",
			revision: 0,
			dirty: true,
			lastError: { kind: "backend_changed" },
		});

		await vi.advanceTimersByTimeAsync(5);
		expect(sync.getSnapshot()).toMatchObject({
			phase: "conflict",
			conflict: {
				fields: ["selectedSessionId"],
				local: { selectedSessionId: "local-edit" },
				remote: { selectedSessionId: "remote-b" },
				remoteRevision: 7,
			},
		});
		expect(writeView).toHaveBeenCalledTimes(1);
	});

	it("three-way merges non-overlapping revision changes before retrying", async () => {
		const base = {
			...presentation("session-base"),
			layout: [
				{ paneId: "pane-1", groupId: "left", order: 0, sizeBasisPoints: 5000 },
			],
		};
		const remote = {
			...base,
			layout: [
				{ paneId: "pane-1", groupId: "right", order: 0, sizeBasisPoints: 7000 },
			],
		};
		const readView = vi
			.fn<ClientViewStateTransport["readView"]>()
			.mockResolvedValueOnce(ok(record(1, base)))
			.mockResolvedValueOnce(ok(record(2, remote)));
		let writes = 0;
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) => {
				writes += 1;
				if (writes === 1) {
					return failure({
						kind: "revision_conflict",
						actualRevision: 2,
						message: "another window changed layout",
					});
				}
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(3, request.presentation, request.identity),
				});
			},
		);
		const sync = createSync(transportWith({ readView, writeView }));
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-local",
		}));

		expect(await sync.flush()).toEqual({ status: "synced", revision: 3 });
		expect(writeView).toHaveBeenCalledTimes(2);
		expect(writeView.mock.calls[1][0]).toMatchObject({
			expectedRevision: 2,
			presentation: {
				selectedSessionId: "session-local",
				layout: remote.layout,
			},
		});
	});

	it("surfaces overlapping changes without a blind overwrite", async () => {
		vi.useFakeTimers();
		const base = presentation("session-base");
		const remote = presentation("session-remote");
		const readView = vi
			.fn<ClientViewStateTransport["readView"]>()
			.mockResolvedValueOnce(ok(record(1, base)))
			.mockResolvedValueOnce(ok(record(2, remote)));
		let conflictReturned = false;
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) => {
				if (!conflictReturned) {
					conflictReturned = true;
					return failure({
						kind: "revision_conflict",
						actualRevision: 2,
						message: "selection changed",
					});
				}
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(3, request.presentation, request.identity),
				});
			},
		);
		const sync = createSync(transportWith({ readView, writeView }));
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-local",
		}));

		const result = await sync.flush();
		expect(result).toMatchObject({
			status: "conflict",
			conflict: {
				reason: "overlapping_changes",
				fields: ["selectedSessionId"],
			},
		});
		expect(writeView).toHaveBeenCalledTimes(1);

		sync.update((current) => ({ ...current, selectedPaneId: "pane-later" }));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(writeView).toHaveBeenCalledTimes(1);

		expect(
			sync.resolveConflict({
				...sync.getSnapshot().presentation,
				selectedSessionId: "session-local",
			}),
		).toBe(true);
		expect(await sync.flush()).toEqual({ status: "synced", revision: 3 });
		expect(writeView).toHaveBeenCalledTimes(2);
	});

	it("stops a stale instance instead of stealing a newer generation", async () => {
		const replacement = authority("instance-new", 2);
		const readAuthority = vi
			.fn<ClientViewStateTransport["readAuthority"]>()
			.mockResolvedValueOnce(ok(authority()))
			.mockResolvedValueOnce(ok(replacement));
		const advanceGeneration =
			vi.fn<ClientViewStateTransport["advanceGeneration"]>();
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(async () =>
			failure({
				kind: "generation_conflict",
				actualGeneration: 2,
				message: "generation changed",
			}),
		);
		const sync = createSync(
			transportWith({ readAuthority, advanceGeneration, writeView }),
		);
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "late-write",
		}));

		expect(await sync.flush()).toEqual({
			status: "fenced",
			authority: replacement,
		});
		expect(advanceGeneration).not.toHaveBeenCalled();
		expect(
			sync.update((current) => ({
				...current,
				selectedSessionId: "local-only-after-fence",
			})),
		).toBe(true);
		expect(await sync.retry()).toEqual({
			status: "fenced",
			authority: replacement,
		});
		expect(sync.getSnapshot().presentation.selectedSessionId).toBe(
			"local-only-after-fence",
		);
		expect(writeView).toHaveBeenCalledTimes(1);
	});

	it("loses a concurrent startup generation race without reclaiming it", async () => {
		const previous = authority("instance-previous", 1);
		const winner = authority("instance-winner", 2);
		const readAuthority = vi
			.fn<ClientViewStateTransport["readAuthority"]>()
			.mockResolvedValueOnce(ok(previous))
			.mockResolvedValueOnce(ok(winner));
		const advanceGeneration = vi.fn<
			ClientViewStateTransport["advanceGeneration"]
		>(async () =>
			failure({
				kind: "generation_conflict",
				actualGeneration: 2,
				message: "another instance advanced first",
			}),
		);
		const readView = vi.fn<ClientViewStateTransport["readView"]>();
		const sync = createSync(
			transportWith({ readAuthority, advanceGeneration, readView }),
		);

		expect(await sync.start()).toEqual({
			status: "fenced",
			authority: winner,
		});
		expect(advanceGeneration).toHaveBeenCalledTimes(1);
		expect(readView).not.toHaveBeenCalled();
		expect(await sync.retry()).toEqual({
			status: "fenced",
			authority: winner,
		});
	});

	it("keeps local presentation usable after a fatal persistence error", async () => {
		vi.useFakeTimers();
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>();
		const sync = createSync(
			transportWith({
				readAuthority: async () =>
					failure({
						kind: "unsupported",
						message: "backend lacks client view capability",
					}),
				writeView,
			}),
		);
		expect(await sync.start()).toMatchObject({ status: "fatal" });

		expect(sync.update(presentation("local-only"))).toBe(true);
		expect(sync.getSnapshot()).toMatchObject({
			phase: "fatal",
			presentation: { selectedSessionId: "local-only" },
			lastError: { kind: "unsupported" },
		});
		await vi.runAllTimersAsync();
		expect(writeView).not.toHaveBeenCalled();
	});

	it("coalesces an update arriving behind an active write", async () => {
		let releaseFirst: (() => void) | undefined;
		const firstBarrier = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let writes = 0;
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) => {
				writes += 1;
				if (writes === 1) await firstBarrier;
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(writes, request.presentation, request.identity),
				});
			},
		);
		const sync = createSync(transportWith({ writeView }));
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-first",
		}));
		const flushing = sync.flush();
		await vi.waitFor(() => expect(writeView).toHaveBeenCalledTimes(1));
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-final",
		}));
		releaseFirst?.();

		expect(await flushing).toEqual({ status: "synced", revision: 2 });
		expect(writeView).toHaveBeenCalledTimes(2);
		expect(writeView.mock.calls[1][0].presentation.selectedSessionId).toBe(
			"session-final",
		);
	});

	it("flushes once on shutdown and strips fields outside the wire contract", async () => {
		vi.useFakeTimers();
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) =>
				ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(1, request.presentation, request.identity),
				}),
		);
		const sync = createSync(transportWith({ writeView }));
		await sync.start();
		sync.update({
			...presentation("session-shutdown"),
			credential: "must-not-cross-the-boundary",
		} as ClientViewPresentationV1);

		expect(await sync.shutdown()).toEqual({ status: "synced", revision: 1 });
		expect(writeView).toHaveBeenCalledTimes(1);
		expect(writeView.mock.calls[0][0].presentation).not.toHaveProperty(
			"credential",
		);
		expect(sync.getSnapshot().phase).toBe("closed");
		await vi.runAllTimersAsync();
		expect(writeView).toHaveBeenCalledTimes(1);
	});

	it("waits for an in-flight write before a no-flush shutdown closes", async () => {
		let releaseWrite: (() => void) | undefined;
		const writeBarrier = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const writeView = vi.fn<ClientViewStateTransport["writeView"]>(
			async (request) => {
				await writeBarrier;
				return ok({
					schemaVersion: 1 as const,
					idempotencyKey: request.idempotencyKey,
					record: record(1, request.presentation, request.identity),
				});
			},
		);
		const sync = createSync(transportWith({ writeView }));
		await sync.start();
		sync.update((current) => ({
			...current,
			selectedSessionId: "session-in-flight",
		}));
		const flushing = sync.flush();
		await vi.waitFor(() => expect(writeView).toHaveBeenCalledTimes(1));
		let shutdownResolved = false;
		const shuttingDown = sync.shutdown({ flush: false }).then((result) => {
			shutdownResolved = true;
			return result;
		});
		await Promise.resolve();
		expect(shutdownResolved).toBe(false);

		releaseWrite?.();
		expect(await flushing).toEqual({ status: "synced", revision: 1 });
		expect(await shuttingDown).toEqual({ status: "synced", revision: 1 });
		expect(sync.getSnapshot().phase).toBe("closed");
		expect(sync.update(presentation("after-close"))).toBe(false);
	});
});
