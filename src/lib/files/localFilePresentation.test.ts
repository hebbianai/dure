// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	events: [] as string[],
	agents: [] as { id: string; name: string; displayName?: string; sessionId: string }[],
	openFilePresentationWindow: vi.fn(),
	emitWhenReady: vi.fn(),
}));

vi.mock("@/lib/workspace/window/windows", () => ({
	FILE_PRESENTATION_WINDOW_LABEL: "win-presentation",
	openFilePresentationWindow: mocks.openFilePresentationWindow,
}));
vi.mock("@/lib/platform/tauriBridge", () => ({
	emitWhenReady: mocks.emitWhenReady,
}));
vi.mock("@/store", () => ({
	useStore: { getState: () => ({ agents: mocks.agents }) },
}));

import { readFilePresentation } from "@/lib/files/filePresentation";
import { presentLocalFile } from "@/lib/files/localFilePresentation";

beforeEach(() => {
	localStorage.clear();
	mocks.events.length = 0;
	mocks.agents.splice(0, mocks.agents.length, {
		id: "agent-1",
		name: "worker",
		displayName: "Release notes",
		sessionId: "session-1",
	});
	mocks.emitWhenReady.mockImplementation(async (_event, payload) => {
		mocks.events.push(`announce ${payload.file.path}`);
	});
	mocks.openFilePresentationWindow.mockImplementation(async (title) => {
		mocks.events.push(`open ${title}`);
		return "created";
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("presentLocalFile", () => {
	it("stores and announces the file before revealing the window, naming the presenter", async () => {
		mocks.openFilePresentationWindow.mockImplementation(async (title) => {
			mocks.events.push(`open ${title}`);
			expect(readFilePresentation()?.file.path).toBe("/work/demo run.mp4");
			return "created";
		});
		const receipt = await presentLocalFile("/work/demo run.mp4", "session-1");
		expect(mocks.events).toEqual([
			"announce /work/demo run.mp4",
			"open demo run.mp4",
		]);
		expect(mocks.emitWhenReady).toHaveBeenCalledWith(
			"dure://file-presentation/changed",
			expect.objectContaining({
				file: { source: "local", path: "/work/demo run.mp4" },
				presenterAgentId: "agent-1",
			}),
		);
		expect(receipt).toEqual({
			label: "win-presentation",
			file: { source: "local", path: "/work/demo run.mp4" },
			reused: false,
			presenter: { agentId: "agent-1", name: "Release notes" },
		});
	});

	it("gives every presentation a new identity and reports a reused window", async () => {
		mocks.openFilePresentationWindow.mockResolvedValue("revealed");
		await presentLocalFile("/work/report.md");
		const firstId = readFilePresentation()?.id;
		const receipt = await presentLocalFile("/work/report.md");
		expect(readFilePresentation()?.id).not.toBe(firstId);
		expect(receipt).toEqual({
			label: "win-presentation",
			file: { source: "local", path: "/work/report.md" },
			reused: true,
		});
		expect(readFilePresentation()).not.toHaveProperty("presenterAgentId");
	});

	it("runs presentations one at a time so the second reuses the first window", async () => {
		let finishFirst: (() => void) | undefined;
		mocks.openFilePresentationWindow
			.mockImplementationOnce(
				(title) =>
					new Promise((resolve) => {
						mocks.events.push(`open ${title}`);
						finishFirst = () => resolve("created");
					}),
			)
			.mockImplementationOnce(async (title) => {
				mocks.events.push(`open ${title}`);
				return "revealed";
			});
		const first = presentLocalFile("/work/a.png");
		const second = presentLocalFile("/work/b.pdf");
		await vi.waitFor(() => expect(finishFirst).toBeDefined());
		expect(mocks.events).toEqual(["announce /work/a.png", "open a.png"]);
		finishFirst?.();
		await expect(first).resolves.toMatchObject({ reused: false });
		await expect(second).resolves.toMatchObject({ reused: true });
		expect(mocks.events).toEqual([
			"announce /work/a.png",
			"open a.png",
			"announce /work/b.pdf",
			"open b.pdf",
		]);
	});

	it("keeps presenting after a failed window and refuses a relative path", async () => {
		mocks.openFilePresentationWindow.mockRejectedValueOnce(
			new Error("window creation failed"),
		);
		await expect(presentLocalFile("/work/a.png")).rejects.toThrow(
			"window creation failed",
		);
		await expect(presentLocalFile("relative.png")).rejects.toThrow(
			"absolute",
		);
		await expect(presentLocalFile("/work/b.png")).resolves.toMatchObject({
			reused: false,
		});
	});
});
