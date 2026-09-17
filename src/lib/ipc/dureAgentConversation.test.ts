import { describe, expect, it, vi } from "vitest";
import type {
	AgentInteractionBindingV1,
	AgentTimelineRowV1,
} from "@/lib/agents/chat/agentConversationContract";
import { createDureAgentConversationClient } from "@/lib/ipc/dureAgentConversation";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

function read() {
	return {
		type: "page",
		page: {
			binding: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				agentId: "agent-1",
				providerId: "claude",
				executionProfile: { kind: "provider_default" },
				providerConversationRef: null,
				runtime: {
					runtimeGeneration: "runtime-1",
					providerEpoch: "query-1",
				},
				timelineEpoch: "timeline-1",
				bindingRevision: 1,
				historyComplete: true,
				createdAtMs: 10,
				updatedAtMs: 10,
			} satisfies AgentInteractionBindingV1,
			rows: [] as AgentTimelineRowV1[],
			liveText: [],
			pendingRequests: [],
			activeTurn: null,
			goal: null,
			finalCursor: { epoch: "timeline-1", sequence: 0 },
			hasMore: false,
		},
	};
}

function envelope(result: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		backendId: "backend-local",
		backendGeneration: "generation-1",
		routeAuthority: testDureBackendRouteAuthority(
			"backend-local",
			"generation-1",
		),
		result: { schemaVersion: 1, ...result },
	};
}

function routeAuthority() {
	return testDureBackendRouteAuthority("backend-local", "generation-1");
}

describe("Dure agent conversation client", () => {
	it("does not dispatch a turn to selected backend B after inspecting A", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let selected = routeA;
		let backendBMutationCount = 0;
		const turn = {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-1",
			runtime: read().page.binding.runtime,
			turnId: "turn-1",
			clientMessageId: "message-1",
			input: "hello",
			requestedAtMs: 10,
		};
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command !== "dure_backend_request") throw new Error(command);
				const requestRoute = arguments_.route as
					| { kind: "selected" }
					| { kind: "exact"; authority: typeof routeA };
				const routed =
					requestRoute.kind === "exact" ? requestRoute.authority : selected;
				if (routed.backend.id === "backend-b") backendBMutationCount += 1;
				if (
					requestRoute.kind === "exact" &&
					requestRoute.authority.backend.id !== selected.backend.id
				) {
					throw {
						code: "backend_transport_authority_changed",
						message: "route changed",
					};
				}
				return {
					schemaVersion: 1,
					backendId: routed.backend.id,
					backendGeneration: routed.backend.generation,
					routeAuthority: routed,
					result:
						arguments_.operation === "agent_conversation.inspect"
							? { schemaVersion: 1, binding: read().page.binding }
							: {
									schemaVersion: 1,
									receipt: { intent: turn, state: "accepted" },
								},
				};
			},
		);
		const client = createDureAgentConversationClient({ invokeCommand });

		const inspected = await client.inspect("agent-1");
		selected = routeB;
		await expect(
			client.startTurn(turn, inspected.routeAuthority),
		).rejects.toMatchObject({
			failure: { kind: "authority_changed" },
		});
		expect(backendBMutationCount).toBe(0);
	});

	it("opens a durable subscription on the current backend after inspecting A", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let selected = routeA;
		let backendBSubscriptionOpenCount = 0;
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command === "dure_backend_request") {
					return {
						schemaVersion: 1,
						backendId: routeA.backend.id,
						backendGeneration: routeA.backend.generation,
						routeAuthority: routeA,
						result: { schemaVersion: 1, binding: read().page.binding },
					};
				}
				if (command === "dure_backend_subscribe") {
					const requestRoute = arguments_.route as
						| { kind: "selected" }
						| { kind: "exact"; authority: typeof routeA }
						| undefined;
					const routed =
						requestRoute?.kind === "exact" ? requestRoute.authority : selected;
					if (routed.backend.id === "backend-b") {
						backendBSubscriptionOpenCount += 1;
					}
					if (
						requestRoute?.kind === "exact" &&
						requestRoute.authority.backend.id !== selected.backend.id
					) {
						throw {
							code: "backend_transport_authority_changed",
							message: "route changed",
						};
					}
					return {
						schemaVersion: 1,
						backendId: routed.backend.id,
						backendGeneration: routed.backend.generation,
						routeAuthority: routed,
						result: { schemaVersion: 1, read: read() },
					};
				}
				if (command === "dure_backend_unsubscribe") return true;
				throw new Error(command);
			},
		);
		const client = createDureAgentConversationClient({
			invokeCommand,
			channelFactory: () => ({ onmessage: () => {} }),
			subscriptionId: () => "chat-subscription-1",
		});

		await client.inspect("agent-1");
		selected = routeB;
		await expect(
			client.subscribe(
				{
					schemaVersion: 1,
					interactionSessionId: "interaction-1",
					direction: "tail",
					cursor: null,
					limit: 128,
				},
				() => {},
			),
		).resolves.toMatchObject({ routeAuthority: routeB });
		expect(backendBSubscriptionOpenCount).toBe(1);
	});

	it.each(["claude", "codex"])(
		"recovers one exact %s conversation binding through the common operation",
		async (providerId) => {
			const binding = { ...read().page.binding, providerId };
			const recovered = {
				...binding,
				runtime: {
					runtimeGeneration: "runtime-2",
					providerEpoch: "query-2",
				},
				bindingRevision: binding.bindingRevision + 1,
				updatedAtMs: binding.updatedAtMs + 1,
			};
			const invokeCommand = vi.fn(async () => envelope({ binding: recovered }));
			const client = createDureAgentConversationClient({ invokeCommand });

			await expect(client.recover(binding, routeAuthority())).resolves.toEqual(
				recovered,
			);
			expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
				route: { kind: "exact", authority: routeAuthority() },
				operation: "agent_conversation.recover",
				body: {
					schemaVersion: 1,
					expectedBinding: binding,
				},
			});
		},
	);

	it("accepts the backend-authoritative recovery projection without replaying its state machine", async () => {
		const binding = read().page.binding;
		const skipped = {
			...binding,
			runtime: {
				runtimeGeneration: "runtime-2",
				providerEpoch: "query-2",
			},
			bindingRevision: binding.bindingRevision + 2,
			updatedAtMs: binding.updatedAtMs + 1,
		};
		const client = createDureAgentConversationClient({
			invokeCommand: vi.fn(async () => envelope({ binding: skipped })),
		});

		await expect(client.recover(binding, routeAuthority())).resolves.toEqual(
			skipped,
		);
	});

	it("rejects a recovery response for another immutable conversation", async () => {
		const binding = read().page.binding;
		const client = createDureAgentConversationClient({
			invokeCommand: vi.fn(async () =>
				envelope({
					binding: { ...binding, interactionSessionId: "interaction-other" },
				}),
			),
		});

		await expect(
			client.recover(binding, routeAuthority()),
		).rejects.toMatchObject({
			code: "agent_conversation_recover_receipt_invalid",
		});
	});

	it("accepts the durable provider-reference and history-gap projection published during recovery", async () => {
		const binding = read().page.binding;
		const recovered = {
			...binding,
			providerConversationRef: "conversation-established",
			runtime: {
				runtimeGeneration: "runtime-2",
				providerEpoch: "query-2",
			},
			bindingRevision: binding.bindingRevision + 2,
			historyComplete: false,
			updatedAtMs: binding.updatedAtMs + 1,
		};
		const client = createDureAgentConversationClient({
			invokeCommand: vi.fn(async () => envelope({ binding: recovered })),
		});

		await expect(client.recover(binding, routeAuthority())).resolves.toEqual(
			recovered,
		);
	});

	it("uses a dedicated subscription command and closes only that observer", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const invokeCommand = vi.fn(async (command: string) => {
			if (command === "dure_backend_subscribe") {
				return envelope({ read: read() });
			}
			if (command === "dure_backend_unsubscribe") return true;
			throw new Error(command);
		});
		const invalidations: unknown[] = [];
		const client = createDureAgentConversationClient({
			invokeCommand,
			channelFactory: () => channel,
			subscriptionId: () => "chat-subscription-1",
		});

		const subscription = await client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			(event) => invalidations.push(event),
		);
		expect(invokeCommand).toHaveBeenNthCalledWith(1, "dure_backend_subscribe", {
			route: { kind: "selected", profileId: "local" },
			subscriptionId: "chat-subscription-1",
			body: {
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			channel,
		});
		channel.onmessage({
			schemaVersion: 1,
			kind: "event",
			subscriptionId: "chat-subscription-1",
			backendId: "backend-local",
			backendGeneration: "generation-1",
			event: {
				schemaVersion: 1,
				topic: "agent_conversation.changed",
				subscriptionRequestId: "request-private-1",
				notification: {
					interactionSessionId: "interaction-1",
					timelineCursor: { epoch: "timeline-1", sequence: 1 },
					kinds: ["timeline", "goal"],
				},
			},
		});
		expect(invalidations).toEqual([
			{
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: { epoch: "timeline-1", sequence: 1 },
				kinds: ["timeline", "goal"],
			},
		]);

		await subscription.close();
		await subscription.close();
		expect(invokeCommand).toHaveBeenCalledTimes(2);
		expect(invokeCommand.mock.calls[1]).toEqual([
			"dure_backend_unsubscribe",
			{ subscriptionId: "chat-subscription-1" },
		]);
	});

	it("keeps a subscription independent from sibling selected snapshots", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let inspectCount = 0;
		let releaseSubscription!: () => void;
		const subscriptionBlocked = new Promise<void>((resolve) => {
			releaseSubscription = resolve;
		});
		const response = (
			route: typeof routeA,
			result: Record<string, unknown>,
		) => ({
			schemaVersion: 1,
			backendId: route.backend.id,
			backendGeneration: route.backend.generation,
			routeAuthority: route,
			result: { schemaVersion: 1, ...result },
		});
		const invokeCommand = vi.fn(
			async (command: string) => {
				if (command === "dure_backend_request") {
					inspectCount += 1;
					return response(inspectCount === 1 ? routeA : routeB, {
						binding: read().page.binding,
					});
				}
				if (command === "dure_backend_subscribe") {
					await subscriptionBlocked;
					return response(routeA, { read: read() });
				}
				if (command === "dure_backend_unsubscribe") return true;
				throw new Error(command);
			},
		);
		const client = createDureAgentConversationClient({
			invokeCommand,
			channelFactory: () => ({ onmessage: () => {} }),
			subscriptionId: () => "chat-subscription-1",
		});
		await client.inspect("agent-1");
		const subscription = client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			() => {},
		);

		await client.inspect("agent-1");
		releaseSubscription();

		await expect(subscription).resolves.toMatchObject({
			routeAuthority: routeA,
		});
	});

	it("reads the timeline from the current complete backend snapshot", async () => {
		const invokeCommand = vi.fn(async () => envelope({ read: read() }));
		const client = createDureAgentConversationClient({ invokeCommand });
		const request = {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-1",
			direction: "after" as const,
			cursor: { epoch: "timeline-1", sequence: 0 },
			limit: 128,
		};

		await client.read(request);
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "selected", profileId: "local" },
			operation: "agent_conversation.read",
			body: request,
		});
	});

	it("accepts a canonical multi-row before page from the current route", async () => {
		const before = read();
		before.page.rows = [3, 4].map((sequence) => ({
			cursor: { epoch: "timeline-1", sequence },
			item: {
				itemId: `item-${sequence}`,
				turnId: null,
				clientMessageId: null,
				providerMessageId: `provider-message-${sequence}`,
				body: {
					type: "message",
					role: "assistant",
					markdown: `${sequence}`,
				},
				createdAtMs: sequence,
			},
		}));
		before.page.finalCursor.sequence = 3;
		const invokeCommand = vi.fn(async () => envelope({ read: before }));
		const client = createDureAgentConversationClient({ invokeCommand });
		const request = {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-1",
			direction: "before" as const,
			cursor: { epoch: "timeline-1", sequence: 5 },
			limit: 128,
		};

		await expect(client.read(request)).resolves.toMatchObject(
			{
				read: {
					type: "page",
					page: {
						rows: [{ cursor: { sequence: 3 } }, { cursor: { sequence: 4 } }],
						finalCursor: { sequence: 3 },
					},
				},
			},
		);
	});

	it("rejects an event from another backend generation", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const client = createDureAgentConversationClient({
			invokeCommand: async (command) =>
				command === "dure_backend_subscribe"
					? envelope({ read: read() })
					: true,
			channelFactory: () => channel,
			subscriptionId: () => "chat-subscription-1",
		});
		const invalidations: Array<{ kind: string }> = [];
		await client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			(event) => invalidations.push(event),
		);
		channel.onmessage({
			schemaVersion: 1,
			kind: "event",
			subscriptionId: "chat-subscription-1",
			backendId: "backend-local",
			backendGeneration: "generation-stale",
			event: {},
		});
		expect(invalidations[0]?.kind).toBe("error");
	});

	it("accepts a reset from the replacement backend generation", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const client = createDureAgentConversationClient({
			invokeCommand: async (command) =>
				command === "dure_backend_subscribe"
					? envelope({ read: read() })
					: true,
			channelFactory: () => channel,
			subscriptionId: () => "chat-subscription-1",
		});
		const invalidations: unknown[] = [];
		await client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			(event) => invalidations.push(event),
		);

		channel.onmessage({
			schemaVersion: 1,
			kind: "event",
			subscriptionId: "chat-subscription-1",
			backendId: "backend-local",
			backendGeneration: "generation-2",
			event: {
				schemaVersion: 1,
				topic: "agent_conversation.reset_required",
				subscriptionRequestId: "request-private-1",
				interactionSessionId: "interaction-1",
			},
		});

		expect(invalidations).toEqual([
			{
				kind: "reset_required",
				interactionSessionId: "interaction-1",
				backendReplaced: true,
			},
		]);
	});

	it("delivers a replacement reset emitted before the initial subscription resolves", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const invokeCommand = vi.fn(async (command: string) => {
			if (command === "dure_backend_subscribe") {
				channel.onmessage({
					schemaVersion: 1,
					kind: "event",
					subscriptionId: "chat-subscription-1",
					backendId: "backend-local",
					backendGeneration: "generation-2",
					event: {
						schemaVersion: 1,
						topic: "agent_conversation.reset_required",
						subscriptionRequestId: "request-private-1",
						interactionSessionId: "interaction-1",
					},
				});
				return envelope({ read: read() });
			}
			if (command === "dure_backend_unsubscribe") return true;
			throw new Error(command);
		});
		const invalidations: unknown[] = [];
		const client = createDureAgentConversationClient({
			invokeCommand,
			channelFactory: () => channel,
			subscriptionId: () => "chat-subscription-1",
		});

		await client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			(event) => invalidations.push(event),
		);

		expect(invalidations).toEqual([
			{
				kind: "reset_required",
				interactionSessionId: "interaction-1",
				backendReplaced: true,
			},
		]);
	});

	it("accepts a provider-neutral runtime invalidation", async () => {
		const channel = { onmessage: (_message: unknown) => {} };
		const client = createDureAgentConversationClient({
			invokeCommand: async (command) =>
				command === "dure_backend_subscribe"
					? envelope({ read: read() })
					: true,
			channelFactory: () => channel,
			subscriptionId: () => "chat-subscription-1",
		});
		const invalidations: unknown[] = [];
		await client.subscribe(
			{
				schemaVersion: 1,
				interactionSessionId: "interaction-1",
				direction: "tail",
				cursor: null,
				limit: 128,
			},
			(event) => invalidations.push(event),
		);
		channel.onmessage({
			schemaVersion: 1,
			kind: "event",
			subscriptionId: "chat-subscription-1",
			backendId: "backend-local",
			backendGeneration: "generation-1",
			event: {
				schemaVersion: 1,
				topic: "agent_conversation.changed",
				subscriptionRequestId: "request-private-1",
				notification: {
					interactionSessionId: "interaction-1",
					timelineCursor: { epoch: "timeline-1", sequence: 1 },
					kinds: ["runtime"],
				},
			},
		});

		expect(invalidations).toEqual([
			{
				kind: "changed",
				interactionSessionId: "interaction-1",
				timelineCursor: { epoch: "timeline-1", sequence: 1 },
				kinds: ["runtime"],
			},
		]);
	});

	it("accepts an uncertain pending-answer receipt after crash recovery", async () => {
		const answer = {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-1",
			runtime: {
				runtimeGeneration: "runtime-1",
				providerEpoch: "query-1",
			},
			requestId: "permission-1",
			clientMessageId: "message-1",
			idempotencyKey: "answer-1",
			answer: { decision: "allow" },
			requestedAtMs: 10,
		};
		const invokeCommand = vi.fn().mockResolvedValue(
			envelope({
				receipt: {
					intent: answer,
					request: { request: { requestId: "permission-1" } },
					state: "uncertain",
					providerReceipt: null,
					newlyPrepared: false,
					updatedAtMs: 11,
				},
			}),
		);
		const client = createDureAgentConversationClient({ invokeCommand });

		await expect(
			client.answerPending(answer, routeAuthority()),
		).resolves.toBeUndefined();
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: routeAuthority() },
			operation: "agent_conversation.answer_pending",
			body: answer,
		});
	});

	it("interrupts only through the observed exact route", async () => {
		const interrupt = {
			schemaVersion: 1 as const,
			interactionSessionId: "interaction-1",
			runtime: {
				runtimeGeneration: "runtime-1",
				providerEpoch: "query-1",
			},
			turnId: "turn-1",
			clientMessageId: "message-1",
			interruptRequestId: "interrupt-1",
			requestedAtMs: 10,
		};
		const invokeCommand = vi.fn().mockResolvedValue(
			envelope({
				receipt: {
					intent: interrupt,
					request: interrupt,
					completedAtMs: 11,
				},
			}),
		);
		const client = createDureAgentConversationClient({ invokeCommand });

		await client.interruptTurn(interrupt, routeAuthority());
		expect(invokeCommand).toHaveBeenCalledWith("dure_backend_request", {
			route: { kind: "exact", authority: routeAuthority() },
			operation: "agent_conversation.interrupt_turn",
			body: interrupt,
		});
	});
});

it("writes a goal to the exact observed server and checks the returned revision", async () => {
	const request = {
		schemaVersion: 1 as const,
		agentId: "agent-1",
		expectedRevision: 1,
		idempotencyKey: "goal-write-1",
		objective: "Ship the feature",
		status: "active" as const,
		detail: null,
	};
	const goal = {
		schemaVersion: 1,
		agentId: "agent-1",
		revision: 2,
		objective: request.objective,
		status: request.status,
		detail: null,
		activationCursor: { epoch: "timeline-1", sequence: 0 },
		createdAtMs: 1,
		updatedAtMs: 2,
	};
	const invokeCommand = vi.fn(async () => envelope({ goal }));
	const client = createDureAgentConversationClient({ invokeCommand });
	await expect(client.putGoal(request, routeAuthority())).resolves.toEqual(
		goal,
	);
	expect(invokeCommand).toHaveBeenCalledExactlyOnceWith(
		"dure_backend_request",
		{
			route: { kind: "exact", authority: routeAuthority() },
			operation: "agent_goal.put",
			body: request,
		},
	);
	invokeCommand.mockResolvedValueOnce(
		envelope({ goal: { ...goal, agentId: "agent-other" } }),
	);
	await expect(client.putGoal(request, routeAuthority())).rejects.toMatchObject(
		{ code: "agent_conversation_response_invalid" },
	);
});
