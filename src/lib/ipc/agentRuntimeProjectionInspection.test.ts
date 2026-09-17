import { invoke } from "@tauri-apps/api/core";
import { beforeEach, expect, it, vi } from "vitest";
import { inspectAgentRuntimeProjection } from "@/lib/agents/agentRuntimeProjectionInspection";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import {
	agentRuntimeBackendEnvelope,
	agentRuntimeProjectionContext,
} from "@/test/dureAgentRuntimeFixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const source = { agentId: "agent-1", backendProfileId: "local" };

function response(agentId: string) {
	const envelope = agentRuntimeBackendEnvelope({ agentId });
	return {
		...envelope,
		result: {
			...envelope.result,
			state: "stable",
			projectionContext: agentRuntimeProjectionContext(agentId),
		},
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

it("does not retry unrelated agents when same-backend responses finish in reverse order", async () => {
	const pending: (() => void)[] = [];
	const seen = new Set<string>();
	vi.mocked(invoke).mockImplementation((_command, args) => {
		const { body } = args as { body: { agentId: string } };
		const value = response(body.agentId);
		// Complete any erroneous retry as well, so a failure reports request
		// amplification rather than a timeout from an unresolved test promise.
		if (seen.has(body.agentId)) return Promise.resolve(value);
		seen.add(body.agentId);
		return new Promise((resolve) => pending.push(() => resolve(value)));
	});
	const reads = Array.from({ length: 12 }, (_, index) =>
		inspectAgentRuntimeProjection({ ...source, agentId: `agent-${index}` }),
	);

	for (let index = reads.length - 1; index >= 0; index--) {
		pending[index]();
		await expect(reads[index]).resolves.toMatchObject({
			agentId: `agent-${index}`,
			backend: { generation: "backend-1" },
		});
	}
	expect(invoke).toHaveBeenCalledTimes(reads.length);
});

it("refreshes once after a real authority rejection from the native transport", async () => {
	vi.mocked(invoke)
		.mockRejectedValueOnce(
			new DureBackendRequestError("changed", "backend changed", {
				kind: "authority_changed",
			}),
		)
		.mockResolvedValueOnce(response(source.agentId));

	await expect(inspectAgentRuntimeProjection(source)).resolves.toMatchObject({
		agentId: source.agentId,
	});
	expect(invoke).toHaveBeenCalledTimes(2);
});

it("does not keep retrying a backend that keeps rejecting its authority", async () => {
	const error = new DureBackendRequestError("changed", "backend changed", {
		kind: "authority_changed",
	});
	vi.mocked(invoke).mockRejectedValue(error);

	await expect(inspectAgentRuntimeProjection(source)).rejects.toBe(error);
	expect(invoke).toHaveBeenCalledTimes(2);
});

it("rejects a receipt for another agent without retrying", async () => {
	vi.mocked(invoke).mockResolvedValue(response("other-agent"));

	await expect(inspectAgentRuntimeProjection(source)).rejects.toMatchObject({
		failure: { kind: "contract" },
	});
	expect(invoke).toHaveBeenCalledOnce();
});

it("preserves transport failures without retrying", async () => {
	const error = new DureBackendRequestError("offline", "offline", {
		kind: "transport",
	});
	vi.mocked(invoke).mockRejectedValue(error);

	await expect(inspectAgentRuntimeProjection(source)).rejects.toBe(error);
	expect(invoke).toHaveBeenCalledOnce();
});
