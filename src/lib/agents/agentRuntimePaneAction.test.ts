import { describe, expect, it, vi } from "vitest";
import { runAgentRuntimePaneAction } from "@/lib/agents/agentRuntimePaneAction";
import { DureAgentRuntimeSourceActiveError } from "@/lib/ipc/dureAgentRuntime";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";

function retainedSource(revision: number) {
	return new DureAgentRuntimeSourceActiveError(
		new DureBackendRequestError(
			"agent_runtime_source_retained",
			"source retained",
			{ kind: "operation", disposition: "terminal" },
		),
		revision,
	);
}

describe("agent runtime pane action", () => {
	it("replaces a source retained by the preserve attempt at the same revision", async () => {
		const switchRuntime = vi
			.fn()
			.mockRejectedValueOnce(retainedSource(7))
			.mockResolvedValueOnce(undefined);

		await runAgentRuntimePaneAction(switchRuntime);

		expect(switchRuntime).toHaveBeenNthCalledWith(1, "preserve");
		expect(switchRuntime).toHaveBeenNthCalledWith(2, "discard", 7);
	});

	it("does not reinterpret unrelated transition failures", async () => {
		const failure = new Error("runtime unavailable");
		const switchRuntime = vi.fn().mockRejectedValue(failure);

		await expect(runAgentRuntimePaneAction(switchRuntime)).rejects.toBe(
			failure,
		);
		expect(switchRuntime).toHaveBeenCalledOnce();
	});
});
