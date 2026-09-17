import { describe, expect, it, vi } from "vitest";
import { AgentChatSessionController } from "@/lib/agents/chat/agentChatSessionController";
import type { AgentTimelineReadV1 } from "@/lib/agents/chat/agentConversationContract";
import type {
	AgentConversationInvalidationV1,
	DureAgentConversationClient,
} from "@/lib/ipc/dureAgentConversation";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const ROUTE_AUTHORITY = testDureBackendRouteAuthority("backend", "one");

function read(providerId = "claude"): AgentTimelineReadV1 {
	return {
		type: "page",
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				agentId: "agent-1",
				providerId,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: {
					runtimeGeneration: "runtime-1",
					providerEpoch: "query-1",
				},
				timelineEpoch: "timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 1,
				updatedAtMs: 1,
			},
			rows: [],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 0 },
			hasMore: false,
		},
	};
}

function client(initial: AgentTimelineReadV1 = read()) {
	if (initial.type !== "page") throw new Error("expected page fixture");
	let invalidation:
		| ((event: AgentConversationInvalidationV1) => void)
		| undefined;
	const close = vi.fn(async () => {});
	const transport: DureAgentConversationClient = {
		putGoal: async () => {
			throw new Error("unused fixture goal write");
		},
		inspect: vi.fn(async () => ({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			binding: initial.page.binding,
		})),
		recover: vi.fn(async (binding) => binding),
		read: vi.fn(async () => ({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: read(),
		})),
		subscribe: vi.fn(async (_request, onInvalidation) => {
			invalidation = onInvalidation;
			return {
				subscriptionId: "subscription-1",
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				initial,
				close,
			};
		}),
		startTurn: vi.fn(async () => "accepted" as const),
		steerTurn: vi.fn(async () => {}),
		answerPending: vi.fn(async () => {}),
		interruptTurn: vi.fn(async () => {}),
	};
	return { close, invalidation: () => invalidation, transport };
}

async function settle() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function runtimeUnavailable() {
	return new DureBackendRequestError(
		"agent_conversation_runtime_unavailable",
		"runtime unavailable",
		{ kind: "operation", disposition: "retry_same" },
	);
}

function terminalProviderFailure() {
	return new DureBackendRequestError(
		"agent_conversation_provider_failed",
		"provider failed",
		{ kind: "operation", disposition: "terminal" },
	);
}

function authorityChanged() {
	return new DureBackendRequestError(
		"backend_transport_authority_changed",
		"backend route changed",
		{ kind: "authority_changed" },
	);
}

function recoveryConflict() {
	return new DureBackendRequestError(
		"agent_conversation_conflict",
		"conversation binding changed",
		{ kind: "operation", disposition: "retry_same" },
	);
}

function staleGeneration() {
	return new DureBackendRequestError(
		"agent_conversation_conflict",
		"conversation generation changed",
		{ kind: "operation", disposition: "stale_generation" },
	);
}

function messageRow(sequence: number) {
	return {
		cursor: { epoch: "timeline-1", sequence },
		item: {
			itemId: `item-${sequence}`,
			turnId: null,
			clientMessageId: null,
			providerMessageId: `provider-message-${sequence}`,
			body: {
				type: "message" as const,
				role: "assistant" as const,
				markdown: `${sequence}`,
			},
			createdAtMs: sequence,
		},
	};
}

function delta(sequence: number, hasMore = false): AgentTimelineReadV1 {
	return deltaRange(sequence, sequence, hasMore);
}

function deltaRange(
	firstSequence: number,
	lastSequence: number,
	hasMore = false,
): AgentTimelineReadV1 {
	const value = read();
	if (value.type !== "page") throw new Error("expected page fixture");
	value.page.finalCursor.sequence = lastSequence;
	value.page.hasMore = hasMore;
	value.page.rows = Array.from(
		{ length: lastSequence - firstSequence + 1 },
		(_, index) => messageRow(firstSequence + index),
	);
	return value;
}

describe("AgentChatSessionController", () => {
	it("attaches through inspect plus one subscription and detaches only the observer", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		expect(controller.getSnapshot().phase).toBe("ready");
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(1);
		expect(fixture.transport.subscribe).toHaveBeenCalledTimes(1);

		controller.stop();
		await settle();
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot().phase).toBe("detached");
	});

	it("loads every older page from the retained oldest cursor", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [messageRow(5), messageRow(6)];
		initial.page.finalCursor.sequence = 6;
		initial.page.hasMore = true;
		const fixture = client(initial);
		vi.mocked(fixture.transport.read)
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: {
					type: "page",
					page: {
						...initial.page,
						rows: [messageRow(3), messageRow(4)],
						finalCursor: { epoch: "timeline-1", sequence: 3 },
						hasMore: true,
					},
				},
			})
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: {
					type: "page",
					page: {
						...initial.page,
						rows: [messageRow(1), messageRow(2)],
						finalCursor: { epoch: "timeline-1", sequence: 1 },
						hasMore: false,
					},
				},
			});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();

		await controller.loadOlder();
		await controller.loadOlder();

		expect(
			vi.mocked(fixture.transport.read).mock.calls.map(([request]) => ({
				direction: request.direction,
				cursor: request.cursor?.sequence,
			})),
		).toEqual([
			{ direction: "before", cursor: 5 },
			{ direction: "before", cursor: 3 },
		]);
		expect(
			controller.getSnapshot().page?.rows.map((row) => row.cursor.sequence),
		).toEqual([1, 2, 3, 4, 5, 6]);
		expect(controller.getSnapshot()).toMatchObject({
			loadingOlder: false,
			page: { hasMore: false, finalCursor: { sequence: 6 } },
		});
	});

	it("retains explicitly loaded history when the transcript crosses the tail cap", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [messageRow(127), messageRow(128)];
		initial.page.finalCursor.sequence = 128;
		initial.page.hasMore = true;
		const fixture = client(initial);
		vi.mocked(fixture.transport.read)
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: {
					type: "page",
					page: {
						...initial.page,
						rows: Array.from({ length: 126 }, (_, index) =>
							messageRow(index + 1),
						),
						finalCursor: { epoch: "timeline-1", sequence: 1 },
						hasMore: false,
					},
				},
			})
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: delta(129),
			});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();

		await controller.loadOlder();
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 129 },
			kinds: ["timeline"],
		});
		await vi.waitFor(() =>
			expect(controller.getSnapshot().page?.finalCursor.sequence).toBe(129),
		);

		const page = controller.getSnapshot().page;
		expect(page?.rows).toHaveLength(129);
		expect(page?.rows[0]?.cursor.sequence).toBe(1);
	});

	it("coalesces older loads and rebases them over a concurrent live refresh", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = Array.from({ length: 128 }, (_, index) =>
			messageRow(index + 129),
		);
		initial.page.finalCursor.sequence = 256;
		initial.page.hasMore = true;
		const fixture = client(initial);
		let resolveOlder:
			| ((value: Awaited<ReturnType<typeof fixture.transport.read>>) => void)
			| undefined;
		let afterPage = 0;
		vi.mocked(fixture.transport.read).mockImplementation(async (request) => {
			if (request.direction === "before") {
				return await new Promise((resolve) => {
					resolveOlder = resolve;
				});
			}
			const read =
				afterPage === 0
					? deltaRange(257, 384, true)
					: afterPage === 1
						? deltaRange(385, 512)
						: delta(513);
			afterPage += 1;
			return {
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read,
			};
		});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();

		const first = controller.loadOlder();
		const second = controller.loadOlder();
		expect(first).toBe(second);
		expect(controller.getSnapshot().loadingOlder).toBe(true);
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 257 },
			kinds: ["timeline"],
		});
		await vi.waitFor(() =>
			expect(controller.getSnapshot().page?.finalCursor.sequence).toBe(512),
		);
		expect(fixture.transport.read).toHaveBeenCalledTimes(3);
		resolveOlder?.({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: {
				type: "page",
				page: {
					...initial.page,
					rows: Array.from({ length: 128 }, (_, index) =>
						messageRow(index + 1),
					),
					finalCursor: { epoch: "timeline-1", sequence: 1 },
					hasMore: false,
				},
			},
		});
		await Promise.all([first, second]);
		const merged = controller.getSnapshot().page;
		expect(merged?.rows).toHaveLength(512);
		expect(merged?.rows[0]?.cursor.sequence).toBe(1);
		expect(merged?.rows[merged.rows.length - 1]?.cursor.sequence).toBe(512);

		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 513 },
			kinds: ["timeline"],
		});
		await vi.waitFor(() =>
			expect(controller.getSnapshot().page?.finalCursor.sequence).toBe(513),
		);
		expect(controller.getSnapshot().page?.rows).toHaveLength(513);
		expect(controller.getSnapshot().page?.rows[0]?.cursor.sequence).toBe(1);
	});

	it("discards a reset before page and reconnects from an authoritative tail", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [messageRow(3), messageRow(4)];
		initial.page.finalCursor.sequence = 4;
		initial.page.hasMore = true;
		const fixture = client(initial);
		vi.mocked(fixture.transport.read).mockResolvedValueOnce({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: {
				type: "reset",
				binding: initial.page.binding,
				reason: "stale_cursor",
			},
		});
		const timers: Array<() => void> = [];
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length;
			},
			clearTimer: vi.fn(),
		});
		controller.start();
		await settle();

		await controller.loadOlder();

		expect(
			controller.getSnapshot().page?.rows.map((row) => row.cursor.sequence),
		).toEqual([3, 4]);
		expect(controller.getSnapshot()).toMatchObject({
			loadingOlder: false,
			reconnecting: true,
			error: "agent_chat_timeline_reset_required",
		});
		timers.shift()?.();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
		});
	});

	it("rebases a pending live refresh over history that finishes first", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [messageRow(5), messageRow(6)];
		initial.page.finalCursor.sequence = 6;
		initial.page.hasMore = true;
		const fixture = client(initial);
		let resolveAfter:
			| ((value: Awaited<ReturnType<typeof fixture.transport.read>>) => void)
			| undefined;
		vi.mocked(fixture.transport.read).mockImplementation(async (request) => {
			if (request.direction === "after") {
				return await new Promise((resolve) => {
					resolveAfter = resolve;
				});
			}
			return {
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: {
					type: "page",
					page: {
						...initial.page,
						rows: [messageRow(3), messageRow(4)],
						finalCursor: { epoch: "timeline-1", sequence: 3 },
						hasMore: false,
					},
				},
			};
		});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 7 },
			kinds: ["timeline"],
		});
		await vi.waitFor(() =>
			expect(fixture.transport.read).toHaveBeenCalledTimes(1),
		);
		await controller.loadOlder();
		expect(
			controller.getSnapshot().page?.rows.map((row) => row.cursor.sequence),
		).toEqual([3, 4, 5, 6]);

		resolveAfter?.({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: delta(7),
		});
		await vi.waitFor(() =>
			expect(controller.getSnapshot().page?.finalCursor.sequence).toBe(7),
		);
		expect(
			controller.getSnapshot().page?.rows.map((row) => row.cursor.sequence),
		).toEqual([3, 4, 5, 6, 7]);
	});

	it("ignores a stale refresh rejection after a newer connection is ready", async () => {
		const fixture = client();
		let rejectRefresh: ((error: Error) => void) | undefined;
		vi.mocked(fixture.transport.read).mockImplementation(
			async () =>
				await new Promise((_, reject) => {
					rejectRefresh = reject;
				}),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 1 },
			kinds: ["timeline"],
		});
		await vi.waitFor(() =>
			expect(fixture.transport.read).toHaveBeenCalledTimes(1),
		);

		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		rejectRefresh?.(new Error("stale refresh failed"));
		await settle();

		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
	});

	it.each(["claude", "codex"])(
		"continues exact %s recovery through bounded reconnect backoff",
		async (providerId) => {
			const initial = read(providerId);
			if (initial.type !== "page") throw new Error("expected page fixture");
			const fixture = client(initial);
			vi.mocked(fixture.transport.subscribe)
				.mockRejectedValueOnce(runtimeUnavailable())
				.mockRejectedValueOnce(runtimeUnavailable());
			vi.mocked(fixture.transport.recover)
				.mockRejectedValueOnce(new Error("host still unavailable"))
				.mockResolvedValueOnce(initial.page.binding);
			const timers: Array<() => void> = [];
			const setTimer = vi.fn((callback: () => void) => {
				timers.push(callback);
				return timers.length;
			});
			const controller = new AgentChatSessionController({
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
				client: fixture.transport,
				setTimer,
				clearTimer: vi.fn(),
			});

			controller.start();
			await vi.waitFor(() =>
				expect(controller.getSnapshot().error).toBe("host still unavailable"),
			);
			expect(controller.getSnapshot().phase).toBe("connecting");
			expect(controller.getSnapshot().reconnecting).toBe(true);
			expect(fixture.transport.recover).toHaveBeenCalledTimes(1);
			expect(fixture.transport.recover).toHaveBeenCalledWith(
				initial.page.binding,
				ROUTE_AUTHORITY,
			);
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(1);
			expect(setTimer).toHaveBeenCalledTimes(1);

			timers.shift()?.();
			await vi.waitFor(() =>
				expect(controller.getSnapshot().phase).toBe("ready"),
			);
			expect(fixture.transport.recover).toHaveBeenCalledTimes(2);
			expect(fixture.transport.recover).toHaveBeenNthCalledWith(
				2,
				initial.page.binding,
				ROUTE_AUTHORITY,
			);
			expect(fixture.transport.inspect).toHaveBeenCalledTimes(3);
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(3);
			expect(setTimer).toHaveBeenCalledTimes(1);
		},
	);

	it("reobserves a newer stable binding after exact recovery fails", async () => {
		const initial = read("codex");
		const replacement = read("codex");
		if (initial.type !== "page" || replacement.type !== "page") {
			throw new Error("expected page fixture");
		}
		initial.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		replacement.page.binding = {
			...replacement.page.binding,
			runtime: {
				runtimeGeneration: "runtime-2",
				providerEpoch: "query-2",
			},
			bindingRevision: 2,
			updatedAtMs: 2,
		};
		const fixture = client(initial);
		vi.mocked(fixture.transport.interruptTurn).mockRejectedValueOnce(
			runtimeUnavailable(),
		);
		vi.mocked(fixture.transport.recover).mockRejectedValue(
			runtimeUnavailable(),
		);
		const timers: Array<() => void> = [];
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length;
			},
			clearTimer: vi.fn(),
		});

		controller.start();
		await settle();
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			binding: replacement.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			initial: replacement,
			close: fixture.close,
		});
		await expect(controller.interrupt()).rejects.toMatchObject({
			code: "agent_conversation_runtime_unavailable",
		});
		await vi.waitFor(() => expect(timers).toHaveLength(1));
		expect(controller.getSnapshot()).toMatchObject({
			phase: "connecting",
			reconnecting: true,
			activeTurn: undefined,
		});

		timers.shift()?.();
		await vi.waitFor(() =>
			expect(controller.getSnapshot()).toMatchObject({
				phase: "ready",
				reconnecting: false,
				activeTurn: undefined,
				actionError: undefined,
			}),
		);
		expect(
			controller.getSnapshot().page?.binding.runtime.runtimeGeneration,
		).toBe("runtime-2");
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(2);
		expect(fixture.transport.recover).toHaveBeenCalledTimes(1);
	});

	it("keeps an exact terminal recovery failure available for explicit retry", async () => {
		const initial = read("codex");
		if (initial.type !== "page") throw new Error("expected page fixture");
		const fixture = client(initial);
		vi.mocked(fixture.transport.subscribe).mockRejectedValueOnce(
			runtimeUnavailable(),
		);
		vi.mocked(fixture.transport.recover).mockRejectedValueOnce(
			terminalProviderFailure(),
		);
		const setTimer = vi.fn(() => 1);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer,
			clearTimer: vi.fn(),
		});

		controller.start();
		await vi.waitFor(() =>
			expect(controller.getSnapshot().error).toBe("provider failed"),
		);
		expect(controller.getSnapshot().phase).toBe("error");
		expect(controller.getSnapshot().reconnecting).toBe(false);
		expect(setTimer).not.toHaveBeenCalled();
	});

	it("reobserves the authoritative binding when recovery loses a concurrent replacement", async () => {
		const initial = read();
		const replacement = read();
		if (initial.type !== "page" || replacement.type !== "page") {
			throw new Error("expected page fixture");
		}
		replacement.page.binding = {
			...replacement.page.binding,
			runtime: {
				runtimeGeneration: "runtime-2",
				providerEpoch: "query-2",
			},
			bindingRevision: 2,
			updatedAtMs: 2,
		};
		const fixture = client(initial);
		vi.mocked(fixture.transport.inspect)
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				binding: initial.page.binding,
			})
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				binding: replacement.page.binding,
			});
		vi.mocked(fixture.transport.subscribe)
			.mockRejectedValueOnce(runtimeUnavailable())
			.mockResolvedValueOnce({
				subscriptionId: "subscription-2",
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				initial: replacement,
				close: fixture.close,
			});
		vi.mocked(fixture.transport.recover).mockRejectedValueOnce(
			recoveryConflict(),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: vi.fn(() => 1),
			clearTimer: vi.fn(),
		});

		controller.start();

		await vi.waitFor(() =>
			expect(
				controller.getSnapshot().page?.binding.runtime.runtimeGeneration,
			).toBe("runtime-2"),
		);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(2);
		expect(fixture.transport.recover).toHaveBeenCalledTimes(1);
		expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2);
	});

	it("reobserves after an inspect-to-subscribe generation race", async () => {
		const initial = read();
		const replacement = read();
		if (initial.type !== "page" || replacement.type !== "page") {
			throw new Error("expected page fixture");
		}
		replacement.page.binding = {
			...replacement.page.binding,
			runtime: {
				runtimeGeneration: "runtime-2",
				providerEpoch: "query-2",
			},
			bindingRevision: 2,
			updatedAtMs: 2,
		};
		const fixture = client(initial);
		vi.mocked(fixture.transport.inspect)
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				binding: initial.page.binding,
			})
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				binding: replacement.page.binding,
			});
		vi.mocked(fixture.transport.subscribe)
			.mockRejectedValueOnce(staleGeneration())
			.mockResolvedValueOnce({
				subscriptionId: "subscription-2",
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				initial: replacement,
				close: fixture.close,
			});
		const timers: Array<() => void> = [];
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length;
			},
			clearTimer: vi.fn(),
		});

		controller.start();
		await vi.waitFor(() => expect(timers).toHaveLength(1));
		timers.shift()?.();
		await vi.waitFor(() =>
			expect(
				controller.getSnapshot().page?.binding.runtime.runtimeGeneration,
			).toBe("runtime-2"),
		);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(2);
		expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2);
	});

	it("keeps a reconnecting transcript visible without admitting stale turns", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		initial.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		initial.page.finalCursor.sequence = 1;
		const fixture = client(initial);
		vi.mocked(fixture.transport.recover).mockRejectedValueOnce(
			new Error("host still unavailable"),
		);
		const setTimer = vi.fn(() => 1);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer,
			clearTimer: vi.fn(),
		});

		controller.start();
		await vi.waitFor(() =>
			expect(controller.getSnapshot().phase).toBe("ready"),
		);
		vi.mocked(fixture.transport.subscribe).mockRejectedValueOnce(
			runtimeUnavailable(),
		);

		controller.retryConnection();
		await vi.waitFor(() =>
			expect(controller.getSnapshot().error).toBe("host still unavailable"),
		);
		expect(controller.getSnapshot().page).toEqual(initial.page);
		expect(controller.getSnapshot().phase).toBe("connecting");
		expect(controller.getSnapshot().reconnecting).toBe(true);
		expect(controller.getSnapshot().activeTurn).toBeUndefined();
		expect(setTimer).toHaveBeenCalledTimes(1);
		await expect(controller.send("stale turn")).rejects.toThrow(
			"agent_chat_binding_unavailable",
		);
		await expect(controller.retryTurn()).rejects.toThrow(
			"agent_chat_binding_unavailable",
		);
		await expect(controller.answerPending("request-1", {})).rejects.toThrow(
			"agent_chat_binding_unavailable",
		);
		expect(fixture.transport.startTurn).not.toHaveBeenCalled();
		expect(fixture.transport.answerPending).not.toHaveBeenCalled();
	});

	it("sends the exact inspected binding without a stale pre-effect re-inspect", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		const fixture = client(initial);
		vi.mocked(fixture.transport.recover).mockRejectedValue(
			new Error("host still unavailable"),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: vi.fn(() => 1),
			clearTimer: vi.fn(),
		});

		const currentBinding = {
			...initial.page.binding,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: "account-current",
				credential_generation: "credential-current",
			},
			runtime: {
				runtimeGeneration: "runtime-current",
				providerEpoch: "query-current",
			},
			bindingRevision: 2,
			updatedAtMs: 2,
		};
		vi.mocked(fixture.transport.subscribe).mockImplementationOnce(async () => {
			vi.mocked(fixture.transport.inspect).mockResolvedValue({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				binding: currentBinding,
			});
			throw runtimeUnavailable();
		});

		controller.start();
		await vi.waitFor(() =>
			expect(fixture.transport.recover).toHaveBeenCalledTimes(1),
		);
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(1);
		expect(fixture.transport.recover).toHaveBeenCalledWith(
			initial.page.binding,
			ROUTE_AUTHORITY,
		);
	});

	it("backs off without recursive recovery when the recovery resubscribe still fails", async () => {
		const initial = read("codex");
		if (initial.type !== "page") throw new Error("expected page fixture");
		const fixture = client(initial);
		vi.mocked(fixture.transport.subscribe).mockRejectedValue(
			runtimeUnavailable(),
		);
		const setTimer = vi.fn(() => 1);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer,
			clearTimer: vi.fn(),
		});

		controller.start();
		await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(1));
		expect(controller.getSnapshot().error).toBe("runtime unavailable");
		expect(controller.getSnapshot().phase).toBe("connecting");
		expect(controller.getSnapshot().reconnecting).toBe(true);
		expect(fixture.transport.recover).toHaveBeenCalledTimes(1);
		expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2);
		expect(setTimer).toHaveBeenCalledTimes(1);
	});

	it("fences recovery continuations after the pane stops", async () => {
		const initial = read("codex");
		if (initial.type !== "page") throw new Error("expected page fixture");
		const binding = initial.page.binding;
		const fixture = client(initial);
		vi.mocked(fixture.transport.subscribe).mockRejectedValueOnce(
			runtimeUnavailable(),
		);
		let finishRecovery: ((recovered: typeof binding) => void) | undefined;
		vi.mocked(fixture.transport.recover).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishRecovery = resolve;
				}),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});

		controller.start();
		await vi.waitFor(() =>
			expect(fixture.transport.recover).toHaveBeenCalledTimes(1),
		);
		controller.stop();
		finishRecovery?.(binding);
		await settle();

		expect(controller.getSnapshot().phase).toBe("detached");
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(1);
		expect(fixture.transport.subscribe).toHaveBeenCalledTimes(1);
	});

	it("retries a response-loss turn with the same intent and original route", async () => {
		const fixture = client();
		vi.mocked(fixture.transport.startTurn)
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValueOnce("accepted");
		let nextId = 0;
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			now: () => 10,
			id: (scope) => `${scope}-${++nextId}`,
		});
		controller.start();
		await settle();
		await expect(controller.send("hello")).rejects.toThrow("response lost");
		expect(controller.getSnapshot().retryTurnAvailable).toBe(true);
		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		const replacement = read();
		if (replacement.type !== "page") throw new Error("expected page fixture");
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			binding: replacement.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			initial: replacement,
			close: fixture.close,
		});
		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		await controller.retryTurn();
		const calls = vi.mocked(fixture.transport.startTurn).mock.calls;
		expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
		expect(calls[0]?.[1]).toEqual(ROUTE_AUTHORITY);
		expect(calls[1]?.[1]).toEqual(ROUTE_AUTHORITY);
		expect(controller.getSnapshot().retryTurnAvailable).toBe(false);
	});

	it("reobserves the selected route after an exact turn refusal without replaying the effect", async () => {
		const fixture = client();
		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		let routeAEffects = 0;
		let routeBEffects = 0;
		vi.mocked(fixture.transport.startTurn).mockImplementation(
			async (_request, routeAuthority) => {
				if (routeAuthority.backend.id === "backend-b") {
					routeBEffects += 1;
					return "accepted";
				}
				routeAEffects += 1;
				throw authorityChanged();
			},
		);
		let nextId = 0;
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			now: () => 10,
			id: (scope) => `${scope}-${++nextId}`,
			setTimer: vi.fn(() => 1),
			clearTimer: vi.fn(),
		});
		controller.start();
		await settle();

		const replacement = read();
		if (replacement.type !== "page") throw new Error("expected page fixture");
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			binding: replacement.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			initial: replacement,
			close: fixture.close,
		});

		await expect(controller.send("original input")).rejects.toMatchObject({
			failure: { kind: "authority_changed" },
		});
		controller.queueMessage("keep this draft too");
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(routeAEffects).toBe(1);
		expect(routeBEffects).toBe(0);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			retryTurnAvailable: true,
			queuedMessages: ["keep this draft too"],
		});

		const restored = controller.editRetryableTurn();
		expect(restored).toBe("original input");
		expect(controller.getSnapshot()).toMatchObject({
			retryTurnAvailable: false,
			queuedMessages: ["keep this draft too"],
		});
		expect(controller.dequeueMessage(0)).toBe("keep this draft too");

		await controller.send(restored ?? "");
		expect(routeBEffects).toBe(1);
		const calls = vi.mocked(fixture.transport.startTurn).mock.calls;
		expect(calls[1]?.[0]).toMatchObject({ input: "original input" });
		expect(calls[1]?.[0].clientMessageId).not.toBe(
			calls[0]?.[0].clientMessageId,
		);
		expect(calls[1]?.[0].turnId).not.toBe(calls[0]?.[0].turnId);
		expect(calls[1]?.[1]).toEqual(routeB);
	});

	it.each(["interrupt", "steer"] as const)(
		"keeps the running turn and queued input after a failed %s command until canonical termination",
		async (action) => {
			const initial = read();
			if (initial.type !== "page") throw new Error("expected page fixture");
			initial.page.rows = [
				{
					cursor: { epoch: "timeline-1", sequence: 1 },
					item: {
						itemId: "turn-start",
						turnId: "turn-1",
						clientMessageId: "message-1",
						providerMessageId: null,
						body: { type: "lifecycle", state: "turn_started", detail: null },
						createdAtMs: 1,
					},
				},
			];
			initial.page.activeTurn = {
				turnId: "turn-1",
				clientMessageId: "message-1",
			};
			initial.page.finalCursor.sequence = 1;
			const fixture = client(initial);
			vi.mocked(fixture.transport.interruptTurn).mockRejectedValue(
				terminalProviderFailure(),
			);
			vi.mocked(fixture.transport.steerTurn).mockRejectedValue(
				terminalProviderFailure(),
			);
			let observed = initial;
			vi.mocked(fixture.transport.read).mockImplementation(async (request) => ({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: {
					type: "page",
					page: {
						...observed.page,
						rows: observed.page.rows.filter(
							(row) => row.cursor.sequence > (request.cursor?.sequence ?? 0),
						),
					},
				},
			}));
			const controller = new AgentChatSessionController({
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
				client: fixture.transport,
			});
			controller.start();
			await settle();
			expect(controller.getSnapshot().activeTurn).toBeTruthy();

			controller.queueMessage("pull 먼저");
			await settle();
			expect(fixture.transport.startTurn).not.toHaveBeenCalled();

			await expect(
				action === "interrupt"
					? controller.interrupt()
					: controller.steerOrQueue("change direction"),
			).rejects.toMatchObject({
				code: "agent_conversation_provider_failed",
			});
			await settle();

			expect(controller.getSnapshot().activeTurn).toEqual(
				initial.page.activeTurn,
			);
			expect(controller.getSnapshot().queuedMessages).toEqual(["pull 먼저"]);
			expect(fixture.transport.startTurn).not.toHaveBeenCalled();
			fixture.invalidation()?.({
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: initial.page.finalCursor,
				kinds: ["timeline"],
			});
			await vi.waitFor(() =>
				expect(fixture.transport.read).toHaveBeenCalledTimes(1),
			);
			expect(controller.getSnapshot().activeTurn).toEqual(
				initial.page.activeTurn,
			);
			expect(fixture.transport.startTurn).not.toHaveBeenCalled();

			const ended = read();
			if (ended.type !== "page") throw new Error("expected page fixture");
			ended.page.rows = [
				{
					cursor: { epoch: "timeline-1", sequence: 2 },
					item: {
						...initial.page.rows[0].item,
						itemId: "turn-failed",
						body: {
							type: "lifecycle",
							state: "turn_failed",
							detail: "runtime_exited",
						},
						createdAtMs: 2,
					},
				},
			];
			ended.page.finalCursor.sequence = 2;
			observed = ended;
			fixture.invalidation()?.({
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: ended.page.finalCursor,
				kinds: ["timeline"],
			});
			await vi.waitFor(() =>
				expect(fixture.transport.startTurn).toHaveBeenCalledTimes(1),
			);
			expect(controller.getSnapshot().activeTurn).toBeUndefined();
			expect(fixture.transport.startTurn).toHaveBeenCalledTimes(1);
			expect(controller.getSnapshot().queuedMessages).toEqual([]);
			expect(
				vi.mocked(fixture.transport.startTurn).mock.calls[0]?.[0].input,
			).toBe("pull 먼저");
			controller.stop();
		},
	);

	it("recovers the exact runtime after an active-turn command reports it unavailable", async () => {
		const initial = read("codex");
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		initial.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		initial.page.finalCursor.sequence = 1;
		const recovered = read("codex");
		if (recovered.type !== "page") throw new Error("expected page fixture");
		recovered.page.rows = [
			...initial.page.rows,
			{
				cursor: { epoch: "timeline-1", sequence: 2 },
				item: {
					itemId: "turn-failed",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: {
						type: "lifecycle",
						state: "turn_failed",
						detail: "runtime_recovered",
					},
					createdAtMs: 2,
				},
			},
		];
		recovered.page.finalCursor.sequence = 2;
		const fixture = client(initial);
		vi.mocked(fixture.transport.interruptTurn).mockRejectedValueOnce(
			runtimeUnavailable(),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		expect(controller.getSnapshot().activeTurn).toEqual(
			initial.page.activeTurn,
		);
		vi.mocked(fixture.transport.subscribe).mockResolvedValueOnce({
			subscriptionId: "subscription-recovered",
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			initial: recovered,
			close: fixture.close,
		});

		await expect(controller.interrupt()).rejects.toMatchObject({
			code: "agent_conversation_runtime_unavailable",
		});

		await vi.waitFor(() =>
			expect(fixture.transport.recover).toHaveBeenCalledWith(
				initial.page.binding,
				ROUTE_AUTHORITY,
			),
		);
		await vi.waitFor(() =>
			expect(controller.getSnapshot()).toMatchObject({
				phase: "ready",
				reconnecting: false,
				activeTurn: undefined,
				actionError: undefined,
			}),
		);
		expect(fixture.transport.startTurn).not.toHaveBeenCalled();
	});

	it("reobserves answer and interrupt authority refusals without replaying either effect", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.pendingRequests = [
			{
				interactionSessionId: "interaction-1",
				runtime: initial.page.binding.runtime,
				request: {
					requestId: "request-1",
					kind: "permission",
					turnId: "turn-1",
					clientMessageId: "message-1",
					payload: { tool: "Bash" },
					createdAtMs: 1,
				},
			},
		];
		initial.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		initial.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		initial.page.finalCursor.sequence = 1;
		const fixture = client(initial);
		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		const routeC = testDureBackendRouteAuthority("backend-c", "three");
		vi.mocked(fixture.transport.answerPending).mockRejectedValue(
			authorityChanged(),
		);
		vi.mocked(fixture.transport.interruptTurn).mockRejectedValue(
			authorityChanged(),
		);
		const setTimer = vi.fn(() => 1);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer,
			clearTimer: vi.fn(),
		});
		controller.start();
		await settle();

		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			binding: initial.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			initial,
			close: fixture.close,
		});
		await expect(
			controller.answerPending("request-1", { decision: "allow" }),
		).rejects.toMatchObject({ failure: { kind: "authority_changed" } });
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(fixture.transport.answerPending).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(fixture.transport.answerPending).mock.calls[0]?.[1],
		).toEqual(ROUTE_AUTHORITY);

		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-c", generation: "three" },
			routeAuthority: routeC,
			binding: initial.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-3",
			backend: { id: "backend-c", generation: "three" },
			routeAuthority: routeC,
			initial,
			close: fixture.close,
		});
		await expect(controller.interrupt()).rejects.toMatchObject({
			failure: { kind: "authority_changed" },
		});
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(3),
		);
		expect(fixture.transport.interruptTurn).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(fixture.transport.interruptTurn).mock.calls[0]?.[1],
		).toEqual(routeB);
		expect(setTimer).not.toHaveBeenCalled();
	});

	it("retries a pending answer on its original route after reconnect", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.pendingRequests = [
			{
				interactionSessionId: "interaction-1",
				runtime: initial.page.binding.runtime,
				request: {
					requestId: "request-1",
					kind: "permission",
					turnId: "turn-1",
					clientMessageId: "message-1",
					payload: { tool: "Bash" },
					createdAtMs: 1,
				},
			},
		];
		const fixture = client(initial);
		vi.mocked(fixture.transport.answerPending)
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValueOnce();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		await expect(
			controller.answerPending("request-1", { decision: "allow" }),
		).rejects.toThrow("response lost");

		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			binding: initial.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			initial,
			close: fixture.close,
		});
		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		await controller.answerPending("request-1", { decision: "allow" });

		const calls = vi.mocked(fixture.transport.answerPending).mock.calls;
		expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
		expect(calls[0]?.[1]).toEqual(ROUTE_AUTHORITY);
		expect(calls[1]?.[1]).toEqual(ROUTE_AUTHORITY);
	});

	it("retries an interrupt on its original route after reconnect", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		initial.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		initial.page.finalCursor.sequence = 1;
		const fixture = client(initial);
		vi.mocked(fixture.transport.interruptTurn)
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValueOnce();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		await expect(controller.interrupt()).rejects.toThrow("response lost");

		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			binding: initial.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: { id: "backend-b", generation: "two" },
			routeAuthority: routeB,
			initial,
			close: fixture.close,
		});
		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		await controller.interrupt();

		const calls = vi.mocked(fixture.transport.interruptTurn).mock.calls;
		expect(calls[0]?.[0]).toEqual(calls[1]?.[0]);
		expect(calls[0]?.[1]).toEqual(ROUTE_AUTHORITY);
		expect(calls[1]?.[1]).toEqual(ROUTE_AUTHORITY);
	});

	it("coalesces invalidations into a cursor-bounded durable refresh", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 1 },
			kinds: ["timeline"],
		});
		fixture.invalidation()?.({
			kind: "reset_required",
			interactionSessionId: "interaction-1",
		});
		await settle();
		expect(fixture.transport.read).toHaveBeenCalledTimes(1);
		expect(fixture.transport.read).toHaveBeenCalledWith({
			schemaVersion: 1,
			interactionSessionId: "interaction-1",
			direction: "after",
			cursor: { epoch: "timeline-1", sequence: 0 },
			limit: 128,
		});
	});

	it("reopens immediately when a reset advances the backend generation", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();

		fixture.invalidation()?.({
			kind: "reset_required",
			interactionSessionId: "interaction-1",
			backendReplaced: true,
		});

		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.transport.read).not.toHaveBeenCalled();
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
	});

	it("drains a bounded delta backlog without replaying the complete tail", async () => {
		const fixture = client();
		vi.mocked(fixture.transport.read)
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: delta(1, true),
			})
			.mockResolvedValueOnce({
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: delta(2),
			});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 2 },
			kinds: ["timeline"],
		});

		await vi.waitFor(() =>
			expect(fixture.transport.read).toHaveBeenCalledTimes(2),
		);
		expect(vi.mocked(fixture.transport.read).mock.calls[1]?.[0]).toMatchObject({
			direction: "after",
			cursor: { epoch: "timeline-1", sequence: 1 },
		});
		expect(
			controller.getSnapshot().page?.rows.map((entry) => entry.cursor.sequence),
		).toEqual([1, 2]);
	});

	it("does not replay 128 durable rows for each live-text invalidation", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		initial.page.rows = Array.from({ length: 128 }, (_, index) =>
			messageRow(index + 1),
		);
		initial.page.finalCursor.sequence = 128;
		initial.page.hasMore = true;
		const fixture = client(initial);
		let replayedRows = 0;
		let liveRevision = 0;
		vi.mocked(fixture.transport.read).mockImplementation(async (request) => {
			const response = read();
			if (response.type !== "page") throw new Error("expected page fixture");
			response.page.finalCursor.sequence = 128;
			response.page.liveText = [
				{
					streamId: "stream-1",
					itemId: "live-1",
					kind: "assistant",
					text: `live-${++liveRevision}`,
					turnId: null,
					clientMessageId: null,
					providerMessageId: "provider-live-1",
					updatedAtMs: liveRevision,
				},
			];
			if (request.direction === "tail") {
				response.page.rows = initial.page.rows;
				replayedRows += response.page.rows.length;
			}
			return {
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				read: response,
			};
		});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();

		for (let index = 1; index <= 4; index += 1) {
			fixture.invalidation()?.({
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: { epoch: "timeline-1", sequence: 128 },
				kinds: ["live_text"],
			});
			await vi.waitFor(() =>
				expect(fixture.transport.read).toHaveBeenCalledTimes(index),
			);
		}

		expect(replayedRows).toBe(0);
		expect(controller.getSnapshot().page?.rows).toBe(initial.page.rows);
		expect(controller.getSnapshot().page?.liveText[0]?.text).toBe("live-4");
	});

	it("reconnects to a complete snapshot when a delta cursor resets", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		const fixture = client(initial);
		const timers: Array<() => void> = [];
		vi.mocked(fixture.transport.read).mockResolvedValueOnce({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: {
				type: "reset",
				binding: initial.page.binding,
				reason: "cursor_retired",
			},
		});
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length;
			},
			clearTimer: vi.fn(),
		});
		controller.start();
		await settle();
		fixture.invalidation()?.({
			kind: "reset_required",
			interactionSessionId: "interaction-1",
		});
		await vi.waitFor(() => expect(fixture.close).toHaveBeenCalledTimes(1));
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: true,
			error: "agent_chat_timeline_reset_required",
		});

		timers.shift()?.();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
	});

	it("reconnects through inspect without timer polling when the provider runtime exits", async () => {
		const fixture = client();
		const setTimer = vi.fn(() => 1);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer,
			clearTimer: vi.fn(),
		});
		const invalidated = vi.fn(() => true);
		controller.subscribeRuntimeInvalidation(invalidated);
		controller.start();
		await settle();
		invalidated.mockClear();

		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 1 },
			kinds: ["runtime"],
		});
		expect(invalidated).toHaveBeenCalledOnce();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);

		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.transport.read).not.toHaveBeenCalled();
		expect(fixture.transport.inspect).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
			error: undefined,
		});
		expect(setTimer).not.toHaveBeenCalled();
	});

	it("fans runtime invalidation out to independent view subscriptions before reconnect", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: vi.fn(() => 1),
			clearTimer: vi.fn(),
		});
		const notified: string[] = [];
		const unsubscribeA = controller.subscribeRuntimeInvalidation(() => {
			notified.push("a");
			return true;
		});
		controller.subscribeRuntimeInvalidation(() => {
			throw new Error("detached view");
		});
		controller.subscribeRuntimeInvalidation(() => {
			notified.push("b");
			return true;
		});
		controller.start();
		await settle();
		notified.length = 0;

		const event = {
			kind: "changed" as const,
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 1 },
			kinds: ["runtime" as const],
		};
		fixture.invalidation()?.(event);
		expect(notified).toEqual(["a", "b"]);

		unsubscribeA();
		fixture.invalidation()?.(event);
		expect(notified).toEqual(["a", "b", "b"]);
	});

	it("notifies views when an accepted page replaces the runtime generation", async () => {
		const initial = read();
		if (initial.type !== "page") throw new Error("expected page fixture");
		const replacement = read();
		if (replacement.type !== "page") throw new Error("expected page fixture");
		replacement.page.binding.runtime = {
			runtimeGeneration: "runtime-2",
			providerEpoch: "query-2",
		};
		replacement.page.binding.bindingRevision = 2;
		const fixture = client(initial);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		const invalidated = vi.fn(() => true);
		controller.subscribeRuntimeInvalidation(invalidated);
		controller.start();
		await settle();
		invalidated.mockClear();
		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(2),
		);
		expect(invalidated).not.toHaveBeenCalled();
		vi.mocked(fixture.transport.subscribe).mockResolvedValueOnce({
			subscriptionId: "subscription-2",
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			initial: replacement,
			close: fixture.close,
		});

		controller.retryConnection();

		await vi.waitFor(() =>
			expect(
				controller.getSnapshot().page?.binding.runtime.runtimeGeneration,
			).toBe("runtime-2"),
		);
		expect(invalidated).toHaveBeenCalledOnce();
	});

	it("notifies views when the backend route changes at the same runtime generation", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		const invalidated = vi.fn((_generation: unknown) => true);
		controller.subscribeRuntimeInvalidation(invalidated);
		controller.start();
		await settle();
		invalidated.mockClear();

		const routeB = testDureBackendRouteAuthority("backend-b", "two");
		const replacement = read();
		if (replacement.type !== "page") throw new Error("expected page fixture");
		vi.mocked(fixture.transport.inspect).mockResolvedValue({
			backend: routeB.backend,
			routeAuthority: routeB,
			binding: replacement.page.binding,
		});
		vi.mocked(fixture.transport.subscribe).mockResolvedValue({
			subscriptionId: "subscription-2",
			backend: routeB.backend,
			routeAuthority: routeB,
			initial: replacement,
			close: fixture.close,
		});

		controller.retryConnection();
		await vi.waitFor(() => expect(invalidated).toHaveBeenCalledOnce());
		expect(invalidated.mock.calls[0]?.[0]).toMatchObject({
			routeAuthority: routeB,
			bindingRevision: 1,
			runtimeGeneration: "runtime-1",
			providerEpoch: "query-1",
		});
	});

	it("keeps runtime invalidation pending until a stable projection acknowledges it", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		const invalidated = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(true);
		controller.subscribeRuntimeInvalidation(invalidated);
		controller.start();
		await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(1));

		controller.retryConnection();
		await vi.waitFor(() => expect(invalidated).toHaveBeenCalledTimes(2));
		expect(invalidated.mock.calls[0]?.[0]).toEqual({
			routeAuthority: ROUTE_AUTHORITY,
			bindingRevision: 1,
			runtimeGeneration: "runtime-1",
			providerEpoch: "query-1",
		});

		controller.retryConnection();
		await vi.waitFor(() =>
			expect(fixture.transport.subscribe).toHaveBeenCalledTimes(3),
		);
		expect(invalidated).toHaveBeenCalledTimes(2);
	});

	it("never abandons reconnecting and converges after a long outage", async () => {
		// A runtime replacement (model/credential switch) can outlive any
		// fixed attempt budget — the pane must keep converging, bounded in
		// delay, unbounded in attempts.
		const fixture = client();
		const timers: Array<() => void> = [];
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			setTimer: (callback) => {
				timers.push(callback);
				return timers.length;
			},
			clearTimer: vi.fn(),
		});
		const invalidated = vi.fn(() => true);
		controller.subscribeRuntimeInvalidation(invalidated);
		controller.start();
		await settle();
		invalidated.mockClear();
		vi.mocked(fixture.transport.inspect).mockRejectedValue(
			new Error("backend unavailable"),
		);
		fixture.invalidation()?.({
			kind: "error",
			error: new DureBackendRequestError(
				"conversation_subscription_closed",
				"subscription closed",
				{ kind: "transport" },
			),
		});
		expect(invalidated).toHaveBeenCalledOnce();
		await settle();

		// Well past the old give-up budget the pane must still be retrying.
		for (let attempt = 0; attempt < 9; attempt += 1) {
			const retry = timers.shift();
			expect(retry).toBeTypeOf("function");
			retry?.();
			await settle();
		}
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: true,
		});

		// The moment the backend answers again, the pane converges.
		vi.mocked(fixture.transport.inspect).mockImplementation(async () => ({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			binding: (() => {
				const initial = read();
				if (initial.type !== "page") throw new Error("expected page");
				return initial.page.binding;
			})(),
		}));
		const retry = timers.shift();
		expect(retry).toBeTypeOf("function");
		retry?.();
		await settle();
		expect(controller.getSnapshot()).toMatchObject({
			phase: "ready",
			reconnecting: false,
		});
	});

	it("keeps the Window receiver while scheduling a reconnect after transport loss", async () => {
		const fixture = client();
		vi.mocked(fixture.transport.inspect).mockRejectedValueOnce(
			new Error("backend unavailable"),
		);
		const scheduled: Array<() => void> = [];
		const browserSetTimeout = vi.fn(function (
			this: typeof globalThis,
			callback: () => void,
		) {
			if (this !== globalThis) {
				throw new TypeError(
					"Can only call Window.setTimeout on instances of Window",
				);
			}
			scheduled.push(callback);
			return scheduled.length;
		});
		vi.stubGlobal("setTimeout", browserSetTimeout);

		try {
			const controller = new AgentChatSessionController({
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
				client: fixture.transport,
			});
			controller.start();
			await settle();

			expect(controller.getSnapshot()).toMatchObject({
				phase: "error",
				reconnecting: true,
			});
			expect(scheduled).toHaveLength(1);

			scheduled.shift()?.();
			await settle();
			expect(controller.getSnapshot()).toMatchObject({
				phase: "ready",
				reconnecting: false,
			});
			controller.stop();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("queues messages during an active turn and sends them joined when it ends", async () => {
		const fixture = client();
		const openTurn = read();
		if (openTurn.type !== "page") throw new Error("expected page");
		openTurn.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		openTurn.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		openTurn.page.finalCursor = { epoch: "timeline-1", sequence: 1 };
		vi.mocked(fixture.transport.subscribe).mockImplementationOnce(
			async (_request, onInvalidation) => {
				fixtureInvalidation = onInvalidation;
				return {
					subscriptionId: "subscription-1",
					backend: { id: "backend", generation: "one" },
					routeAuthority: ROUTE_AUTHORITY,
					initial: openTurn,
					close: fixture.close,
				};
			},
		);
		let fixtureInvalidation:
			| ((
					event: Parameters<typeof fixture.transport.subscribe>[1] extends (
						event: infer E,
					) => void
						? E
						: never,
			  ) => void)
			| undefined;
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		expect(controller.getSnapshot().activeTurn).toBeTruthy();

		controller.queueMessage("first");
		controller.queueMessage("second");
		expect(controller.getSnapshot().queuedMessages).toEqual([
			"first",
			"second",
		]);
		expect(fixture.transport.startTurn).not.toHaveBeenCalled();

		const removed = controller.dequeueMessage(1);
		expect(removed).toBe("second");
		controller.queueMessage("second");

		const bounded = read();
		if (bounded.type !== "page") throw new Error("expected page");
		bounded.page.rows = Array.from({ length: 128 }, (_, index) =>
			messageRow(index + 2),
		);
		bounded.page.activeTurn = openTurn.page.activeTurn;
		bounded.page.finalCursor = { epoch: "timeline-1", sequence: 129 };
		vi.mocked(fixture.transport.read).mockResolvedValue({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: bounded,
		});
		fixtureInvalidation?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 129 },
			kinds: ["timeline"],
		});
		await settle();
		expect(controller.getSnapshot().page?.rows[0]?.cursor.sequence).toBe(2);
		expect(controller.getSnapshot().activeTurn).toEqual(
			openTurn.page.activeTurn,
		);
		expect(fixture.transport.startTurn).not.toHaveBeenCalled();

		// Refresh reads deltas after the known cursor; return only the new row.
		const finished = read();
		if (finished.type !== "page") throw new Error("expected page");
		finished.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 130 },
				item: {
					itemId: "turn-complete",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_completed", detail: null },
					createdAtMs: 130,
				},
			},
		];
		finished.page.finalCursor = { epoch: "timeline-1", sequence: 130 };
		vi.mocked(fixture.transport.read).mockResolvedValue({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: finished,
		});
		fixtureInvalidation?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 130 },
			kinds: ["timeline"],
		});
		await settle();

		expect(fixture.transport.startTurn).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(fixture.transport.startTurn).mock.calls[0]?.[0],
		).toMatchObject({ input: "first\n\nsecond" });
		expect(controller.getSnapshot().queuedMessages).toEqual([]);
	});

	it("steers into the running turn and falls back to the queue when refused", async () => {
		const fixture = client();
		const openTurn = read();
		if (openTurn.type !== "page") throw new Error("expected page");
		openTurn.page.rows = [
			{
				cursor: { epoch: "timeline-1", sequence: 1 },
				item: {
					itemId: "turn-start",
					turnId: "turn-1",
					clientMessageId: "message-1",
					providerMessageId: null,
					body: { type: "lifecycle", state: "turn_started", detail: null },
					createdAtMs: 1,
				},
			},
		];
		openTurn.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		openTurn.page.finalCursor = { epoch: "timeline-1", sequence: 1 };
		vi.mocked(fixture.transport.subscribe).mockImplementationOnce(
			async (_request, _onInvalidation) => ({
				subscriptionId: "subscription-1",
				backend: { id: "backend", generation: "one" },
				routeAuthority: ROUTE_AUTHORITY,
				initial: openTurn,
				close: fixture.close,
			}),
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		expect(controller.getSnapshot().activeTurn).toBeTruthy();

		expect(await controller.steerOrQueue("go left")).toBe("steered");
		expect(fixture.transport.steerTurn).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(fixture.transport.steerTurn).mock.calls[0]?.[0],
		).toMatchObject({ turnId: "turn-1", input: "go left" });
		expect(controller.getSnapshot().queuedMessages).toEqual([]);

		// A provider without a mid-turn channel is remembered: the refusal
		// queues the message, and later messages skip straight to the queue.
		vi.mocked(fixture.transport.steerTurn).mockRejectedValueOnce(
			new Error("steer_unsupported: provider has no mid-turn channel"),
		);
		expect(await controller.steerOrQueue("later")).toBe("queued");
		expect(await controller.steerOrQueue("also later")).toBe("queued");
		expect(fixture.transport.steerTurn).toHaveBeenCalledTimes(2);
		expect(controller.getSnapshot().queuedMessages).toEqual([
			"later",
			"also later",
		]);
	});

	it("does not resend a delivered steer after its response is lost", async () => {
		const openTurn = read();
		if (openTurn.type !== "page") throw new Error("expected page");
		openTurn.page.activeTurn = {
			turnId: "turn-1",
			clientMessageId: "message-1",
		};
		const fixture = client(openTurn);
		const delivered: string[] = [];
		const lostResponse = new DureBackendRequestError(
			"backend_unreachable",
			"Response lost after delivery",
			{ kind: "transport" },
		);
		vi.mocked(fixture.transport.steerTurn).mockImplementationOnce(
			async (request) => {
				delivered.push(request.input);
				throw lostResponse;
			},
		);
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		try {
			const outcome = await controller
				.steerOrQueue("apply once")
				.catch((error) => error);
			fixture.invalidation()?.({
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: { epoch: "timeline-1", sequence: 0 },
				kinds: ["timeline"],
			});
			await settle();
			expect(delivered).toEqual(["apply once"]);
			expect(fixture.transport.startTurn).not.toHaveBeenCalled();
			expect(controller.getSnapshot().queuedMessages).toEqual([]);
			expect(outcome).toBe(lostResponse);

			// Failure of one request does not disable steering for the session.
			openTurn.page.activeTurn = {
				turnId: "turn-2",
				clientMessageId: "message-2",
			};
			controller.retryConnection();
			await settle();
			expect(await controller.steerOrQueue("new direction")).toBe("steered");
			expect(fixture.transport.steerTurn).toHaveBeenCalledTimes(2);
		} finally {
			controller.stop();
		}
	});

	it.each(["prepared", "uncertain", "failed"] as const)(
		"retains the same send intent after a %s receipt",
		async (state) => {
			const fixture = client();
			vi.mocked(fixture.transport.startTurn).mockResolvedValueOnce(state);
			const controller = new AgentChatSessionController({
				agentId: "agent-1",
				interactionSessionId: "interaction-1",
				client: fixture.transport,
			});
			controller.start();
			await settle();
			try {
				await expect(
					controller.send("preserve this request"),
				).rejects.toBeInstanceOf(Error);
				expect(controller.getSnapshot().retryTurnAvailable).toBe(true);
				expect(fixture.transport.startTurn).toHaveBeenCalledTimes(1);
				if (state === "failed") {
					vi.mocked(fixture.transport.startTurn).mockResolvedValueOnce(
						"failed",
					);
					await expect(controller.retryTurn()).rejects.toBeInstanceOf(Error);
					expect(controller.editRetryableTurn()).toBe("preserve this request");
				} else {
					await controller.retryTurn();
				}
				const attempts = vi.mocked(fixture.transport.startTurn).mock.calls;
				expect(attempts).toHaveLength(2);
				expect(attempts[1]).toEqual(attempts[0]);
				expect(controller.getSnapshot().retryTurnAvailable).toBe(false);
			} finally {
				controller.stop();
			}
		},
	);

	it("queues without a steer attempt when no turn is running", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		expect(controller.getSnapshot().activeTurn).toBeFalsy();

		expect(await controller.steerOrQueue("hello")).toBe("queued");
		await settle();
		expect(fixture.transport.steerTurn).not.toHaveBeenCalled();
		// With no turn running the queue drains straight into a normal send.
		expect(fixture.transport.startTurn).toHaveBeenCalledTimes(1);
		expect(
			vi.mocked(fixture.transport.startTurn).mock.calls[0]?.[0],
		).toMatchObject({ input: "hello" });
		expect(controller.getSnapshot().queuedMessages).toEqual([]);
	});
});

describe("goal observation and writes", () => {
	it("reobserves a teammate's goal through the conversation and does not replay a conflicting edit", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
			id: () => "goal-edit-1",
		});
		controller.start();
		await settle();
		const next = read();
		if (next.type !== "page") throw new Error("expected page");
		const goal = {
			schemaVersion: 1 as const,
			agentId: "agent-1",
			objective: "Teammate direction",
			status: "paused" as const,
			revision: 2,
			detail: null,
			activationCursor: { epoch: "timeline-1", sequence: 0 },
			createdAtMs: 1,
			updatedAtMs: 2,
		};
		next.page.goal = goal;
		vi.mocked(fixture.transport.read).mockResolvedValue({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: next,
		});
		fixture.invalidation()?.({
			kind: "changed",
			interactionSessionId: "interaction-1",
			timelineCursor: { epoch: "timeline-1", sequence: 0 },
			kinds: ["goal"],
		});
		await settle();
		expect(controller.getSnapshot().page?.goal).toEqual(goal);
		const put = vi.fn().mockRejectedValue(
			new DureBackendRequestError("agent_goal_conflict", "conflict", {
				kind: "operation",
				disposition: "terminal",
			}),
		);
		fixture.transport.putGoal = put;
		expect(
			await controller.putGoal({
				objective: "My direction",
				expectedRevision: 1,
				status: "active",
			}),
		).toBe(false);
		expect(put).toHaveBeenCalledExactlyOnceWith(
			{
				schemaVersion: 1,
				agentId: "agent-1",
				expectedRevision: 1,
				objective: "My direction",
				status: "active",
				idempotencyKey: "goal-edit-1",
				detail: null,
			},
			ROUTE_AUTHORITY,
		);
		expect(controller.getSnapshot().goalError).toBeTruthy();
		expect(controller.getSnapshot().page?.goal).toEqual(goal);
		expect(controller.getSnapshot().savingGoal).toBe(false);
		controller.stop();
	});
	it("projects the server snapshot after saving rather than replacing it with a mutation receipt", async () => {
		const fixture = client();
		const controller = new AgentChatSessionController({
			agentId: "agent-1",
			interactionSessionId: "interaction-1",
			client: fixture.transport,
		});
		controller.start();
		await settle();
		const next = read();
		if (next.type !== "page") throw new Error("expected page");
		const receipt = {
			schemaVersion: 1 as const,
			agentId: "agent-1",
			objective: "First direction",
			status: "active" as const,
			revision: 1,
			detail: null,
			activationCursor: { epoch: "timeline-1", sequence: 0 },
			createdAtMs: 1,
			updatedAtMs: 2,
		};
		next.page.goal = {
			...receipt,
			objective: "Newer teammate direction",
			revision: 2,
		};
		fixture.transport.putGoal = vi.fn().mockResolvedValue(receipt);
		vi.mocked(fixture.transport.read).mockResolvedValue({
			backend: { id: "backend", generation: "one" },
			routeAuthority: ROUTE_AUTHORITY,
			read: next,
		});
		expect(
			await controller.putGoal({
				objective: receipt.objective,
				status: "active",
				expectedRevision: 0,
			}),
		).toBe(true);
		expect(controller.getSnapshot().page?.goal).toEqual(next.page.goal);
		controller.stop();
	});
});
