import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import { inspectLocalAgentIdle } from "./dureAgentIdle";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const snapshot = {
	schemaVersion: 1,
	configuration: "enabled",
	afterMs: 86_400_000,
	policyRevision: 2,
	observedAtMs: 1000,
	partial: true,
	reasonCode: null,
	agents: [
		{
			agentId: "agent-observed",
			state: "protected",
			observedIdleMs: null,
			reasonCode: "hmux_controller_input_pending",
		},
	],
};
function respond(result: unknown, profile = "local") {
	vi.mocked(invoke).mockResolvedValue({
		schemaVersion: 1,
		backendId: "backend-1",
		backendGeneration: "generation-1",
		routeAuthority: testDureBackendRouteAuthority(
			"backend-1",
			"generation-1",
			profile,
		),
		result,
	});
}

it("reads retained observations only from the explicit local profile", async () => {
	respond(snapshot);
	expect(await inspectLocalAgentIdle()).toEqual(snapshot);
	expect(invoke).toHaveBeenCalledExactlyOnceWith("dure_backend_request", {
		route: { kind: "selected", profileId: "local" },
		operation: "agent_runtime.idle.inspect",
		body: { schemaVersion: 1 },
	});
});
it("preserves future states and reasons without inferring eligibility", async () => {
	const future = {
		...snapshot,
		agents: [
			{
				agentId: "agent-future",
				state: "future_state",
				observedIdleMs: null,
				reasonCode: "future_reason",
			},
		],
	};
	respond(future);
	expect(await inspectLocalAgentIdle()).toEqual(future);
});
it.each([
	{ ...snapshot, afterMs: null },
	{ ...snapshot, agents: [{ ...snapshot.agents[0], observedIdleMs: -1 }] },
	{ ...snapshot, observedAtMs: Number.MAX_SAFE_INTEGER },
])("rejects invalid observations", async (result) => {
	respond(result);
	await expect(inspectLocalAgentIdle()).rejects.toMatchObject({
		code: "runtime_idle_response_invalid",
	});
});
it("rejects a remote route rather than presenting it as local", async () => {
	respond(snapshot, "remote");
	await expect(inspectLocalAgentIdle()).rejects.toMatchObject({
		code: "runtime_idle_response_invalid",
	});
});
it("preserves disabled, unsampled state", async () => {
	const disabled = {
		...snapshot,
		configuration: "disabled",
		afterMs: null,
		observedAtMs: null,
		agents: [],
	};
	respond(disabled);
	expect(await inspectLocalAgentIdle()).toEqual(disabled);
});
it("does not retry or mutate after a read failure", async () => {
	vi.mocked(invoke).mockRejectedValue(new Error("offline"));
	await expect(inspectLocalAgentIdle()).rejects.toThrow();
	expect(invoke).toHaveBeenCalledTimes(1);
});
