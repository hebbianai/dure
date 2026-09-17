import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ begin: vi.fn(), prompt: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ cliRequestBeginDecision: mocks.begin }));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => ({ requestSshRegistrationDecision: mocks.prompt }),
	},
}));

import { requestRemoteShellHostRegistration } from "./remoteHmuxShellDecision";

const candidate = {
	name: "qa@192.0.2.1:22",
	host: "192.0.2.1",
	port: 22,
	user: "qa",
	auth: "auto" as const,
};

describe("native-admitted SSH decision", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	it("keeps duplicate or expired delivery out of the prompt and completion path", async () => {
		mocks.begin.mockResolvedValue(null);
		await expect(
			requestRemoteShellHostRegistration("duplicate", candidate),
		).resolves.toBeNull();
		expect(mocks.prompt).not.toHaveBeenCalled();
	});
	it("uses the exact native request and admitted lifetime for the presentation", async () => {
		mocks.begin.mockResolvedValue(30_000);
		mocks.prompt.mockResolvedValue(true);
		await expect(
			requestRemoteShellHostRegistration("request", candidate),
		).resolves.toBe(true);
		expect(mocks.begin).toHaveBeenCalledExactlyOnceWith("request");
		expect(mocks.prompt).toHaveBeenCalledExactlyOnceWith(
			"request",
			candidate,
			30_000,
		);
	});
});
