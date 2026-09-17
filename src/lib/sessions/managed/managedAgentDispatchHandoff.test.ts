import { describe, expect, it, vi } from "vitest";
import type { DureBackendRouteAuthorityV1 } from "@/lib/ipc/dureBackendRoute";
import { createDureWorkflowTransport } from "@/lib/ipc/dureWorkflow";
import {
	createManagedAgentDispatchHandoff,
	type ManagedAgentDispatchHandoffRuntime,
} from "@/lib/sessions/managed/managedAgentDispatchHandoff";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehostInspection";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntime";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const sourceFence = stopFenceFixture({
	runnerPrincipal: "principal-old",
	runnerInstance: "runner-old",
	channelEpoch: "7",
	hostInstanceId: "host-old",
	terminalEpoch: "terminal-old",
});
const targetFence = stopFenceFixture({
	runnerPrincipal: "principal-new",
	runnerInstance: "runner-new",
	channelEpoch: "8",
	hostInstanceId: "host-new",
	terminalEpoch: "terminal-new",
});
const workflowDispatch = {
	schemaVersion: 1 as const,
	taskId: `task.${"a".repeat(64)}`,
	dispatchId: `dispatch.${"a".repeat(64)}`,
	generation: 1,
};
const source = agentFixture({
	id: "agent-worker",
	name: "worker",
	provider: "codex",
	sessionId: "session-old",
	runtimeBinding: managedBindingFixture({
		sessionId: "session-old",
		workspaceId: "workspace-1",
		stopFence: sourceFence,
	}),
	workflowDispatch,
});

function inspection(): ManagedAgentRehostInspection {
	return {
		providerId: "codex",
		sourceBinding: source.runtimeBinding,
	} as ManagedAgentRehostInspection;
}

function recovery(
	backendRouteAuthority?: DureBackendRouteAuthorityV1,
): ManagedAgentRecoveryResult {
	const replacement = {
		sessionId: "session-new",
		workspaceId: "workspace-1",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		terminalEpoch: targetFence.terminalEpoch,
		stopFence: targetFence,
		outputSeq: "0",
		capabilities: [],
	};
	return {
		providerId: "codex",
		permissionMode: "default",
		conversationId: "conversation-1",
		createIdempotencyKey: "rehost-operation-1",
		...(backendRouteAuthority ? { backendRouteAuthority } : {}),
		replacement,
		receipt: {
			sourceSessionId: "session-old",
			targetBuildId: "build-current",
			action: "replace_ai_provider_with_explicit_conversation",
			outcome: "replaced",
			replayed: false,
			operationId: "rehost-operation-1",
			conversationId: "conversation-1",
			sourceStopReceipt: {
				schema: "hmux-managed-stop-v1",
				schemaVersion: 2,
				stopId: "rehost-operation-1:stop",
				sessionId: "session-old",
				workspaceId: "workspace-1",
				runnerPrincipal: sourceFence.runnerPrincipal,
				runnerInstance: sourceFence.runnerInstance,
				channelEpoch: 7,
				hostInstanceId: sourceFence.hostInstanceId,
				terminalEpoch: sourceFence.terminalEpoch,
				outcome: "stopped",
				exitReason: "managed_rehost",
			},
			replacementTarget: {
				idempotencyKey: "rehost-operation-1",
				sessionId: replacement.sessionId,
				workspaceId: replacement.workspaceId,
				providerId: "codex",
				permissionMode: "default",
				...targetFence,
			},
			replacementSession: replacement,
		},
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

function envelope(
	authority: DureBackendRouteAuthorityV1,
	method: string,
	receipt: Record<string, unknown>,
) {
	return {
		schemaVersion: 1,
		backendId: authority.backend.id,
		backendGeneration: authority.backend.generation,
		routeAuthority: authority,
		result: {
			schemaVersion: 1,
			apiVersion: "dure.orchestration/v1",
			method,
			receipt,
		},
	};
}

describe("managed Agent Dispatch handoff", () => {
	it("does not consult orchestration for an ordinary Agent without a Dispatch", async () => {
		const route = testDureBackendRouteAuthority("backend-a", "generation-a");
		const runtime = {
			inspectDispatchSession: vi
				.fn()
				.mockRejectedValue(new Error("orchestration store rejected the operation")),
			rebindDispatchSession: vi
				.fn()
				.mockRejectedValue(new Error("orchestration store rejected the operation")),
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;
		const ordinarySource = { ...source, workflowDispatch: undefined };
		const handoff = createManagedAgentDispatchHandoff(ordinarySource, runtime);

		await expect(
			handoff.inspect(route, inspection(), ordinarySource),
		).resolves.toBeUndefined();
		await expect(handoff.complete(recovery(route))).resolves.toEqual({
			recovery: recovery(route),
		});
		expect(runtime.inspectDispatchSession).not.toHaveBeenCalled();
		expect(runtime.rebindDispatchSession).not.toHaveBeenCalled();
	});

	it("resumes even when the orchestration store rejects inspect and rebind", async () => {
		// The recovery path must recover (owner decision 2026-09-01): a
		// Dispatch-carrying Agent whose lineage store rejects the operation —
		// or times out — downgrades to an un-orchestrated resume instead of
		// failing the pane. Reproduces the 2026-09-01 report: every exact
		// resume on a quick-dispatched codex pane died with "orchestration
		// store rejected the operation" / "backend request deadline exceeded".
		const route = testDureBackendRouteAuthority("backend-a", "generation-a");
		const runtime = {
			inspectDispatchSession: vi
				.fn()
				.mockRejectedValue(
					new Error("orchestration store rejected the operation"),
				),
			rebindDispatchSession: vi
				.fn()
				.mockRejectedValue(new Error("backend request deadline exceeded")),
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;
		const handoff = createManagedAgentDispatchHandoff(source, runtime);

		await expect(
			handoff.inspect(route, inspection(), source),
		).resolves.toBeUndefined();
		await expect(handoff.complete(recovery(route))).resolves.toEqual({
			recovery: recovery(route),
		});
		expect(runtime.inspectDispatchSession).toHaveBeenCalledOnce();
		expect(runtime.rebindDispatchSession).toHaveBeenCalledOnce();
	});

	it("resumes without a stop fence instead of demanding an exact source generation", async () => {
		const route = testDureBackendRouteAuthority("backend-a", "generation-a");
		const runtime = {
			inspectDispatchSession: vi.fn(),
			rebindDispatchSession: vi.fn(),
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;
		const fencelessSource = {
			...source,
			runtimeBinding: managedBindingFixture({
				sessionId: "session-old",
				workspaceId: "workspace-1",
			}),
		};
		const handoff = createManagedAgentDispatchHandoff(fencelessSource, runtime);

		await expect(
			handoff.inspect(
				route,
				{
					providerId: "codex",
					sourceBinding: fencelessSource.runtimeBinding,
				} as ManagedAgentRehostInspection,
				fencelessSource,
			),
		).resolves.toBeUndefined();
	});

	it("rebinds on the route captured by source inspection even after selection changes", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		let selected = routeA;
		const rebindMutations = new Map<string, number>();
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command === "dure_backend_route_assert") {
					return requestedRoute(arguments_, selected);
				}
				const authority = requestedRoute(arguments_, selected);
				const invocation = arguments_.body as {
					method: string;
					body: Record<string, unknown>;
				};
				if (invocation.method === "dispatch.session.inspect") {
					selected = routeB;
					return envelope(authority, invocation.method, {
						schemaVersion: 1,
						outcome: "active_dispatch",
						session: invocation.body.session,
						target: {
							authority: { workspaceId: "workspace-1" },
							runId: `run.${"a".repeat(64)}`,
							...workflowDispatch,
						},
					});
				}
				if (invocation.method === "dispatch.session.rebind") {
					rebindMutations.set(
						authority.backend.id,
						(rebindMutations.get(authority.backend.id) ?? 0) + 1,
					);
					return envelope(authority, invocation.method, {
						...invocation.body,
						outcome: "rebound",
						runId: `run.${"a".repeat(64)}`,
						...workflowDispatch,
					});
				}
				throw new Error(`unexpected orchestration method ${invocation.method}`);
			},
		);
		const transport = createDureWorkflowTransport({ invokeCommand });
		const runtime = {
			inspectDispatchSession: transport.inspectDispatchSession,
			rebindDispatchSession: transport.rebindDispatchSession,
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;
		const handoff = createManagedAgentDispatchHandoff(source, runtime);

		await handoff.inspect(routeA, inspection(), source);
		await handoff.complete(recovery(routeA));

		expect(rebindMutations.get("backend-a") ?? 0).toBe(1);
		expect(rebindMutations.get("backend-b") ?? 0).toBe(0);
	});

	it("rebinds restart reconciliation on its journal-recovered exact route", async () => {
		const routeA = testDureBackendRouteAuthority("backend-a", "generation-a");
		const routeB = testDureBackendRouteAuthority("backend-b", "generation-b");
		const rebindMutations = new Map<string, number>();
		const invokeCommand = vi.fn(
			async (command: string, arguments_: Record<string, unknown>) => {
				if (command === "dure_backend_route_assert") return routeB;
				const authority = requestedRoute(arguments_, routeB);
				const invocation = arguments_.body as {
					method: string;
					body: Record<string, unknown>;
				};
				if (invocation.method === "dispatch.session.rebind") {
					rebindMutations.set(
						authority.backend.id,
						(rebindMutations.get(authority.backend.id) ?? 0) + 1,
					);
					return envelope(authority, invocation.method, {
						...invocation.body,
						outcome: "rebound",
						runId: `run.${"a".repeat(64)}`,
						...workflowDispatch,
					});
				}
				throw new Error(`unexpected orchestration method ${invocation.method}`);
			},
		);
		const transport = createDureWorkflowTransport({ invokeCommand });
		const runtime = {
			inspectDispatchSession: transport.inspectDispatchSession,
			rebindDispatchSession: transport.rebindDispatchSession,
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;

		await createManagedAgentDispatchHandoff(source, runtime).reconcile(
			recovery(routeA),
		);

		expect(rebindMutations.get("backend-a") ?? 0).toBe(1);
		expect(rebindMutations.get("backend-b") ?? 0).toBe(0);
	});

	it("keeps a legacy restart pending without a route commitment", async () => {
		const runtime = {
			inspectDispatchSession: vi.fn(),
			rebindDispatchSession: vi.fn(),
			now: () => 1_200,
		} satisfies ManagedAgentDispatchHandoffRuntime;

		await expect(
			createManagedAgentDispatchHandoff(source, runtime).reconcile(recovery()),
		).resolves.toEqual({ recovery: recovery() });
		expect(runtime.inspectDispatchSession).not.toHaveBeenCalled();
		expect(runtime.rebindDispatchSession).not.toHaveBeenCalled();
	});
});
