import { describe, expect, it, vi } from "vitest";
import {
	createDureOrchestrationTransport,
	eventInteractionId,
	MAX_DISPATCH_CONTEXT_BATCH_ITEMS,
	MAX_READ_EVENTS_BATCH_ITEMS,
} from "@/lib/ipc/dureOrchestration";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const target = {
	authority: { workspaceId: "workspace-1" },
	runId: "run-1",
	taskId: "task-1",
	dispatchId: "dispatch-1",
	generation: 1,
};
const session = {
	sessionId: "session-1",
	workspaceId: "workspace-1",
	providerId: "codex",
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "terminal",
};
const routeAuthority = testDureBackendRouteAuthority(
	"dure-local",
	"generation-1",
);
const grant = {
	membershipRef: "membership-owner",
	participant: "participant-owner",
	roles: ["role.coordinator"],
	capabilities: ["capability-inbox", "capability-reply"],
	deliveryCapability: "capability-inbox",
};
const context = {
	schemaVersion: 1,
	target,
	dispatchRevision: 2,
	dispatchState: "active",
	successorRequired: false,
	participant: "participant-worker",
	interactionCapability: "capability-interaction",
	completionCapability: "capability-completion",
	deliveryCapability: "capability-worker-inbox",
	acknowledgementCapability: "capability-worker-ack",
	wakeCapability: "capability-worker-wake",
	endpointFence: {
		endpointRef: "endpoint-1",
		sessionIdentity: "session-identity-1",
		generation: 1,
		deliveryCapability: "capability-worker-inbox",
		acknowledgementCapability: "capability-worker-ack",
	},
	coordinatorGrant: grant,
	coordinatorReplyCapability: "capability-reply",
	integrationReceipt: {
		installRootRef: "install-root-1",
		version: "v1",
		digest: "a".repeat(64),
		channel: "test",
		capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
	},
};
const openDecision = {
	kind: "decision",
	common: {
		id: "decision-1",
		target,
		author: "participant-worker",
		audience: { grants: [grant] },
		title: "배포 범위",
		descriptionMarkdown: "**범위**를 선택하세요.",
		revision: 1,
		createdAtMs: 10,
	},
	response: {
		kind: "select",
		options: [
			{ id: "local", label: "로컬" },
			{ id: "remote", label: "원격" },
		],
		minSelections: 1,
		maxSelections: 1,
	},
	replyCapability: "capability-reply",
	state: { state: "open" },
};
const blockedEvent = {
	cursor: 4,
	target,
	actor: "participant-worker",
	kind: { kind: "dispatch_blocked", decisionId: "decision-1" },
	recordedAtMs: 11,
};
const delivery = {
	receiptId: "delivery-4-owner",
	eventCursor: 4,
	participant: "participant-owner",
	state: "observed",
};
const answerRequest = {
	schemaVersion: 1 as const,
	session,
	expectedDispatchRevision: 2,
	expectedReplyCapability: "capability-reply",
	idempotencyKey: "interaction.answer.r1.fixture",
	interactionId: "decision-1",
	expectedRevision: 1,
	answer: { kind: "select" as const, optionIds: ["local"] },
	answeredAtMs: 12,
};
const answeredDecision = {
	...openDecision,
	common: { ...openDecision.common, revision: 2 },
	state: {
		state: "answered",
		receipt: {
			answeredBy: "participant-owner",
			answer: answerRequest.answer,
			answeredAtMs: 12,
		},
	},
};
const answerEvents = [
	{
		cursor: 5,
		target,
		actor: "participant-owner",
		kind: { kind: "decision_answered", decisionId: "decision-1" },
		recordedAtMs: 12,
	},
	{
		cursor: 6,
		target,
		actor: "participant-owner",
		kind: { kind: "dispatch_unblocked", decisionId: "decision-1" },
		recordedAtMs: 12,
	},
];

function envelope(
	method: string,
	receipt: unknown,
	generation = "generation-1",
	profileId = "local",
) {
	return {
		schemaVersion: 1,
		backendId: "dure-local",
		backendGeneration: generation,
		routeAuthority: testDureBackendRouteAuthority(
			"dure-local",
			generation,
			profileId,
		),
		result: {
			schemaVersion: 1,
			apiVersion: "dure.orchestration/v1",
			method,
			receipt,
		},
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("Dure orchestration IPC", () => {
	it("uses one run.create enrollment contract for local and SSH backend carriers", async () => {
		const enrollmentContext = { ...context, dispatchRevision: 1 };
		const event = {
			cursor: 1,
			target,
			actor: "participant-owner",
			kind: {
				kind: "run_created",
				workflowKindRef: "workflow.existing-session-reporting",
			},
			recordedAtMs: 9,
		};
		const receipt = {
			context: enrollmentContext,
			event,
			deliveries: [
				{
					receiptId: "delivery-1-owner",
					eventCursor: 1,
					participant: "participant-owner",
					state: "queued",
				},
				{
					receiptId: "delivery-1-worker",
					eventCursor: 1,
					participant: "participant-worker",
					state: "queued",
					endpoint: {
						endpointRef: "endpoint-1",
						sessionIdentity: "session-identity-1",
						generation: 1,
					},
				},
				{
					receiptId: "delivery-1-reviewer",
					eventCursor: 1,
					participant: "participant-reviewer",
					state: "queued",
				},
			],
			idempotent: false,
		};
		const enrollment = {
			session,
			integrationReceipt: context.integrationReceipt,
			idempotencyKey: "run.enroll.fixture",
			createdAtMs: 9,
		};
		const calls = [] as Array<Record<string, unknown>>;

		for (const profileId of ["local", "ssh-team"]) {
			const invokeCommand = vi.fn(async (_command, arguments_) => {
				calls.push(arguments_ as Record<string, unknown>);
				return envelope("run.create", receipt, "generation-1", profileId);
			});
			const transport = createDureOrchestrationTransport({
				profileId,
				invokeCommand,
			});
			await expect(
				transport.enrollManagedSession(
					testDureBackendRouteAuthority(
						"dure-local",
						"generation-1",
						profileId,
					),
					enrollment,
				),
			).resolves.toEqual({
				backend: { id: "dure-local", generation: "generation-1" },
				receipt,
			});
		}

		expect(
			calls.map(
				(call) =>
					(
						call.route as {
							authority: { profileId: string };
						}
					).authority.profileId,
			),
		).toEqual(["local", "ssh-team"]);
		expect(calls.map((call) => (call.body as { body: unknown }).body)).toEqual([
			expect.objectContaining({
				workflowKindRef: "workflow.existing-session-reporting",
				session,
				integrationReceipt: context.integrationReceipt,
				targetReference: "orchestration.current-session",
			}),
			expect.objectContaining({
				workflowKindRef: "workflow.existing-session-reporting",
				session,
				integrationReceipt: context.integrationReceipt,
				targetReference: "orchestration.current-session",
			}),
		]);
	});

	it("opens one exact-session Message and verifies its endpoint delivery receipt", async () => {
		const request = {
			schemaVersion: 1 as const,
			session,
			expectedEndpointRef: context.endpointFence.endpointRef,
			idempotencyKey: "assignment-open-1",
			interactionId: "assignment-1",
			title: "Review the bounded change",
			descriptionMarkdown: "Report through the durable inbox.",
			openedAtMs: 20,
		};
		const receipt = {
			interaction: {
				kind: "message",
				common: {
					id: request.interactionId,
					target,
					author: grant.participant,
					audience: {
						grants: [
							{
								membershipRef: "membership-worker",
								participant: context.participant,
								roles: ["role.worker"],
								capabilities: [context.deliveryCapability],
								deliveryCapability: context.deliveryCapability,
							},
						],
					},
					title: request.title,
					descriptionMarkdown: request.descriptionMarkdown,
					revision: 1,
					createdAtMs: request.openedAtMs,
				},
				purpose: "update",
			},
			dispatchState: "active",
			events: [
				{
					cursor: 7,
					target,
					actor: grant.participant,
					kind: {
						kind: "interaction_opened",
						interactionId: request.interactionId,
					},
					recordedAtMs: request.openedAtMs,
				},
			],
			deliveries: [
				{
					receiptId: "delivery-assignment-1",
					eventCursor: 7,
					participant: context.participant,
					state: "queued",
					endpoint: {
						endpointRef: context.endpointFence.endpointRef,
						sessionIdentity: context.endpointFence.sessionIdentity,
						generation: context.endpointFence.generation,
					},
					wake: {
						state: "triggered",
						effectRef: "wake-effect-1",
						updatedAtMs: request.openedAtMs,
					},
				},
			],
			idempotent: false,
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const call = arguments_.body as {
				method: string;
				body: Record<string, unknown>;
			};
			expect(call).toEqual({
				apiVersion: "dure.orchestration/v1",
				method: "interaction.message.open.exact-session",
				body: request,
			});
			return envelope(call.method, receipt);
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });
		await expect(
			transport.openExactSessionMessage(routeAuthority, request),
		).resolves.toMatchObject({
			receipt: {
				interaction: { kind: "message", common: { id: "assignment-1" } },
				deliveries: [
					{
						endpoint: { sessionIdentity: "session-identity-1" },
						wake: { state: "triggered" },
					},
				],
			},
		});
	});

	it("keeps service authority scope separate from runtime Session identity", async () => {
		const serviceContext = {
			...context,
			target: {
				...target,
				authority: { workspaceId: "canonical-authority-workspace" },
			},
		};
		const transport = createDureOrchestrationTransport({
			invokeCommand: vi.fn(async () =>
				envelope("dispatch.context.get", serviceContext),
			),
		});

		await expect(
			transport.getDispatchContext(routeAuthority, session),
		).resolves.toMatchObject({
			receipt: {
				target: { authority: { workspaceId: "canonical-authority-workspace" } },
			},
		});
	});

	it("resolves an aligned exact-context batch with typed partial failures", async () => {
		const staleSession = {
			...session,
			sessionId: "session-stale",
			runnerInstance: "instance-stale",
			hostInstanceId: "host-stale",
			terminalEpoch: "terminal-stale",
		};
		const candidate = {
			agentId: "agent-1",
			session,
			expectedDispatch: {
				taskId: target.taskId,
				dispatchId: target.dispatchId,
				generation: target.generation,
			},
		};
		const staleCandidate = {
			...candidate,
			agentId: "agent-stale",
			session: staleSession,
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const call = arguments_.body as {
				method: string;
				body: Record<string, unknown>;
			};
			expect(call).toEqual({
				apiVersion: "dure.orchestration/v1",
				method: "dispatch.context.get.batch",
				body: { schemaVersion: 1, candidates: [candidate, staleCandidate] },
			});
			return envelope(call.method, {
				schemaVersion: 1,
				results: [
					{ outcome: "found", candidate, context },
					{
						outcome: "failed",
						candidate: staleCandidate,
						error: {
							code: "orchestration_generation_conflict",
							message: "the exact generation is stale",
							details: { disposition: "stale_generation" },
						},
					},
				],
			});
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		await expect(
			transport.getDispatchContexts(routeAuthority, [
				candidate,
				staleCandidate,
			]),
		).resolves.toMatchObject({
			receipt: {
				results: [
					{ outcome: "found", candidate, context },
					{
						outcome: "failed",
						candidate: staleCandidate,
						code: "orchestration_generation_conflict",
						failure: { kind: "operation", disposition: "stale_generation" },
					},
				],
			},
		});
	});

	it("rejects batch results before projecting missing, swapped, or invalid items", async () => {
		const otherSession = {
			...session,
			sessionId: "session-2",
			runnerInstance: "instance-2",
			hostInstanceId: "host-2",
			terminalEpoch: "terminal-2",
		};
		const firstCandidate = {
			agentId: "agent-1",
			session,
			expectedDispatch: {
				taskId: target.taskId,
				dispatchId: target.dispatchId,
				generation: target.generation,
			},
		};
		const secondCandidate = {
			agentId: "agent-2",
			session: otherSession,
			expectedDispatch: {
				taskId: "task-2",
				dispatchId: "dispatch-2",
				generation: 2,
			},
		};
		const invalidReceipts = [
			{
				schemaVersion: 1,
				results: [{ outcome: "found", candidate: firstCandidate, context }],
			},
			{
				schemaVersion: 1,
				results: [
					{ outcome: "found", candidate: firstCandidate, context },
					{ outcome: "found", candidate: secondCandidate, context },
					{ outcome: "found", candidate: secondCandidate, context },
				],
			},
			{
				schemaVersion: 1,
				results: [
					{ outcome: "found", candidate: secondCandidate, context },
					{ outcome: "found", candidate: firstCandidate, context },
				],
			},
			{
				schemaVersion: 1,
				results: [
					{ outcome: "found", candidate: firstCandidate, context },
					{ outcome: "found", candidate: firstCandidate, context },
				],
			},
			{
				schemaVersion: 1,
				results: [
					{
						outcome: "found",
						candidate: { agentId: firstCandidate.agentId, session },
						context,
					},
					{ outcome: "found", candidate: secondCandidate, context },
				],
			},
			{
				schemaVersion: 1,
				results: [
					{ outcome: "found", candidate: firstCandidate, context },
					{
						outcome: "failed",
						candidate: secondCandidate,
						error: {
							code: "orchestration_store_failed",
							message: "store unavailable",
							details: { disposition: "later" },
						},
					},
				],
			},
			{
				schemaVersion: 1,
				results: [
					{
						outcome: "found",
						candidate: firstCandidate,
						context: { ...context, dispatchRevision: 0 },
					},
					{ outcome: "found", candidate: secondCandidate, context },
				],
			},
		];

		for (const receipt of invalidReceipts) {
			const transport = createDureOrchestrationTransport({
				invokeCommand: vi.fn(async () =>
					envelope("dispatch.context.get.batch", receipt),
				),
			});
			await expect(
				transport.getDispatchContexts(routeAuthority, [
					firstCandidate,
					secondCandidate,
				]),
			).rejects.toMatchObject({
				code: "orchestration_receipt_invalid",
				failure: { kind: "contract" },
			});
		}
	});

	it("rejects empty, duplicate, and oversized context batches before transport", async () => {
		const invokeCommand = vi.fn();
		const transport = createDureOrchestrationTransport({ invokeCommand });
		const candidate = { agentId: "agent-1", session };
		const oversized = Array.from(
			{ length: MAX_DISPATCH_CONTEXT_BATCH_ITEMS + 1 },
			(_, index) => ({
				agentId: `agent-${index}`,
				session: {
					...session,
					sessionId: `session-${index}`,
					runnerInstance: `instance-${index}`,
					hostInstanceId: `host-${index}`,
					terminalEpoch: `terminal-${index}`,
				},
			}),
		);

		for (const candidates of [
			[],
			[candidate, candidate],
			[
				{
					...candidate,
					expectedDispatch: {
						taskId: target.taskId,
						dispatchId: target.dispatchId,
						generation: 0,
					},
				},
			],
			oversized,
		]) {
			await expect(
				transport.getDispatchContexts(routeAuthority, candidates),
			).rejects.toMatchObject({
				code: "orchestration_request_invalid",
				failure: { kind: "contract" },
			});
		}
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("reads an ordered Event batch with typed partial failures", async () => {
		const secondTarget = {
			...target,
			runId: "run-2",
			taskId: "task-2",
			dispatchId: "dispatch-2",
		};
		const firstRequest = {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 3,
			limit: 128,
		};
		const secondRequest = {
			...firstRequest,
			target: secondTarget,
			after: 0,
		};
		const request = {
			authority: target.authority,
			requests: [
				{ correlationId: "subscription:1", request: firstRequest },
				{ correlationId: "subscription:2", request: secondRequest },
			],
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const call = arguments_.body as {
				method: string;
				body: Record<string, unknown>;
			};
			expect(call).toEqual({
				apiVersion: "dure.orchestration/v1",
				method: "events.read.batch",
				body: {
					schemaVersion: 1,
					authority: target.authority,
					requests: [
						{
							correlationId: "subscription:1",
							request: { schemaVersion: 1, ...firstRequest },
						},
						{
							correlationId: "subscription:2",
							request: { schemaVersion: 1, ...secondRequest },
						},
					],
				},
			});
			return envelope(call.method, {
				schemaVersion: 1,
				authority: target.authority,
				results: [
					{
						outcome: "read",
						correlationId: "subscription:1",
						receipt: {
							events: [blockedEvent],
							deliveries: [delivery],
							nextCursor: 4,
						},
					},
					{
						outcome: "failed",
						correlationId: "subscription:2",
						error: {
							code: "orchestration_generation_conflict",
							message: "the exact generation is stale",
							details: { disposition: "stale_generation" },
						},
					},
				],
			});
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		await expect(
			transport.readEventsBatch(routeAuthority, request),
		).resolves.toMatchObject({
			receipt: {
				authority: target.authority,
				results: [
					{ outcome: "read", correlationId: "subscription:1" },
					{
						outcome: "failed",
						correlationId: "subscription:2",
						code: "orchestration_generation_conflict",
						failure: { kind: "operation", disposition: "stale_generation" },
					},
				],
			},
		});
	});

	it("rejects an entire Event batch before exposing a miscorrelated item", async () => {
		const secondTarget = {
			...target,
			runId: "run-2",
			taskId: "task-2",
			dispatchId: "dispatch-2",
		};
		const requests = [
			{
				correlationId: "subscription:1",
				request: {
					authority: target.authority,
					target,
					participant: "participant-owner",
					deliveryCapability: "capability-inbox",
					after: 3,
					limit: 128,
				},
			},
			{
				correlationId: "subscription:2",
				request: {
					authority: target.authority,
					target: secondTarget,
					participant: "participant-owner",
					deliveryCapability: "capability-inbox",
					after: 0,
					limit: 128,
				},
			},
		];
		const emptyResults = [
			{
				outcome: "read",
				correlationId: "subscription:1",
				receipt: { events: [], deliveries: [], nextCursor: 3 },
			},
			{
				outcome: "read",
				correlationId: "subscription:2",
				receipt: { events: [], deliveries: [], nextCursor: 0 },
			},
		];
		const foreignTarget = {
			...target,
			authority: { workspaceId: "foreign-workspace" },
		};
		const invalidReceipts = [
			{ schemaVersion: 1, authority: target.authority, results: [emptyResults[0]] },
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [...emptyResults, emptyResults[1]],
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [emptyResults[1], emptyResults[0]],
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [emptyResults[0], { ...emptyResults[1], correlationId: "subscription:1" }],
			},
			{
				schemaVersion: 1,
				authority: foreignTarget.authority,
				results: emptyResults,
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [
					{
						...emptyResults[0],
						receipt: {
							events: [{ ...blockedEvent, target: foreignTarget }],
							deliveries: [delivery],
							nextCursor: 4,
						},
					},
					emptyResults[1],
				],
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [
					{
						...emptyResults[0],
						receipt: {
							events: [blockedEvent],
							deliveries: [{ ...delivery, participant: "participant-foreign" }],
							nextCursor: 4,
						},
					},
					emptyResults[1],
				],
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [
					{
						...emptyResults[0],
						receipt: {
							events: [blockedEvent],
							deliveries: [delivery],
							nextCursor: 5,
						},
					},
					emptyResults[1],
				],
			},
			{
				schemaVersion: 1,
				authority: target.authority,
				results: [
					emptyResults[0],
					{
						...emptyResults[1],
						receipt: { events: [], deliveries: [], nextCursor: "invalid" },
					},
				],
			},
		];

		for (const receipt of invalidReceipts) {
			const transport = createDureOrchestrationTransport({
				invokeCommand: vi.fn(async () => envelope("events.read.batch", receipt)),
			});
			await expect(
				transport.readEventsBatch(routeAuthority, {
					authority: target.authority,
					requests,
				}),
			).rejects.toMatchObject({
				code: "orchestration_receipt_invalid",
				failure: { kind: "contract" },
			});
		}
	});

	it("validates a nested Event acknowledgement against its exact endpoint fence", async () => {
		const request = {
			authority: target.authority,
			requests: [
				{
					correlationId: "subscription:worker",
					request: {
						authority: target.authority,
						target,
						participant: "participant-worker",
						deliveryCapability: "capability-worker-inbox",
						endpointFence: context.endpointFence,
						after: 4,
						acknowledgement: {
							through: 4,
							idempotencyKey: "ack-worker-cursor-4",
							acknowledgementCapability: "capability-worker-ack",
						},
						limit: 128,
					},
				},
			],
		};
		const acknowledgedDelivery = {
			receiptId: "delivery-4-worker",
			eventCursor: 4,
			participant: "participant-worker",
			state: "acknowledged",
			endpoint: {
				endpointRef: "endpoint-1",
				sessionIdentity: "session-identity-1",
				generation: 1,
			},
		};
		const result = {
			outcome: "read",
			correlationId: "subscription:worker",
			receipt: {
				events: [],
				deliveries: [],
				nextCursor: 4,
				acknowledgement: {
					through: 4,
					delivery: acknowledgedDelivery,
					idempotent: false,
				},
			},
		};
		const validReceipt = {
			schemaVersion: 1,
			authority: target.authority,
			results: [result],
		};
		const validTransport = createDureOrchestrationTransport({
			invokeCommand: vi.fn(async () =>
				envelope("events.read.batch", validReceipt),
			),
		});
		await expect(
			validTransport.readEventsBatch(routeAuthority, request),
		).resolves.toMatchObject({
			receipt: {
				results: [
					{
						outcome: "read",
						receipt: { acknowledgement: { idempotent: false } },
					},
				],
			},
		});

		const invalidReceipts = [
			{
				...validReceipt,
				results: [
					{
						...result,
						receipt: { ...result.receipt, acknowledgement: undefined },
					},
				],
			},
			{
				...validReceipt,
				results: [
					{
						...result,
						receipt: {
							...result.receipt,
							acknowledgement: {
								...result.receipt.acknowledgement,
								through: 3,
							},
						},
					},
				],
			},
			{
				...validReceipt,
				results: [
					{
						...result,
						receipt: {
							...result.receipt,
							acknowledgement: {
								...result.receipt.acknowledgement,
								delivery: {
									...acknowledgedDelivery,
									endpoint: {
										...acknowledgedDelivery.endpoint,
										sessionIdentity: "session-replaced",
									},
								},
							},
						},
					},
				],
			},
		];
		for (const receipt of invalidReceipts) {
			const invalidTransport = createDureOrchestrationTransport({
				invokeCommand: vi.fn(async () =>
					envelope("events.read.batch", receipt),
				),
			});
			await expect(
				invalidTransport.readEventsBatch(routeAuthority, request),
			).rejects.toMatchObject({
				code: "orchestration_receipt_invalid",
				failure: { kind: "contract" },
			});
		}
	});

	it("rejects invalid Event batches before transport", async () => {
		const invokeCommand = vi.fn();
		const transport = createDureOrchestrationTransport({ invokeCommand });
		const request = {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 0,
			limit: 128,
		};
		const oversized = Array.from(
			{ length: MAX_READ_EVENTS_BATCH_ITEMS + 1 },
			(_, index) => ({ correlationId: `subscription:${index}`, request }),
		);
		const invalidRequests = [
			[],
			[
				{ correlationId: "subscription:1", request },
				{ correlationId: "subscription:1", request },
			],
			[{ correlationId: "subscription/invalid", request }],
			[
				{
					correlationId: "subscription:foreign",
					request: {
						...request,
						authority: { workspaceId: "foreign-workspace" },
						target: {
							...target,
							authority: { workspaceId: "foreign-workspace" },
						},
					},
				},
			],
			oversized,
		];

		for (const requests of invalidRequests) {
			await expect(
				transport.readEventsBatch(routeAuthority, {
					authority: target.authority,
					requests,
				}),
			).rejects.toMatchObject({
				code: "orchestration_request_invalid",
				failure: { kind: "contract" },
			});
		}
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("reads heterogeneous authority batches through one exact route carrier", async () => {
		const secondTarget = {
			...target,
			authority: { workspaceId: "workspace-2" },
			runId: "run-2",
			taskId: "task-2",
			dispatchId: "dispatch-2",
		};
		const firstRead = {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 3,
			limit: 128,
		};
		const secondRead = {
			...firstRead,
			authority: secondTarget.authority,
			target: secondTarget,
			after: 0,
		};
		const request = {
			batches: [
				{
					correlationId: "authority:1",
					request: {
						authority: target.authority,
						requests: [
							{ correlationId: "subscription:1", request: firstRead },
						],
					},
				},
				{
					correlationId: "authority:2",
					request: {
						authority: secondTarget.authority,
						requests: [
							{ correlationId: "subscription:2", request: secondRead },
						],
					},
				},
			],
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const call = arguments_.body as {
				method: string;
				body: Record<string, unknown>;
			};
			expect(call).toEqual({
				apiVersion: "dure.orchestration/v1",
				method: "events.read.route.batch",
				body: {
					schemaVersion: 1,
					batches: request.batches.map((batch) => ({
						correlationId: batch.correlationId,
						request: {
							schemaVersion: 1,
							authority: batch.request.authority,
							requests: batch.request.requests.map((item) => ({
								correlationId: item.correlationId,
								request: { schemaVersion: 1, ...item.request },
							})),
						},
					})),
				},
			});
			return envelope(call.method, {
				schemaVersion: 1,
				results: [
					{
						outcome: "read",
						correlationId: "authority:1",
						receipt: {
							schemaVersion: 1,
							authority: target.authority,
							results: [
								{
									outcome: "read",
									correlationId: "subscription:1",
									receipt: {
										events: [blockedEvent],
										deliveries: [delivery],
										nextCursor: 4,
									},
								},
							],
						},
					},
					{
						outcome: "read",
						correlationId: "authority:2",
						receipt: {
							schemaVersion: 1,
							authority: secondTarget.authority,
							results: [
								{
									outcome: "read",
									correlationId: "subscription:2",
									receipt: {
										events: [],
										deliveries: [],
										nextCursor: 0,
									},
								},
							],
						},
					},
				],
			});
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		await expect(
			transport.readEventsRouteBatch(routeAuthority, request),
		).resolves.toMatchObject({
			receipt: {
				results: [
					{ outcome: "read", correlationId: "authority:1" },
					{ outcome: "read", correlationId: "authority:2" },
				],
			},
		});
	});

	it("rejects malformed heterogeneous route receipts before exposing any batch", async () => {
		const secondAuthority = { workspaceId: "workspace-2" };
		const firstRead = {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 3,
			limit: 128,
		};
		const secondTarget = { ...target, authority: secondAuthority, runId: "run-2" };
		const secondRead = {
			...firstRead,
			authority: secondAuthority,
			target: secondTarget,
			after: 0,
		};
		const request = {
			batches: [
				{
					correlationId: "authority:1",
					request: {
						authority: target.authority,
						requests: [
							{ correlationId: "subscription:1", request: firstRead },
						],
					},
				},
				{
					correlationId: "authority:2",
					request: {
						authority: secondAuthority,
						requests: [
							{ correlationId: "subscription:2", request: secondRead },
						],
					},
				},
			],
		};
		const firstResult = {
			outcome: "read",
			correlationId: "authority:1",
			receipt: {
				schemaVersion: 1,
				authority: target.authority,
				results: [
					{
						outcome: "read",
						correlationId: "subscription:1",
						receipt: {
							events: [blockedEvent],
							deliveries: [delivery],
							nextCursor: 4,
						},
					},
				],
			},
		};
		const secondResult = {
			outcome: "read",
			correlationId: "authority:2",
			receipt: {
				schemaVersion: 1,
				authority: secondAuthority,
				results: [
					{
						outcome: "read",
						correlationId: "subscription:2",
						receipt: { events: [], deliveries: [], nextCursor: 0 },
					},
				],
			},
		};
		const invalidReceipts = [
			{ schemaVersion: 1, results: [firstResult] },
			{ schemaVersion: 1, results: [firstResult, secondResult, secondResult] },
			{ schemaVersion: 1, results: [secondResult, firstResult] },
			{
				schemaVersion: 1,
				results: [firstResult, { ...secondResult, correlationId: "authority:1" }],
			},
			{
				schemaVersion: 1,
				results: [
					firstResult,
					{
						outcome: "failed",
						correlationId: "authority:2",
						authority: { workspaceId: "foreign-workspace" },
						error: {
							code: "orchestration_storage_unavailable",
							message: "authority unavailable",
							details: { disposition: "retryable" },
						},
					},
				],
			},
			{
				schemaVersion: 1,
				results: [
					firstResult,
					{
						...secondResult,
						receipt: {
							...secondResult.receipt,
							results: [
								{
									...secondResult.receipt.results[0],
									receipt: {
										events: [],
										deliveries: [],
										nextCursor: "malformed",
									},
								},
							],
						},
					},
				],
			},
		];

		for (const receipt of invalidReceipts) {
			const transport = createDureOrchestrationTransport({
				invokeCommand: vi.fn(async () =>
					envelope("events.read.route.batch", receipt),
				),
			});
			await expect(
				transport.readEventsRouteBatch(routeAuthority, request),
			).rejects.toMatchObject({
				code: "orchestration_receipt_invalid",
				failure: { kind: "contract" },
			});
		}
	});

	it("rejects invalid heterogeneous route batches before transport", async () => {
		const invokeCommand = vi.fn();
		const transport = createDureOrchestrationTransport({ invokeCommand });
		const read = {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 0,
			limit: 128,
		};
		const batch = (index: number) => {
			const authority = { workspaceId: `workspace-${index}` };
			return {
				correlationId: `authority:${index}`,
				request: {
					authority,
					requests: [
						{
							correlationId: `subscription:${index}`,
							request: {
								...read,
								authority,
								target: { ...target, authority, runId: `run-${index}` },
							},
						},
					],
				},
			};
		};
		const first = batch(1);
		const second = batch(2);
		const seventeenLeaves = Array.from({ length: 17 }, (_, index) => ({
			correlationId: `subscription:overflow:${index}`,
			request: {
				...second.request.requests[0]!.request,
				target: {
					...second.request.requests[0]!.request.target,
					runId: `run-overflow-${index}`,
				},
			},
		}));
		const invalidRequests = [
			{ batches: [] },
			{ batches: [first, { ...second, correlationId: first.correlationId }] },
			{
				batches: [
					first,
					{ ...second, request: { ...second.request, authority: first.request.authority } },
				],
			},
			{
				batches: [
					first,
					{
						...second,
						request: {
							...second.request,
							requests: [
								{
									...second.request.requests[0]!,
									correlationId: first.request.requests[0]!.correlationId,
								},
							],
						},
					},
				],
			},
			{ batches: Array.from({ length: 33 }, (_, index) => batch(index + 1)) },
			{
				batches: [
					{
						...first,
						request: {
							...first.request,
							requests: Array.from({ length: 16 }, (_, index) => ({
								...first.request.requests[0]!,
								correlationId: `subscription:first:${index}`,
							})),
						},
					},
					{
						...second,
						request: { ...second.request, requests: seventeenLeaves },
					},
				],
			},
		];

		for (const request of invalidRequests) {
			await expect(
				transport.readEventsRouteBatch(routeAuthority, request),
			).rejects.toMatchObject({
				code: "orchestration_request_invalid",
				failure: { kind: "contract" },
			});
		}
		expect(invokeCommand).not.toHaveBeenCalled();
	});

	it("accepts a service audit Event without inventing an Interaction identity", async () => {
		const runCreated = {
			cursor: 1,
			target,
			actor: "participant-owner",
			kind: {
				kind: "run_created",
				workflowKindRef: "workflow.existing-session-reporting",
			},
			recordedAtMs: 9,
		};
		const invokeCommand = vi.fn(async () =>
			envelope("events.read", {
				events: [runCreated],
				deliveries: [
					{
						receiptId: "delivery-1-owner",
						eventCursor: 1,
						participant: "participant-owner",
						state: "observed",
					},
				],
				nextCursor: 1,
			}),
		);
		const transport = createDureOrchestrationTransport({ invokeCommand });
		const read = await transport.readEvents(routeAuthority, {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 0,
			limit: 128,
		});

		expect(read.receipt.events[0]?.kind).toEqual(runCreated.kind);
		expect(eventInteractionId(read.receipt.events[0]!)).toBeUndefined();
	});

	it("uses one generation-fenced backend carrier for context, Event receipts, and records", async () => {
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const request = arguments_.body as {
				method: string;
				body: Record<string, unknown>;
			};
			switch (request.method) {
				case "dispatch.context.get":
					return envelope(request.method, context);
				case "events.read":
					return envelope(request.method, {
						events: [blockedEvent],
						deliveries: [delivery],
						nextCursor: 4,
					});
				case "interaction.get":
					return envelope(request.method, openDecision);
				case "interaction.decision.answer.exact-session":
					return envelope(request.method, {
						interaction: answeredDecision,
						dispatchState: "active",
						events: answerEvents,
						deliveries: [{ ...delivery, eventCursor: 5 }],
						idempotent: false,
					});
				default:
					throw new Error(`unexpected method ${request.method}`);
			}
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		const resolved = await transport.getDispatchContext(
			routeAuthority,
			session,
		);
		expect(resolved.receipt.coordinatorGrant.participant).toBe(
			"participant-owner",
		);
		const events = await transport.readEvents(routeAuthority, {
			authority: target.authority,
			target,
			participant: "participant-owner",
			deliveryCapability: "capability-inbox",
			after: 3,
			limit: 128,
		});
		expect(events.receipt.nextCursor).toBe(4);
		const interaction = await transport.getInteraction(routeAuthority, {
			authority: target.authority,
			interactionId: "decision-1",
			participant: "participant-owner",
			readCapability: "capability-inbox",
		});
		expect(interaction.receipt).toMatchObject({
			interaction: { kind: "decision", state: "open" },
			replyCapability: "capability-reply",
		});
		const answered = await transport.answerDecision(
			routeAuthority,
			answerRequest,
		);
		expect(answered.receipt).toMatchObject({
			interaction: {
				kind: "decision",
				state: "answered",
				answer: { kind: "select", optionIds: ["local"] },
			},
			dispatchState: "active",
			idempotent: false,
		});
		expect(invokeCommand.mock.calls.map((call) => call[0])).toEqual([
			"dure_backend_request",
			"dure_backend_request",
			"dure_backend_request",
			"dure_backend_request",
		]);
		expect(invokeCommand.mock.calls[1][1]).toMatchObject({
			route: { kind: "exact", authority: routeAuthority },
			operation: "orchestration.invoke",
			body: {
				apiVersion: "dure.orchestration/v1",
				method: "events.read",
			},
		});
		expect(invokeCommand.mock.calls[3][1]).toMatchObject({
			route: { kind: "exact", authority: routeAuthority },
			operation: "orchestration.invoke",
			body: {
				apiVersion: "dure.orchestration/v1",
				method: "interaction.decision.answer.exact-session",
				body: answerRequest,
			},
		});
	});

	it("rejects a mismatched receipt and accepts an explicit replacement lease", async () => {
		let generation = "generation-1";
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const request = arguments_.body as { method: string };
			return request.method === "dispatch.context.get"
				? envelope(request.method, context, generation)
				: envelope(
						request.method,
						{
							events: [blockedEvent],
							deliveries: [{ ...delivery, participant: "participant-foreign" }],
							nextCursor: 4,
						},
						generation,
					);
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });
		await transport.getDispatchContext(routeAuthority, session);
		await expect(
			transport.readEvents(routeAuthority, {
				authority: target.authority,
				target,
				participant: "participant-owner",
				deliveryCapability: "capability-inbox",
				after: 3,
				limit: 128,
			}),
		).rejects.toMatchObject({ code: "orchestration_receipt_invalid" });

		generation = "generation-2";
		const replacementRoute = testDureBackendRouteAuthority(
			"dure-local",
			generation,
		);
		await expect(
			transport.getDispatchContext(replacementRoute, session),
		).resolves.toMatchObject({
			backend: { generation: "generation-2" },
			receipt: context,
		});
	});

	it("rejects Event and Interaction receipts outside the requested authority", async () => {
		const foreignTarget = {
			...target,
			authority: { workspaceId: "workspace-foreign" },
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const request = arguments_.body as { method: string };
			return request.method === "events.read"
				? envelope(request.method, {
						events: [{ ...blockedEvent, target: foreignTarget }],
						deliveries: [delivery],
						nextCursor: 4,
					})
				: envelope(request.method, {
						...openDecision,
						common: { ...openDecision.common, target: foreignTarget },
					});
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		await expect(
			transport.readEvents(routeAuthority, {
				authority: target.authority,
				target,
				participant: "participant-owner",
				deliveryCapability: "capability-inbox",
				after: 3,
				limit: 128,
			}),
		).rejects.toMatchObject({ code: "orchestration_receipt_invalid" });
		await expect(
			transport.getInteraction(routeAuthority, {
				authority: target.authority,
				interactionId: "decision-1",
				participant: "participant-owner",
				readCapability: "capability-inbox",
			}),
		).rejects.toMatchObject({ code: "orchestration_receipt_invalid" });
	});

	it("accepts concurrent reads carrying the same explicit replacement lease", async () => {
		const replacements = [
			deferred<ReturnType<typeof envelope>>(),
			deferred<ReturnType<typeof envelope>>(),
		];
		let call = 0;
		const invokeCommand = vi.fn(async () => {
			call += 1;
			if (call === 1) {
				return envelope("dispatch.context.get", context);
			}
			return replacements[call - 2].promise;
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });
		await transport.getDispatchContext(routeAuthority, session);

		const replacementRoute = testDureBackendRouteAuthority(
			"dure-local",
			"generation-2",
		);
		const first = transport.getDispatchContext(replacementRoute, session);
		const second = transport.getDispatchContext(replacementRoute, session);
		replacements[0].resolve(
			envelope("dispatch.context.get", context, "generation-2"),
		);
		replacements[1].resolve(
			envelope("dispatch.context.get", context, "generation-2"),
		);
		const outcomes = await Promise.allSettled([first, second]);

		expect(outcomes[0]).toMatchObject({
			status: "fulfilled",
			value: { backend: { generation: "generation-2" }, receipt: context },
		});
		expect(outcomes[1]).toMatchObject({
			status: "fulfilled",
			value: { backend: { generation: "generation-2" }, receipt: context },
		});
	});

	it("preserves an authoritative operation disposition without classifying its code", async () => {
		const invokeCommand = vi.fn(async () => {
			throw {
				code: "orchestration_future_context_failure",
				message: "a future backend rejected the context lookup",
				details: { disposition: "unassigned", diagnostic: "retained" },
			};
		});
		const transport = createDureOrchestrationTransport({ invokeCommand });

		await expect(
			transport.getDispatchContext(routeAuthority, session),
		).rejects.toMatchObject({
			code: "orchestration_future_context_failure",
			failure: { kind: "operation", disposition: "unassigned" },
		});
	});

	it("rejects an answer receipt that does not match the submitted answer fence", async () => {
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const request = arguments_.body as { method: string };
			return envelope(request.method, {
				interaction: {
					...answeredDecision,
					state: {
						...answeredDecision.state,
						receipt: {
							...answeredDecision.state.receipt,
							answer: { kind: "select", optionIds: ["remote"] },
						},
					},
				},
				dispatchState: "active",
				events: answerEvents,
				deliveries: [{ ...delivery, eventCursor: 5 }],
				idempotent: false,
			});
		});
		const transport = createDureOrchestrationTransport({
			profileId: "ssh-team",
			invokeCommand,
		});

		await expect(
			transport.answerDecision(routeAuthority, answerRequest),
		).rejects.toMatchObject({
			code: "orchestration_receipt_invalid",
		});
		expect(invokeCommand).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				route: { kind: "exact", authority: routeAuthority },
				operation: "orchestration.invoke",
			}),
		);
	});

	it("replays the exact cursor acknowledgement after an SSH disconnect", async () => {
		const acknowledgedDelivery = {
			receiptId: "delivery-4-worker",
			eventCursor: 4,
			participant: "participant-worker",
			state: "acknowledged",
			endpoint: {
				endpointRef: "endpoint-1",
				sessionIdentity: "session-identity-1",
				generation: 1,
			},
		};
		let disconnected = false;
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const request = arguments_.body as { method: string };
			if (!disconnected) {
				disconnected = true;
				throw new Error("connection closed after write");
			}
			return envelope(request.method, {
				events: [],
				deliveries: [],
				nextCursor: 4,
				acknowledgement: {
					through: 4,
					delivery: acknowledgedDelivery,
					idempotent: true,
				},
			});
		});
		const transport = createDureOrchestrationTransport({
			profileId: "ssh-team",
			invokeCommand,
		});

		const request = {
			authority: target.authority,
			target,
			participant: "participant-worker",
			deliveryCapability: "capability-worker-inbox",
			endpointFence: context.endpointFence,
			after: 4,
			acknowledgement: {
				through: 4,
				idempotencyKey: "ack-worker-cursor-4",
				acknowledgementCapability: "capability-worker-ack",
			},
			limit: 128,
		};
		await expect(
			transport.readEvents(routeAuthority, request),
		).rejects.toMatchObject({
			code: "orchestration_transport_failed",
		});
		const read = await transport.readEvents(routeAuthority, request);
		const replay = await transport.readEvents(routeAuthority, request);

		expect(read.receipt.acknowledgement).toEqual({
			through: 4,
			delivery: acknowledgedDelivery,
			idempotent: true,
		});
		expect(replay.receipt).toEqual(read.receipt);
		expect(invokeCommand.mock.calls[1]).toEqual(invokeCommand.mock.calls[0]);
		expect(invokeCommand.mock.calls[2]).toEqual(invokeCommand.mock.calls[0]);
		expect(invokeCommand).toHaveBeenCalledWith(
			"dure_backend_request",
			expect.objectContaining({
				route: { kind: "exact", authority: routeAuthority },
				operation: "orchestration.invoke",
			}),
		);
	});
});
