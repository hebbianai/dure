import { describe, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import {
	createDureOrchestrationTransport,
	DureOrchestrationError,
	type DureOrchestrationTransport,
} from "@/lib/ipc/dureOrchestration";
import type {
	DelegateOnceReceiptV1,
	DureWorkflowTransport,
} from "@/lib/ipc/dureWorkflow";
import {
	createDureWorkflowTransport,
	DureWorkflowError,
} from "@/lib/ipc/dureWorkflow";
import {
	type DelegateOnceIntentStorage,
	type DelegateOnceIntentV1,
	readDelegateOnceIntents,
} from "@/lib/workflows/delegateOnce";
import {
	type DelegateOnceRuntimeDependencies,
	delegateOnceFromAgent,
	resumeInterruptedDelegateOnceIntents,
} from "@/lib/workflows/delegateOnceRuntime";
import { agentFixture, managedBindingFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent } from "@/types";

function storage(): DelegateOnceIntentStorage {
	const values = new Map<string, string>();
	return {
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}

const fence = {
	runnerPrincipal: "runner",
	runnerInstance: "instance",
	channelEpoch: "1",
	hostInstanceId: "host",
	terminalEpoch: "terminal",
};

const testRouteAuthority = testDureBackendRouteAuthority(
	"backend-test",
	"generation-test",
);

const resolveTestRouteAuthority = async () => testRouteAuthority;

const coordinator: Agent = agentFixture({
	name: "coordinator",
	worktreePath: "/repo",
	branch: "agent/coordinator",
	sessionId: "coordinator-session",
	runtimeBinding: managedBindingFixture({
		sessionId: "coordinator-session",
		createIdempotencyKey: undefined,
		stopFence: fence,
	}),
});

const input = {
	contributionId: "dure.core.delegate-once",
	desktopId: "desktop-1",
	coordinator,
	task: { summary: "Review", instructions: "Review this bounded change." },
	providerId: "codex" as const,
};

function receipt(idempotencyKey: string): DelegateOnceReceiptV1 {
	const digest = "c".repeat(64);
	return {
		schemaVersion: 1,
		idempotencyKey,
		runId: `run.${digest}`,
		taskId: `task.${digest}`,
		dispatchId: `dispatch.${digest}`,
		generation: 1,
		status: "active",
		launchIdempotencyKey: `workflow:${digest}`,
		session: {
			sessionId: "worker-session",
			workspaceId: "workspace-1",
			providerId: "codex",
			...fence,
		},
		promptDelivery: {
			idempotencyKey: "workflow-prompt",
			state: "written_to_pty",
		},
		createdAtMs: 1,
		updatedAtMs: 2,
	};
}

function backendEnvelope(
	authority: DureBackendRouteAuthorityV1,
	result: Record<string, unknown>,
) {
	return {
		schemaVersion: 1,
		backendId: authority.backend.id,
		backendGeneration: authority.backend.generation,
		routeAuthority: authority,
		result: { schemaVersion: 1, ...result },
	};
}

function requestedRoute(
	request: Record<string, unknown>,
	selected: DureBackendRouteAuthorityV1,
): DureBackendRouteAuthorityV1 {
	const route = request.route as
		| { kind: "selected" }
		| { kind: "exact"; authority: DureBackendRouteAuthorityV1 };
	return route.kind === "exact" ? route.authority : selected;
}

const projectedWorker: Agent = {
	...coordinator,
	id: "agent-worker",
	name: "worker",
	sessionId: "worker-session",
};

const targetFence = {
	...fence,
	runnerInstance: "target-instance",
	terminalEpoch: "target-terminal",
};

const existingTarget: Agent = {
	...coordinator,
	id: "agent-target",
	name: "existing-target",
	displayName: "Existing target",
	sessionId: "target-session",
	runtimeBinding: managedBindingFixture({
		sessionId: "target-session",
		createIdempotencyKey: "create-target",
		stopFence: targetFence,
	}),
};

const targetDigest = "d".repeat(64);
const assignmentContext = {
	schemaVersion: 1 as const,
	target: {
		authority: { workspaceId: "workspace-1" },
		runId: `run.${targetDigest}`,
		taskId: `task.${targetDigest}`,
		dispatchId: `dispatch.${targetDigest}`,
		generation: 1,
	},
	dispatchRevision: 1,
	participant: "participant-target",
	interactionCapability: "capability-interaction",
	completionCapability: "capability-completion",
	deliveryCapability: "capability-target-delivery",
	acknowledgementCapability: "capability-target-ack",
	endpointFence: {
		endpointRef: "endpoint-target",
		sessionIdentity: "session-identity-target",
		generation: 1,
		deliveryCapability: "capability-target-delivery",
		acknowledgementCapability: "capability-target-ack",
	},
	coordinatorGrant: {
		membershipRef: "membership-coordinator",
		participant: "participant-coordinator",
		roles: ["role.coordinator"],
		capabilities: [
			"capability-coordinator-delivery",
			"capability-coordinator-reply",
		],
		deliveryCapability: "capability-coordinator-delivery",
	},
	coordinatorReplyCapability: "capability-coordinator-reply",
	integrationReceipt: {
		installRootRef: "install-codex-test",
		version: "test-v1",
		digest: "a".repeat(64),
		channel: "test",
		capabilities: ["event_cursor_v1", "idempotent_delivery_receipt_v1"],
	},
};

function existingInput() {
	return {
		...input,
		providerId: existingTarget.provider,
		target: existingTarget,
	};
}

function assignmentReceipt(idempotent = false) {
	return {
		interaction: {
			kind: "message" as const,
			common: {
				id: "assignment-delegate-once-test",
				target: assignmentContext.target,
				revision: 1,
				title: input.task.summary,
				descriptionMarkdown: input.task.instructions,
				author: assignmentContext.coordinatorGrant.participant,
				audience: {
					grants: [
						{
							membershipRef: "membership-target",
							participant: assignmentContext.participant,
							roles: ["role.worker"],
							capabilities: [assignmentContext.deliveryCapability],
							deliveryCapability: assignmentContext.deliveryCapability,
						},
					],
				},
				createdAtMs: 1,
			},
			purpose: "update" as const,
		},
		dispatchState: "active" as const,
		events: [
			{
				cursor: 2,
				target: assignmentContext.target,
				actor: assignmentContext.coordinatorGrant.participant,
				kind: {
					kind: "interaction_opened" as const,
					interactionId: "assignment-delegate-once-test",
				},
				recordedAtMs: 1,
			},
		],
		deliveries: [
			{
				receiptId: "delivery-assignment",
				eventCursor: 2,
				participant: assignmentContext.participant,
				state: "queued" as const,
				endpoint: {
					endpointRef: assignmentContext.endpointFence.endpointRef,
					sessionIdentity: assignmentContext.endpointFence.sessionIdentity,
					generation: assignmentContext.endpointFence.generation,
				},
			},
		],
		idempotent,
	};
}

function existingTargetDependencies(options?: {
	getContext?: DureOrchestrationTransport["getExactDispatchContext"];
	openMessage?: DureOrchestrationTransport["openExactSessionMessage"];
}) {
	const ensureCoordinatorBinding = vi.fn(async () => ({
		agentId: coordinator.id,
		sessionId: coordinator.sessionId,
		bindingGeneration: 7,
	}));
	const delegateOnce = vi.fn(async (_route, request) =>
		receipt(request.idempotencyKey),
	);
	const getExactDispatchContext =
		options?.getContext ?? vi.fn(async () => ({ receipt: assignmentContext }));
	const openExactSessionMessage =
		options?.openMessage ??
		vi.fn(async () => ({ receipt: assignmentReceipt(false) }));
	const projected = {
		...existingTarget,
		workflowDispatch: {
			schemaVersion: 1 as const,
			taskId: assignmentContext.target.taskId,
			dispatchId: assignmentContext.target.dispatchId,
			generation: assignmentContext.target.generation,
		},
	};
	const dependencies = {
		transport: { ensureCoordinatorBinding, delegateOnce },
		orchestrationTransport: {
			getExactDispatchContext,
			openExactSessionMessage,
		},
		resolveAgents: () => [coordinator, existingTarget],
		resolveRouteAuthority: resolveTestRouteAuthority,
		projectExistingTarget: vi.fn(() => projected),
		projectWorker: () => projectedWorker,
	} as unknown as DelegateOnceRuntimeDependencies;
	return {
		dependencies,
		delegateOnce,
		ensureCoordinatorBinding,
		getExactDispatchContext,
		openExactSessionMessage,
		projected,
	};
}

describe("delegate-once runtime", () => {
	it("keeps one persisted backend route across binding, delegate, and app-resume retry", async () => {
		const memory = storage();
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let selected = routeA;
		const delegateMutations = new Map<string, number>();
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command === "dure_backend_route_assert") {
					return requestedRoute(arguments_, selected);
				}
				const authority = requestedRoute(arguments_, selected);
				if (arguments_.operation === "agent_checkpoint.binding.ensure") {
					selected = routeB;
					return backendEnvelope(authority, {
						identity: {
							agentId: coordinator.id,
							sessionId: coordinator.sessionId,
							bindingGeneration: 4,
						},
					});
				}
				if (arguments_.operation === "workflow.delegate_once") {
					delegateMutations.set(
						authority.backend.id,
						(delegateMutations.get(authority.backend.id) ?? 0) + 1,
					);
					throw new Error("response lost after delegate mutation");
				}
				throw new Error(
					`unexpected backend operation ${String(arguments_.operation)}`,
				);
			},
		);
		const resolveRouteAuthority = vi.fn(async () => selected);
		const dependencies = {
			storage: memory,
			transport: createDureWorkflowTransport({ invokeCommand }),
			resolveRouteAuthority,
			projectWorker: () => projectedWorker,
		} as unknown as DelegateOnceRuntimeDependencies;

		await expect(delegateOnceFromAgent(input, dependencies)).rejects.toThrow(
			"response lost after delegate mutation",
		);
		const [stored] = readDelegateOnceIntents(memory);
		expect(
			(
				stored as DelegateOnceIntentV1 & {
					routeAuthority?: DureBackendRouteAuthorityV1;
				}
			).routeAuthority,
		).toEqual(routeA);
		expect(delegateMutations.get("backend-b") ?? 0).toBe(0);

		await resumeInterruptedDelegateOnceIntents(dependencies);
		expect(resolveRouteAuthority).toHaveBeenCalledTimes(1);
		expect(delegateMutations.get("backend-a") ?? 0).toBe(2);
		expect(delegateMutations.get("backend-b") ?? 0).toBe(0);
		expect(readDelegateOnceIntents(memory)[0]).toMatchObject({
			routeAuthority: routeA,
		});
	});

	it("assigns the durable task to one exact existing Agent without launching a worker", async () => {
		const memory = storage();
		const fixture = existingTargetDependencies();
		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).resolves.toBe(fixture.projected);
		expect(fixture.getExactDispatchContext).toHaveBeenCalledTimes(1);
		expect(fixture.openExactSessionMessage).toHaveBeenCalledTimes(1);
		expect(fixture.delegateOnce).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("retries an existing-target context and Message on the intent's stored route", async () => {
		const memory = storage();
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let selected = routeA;
		let openAttempts = 0;
		const openMutations = new Map<string, number>();
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command === "dure_backend_route_assert") {
					return requestedRoute(arguments_, selected);
				}
				const authority = requestedRoute(arguments_, selected);
				if (arguments_.operation === "agent_checkpoint.binding.ensure") {
					return backendEnvelope(authority, {
						identity: {
							agentId: coordinator.id,
							sessionId: coordinator.sessionId,
							bindingGeneration: 7,
						},
					});
				}
				if (arguments_.operation !== "orchestration.invoke") {
					throw new Error(
						`unexpected backend operation ${String(arguments_.operation)}`,
					);
				}
				const invocation = arguments_.body as {
					method: string;
					body: Record<string, unknown>;
				};
				if (invocation.method === "dispatch.context.get.exact-session") {
					selected = routeB;
					return backendEnvelope(authority, {
						apiVersion: "dure.orchestration/v1",
						method: invocation.method,
						receipt: assignmentContext,
					});
				}
				if (invocation.method === "interaction.message.open.exact-session") {
					openAttempts += 1;
					openMutations.set(
						authority.backend.id,
						(openMutations.get(authority.backend.id) ?? 0) + 1,
					);
					if (openAttempts === 1) {
						throw new Error("response lost after Message mutation");
					}
					const opened = assignmentReceipt(true);
					const interactionId = String(invocation.body.interactionId);
					const openedAtMs = Number(invocation.body.openedAtMs);
					return backendEnvelope(authority, {
						apiVersion: "dure.orchestration/v1",
						method: invocation.method,
						receipt: {
							...opened,
							interaction: {
								...opened.interaction,
								common: {
									...opened.interaction.common,
									id: interactionId,
									createdAtMs: openedAtMs,
								},
							},
							events: opened.events.map((event) => ({
								...event,
								kind: { ...event.kind, interactionId },
								recordedAtMs: openedAtMs,
							})),
						},
					});
				}
				throw new Error(`unexpected orchestration method ${invocation.method}`);
			},
		);
		const projected = {
			...existingTarget,
			workflowDispatch: {
				schemaVersion: 1 as const,
				taskId: assignmentContext.target.taskId,
				dispatchId: assignmentContext.target.dispatchId,
				generation: assignmentContext.target.generation,
			},
		};
		const dependencies = {
			storage: memory,
			transport: createDureWorkflowTransport({ invokeCommand }),
			orchestrationTransport: createDureOrchestrationTransport({
				invokeCommand,
			}),
			resolveRouteAuthority: vi.fn(async () => selected),
			resolveAgents: () => [coordinator, existingTarget],
			projectExistingTarget: vi.fn(() => projected),
			projectWorker: () => projectedWorker,
		} as unknown as DelegateOnceRuntimeDependencies;

		await expect(
			delegateOnceFromAgent(existingInput(), dependencies),
		).rejects.toThrow("response lost after Message mutation");
		expect(openMutations.get("backend-b") ?? 0).toBe(0);
		expect(readDelegateOnceIntents(memory)[0]).toMatchObject({
			routeAuthority: routeA,
			target: { context: expect.any(Object) },
		});

		await resumeInterruptedDelegateOnceIntents(dependencies);
		expect(openMutations.get("backend-a") ?? 0).toBe(2);
		expect(openMutations.get("backend-b") ?? 0).toBe(0);
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("retains an existing-target journal when exact context lookup is retryable", async () => {
		const memory = storage();
		const getContext = vi.fn(async () => {
			throw new DureOrchestrationError(
				"orchestration_future_context_failure",
				"the exact context lookup can be retried",
				{ kind: "operation", disposition: "retry_same" },
			);
		});
		const fixture = existingTargetDependencies({ getContext });

		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).rejects.toMatchObject({ code: "orchestration_future_context_failure" });
		expect(fixture.openExactSessionMessage).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toHaveLength(1);
	});

	it("fails closed when the exact context fence changes before delivery", async () => {
		const memory = storage();
		const openMessage = vi.fn(async () => {
			throw new DureOrchestrationError(
				"orchestration_generation_conflict",
				"context fence changed",
				{ kind: "operation", disposition: "terminal" },
			);
		});
		const fixture = existingTargetDependencies({ openMessage });
		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).rejects.toMatchObject({ code: "orchestration_generation_conflict" });
		expect(fixture.getExactDispatchContext).toHaveBeenCalledTimes(1);
		expect(fixture.openExactSessionMessage).toHaveBeenCalledTimes(1);
		expect(fixture.delegateOnce).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it.each([
		"orchestration_generation_conflict",
		"orchestration_future_delivery_failure",
	])(
		"retains an existing-target journal for retryable code %s",
		async (errorCode) => {
			const memory = storage();
			const openMessage = vi.fn(async () => {
				throw new DureOrchestrationError(
					errorCode,
					"the exact operation can be retried",
					{ kind: "operation", disposition: "retry_same" },
				);
			});
			const fixture = existingTargetDependencies({ openMessage });

			await expect(
				delegateOnceFromAgent(existingInput(), {
					...fixture.dependencies,
					storage: memory,
				}),
			).rejects.toMatchObject({ code: errorCode });
			expect(readDelegateOnceIntents(memory)).toHaveLength(1);
		},
	);

	it("unlocks a pre-delivery intent when the pane generation changes after preview", async () => {
		const memory = storage();
		const replacement = {
			...existingTarget,
			runtimeBinding: {
				...existingTarget.runtimeBinding!,
				stopFence: {
					...targetFence,
					terminalEpoch: "replacement-terminal",
				},
			},
		};
		const resolveAgents = vi
			.fn()
			.mockReturnValueOnce([coordinator, existingTarget])
			.mockReturnValueOnce([coordinator, existingTarget])
			.mockReturnValue([coordinator, replacement]);
		const fixture = existingTargetDependencies();

		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				resolveAgents,
				storage: memory,
			}),
		).rejects.toThrow("exact Session generation이 변경되었습니다");
		expect(fixture.openExactSessionMessage).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("replays one uncertain existing-target delivery with identical inputs", async () => {
		const memory = storage();
		let firstRequest: unknown;
		const openMessage = vi
			.fn()
			.mockImplementationOnce(async (routeAuthority, request) => {
				firstRequest = { routeAuthority, request };
				throw new Error("response lost after durable write");
			})
			.mockImplementationOnce(async (routeAuthority, request) => {
				expect({ routeAuthority, request }).toEqual(firstRequest);
				return { receipt: assignmentReceipt(true) };
			});
		const fixture = existingTargetDependencies({ openMessage });
		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).rejects.toThrow("response lost after durable write");
		expect(readDelegateOnceIntents(memory)).toHaveLength(1);

		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).resolves.toBe(fixture.projected);
		expect(fixture.ensureCoordinatorBinding).toHaveBeenCalledTimes(1);
		expect(openMessage).toHaveBeenCalledTimes(2);
		expect(fixture.delegateOnce).not.toHaveBeenCalled();
	});

	it("resumes the same existing-target interaction after reconnect", async () => {
		const memory = storage();
		const openMessage = vi
			.fn()
			.mockRejectedValueOnce(new Error("connection closed"))
			.mockResolvedValueOnce({ receipt: assignmentReceipt(true) });
		const fixture = existingTargetDependencies({ openMessage });
		await expect(
			delegateOnceFromAgent(existingInput(), {
				...fixture.dependencies,
				storage: memory,
			}),
		).rejects.toThrow("connection closed");

		await resumeInterruptedDelegateOnceIntents({
			...fixture.dependencies,
			storage: memory,
		});
		expect(openMessage).toHaveBeenCalledTimes(2);
		expect(fixture.delegateOnce).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("unlocks inputs when coordinator binding fails before any Dispatch", async () => {
		const memory = storage();
		const transport: DureWorkflowTransport = {
			ensureCoordinatorBinding: vi.fn(async () => {
				throw new DureWorkflowError(
					"agent_checkpoint_binding_stale",
					"binding stale",
					{ kind: "operation", disposition: "terminal" },
				);
			}),
			delegateOnce: vi.fn(),
		};
		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).rejects.toMatchObject({ code: "agent_checkpoint_binding_stale" });
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("journals before binding, then recovers with the same request after response loss", async () => {
		const memory = storage();
		let firstRequest: unknown;
		const firstTransport: DureWorkflowTransport = {
			ensureCoordinatorBinding: vi.fn(async () => {
				expect(readDelegateOnceIntents(memory)).toHaveLength(1);
				return {
					agentId: coordinator.id,
					sessionId: coordinator.sessionId,
					bindingGeneration: 4,
				};
			}),
			delegateOnce: vi.fn(async (_route, request) => {
				firstRequest = request;
				throw new Error("response lost");
			}),
		};
		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport: firstTransport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).rejects.toThrow("response lost");
		const [pending] = readDelegateOnceIntents(memory);
		expect(pending.coordinator.bindingGeneration).toBe(4);
		expect(firstRequest).toMatchObject({
			contributionId: "dure.core.delegate-once",
		});

		const ensureAgain = vi.fn();
		const secondTransport: DureWorkflowTransport = {
			ensureCoordinatorBinding: ensureAgain,
			delegateOnce: vi.fn(async (_route, request) => {
				expect(request).toEqual(firstRequest);
				return receipt(request.idempotencyKey);
			}),
		};
		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport: secondTransport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).resolves.toBe(projectedWorker);
		expect(ensureAgain).not.toHaveBeenCalled();
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it("unlocks a definitive workflow prelaunch refusal", async () => {
		const memory = storage();
		const transport: DureWorkflowTransport = {
			ensureCoordinatorBinding: vi.fn(async () => ({
				agentId: coordinator.id,
				sessionId: coordinator.sessionId,
				bindingGeneration: 1,
			})),
			delegateOnce: vi.fn(async () => {
				throw new DureWorkflowError(
					"workflow_provider_unavailable",
					"provider unavailable",
					{ kind: "operation", disposition: "terminal" },
				);
			}),
		};
		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).rejects.toMatchObject({ code: "workflow_provider_unavailable" });
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});

	it.each([
		"workflow_provider_unavailable",
		"workflow_future_prelaunch_failure",
	])("retains a prelaunch journal for retryable code %s", async (errorCode) => {
		const memory = storage();
		const transport: DureWorkflowTransport = {
			ensureCoordinatorBinding: vi.fn(async () => ({
				agentId: coordinator.id,
				sessionId: coordinator.sessionId,
				bindingGeneration: 1,
			})),
			delegateOnce: vi.fn(async () => {
				throw new DureWorkflowError(
					errorCode,
					"provider availability is transient",
					{ kind: "operation", disposition: "retry_same" },
				);
			}),
		};

		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).rejects.toMatchObject({ code: errorCode });
		expect(readDelegateOnceIntents(memory)).toHaveLength(1);
	});

	it("clears a terminal start-failure receipt instead of retrying forever", async () => {
		const memory = storage();
		const transport: DureWorkflowTransport = {
			ensureCoordinatorBinding: vi.fn(async () => ({
				agentId: coordinator.id,
				sessionId: coordinator.sessionId,
				bindingGeneration: 1,
			})),
			delegateOnce: vi.fn(async (_route, request) => {
				const active = receipt(request.idempotencyKey);
				return {
					...active,
					status: "start_failed" as const,
					session: undefined,
					promptDelivery: undefined,
					startErrorCode: "hmux_managed_create_refused",
				};
			}),
		};
		await expect(
			delegateOnceFromAgent(input, {
				storage: memory,
				transport,
				resolveRouteAuthority: resolveTestRouteAuthority,
				projectWorker: () => projectedWorker,
			}),
		).rejects.toMatchObject({ code: "hmux_managed_create_refused" });
		expect(readDelegateOnceIntents(memory)).toEqual([]);
	});
});
