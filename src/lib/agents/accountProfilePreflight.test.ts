import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	homeDir: vi.fn(),
	providerPreflight: vi.fn(),
}));

vi.mock("@/lib/ipc", () => ({
	homeDir: mocks.homeDir,
	providerPreflight: mocks.providerPreflight,
}));

import { preflightAccountProfileCreation } from "@/lib/agents/accountProfilePreflight";

beforeEach(() => {
	mocks.homeDir.mockReset().mockResolvedValue("/Users/runtime");
	mocks.providerPreflight.mockReset().mockResolvedValue({
		ready: true,
		version: "2.1.212 (Claude Code)",
	});
});

describe("account profile creation preflight", () => {
	it("does not require Codex version diagnostics to create an account profile", async () => {
		mocks.providerPreflight.mockResolvedValue({
			ready: false,
			message: "version timed out",
		});
		await preflightAccountProfileCreation("codex");
		expect(mocks.homeDir).not.toHaveBeenCalled();
		expect(mocks.providerPreflight).not.toHaveBeenCalled();
	});

	it("accepts the reviewed Claude CLI before profile creation", async () => {
		await preflightAccountProfileCreation("claude");

		expect(mocks.providerPreflight).toHaveBeenCalledWith({
			provider: "claude",
			command: "claude",
			cwd: "/Users/runtime",
		});
	});

	it("refuses an old Claude CLI before profile creation", async () => {
		mocks.providerPreflight.mockResolvedValue({
			ready: true,
			version: "2.1.211 (Claude Code)",
		});

		await expect(
			preflightAccountProfileCreation("claude"),
		).rejects.toMatchObject({
			code: "credential_overlay_version_unsupported",
		});
	});

	it("surfaces provider readiness failures before profile creation", async () => {
		mocks.providerPreflight.mockResolvedValue({
			ready: false,
			message: "claude executable is unavailable",
		});

		await expect(preflightAccountProfileCreation("claude")).rejects.toThrow(
			"claude executable is unavailable",
		);
	});

	it("leaves legacy alias providers on their existing creation path", async () => {
		await preflightAccountProfileCreation("kimi");

		expect(mocks.homeDir).not.toHaveBeenCalled();
		expect(mocks.providerPreflight).not.toHaveBeenCalled();
	});
});
