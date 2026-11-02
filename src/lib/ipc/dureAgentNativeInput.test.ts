import { describe, expect, it, vi } from "vitest";
import { sendNativeAgentPrompt } from "@/lib/ipc/dureAgentNativeInput";
import {
	agentRuntimeBackendEnvelope as envelope,
	agentRuntimeProjectionContext as projectionContext,
	nativeRuntimeReceipt,
} from "@/test/dureAgentRuntimeFixtures";

const target = {
	agentId: "agent-1",
	backendProfileId: "local",
	expectedTerminalEpoch: "terminal-1",
} as const;

function projection(
	receipt: unknown = nativeRuntimeReceipt(
		{ kind: "provider_default" },
		4,
		"native-launch-1",
	),
) {
	const source = envelope();
	return {
		...source,
		result: {
			state: "stable",
			schemaVersion: 1,
			projectionContext: projectionContext(),
			receipt,
		},
	};
}

function inputResponse(receipt: Record<string, unknown>) {
	return {
		...envelope(),
		result: { schemaVersion: 1, receipt },
	};
}

describe("native agent prompt input", () => {
	it("reads the exact selection first and sends one prompt on that route", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(projection())
			.mockResolvedValueOnce(
				inputResponse({
					terminalEpoch: "terminal-1",
					state: "written_to_pty",
					recordId: "17",
				}),
			);

		await expect(
			sendNativeAgentPrompt(target, "Ship it", { invokeCommand }),
		).resolves.toEqual({ terminalEpoch: "terminal-1", recordId: "17" });
		expect(invokeCommand).toHaveBeenCalledTimes(2);
		expect(invokeCommand.mock.calls[0][1]).toMatchObject({
			operation: "agent_runtime.projection.inspect",
			body: { schemaVersion: 1, agentId: "agent-1" },
		});
		expect(invokeCommand.mock.calls[1][1]).toEqual({
			route: { kind: "exact", authority: envelope().routeAuthority },
			operation: "agent_runtime.native.input",
			body: {
				schemaVersion: 1,
				agentId: "agent-1",
				expectedSelectionRevision: 4,
				expectedTerminalEpoch: "terminal-1",
				text: "Ship it",
			},
		});
	});

	it("refuses without writing when the runtime is not the presented terminal", async () => {
		const replaced = nativeRuntimeReceipt(
			{ kind: "provider_default" },
			4,
			"native-launch-1",
		);
		replaced.authority.authority.terminalEpoch = "terminal-2";
		for (const observed of [projection(replaced), envelope()]) {
			const invokeCommand = vi.fn().mockResolvedValueOnce(
				"state" in observed.result
					? observed
					: {
							...observed,
							result: {
								...observed.result,
								state: "stable",
								projectionContext: projectionContext(),
							},
						},
			);
			await expect(
				sendNativeAgentPrompt(target, "Ship it", { invokeCommand }),
			).rejects.toMatchObject({ code: "agent_runtime_native_changed" });
			expect(invokeCommand).toHaveBeenCalledTimes(1);
		}
	});

	it("surfaces the Host refusal token unchanged", async () => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(projection())
			.mockRejectedValueOnce({
				code: "hmux_agent_prompt_refused",
				message: "Hmux Host refused the agent prompt (3)",
				details: { disposition: "terminal" },
			});
		await expect(
			sendNativeAgentPrompt(target, "Ship it", { invokeCommand }),
		).rejects.toMatchObject({ code: "hmux_agent_prompt_refused" });
	});

	it.each([
		{ terminalEpoch: "terminal-2", state: "written_to_pty" },
		{ terminalEpoch: "terminal-1", state: "queued" },
	])("does not report an unconfirmed write as sent (%o)", async (receipt) => {
		const invokeCommand = vi
			.fn()
			.mockResolvedValueOnce(projection())
			.mockResolvedValueOnce(inputResponse(receipt));
		await expect(
			sendNativeAgentPrompt(target, "Ship it", { invokeCommand }),
		).rejects.toMatchObject({ code: "agent_runtime_native_input_unconfirmed" });
	});

	it.each(["", "   ", "nul\0byte", "x".repeat(64 * 1024 + 1)])(
		"rejects an invalid prompt before any request",
		async (text) => {
			const invokeCommand = vi.fn();
			await expect(
				sendNativeAgentPrompt(target, text, { invokeCommand }),
			).rejects.toMatchObject({ code: "agent_runtime_native_request_invalid" });
			expect(invokeCommand).not.toHaveBeenCalled();
		},
	);
});
