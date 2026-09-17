// @vitest-environment jsdom

import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DURABLE_APP_STORE_NAME } from "./lib/persistence/durableAppStoreName";
import { createWorktreePresentationEnvelope } from "./lib/persistence/worktreePresentationEnvelope";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	started: vi.fn(),
	render: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/platform/reactDomClient", () => ({
	default: { createRoot: () => ({ render: mocks.render }) },
}));
vi.mock("./components/AppErrorBoundary", () => ({ RenderFailure: () => null }));

const profile = {
	sourceChannel: "dev-task-0123456789",
	targetChannel: "release-task-0123456789",
	identifier: "io.hebbian.ade.release.0123456789",
	dataStoreIdentifier: Array(16).fill(42),
};
const original = '{"version":8,"state":{"spaces":[{"id":"space-a"}]}}';

beforeEach(() => {
	vi.resetModules();
	vi.resetAllMocks();
	vi.stubGlobal("crypto", webcrypto);
	vi.stubEnv("VITE_DURE_WORKTREE_RELEASE_PROFILE", JSON.stringify(profile));
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			request: (_name: string, _options: unknown, run: () => unknown) => run(),
		},
	});
	localStorage.clear();
	document.body.innerHTML = '<div id="root"></div>';
	vi.doMock("./main", () => {
		mocks.started(localStorage.getItem(DURABLE_APP_STORE_NAME));
		return {};
	});
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.doUnmock("./main");
});

describe("worktree release entry ordering", () => {
	it("commits and acknowledges the import before loading the app/store entry", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			profile,
			original,
		);
		mocks.invoke.mockImplementation(async (command: string) => {
			if (command === "read_worktree_presentation")
				return { imported: false, envelope: JSON.stringify(envelope) };
			expect(command).toBe("complete_worktree_presentation");
			expect(localStorage.getItem(DURABLE_APP_STORE_NAME)).toBe(original);
			expect(mocks.started).not.toHaveBeenCalled();
		});
		await import("./worktreeReleaseBootstrap");
		await vi.waitFor(() =>
			expect(mocks.started).toHaveBeenCalledWith(original),
		);
		expect(mocks.invoke).toHaveBeenCalledTimes(2);
		expect(mocks.render).not.toHaveBeenCalled();
	});

	it("does not load default app state or acknowledge an invalid import", async () => {
		mocks.invoke.mockResolvedValue({ imported: false, envelope: "invalid" });
		await import("./worktreeReleaseBootstrap");
		await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
		expect(mocks.started).not.toHaveBeenCalled();
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
			"read_worktree_presentation",
		);
		expect(localStorage.getItem(DURABLE_APP_STORE_NAME)).toBeNull();
	});

	it("retains committed state after an archive failure for the next launch", async () => {
		const envelope = await createWorktreePresentationEnvelope(
			profile,
			original,
		);
		mocks.invoke.mockResolvedValueOnce({
			imported: false,
			envelope: JSON.stringify(envelope),
		});
		mocks.invoke.mockRejectedValueOnce(new Error("archive write failed"));
		await import("./worktreeReleaseBootstrap");
		await vi.waitFor(() => expect(mocks.render).toHaveBeenCalledOnce());
		expect(localStorage.getItem(DURABLE_APP_STORE_NAME)).toBe(original);
		expect(mocks.started).not.toHaveBeenCalled();
	});
});
