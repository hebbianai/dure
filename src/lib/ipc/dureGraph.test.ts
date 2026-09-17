import { describe, expect, it, vi } from "vitest";
import { dailyReviewWorkflow } from "@/lib/automations/graphEditing";
import type { DureBackendRouteAuthorityV1 } from "./dureBackendRoute";
import { createGraphClient } from "./dureGraph";

const authority: DureBackendRouteAuthorityV1 = {
	schemaVersion: 1,
	profileId: "local",
	revision: `sha256:${"a".repeat(64)}`,
	backend: { id: "backend-local", generation: "g1" },
	target: { source: "local", hostId: "local" },
};
const draft = dailyReviewWorkflow(
	{
		name: "Review",
		collect: "Changes",
		review: "Review",
		prompt: "Review changes",
	},
	"UTC",
);
const workflow = {
	...draft,
	schemaVersion: 1,
	workflowId: "daily",
	revision: 2,
	enabled: false,
	createdAtMs: 1,
	updatedAtMs: 2,
};
function envelope(method: string, receipt: object) {
	return {
		schemaVersion: 1,
		routeAuthority: authority,
		backendId: authority.backend.id,
		backendGeneration: authority.backend.generation,
		result: {
			schemaVersion: 1,
			apiVersion: "dure.orchestration/v1",
			method: `workflow.graph.${method}`,
			receipt: { schemaVersion: 1, ...receipt },
		},
	};
}

describe("graph IPC", () => {
	it("saves the exact revision and route without adding presentation data", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValue(envelope("put", { workflow }));
		const intent = {
			...draft,
			schemaVersion: 1 as const,
			workflowId: "daily",
			expectedRevision: 1,
			idempotencyKey: "save-1",
		};
		await createGraphClient({ invokeCommand }).put(intent, authority);
		expect(invokeCommand.mock.calls[0]).toEqual([
			"dure_backend_request",
			{
				route: { kind: "exact", authority },
				operation: "orchestration.invoke",
				body: {
					apiVersion: "dure.orchestration/v1",
					method: "workflow.graph.put",
					body: intent,
				},
			},
		]);
	});
	it("rejects acknowledgements for a different mutation or draft revision", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(envelope("activate", { workflow }))
			.mockResolvedValueOnce(
				envelope("put", { workflow: { ...workflow, revision: 5 } }),
			);
		const client = createGraphClient({ invokeCommand });
		const intent = {
			...draft,
			schemaVersion: 1 as const,
			workflowId: "daily",
			expectedRevision: 1,
			idempotencyKey: "save-1",
		};
		await expect(client.put(intent, authority)).rejects.toThrow(
			"workflow_response_invalid",
		);
		await expect(client.put(intent, authority)).rejects.toThrow(
			"workflow_response_invalid",
		);
	});
	it("does not show data from a different pinned version", async () => {
		const task = {
			nodeId: "collect",
			taskId: "task-1",
			dispatchId: "dispatch-1",
			action: { actionId: "command", version: 1 },
			state: { kind: "pending" },
		};
		const invokeCommand = vi.fn().mockResolvedValue(
			envelope("inspect", {
				run: {
					schemaVersion: 1,
					runId: "run-1",
					workflowId: "daily",
					workflowVersion: 1,
					sourceDigest: "original",
					status: "pending",
					trigger: { kind: "manual" },
					createdAtMs: 1,
					updatedAtMs: 1,
				},
				version: {
					...draft,
					schemaVersion: 1,
					workflowId: "daily",
					version: 1,
					sourceRevision: 1,
					digest: "different",
					createdAtMs: 1,
				},
				task,
				tasks: [task],
			}),
		);
		await expect(
			createGraphClient({ invokeCommand }).inspect("run-1", authority),
		).rejects.toThrow("workflow_response_invalid");
	});
});
