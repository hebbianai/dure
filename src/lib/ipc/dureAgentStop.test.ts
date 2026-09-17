import { describe, expect, it, vi } from "vitest";
import { createDureAgentStopClient } from "@/lib/ipc/dureAgentStop";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const route = testDureBackendRouteAuthority("dure-local", "generation-1");
const planToken = `sha256:${"a".repeat(64)}`;

function result(
	status: "planned" | "authorized" | "workspace_preserved",
	revision: number,
) {
	return {
		schemaVersion: 1,
		receipt: {
			plan: {
				schemaVersion: 1,
				operationId: "stop-1",
				agentId: "agent-1",
				spawn: { operationId: "spawn-1" },
				planToken,
				workspaceDisposition: "preserve",
			},
			state:
				status === "planned"
					? { status }
					: status === "authorized"
						? { status, runtimeCloseOperationId: "close-1" }
						: { status, runtime: {} },
			journalRevision: revision,
			createdAtMs: 1,
			updatedAtMs: revision,
		},
	};
}

function envelope(value: unknown) {
	return {
		schemaVersion: 1,
		backendId: route.backend.id,
		backendGeneration: route.backend.generation,
		routeAuthority: route,
		result: value,
	};
}

describe("Dure Agent stop client", () => {
	it("reads status, then previews and applies preserve on one exact route", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(envelope({ schemaVersion: 1, receipt: null }))
			.mockResolvedValueOnce(envelope(result("planned", 1)))
			.mockResolvedValueOnce(envelope(result("workspace_preserved", 3)));
		const client = createDureAgentStopClient({
			profileId: "local",
			invokeCommand,
		});

		const observed = await client.status("spawn-1");
		const preview = await client.preview("spawn-1", observed.routeAuthority);
		const applied = await client.apply(preview, observed.routeAuthority);

		expect(observed.receipt).toBeNull();
		expect(applied.status).toBe("workspace_preserved");
		expect(invokeCommand).toHaveBeenNthCalledWith(
			1,
			"dure_backend_request",
			expect.objectContaining({
				operation: "dispatch.stop.status",
				body: { schemaVersion: 1, spawnOperationId: "spawn-1" },
			}),
		);
		expect(invokeCommand).toHaveBeenNthCalledWith(
			2,
			"dure_backend_request",
			expect.objectContaining({
				operation: "dispatch.stop.preview",
				body: {
					schemaVersion: 1,
					spawnOperationId: "spawn-1",
					workspaceDisposition: "preserve",
				},
				route: { kind: "exact", authority: route },
			}),
		);
		expect(invokeCommand).toHaveBeenNthCalledWith(
			3,
			"dure_backend_request",
			expect.objectContaining({
				operation: "dispatch.stop.apply",
				body: {
					schemaVersion: 1,
					operationId: "stop-1",
					planToken,
					expectedJournalRevision: 1,
				},
			}),
		);
	});

	it("resumes an already-authorized stop with its original authorization CAS", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(envelope(result("authorized", 2)))
			.mockResolvedValueOnce(envelope(result("workspace_preserved", 3)));
		const client = createDureAgentStopClient({
			profileId: "local",
			invokeCommand,
		});

		const observed = await client.status("spawn-1");
		if (!observed.receipt) throw new Error("expected authorized receipt");
		await client.apply(observed.receipt, observed.routeAuthority);

		expect(invokeCommand).toHaveBeenNthCalledWith(
			2,
			"dure_backend_request",
			expect.objectContaining({
				body: expect.objectContaining({ expectedJournalRevision: 1 }),
			}),
		);
	});
});
