import { describe, expect, it, vi } from "vitest";
import type { DureBackendInvoke } from "./dureBackend";
import type { DureBackendRouteAuthorityV1 } from "./dureBackendRoute";
import { createGraphClient } from "./dureGraph";
import { createDureOrchestrationTransport } from "./dureOrchestration";
import { createDureWorkflowTransport } from "./dureWorkflow";

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "g1" },
	target: { source: "local", hostId: "local" },
};
const session = {
	sessionId: "session-1",
	workspaceId: "workspace-1",
	providerId: "codex" as const,
	runnerPrincipal: "owner",
	runnerInstance: "runner-1",
	channelEpoch: "1",
	hostInstanceId: "host-1",
	terminalEpoch: "epoch-1",
};
const consumers = [
	{
		name: "graph",
		call: (invokeCommand: DureBackendInvoke) =>
			createGraphClient({ invokeCommand }).catalog(authority),
		method: "workflow.graph.catalog",
		code: undefined,
	},
	{
		name: "orchestration",
		call: (invokeCommand: DureBackendInvoke) =>
			createDureOrchestrationTransport({ invokeCommand }).getDispatchContext(
				authority,
				session,
			),
		method: "dispatch.context.get",
		code: "orchestration_response_invalid",
	},
	{
		name: "workflow",
		call: (invokeCommand: DureBackendInvoke) =>
			createDureWorkflowTransport({ invokeCommand }).inspectDispatchSession(
				authority,
				session,
			),
		method: "dispatch.session.inspect",
		code: "workflow_response_invalid",
	},
];

describe.each(consumers)(
	"$name envelope consumer",
	({ call, method, code }) => {
		it.each(["version", "method", "missing receipt"])(
			"rejects %s mismatch without changing the request route",
			async (fault) => {
				const result: Record<string, unknown> = {
					schemaVersion: 1,
					apiVersion: "dure.orchestration/v1",
					method,
					receipt: { schemaVersion: 1 },
				};
				if (fault === "version") result.apiVersion = "dure.orchestration/v2";
				if (fault === "method") result.method = "another.operation";
				if (fault === "missing receipt") delete result.receipt;
				const invokeCommand = vi.fn().mockResolvedValue({
					schemaVersion: 1,
					routeAuthority: authority,
					backendId: authority.backend.id,
					backendGeneration: authority.backend.generation,
					result,
				});
				const promise = call(invokeCommand);
				if (code)
					await expect(promise).rejects.toMatchObject({
						code,
						failure: { kind: "contract" },
					});
				else await expect(promise).rejects.toThrow("workflow_response_invalid");
				expect(invokeCommand).toHaveBeenCalledOnce();
				expect(invokeCommand.mock.calls[0]).toMatchObject([
					"dure_backend_request",
					{
						route: { kind: "exact", authority },
						operation: "orchestration.invoke",
						body: { apiVersion: "dure.orchestration/v1", method },
					},
				]);
			},
		);
	},
);
