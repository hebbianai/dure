import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	backendSupports: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./core", async (importOriginal) => ({
	...(await importOriginal<typeof import("./core")>()),
	backendSupports: mocks.backendSupports,
}));

import { hmux } from "./hmux";

const request = {
	sessionId: "session-1",
	workspaceId: "workspace-1",
	expectedFence: {
		runnerPrincipal: "principal-1",
		runnerInstance: "runner-1",
		channelEpoch: "7",
		hostInstanceId: "host-1",
		terminalEpoch: "terminal-1",
	},
	prompt: "first turn",
};

describe("local Host-atomic initial prompt IPC", () => {
	beforeEach(() => {
		mocks.invoke.mockReset();
		mocks.backendSupports.mockReset().mockResolvedValue(true);
	});

	it("sends only the exact generation and parses a receipt without runtime revision", async () => {
		mocks.invoke.mockResolvedValue({
			terminalEpoch: "terminal-1",
			recordId: "3",
			inputBaselineOutputSequence: "2",
		});

		await expect(hmux.initialAgentPrompt(request)).resolves.toEqual({
			terminalEpoch: "terminal-1",
			recordId: "3",
			inputBaselineOutputSequence: "2",
		});
		expect(mocks.invoke).toHaveBeenCalledWith("hmux_initial_agent_prompt", {
			request,
		});
		expect(mocks.invoke.mock.calls[0]?.[1]).not.toHaveProperty(
			"request.providerId",
		);
	});

	it("does not invoke an older backend without the semantic command", async () => {
		mocks.backendSupports.mockResolvedValue(false);

		await expect(hmux.initialAgentPrompt(request)).rejects.toMatchObject({
			code: "hmux_initial_agent_prompt_backend_unavailable",
			deliveryState: "not_written",
		});
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});
