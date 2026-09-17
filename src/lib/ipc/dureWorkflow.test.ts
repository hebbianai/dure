import { describe, expect, it, vi } from "vitest";
import {
	createDureWorkflowTransport,
	type DelegateOnceRequestV1,
} from "@/lib/ipc/dureWorkflow";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const fence = {
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

const delegateRequest: DelegateOnceRequestV1 = {
	schemaVersion: 1,
	contributionId: "dure.core.delegate-once",
	coordinator: {
		agentId: "agent-1",
		sessionId: "coordinator-session",
		bindingGeneration: 2,
	},
	task: { summary: "Review", instructions: "Review the bounded change." },
	providerId: "codex",
	runtimeKindId: "runtime.hmux",
	targetReference: "backend-profile:local",
	idempotencyKey: "delegate-once-test",
	createdAtMs: 1_000,
};

function envelope(
	result: Record<string, unknown>,
	generation = "generation-1",
) {
	return {
		schemaVersion: 1,
		backendId: "dure-local",
		backendGeneration: generation,
		routeAuthority: testDureBackendRouteAuthority("dure-local", generation),
		result: { schemaVersion: 1, ...result },
	};
}

function receipt(overrides: Record<string, unknown> = {}) {
	const digest = "a".repeat(64);
	return {
		schemaVersion: 1,
		idempotencyKey: delegateRequest.idempotencyKey,
		runId: `run.${digest}`,
		taskId: `task.${digest}`,
		dispatchId: `dispatch.${digest}`,
		generation: 1,
		status: "active",
		launchIdempotencyKey: `workflow:${digest}`,
		effectiveLaunchIdempotencyKey: "workflow:successor",
		session: {
			sessionId: "worker-session",
			workspaceId: "workspace-1",
			providerId: "codex",
			...fence,
		},
		promptDelivery: {
			idempotencyKey: "workflow-prompt",
			state: "written_to_pty",
			evidence: { ignoredByProjection: true },
		},
		createdAtMs: 1_000,
		updatedAtMs: 1_001,
		...overrides,
	};
}

describe("Dure workflow IPC", () => {
	it("inspects and rebinds one exact active Dispatch generation", async () => {
		const source = {
			sessionId: "worker-session",
			workspaceId: "workspace-1",
			providerId: "codex" as const,
			...fence,
		};
		const target = {
			...source,
			sessionId: "worker-session-rehosted",
			runnerInstance: "instance-rehosted",
			channelEpoch: "2",
			hostInstanceId: "host-rehosted",
			terminalEpoch: "terminal-rehosted",
		};
		const dispatchTarget = {
			authority: { workspaceId: "workspace-1" },
			runId: `run.${"a".repeat(64)}`,
			taskId: `task.${"a".repeat(64)}`,
			dispatchId: `dispatch.${"a".repeat(64)}`,
			generation: 1,
		};
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			const method = arguments_.body.method;
			return envelope({
				apiVersion: "dure.orchestration/v1",
				method,
				receipt:
					method === "dispatch.session.inspect"
						? {
								schemaVersion: 1,
								outcome: "active_dispatch",
								session: source,
								target: {
									...dispatchTarget,
									diagnosticLabel: "worker",
								},
								diagnostics: { source: "backend" },
							}
						: {
								schemaVersion: 1,
								operationId: "permission-relaunch-1",
								outcome: "rebound",
								source,
								target,
								runId: dispatchTarget.runId,
								taskId: dispatchTarget.taskId,
								dispatchId: dispatchTarget.dispatchId,
								generation: 1,
								diagnostics: { replaySafe: true },
							},
			});
		});
		const transport = createDureWorkflowTransport({ invokeCommand });

		await expect(
			transport.inspectDispatchSession(routeAuthority, source),
		).resolves.toMatchObject({
			outcome: "active_dispatch",
			target: dispatchTarget,
		});
		await expect(
			transport.rebindDispatchSession(routeAuthority, {
				schemaVersion: 1,
				operationId: "permission-relaunch-1",
				source,
				target,
				reboundAtMs: 1_200,
			}),
		).resolves.toMatchObject({ outcome: "rebound", target });
		await expect(
			transport.reconcileDispatchSession(routeAuthority, {
				schemaVersion: 1,
				expected: {
					taskId: dispatchTarget.taskId,
					dispatchId: dispatchTarget.dispatchId,
					generation: dispatchTarget.generation,
				},
				target,
				reconciledAtMs: 1_300,
			}),
		).resolves.toMatchObject({ outcome: "rebound", target });
		expect(invokeCommand).toHaveBeenNthCalledWith(1, "dure_backend_request", {
			route: { kind: "exact", authority: routeAuthority },
			operation: "orchestration.invoke",
			body: {
				apiVersion: "dure.orchestration/v1",
				method: "dispatch.session.inspect",
				body: { schemaVersion: 1, session: source },
			},
		});
		expect(invokeCommand).toHaveBeenNthCalledWith(3, "dure_backend_request", {
			route: { kind: "exact", authority: routeAuthority },
			operation: "orchestration.invoke",
			body: {
				apiVersion: "dure.orchestration/v1",
				method: "dispatch.session.reconcile-rehost",
				body: {
					schemaVersion: 1,
					expected: {
						taskId: dispatchTarget.taskId,
						dispatchId: dispatchTarget.dispatchId,
						generation: 1,
					},
					target,
					reconciledAtMs: 1_300,
				},
			},
		});
	});

	it("maps binding and delegate operations onto one fenced local backend", async () => {
		const invokeCommand = vi.fn(async (_command, arguments_) => {
			if (arguments_.operation === "agent_checkpoint.binding.ensure") {
				return envelope({
					identity: {
						agentId: "agent-1",
						sessionId: "coordinator-session",
						bindingGeneration: 2,
					},
				});
			}
			return envelope({ receipt: receipt() });
		});
		const transport = createDureWorkflowTransport({ invokeCommand });

		await expect(
			transport.ensureCoordinatorBinding(routeAuthority, {
				schemaVersion: 1,
				agentId: "agent-1",
				sessionId: "coordinator-session",
				workspaceId: "workspace-1",
				displayName: "Coordinator",
				worktreePath: "/repo",
				stopFence: fence,
			}),
		).resolves.toEqual({
			agentId: "agent-1",
			sessionId: "coordinator-session",
			bindingGeneration: 2,
		});
		await expect(
			transport.delegateOnce(routeAuthority, delegateRequest),
		).resolves.toMatchObject({
			status: "active",
			session: { sessionId: "worker-session", providerId: "codex" },
		});
		expect(invokeCommand).toHaveBeenNthCalledWith(2, "dure_backend_request", {
			route: { kind: "exact", authority: routeAuthority },
			operation: "workflow.delegate_once",
			body: delegateRequest,
		});
	});

	it("rejects a backend generation change between binding and mutation", async () => {
		let call = 0;
		const transport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async (_command, arguments_) => {
				call += 1;
				return arguments_.operation === "agent_checkpoint.binding.ensure"
					? envelope(
							{
								identity: {
									agentId: "agent-1",
									sessionId: "coordinator-session",
									bindingGeneration: 2,
								},
							},
							`generation-${call}`,
						)
					: envelope({ receipt: receipt() }, `generation-${call}`);
			}),
		});
		await transport.ensureCoordinatorBinding(routeAuthority, {
			schemaVersion: 1,
			agentId: "agent-1",
			sessionId: "coordinator-session",
			workspaceId: "workspace-1",
			displayName: "Coordinator",
			worktreePath: "/repo",
			stopFence: fence,
		});
		await expect(
			transport.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({
			code: "workflow_backend_changed",
		});
	});

	it("rejects a foreign provider or malformed terminal receipt", async () => {
		const foreign = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({
					receipt: receipt({
						session: {
							sessionId: "worker-session",
							workspaceId: "workspace-1",
							providerId: "claude",
							...fence,
						},
					}),
				}),
			),
		});
		await expect(
			foreign.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({
			code: "workflow_receipt_invalid",
		});

		const malformed = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({ receipt: receipt({ status: "active", session: null }) }),
			),
		});
		await expect(
			malformed.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({
			code: "workflow_receipt_invalid",
		});
	});

	it("rejects a successor Session paired with the prepared create key", async () => {
		const transport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({
					receipt: receipt({
						effectiveLaunchIdempotencyKey: `workflow:${"a".repeat(64)}`,
					}),
				}),
			),
		});

		await expect(
			transport.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({ code: "workflow_receipt_invalid" });
	});

	it("normalizes a legacy prepared receipt and rejects a legacy successor without its key", async () => {
		const digest = "a".repeat(64);
		const preparedTransport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({
					receipt: receipt({
						effectiveLaunchIdempotencyKey: undefined,
						session: {
							sessionId: `workflow-${digest.slice(0, 32)}`,
							workspaceId: "workspace-1",
							providerId: "codex",
							...fence,
						},
					}),
				}),
			),
		});
		await expect(
			preparedTransport.delegateOnce(routeAuthority, delegateRequest),
		).resolves.toMatchObject({
			effectiveLaunchIdempotencyKey: `workflow:${digest}`,
			session: { sessionId: `workflow-${digest.slice(0, 32)}` },
		});

		const successorTransport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({
					receipt: receipt({ effectiveLaunchIdempotencyKey: undefined }),
				}),
			),
		});
		await expect(
			successorTransport.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({ code: "workflow_receipt_invalid" });
	});

	it("rejects a non-canonical Hmux generation in a workflow receipt", async () => {
		const transport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () =>
				envelope({
					receipt: receipt({
						session: {
							sessionId: "worker-session",
							workspaceId: "workspace-1",
							providerId: "codex",
							...fence,
							channelEpoch: "not-decimal",
						},
					}),
				}),
			),
		});

		await expect(
			transport.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({
			code: "workflow_receipt_invalid",
		});
	});

	it("carries the backend's terminal disposition with its diagnostic code", async () => {
		const transport = createDureWorkflowTransport({
			invokeCommand: vi.fn(async () => {
				throw {
					code: "workflow_future_prelaunch_refusal",
					message: "a future prelaunch policy refused the request",
					details: { disposition: "terminal" },
				};
			}),
		});

		await expect(
			transport.delegateOnce(routeAuthority, delegateRequest),
		).rejects.toMatchObject({
			code: "workflow_future_prelaunch_refusal",
			failure: { kind: "operation", disposition: "terminal" },
		});
	});
});
