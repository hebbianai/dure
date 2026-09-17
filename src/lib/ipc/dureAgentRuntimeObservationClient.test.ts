import { describe, expect, it, vi } from "vitest";
import { observeRuntimeConvergence } from "@/lib/agents/agentRuntimeConvergence";
import { createDureAgentRuntimeClient } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";

function deferredEnvelope() {
	return {
		...agentRuntimeBackendEnvelope(),
		result: {
			schemaVersion: 1,
			state: "transitioning",
			agentId: "agent-1",
			operationId: "sleep-1",
			journalRevision: 2,
			stage: "source_stopped",
			targetInteractionProfile: "native_cli",
			targetExecutionProfile: { kind: "provider_default" },
			deferredTarget: { state: "waiting" },
			projectionContext: agentRuntimeProjectionContext(),
		},
	};
}

describe("deferred runtime observation", () => {
	it("retains the visible conversation guard in the shared wake request", async () => {
		const invokeCommand = vi.fn().mockResolvedValue(deferredEnvelope());
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const source = await client.inspect("agent-1");
		if (source.state !== "dormant") throw new Error("Expected dormant source");
		await client.wake(source, "visible-conversation");
		expect(invokeCommand.mock.calls[1][1].body).toEqual({
			schemaVersion: 1,
			agentId: "agent-1",
			operationId: "sleep-1",
			expectedJournalRevision: 2,
			expectedProviderConversationRef: "visible-conversation",
		});
	});
	it.each(["", " ", " conversation", "conversation "])(
		"refuses an ambiguous conversation guard before wake: %j",
		async (expectedProviderConversationRef) => {
			const invokeCommand = vi.fn().mockResolvedValue(deferredEnvelope());
			const client = createDureAgentRuntimeClient({ invokeCommand });
			const source = await client.inspect("agent-1");
			if (source.state !== "dormant")
				throw new Error("Expected dormant source");
			await expect(
				client.wake(source, expectedProviderConversationRef),
			).rejects.toMatchObject({
				code: "agent_runtime_transition_response_invalid",
			});
			expect(invokeCommand).toHaveBeenCalledOnce();
		},
	);

	it.each([0, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"refuses an unfenced hibernate without sending a request: %s",
		async (expectedSourceRevision) => {
			const invokeCommand = vi.fn();
			const client = createDureAgentRuntimeClient({ invokeCommand });
			await expect(
				client.hibernate({
					agentId: "agent-1",
					expectedSourceRevision,
					routeAuthority: deferredEnvelope().routeAuthority,
				}),
			).rejects.toMatchObject({
				code: "agent_runtime_transition_response_invalid",
			});
			expect(invokeCommand).not.toHaveBeenCalled();
		},
	);

	it.each([{ operationId: "bad operation" }, { journalRevision: 0 }])(
		"refuses a malformed wake fence without a mutation: %j",
		async (changes) => {
			const invokeCommand = vi.fn().mockResolvedValue(deferredEnvelope());
			const client = createDureAgentRuntimeClient({ invokeCommand });
			const source = await client.inspect("agent-1");
			if (source.state !== "dormant")
				throw new Error("Expected dormant source");
			await expect(
				client.wake({ ...source, ...changes }),
			).rejects.toMatchObject({
				code: "agent_runtime_transition_response_invalid",
			});
			expect(invokeCommand).toHaveBeenCalledOnce();
		},
	);

	it("wakes through the same exact journal request as the CLI without replaying metadata", async () => {
		const sleeping = deferredEnvelope();
		const awake = {
			...sleeping,
			result: {
				schemaVersion: 1,
				state: "stable",
				projectionContext: agentRuntimeProjectionContext(),
				receipt: nativeRuntimeReceipt(
					{ kind: "provider_default" },
					2,
					"wake-launch",
				),
			},
		};
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(sleeping)
			.mockResolvedValueOnce(awake);
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const source = await client.inspect("agent-1");
		if (source.state !== "dormant") throw new Error("Expected dormant source");
		await expect(client.wake(source)).resolves.toMatchObject({
			state: "stable",
			selectionRevision: 2,
			providerConversationRef: "conversation-1",
		});
		expect(invokeCommand).toHaveBeenCalledTimes(2);
		expect(invokeCommand.mock.calls[1]).toEqual([
			"dure_backend_request",
			{
				route: { kind: "exact", authority: sleeping.routeAuthority },
				operation: "agent_runtime.wake",
				body: {
					schemaVersion: 1,
					agentId: "agent-1",
					operationId: "sleep-1",
					expectedJournalRevision: 2,
				},
			},
		]);
	});

	it("hibernates the observed source revision and preserves backend refusal", async () => {
		const sleeping = deferredEnvelope();
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(sleeping)
			.mockRejectedValueOnce(
				new DureBackendRequestError("agent_runtime_source_busy", "busy", {
					kind: "operation",
					disposition: "terminal",
				}),
			);
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const request = {
			agentId: "agent-1",
			expectedSourceRevision: 1,
			routeAuthority: sleeping.routeAuthority,
		};
		await expect(client.hibernate(request)).resolves.toMatchObject({
			state: "dormant",
		});
		expect(invokeCommand.mock.calls[0]).toEqual([
			"dure_backend_request",
			{
				route: { kind: "exact", authority: sleeping.routeAuthority },
				operation: "agent_runtime.hibernate",
				body: {
					schemaVersion: 1,
					agentId: "agent-1",
					expectedSourceRevision: 1,
				},
			},
		]);
		await expect(client.hibernate(request)).rejects.toMatchObject({
			condition: "source_active",
		});
		expect(invokeCommand).toHaveBeenCalledTimes(2);
	});

	it("does not turn lost wake response into another mutation", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(deferredEnvelope())
			.mockRejectedValueOnce(new Error("response lost"));
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const source = await client.inspect("agent-1");
		if (source.state !== "dormant") throw new Error("Expected dormant source");
		await expect(client.wake(source)).rejects.toMatchObject({
			code: "agent_runtime_transition_transport_failed",
		});
		expect(invokeCommand).toHaveBeenCalledTimes(2);
	});

	it("keeps unknown additive deferral metadata readable without inventing a wake target", async () => {
		const wire = deferredEnvelope();
		wire.result.deferredTarget.state = "future_policy";
		const invokeCommand = vi.fn().mockResolvedValue(wire);
		await expect(
			createDureAgentRuntimeClient({ invokeCommand }).inspect("agent-1"),
		).resolves.toMatchObject({
			state: "transitioning",
			operationId: "sleep-1",
		});
		expect(invokeCommand).toHaveBeenCalledOnce();
	});

	it("finishes read-only convergence at dormancy without polling or waking", async () => {
		const invokeCommand = vi.fn().mockResolvedValue(deferredEnvelope());
		const client = createDureAgentRuntimeClient({ invokeCommand });
		const wait = vi.fn().mockResolvedValue(undefined);
		const observed = await observeRuntimeConvergence(client, "agent-1", {
			wait,
			maxInspections: 3,
		});
		expect(observed).toMatchObject({
			state: "dormant",
			agentId: "agent-1",
			operationId: "sleep-1",
			journalRevision: 2,
			projectionContext: agentRuntimeProjectionContext(),
		});
		expect(invokeCommand).toHaveBeenCalledOnce();
		expect(wait).not.toHaveBeenCalled();
	});
});
