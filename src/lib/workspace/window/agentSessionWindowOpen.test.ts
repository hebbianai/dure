// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	created: [] as Array<{ label: string; options: Record<string, unknown> }>,
	getByLabel: vi.fn(),
	emitTo: vi.fn(async () => {}),
	once: vi.fn(),
	setFocus: vi.fn(),
	show: vi.fn(),
	unminimize: vi.fn(),
	windowLabel: "main",
	webviewStorageOptions: vi.fn(),
}));

vi.mock("@/lib/ipc/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/ipc/core")>()),
	webviewStorageOptions: mocks.webviewStorageOptions,
}));
vi.mock("@/lib/ipc", () => ({ setShellGlass: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
	emitTo: mocks.emitTo,
	listen: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ label: mocks.windowLabel }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
	WebviewWindow: class {
		static getByLabel = mocks.getByLabel;
		constructor(label: string, options: Record<string, unknown>) {
			mocks.created.push({ label, options });
		}
		once = mocks.once;
		setFocus = mocks.setFocus;
		show = mocks.show;
		unminimize = mocks.unminimize;
	},
}));

import {
	initialAgentSessionWindowId,
	initialAgentSessionSourceWindowLabel,
	isMainWindow,
	openAgentSessionWindow,
	openDesktopWindow,
	openAgentDiffWindow,
	openPopoutWindow,
	restoreWindowAfterSecondaryClose,
} from "@/lib/workspace/window/windows";
import {
	SECONDARY_WINDOW_EVENT_TIMEOUT_MS,
	SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS,
} from "@/lib/workspace/window/secondaryWindowOperation";

beforeEach(() => {
	mocks.created.length = 0;
	mocks.getByLabel.mockReset().mockResolvedValue(null);
	mocks.emitTo.mockReset().mockResolvedValue(undefined);
	mocks.once.mockReset().mockImplementation(async (event, handler) => {
		if (event === "tauri://created") queueMicrotask(handler);
		return () => {};
	});
	mocks.setFocus.mockReset().mockResolvedValue(undefined);
	mocks.show.mockReset().mockResolvedValue(undefined);
	mocks.unminimize.mockReset().mockResolvedValue(undefined);
	mocks.windowLabel = "main";
	mocks.webviewStorageOptions.mockReset().mockResolvedValue({});
	localStorage.clear();
	window.history.replaceState({}, "", "/");
});

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllEnvs();
});

describe("native-selected window storage", () => {
	const openers = [
		["workspace", () => openDesktopWindow("storage-space")],
		["popout", () => openPopoutWindow("storage-space")],
		["diff", () => openAgentDiffWindow("storage-agent")],
		["session", () => openAgentSessionWindow("storage-agent")],
	] as const;

	it.each(openers)("inherits native storage for %s instead of deriving it from build metadata", async (_, open) => {
		const options = {
			dataStoreIdentifier: Array(16).fill(17),
			dataDirectory: "native-selected-directory",
		};
		mocks.webviewStorageOptions.mockResolvedValue(options);
		vi.stubEnv("VITE_DURE_WORKTREE_RELEASE_PROFILE", JSON.stringify({
			sourceChannel: "dev-task-0123456789",
			targetChannel: "release-task-0123456789",
			identifier: "io.hebbian.ade.release.0123456789",
			dataStoreIdentifier: Array(16).fill(42),
		}));
		await open();
		expect(mocks.created).toHaveLength(1);
		expect(mocks.created[0].options).toMatchObject(options);
		expect(mocks.webviewStorageOptions).toHaveBeenCalled();
	});

	it("keeps the native default when no override is configured", async () => {
		await openPopoutWindow("default-storage");
		expect(mocks.created).toHaveLength(1);
		expect(mocks.created[0].options).not.toHaveProperty("dataStoreIdentifier");
		expect(mocks.created[0].options).not.toHaveProperty("dataDirectory");
	});

	it.each(openers)("does not silently use a default store when %s storage lookup fails", async (_, open) => {
		mocks.webviewStorageOptions.mockRejectedValue(new Error("native storage unavailable"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await open();
			expect(mocks.created).toHaveLength(0);
			expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
				message: "native storage unavailable",
			}));
		} finally {
			log.mockRestore();
		}
	});

	it("reuses an existing window without another storage lookup", async () => {
		mocks.getByLabel.mockResolvedValue({ show: mocks.show, unminimize: mocks.unminimize, setFocus: mocks.setFocus });
		await openPopoutWindow("existing-storage");
		expect(mocks.webviewStorageOptions).not.toHaveBeenCalled();
		expect(mocks.created).toHaveLength(0);
		expect(mocks.show).toHaveBeenCalledOnce();
	});
});

describe("popout creation acknowledgement", () => {
	it("stays pending until native creation and reveal complete", async () => {
		let created: (() => void) | undefined;
		mocks.once.mockImplementation(async (event, handler) => {
			if (event === "tauri://created") created = () => handler({ payload: undefined });
			return () => {};
		});
		let settled = false;
		const pending = openPopoutWindow("pending-popout").then((result) => { settled = true; return result; });
		try {
			await vi.waitFor(() => expect(mocks.created).toHaveLength(1));
			expect(settled).toBe(false);
			created?.();
			expect(await pending).toBe(true);
			expect(mocks.show).toHaveBeenCalledOnce();
		} finally { created?.(); await pending; }
	});
	it("reports native creation failure to the pane move caller", async () => {
		mocks.once.mockImplementation(async (event, handler) => {
			if (event === "tauri://error") queueMicrotask(() => handler({ payload: "native creation failed" }));
			return () => {};
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try { expect(await openPopoutWindow("failed-popout")).toBe(false); }
		finally { log.mockRestore(); }
		expect(mocks.show).not.toHaveBeenCalled();
	});
	it("reveals an existing hidden popout before reporting success", async () => {
		const existing = { show: mocks.show, unminimize: mocks.unminimize, setFocus: mocks.setFocus };
		mocks.getByLabel.mockResolvedValue(existing);
		expect(await openPopoutWindow("existing-popout")).toBe(true);
		expect(mocks.created).toHaveLength(0);
		expect(mocks.show).toHaveBeenCalledOnce();
	});
});

describe("agent session secondary window", () => {
	it("classifies the URL as a secondary window", () => {
		window.history.replaceState({}, "", "/?sessionWindow=agent-1");
		expect(initialAgentSessionWindowId()).toBe("agent-1");
		expect(initialAgentSessionSourceWindowLabel()).toBe("main");
		expect(isMainWindow()).toBe(false);
	});

	it("opens a stable large window without serializing runtime state", async () => {
		await openAgentSessionWindow("agent-1", "UI polish");

		expect(mocks.created).toEqual([
			expect.objectContaining({
				label: "win-session-agent-1",
				options: expect.objectContaining({
					url: "index.html?sessionWindow=agent-1&sourceWindow=main",
					title: "Dure — UI polish",
					width: 1180,
					height: 880,
				}),
			}),
		]);
		expect(mocks.show).toHaveBeenCalledOnce();
		expect(mocks.unminimize).toHaveBeenCalledOnce();
		expect(mocks.setFocus).toHaveBeenCalledOnce();
		expect(mocks.show.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.unminimize.mock.invocationCallOrder[0],
		);
		expect(mocks.unminimize.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.setFocus.mock.invocationCallOrder[0],
		);
	});

	it("records a non-main workspace as the return target", async () => {
		mocks.windowLabel = "win-workspace-2";

		await openAgentSessionWindow(
			"agent-2",
			undefined,
			"desktop-2:agent:agent-2",
		);

		expect(mocks.created[0]?.options.url).toBe(
			"index.html?sessionWindow=agent-2&sourceWindow=win-workspace-2&sourcePane=desktop-2%3Aagent%3Aagent-2",
		);
		window.history.replaceState(
			{},
			"",
			"/?sessionWindow=agent-2&sourceWindow=win-workspace-2&sourcePane=desktop-2%3Aagent%3Aagent-2",
		);
		expect(initialAgentSessionSourceWindowLabel()).toBe("win-workspace-2");
	});

	it("focuses an existing Agent window instead of creating another observer", async () => {
		mocks.windowLabel = "win-workspace-3";
		const existing = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
		};
		mocks.getByLabel.mockResolvedValue(existing);

		await openAgentSessionWindow(
			"agent-1",
			undefined,
			"desktop-3:agent:agent-1",
		);

		expect(mocks.created).toHaveLength(0);
		expect(existing.show).toHaveBeenCalledOnce();
		expect(existing.unminimize).toHaveBeenCalledOnce();
		expect(existing.setFocus).toHaveBeenCalledOnce();
		expect(mocks.emitTo).toHaveBeenCalledWith(
			{ kind: "WebviewWindow", label: "win-session-agent-1" },
			"dure://agent-session/source-window-changed",
			{
				agentId: "agent-1",
				sourceWindowLabel: "win-workspace-3",
				sourcePaneOwnerId: "desktop-3:agent:agent-1",
			},
		);
		expect(existing.show.mock.invocationCallOrder[0]).toBeLessThan(
			existing.unminimize.mock.invocationCallOrder[0],
		);
		expect(existing.unminimize.mock.invocationCallOrder[0]).toBeLessThan(
			existing.setFocus.mock.invocationCallOrder[0],
		);
	});

	it("reveals an existing window without waiting for source-event delivery", async () => {
		const existing = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
		};
		mocks.getByLabel.mockResolvedValue(existing);
		mocks.emitTo.mockImplementation(() => new Promise(() => {}));

		const open = openAgentSessionWindow(
			"agent-1",
			undefined,
			"desktop-3:agent:agent-1",
		);
		await vi.waitFor(() => expect(existing.show).toHaveBeenCalledOnce());
		await open;
	});

	it("restores and focuses the exact non-main source window", async () => {
		const source = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
		};
		mocks.getByLabel.mockResolvedValue(source);

		await restoreWindowAfterSecondaryClose("win-workspace-2");

		expect(mocks.getByLabel).toHaveBeenCalledWith("win-workspace-2");
		expect(source.show).toHaveBeenCalledOnce();
		expect(source.unminimize).toHaveBeenCalledOnce();
		expect(source.setFocus).toHaveBeenCalledOnce();
	});

	it("recovers a stalled creation without constructing a duplicate label", async () => {
		vi.useFakeTimers();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.once.mockReset().mockResolvedValue(() => {});
		const stalled = openAgentSessionWindow("agent-1");
		await vi.advanceTimersByTimeAsync(
			SECONDARY_WINDOW_EVENT_TIMEOUT_MS +
				SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS +
				50,
		);
		await stalled;

		const existing = {
			show: vi.fn(async () => {}),
			unminimize: vi.fn(async () => {}),
			setFocus: vi.fn(async () => {}),
		};
		mocks.getByLabel.mockResolvedValue(existing);
		await openAgentSessionWindow("agent-1");

		expect(mocks.created).toHaveLength(1);
		expect(existing.show).toHaveBeenCalledOnce();
		error.mockRestore();
		vi.useRealTimers();
	});

	it("does not create when the initial stable-label lookup is unresolved", async () => {
		vi.useFakeTimers();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		mocks.getByLabel.mockImplementation(() => new Promise(() => {}));
		const pending = openAgentSessionWindow("agent-lookup-timeout");

		await vi.advanceTimersByTimeAsync(SECONDARY_WINDOW_LOOKUP_TIMEOUT_MS);
		await pending;

		expect(mocks.created).toHaveLength(0);
		error.mockRestore();
		vi.useRealTimers();
	});
});
