import { describe, expect, it } from "vitest";
import {
	canonicalAgentStopAppliesToAgentV1,
	parseCanonicalAgentStopResultV1,
	projectCanonicalAgentStopV1,
} from "@/lib/agents/canonicalAgentStopLifecycle";
import { agentFixture } from "@/test/agentFixtures";

const planToken = `sha256:${"a".repeat(64)}`;

function result(status: string, workspaceDisposition = "preserve") {
	const state =
		status === "planned" || status === "superseded"
			? { status }
			: status === "authorized"
				? { status, runtimeCloseOperationId: "close-1" }
				: status === "succeeded"
					? { status, runtime: {}, workspace: {} }
					: { status, runtime: {} };
	return {
		schemaVersion: 1,
		receipt: {
			plan: {
				schemaVersion: 1,
				operationId: "stop-1",
				agentId: "agent-1",
				spawn: { operationId: "spawn-1" },
				planToken,
				...(workspaceDisposition === "preserve"
					? { workspaceDisposition }
					: { ownedCheckout: {} }),
			},
			state,
			journalRevision: status === "planned" ? 1 : 2,
			createdAtMs: 1,
			updatedAtMs: 2,
		},
	};
}

describe("canonical Agent stop lifecycle projector", () => {
	it("normalizes a preserve receipt and projects backend-owned lifecycle", () => {
		const planned = parseCanonicalAgentStopResultV1(
			result("planned"),
			"spawn-1",
		);
		const authorized = parseCanonicalAgentStopResultV1(
			result("authorized"),
			"spawn-1",
		);
		const completed = parseCanonicalAgentStopResultV1(
			result("workspace_preserved"),
			"spawn-1",
		);

		expect(projectCanonicalAgentStopV1(planned ?? null).kind).toBe(
			"pending_confirmation",
		);
		expect(projectCanonicalAgentStopV1(authorized ?? null).kind).toBe(
			"resume_apply",
		);
		expect(projectCanonicalAgentStopV1(completed ?? null).kind).toBe(
			"forget_presentation",
		);
	});

	it("rejects mismatched provenance and impossible disposition outcomes", () => {
		expect(
			parseCanonicalAgentStopResultV1(result("workspace_preserved"), "other"),
		).toBeUndefined();
		expect(
			parseCanonicalAgentStopResultV1(
				result("workspace_preserved", "remove_owned"),
				"spawn-1",
			),
		).toBeUndefined();
	});

	it("converges legacy untagged remove-owned receipts without exposing creation", () => {
		const completed = parseCanonicalAgentStopResultV1(
			result("succeeded", "remove_owned"),
			"spawn-1",
		);
		const retained = parseCanonicalAgentStopResultV1(
			result("source_retained", "remove_owned"),
			"spawn-1",
		);

		expect(completed).toMatchObject({
			workspaceDisposition: "remove_owned",
			status: "succeeded",
		});
		expect(projectCanonicalAgentStopV1(completed ?? null).kind).toBe(
			"forget_presentation",
		);
		expect(projectCanonicalAgentStopV1(retained ?? null).kind).toBe(
			"source_retained",
		);
	});

	it("preserves a same-ID successor with different canonical provenance", () => {
		const provenance = {
			schemaVersion: 1 as const,
			backendProfileId: "local",
			operationId: "spawn-1",
		};
		const receipt = parseCanonicalAgentStopResultV1(
			result("workspace_preserved"),
			"spawn-1",
		);
		if (!receipt) throw new Error("expected receipt");
		const source = agentFixture({ id: "agent-1", canonicalSpawn: provenance });
		const successor = {
			...source,
			canonicalSpawn: { ...provenance, operationId: "spawn-2" },
		};

		expect(
			canonicalAgentStopAppliesToAgentV1(receipt, provenance, source),
		).toBe(true);
		expect(
			canonicalAgentStopAppliesToAgentV1(receipt, provenance, successor),
		).toBe(false);
	});
});
