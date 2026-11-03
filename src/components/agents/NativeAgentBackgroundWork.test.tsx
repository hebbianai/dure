// @vitest-environment jsdom

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { setLang } from "@/lib/i18n";
import type { BackgroundWorkList } from "@/lib/ipc/conversations";
import {
	BACKGROUND_WORK_REFRESH_MS,
	NativeAgentBackgroundWork,
} from "./NativeAgentBackgroundWork";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/ipc/conversations", () => ({
	readAgentBackgroundWork: (...args: unknown[]) => mocks.read(...args),
}));

const NOW = 1_793_600_000_000;
const running: BackgroundWorkList = {
	items: [
		{
			id: "wf_1",
			kind: "workflow",
			label: "typing-accuracy-first",
			startedUnixMs: NOW - 34 * 60_000,
			steps: { done: 1, total: 2 },
			tokens: 514_800,
		},
		{ id: "b1", kind: "shell", label: "Watch CI", startedUnixMs: NOW - 5_000 },
	],
	counts: { subagents: 0, workflows: 1, shells: 1, monitors: 0 },
	truncated: false,
};

beforeAll(() => setLang("en"));
afterAll(() => setLang("ko"));
afterEach(() => {
	cleanup();
	mocks.read.mockReset();
});

describe("NativeAgentBackgroundWork", () => {
	it("renders nothing and reads nothing while the agent is idle", () => {
		const { container } = render(
			<NativeAgentBackgroundWork
				workspaceId="workspace-1"
				sessionId="session-1"
				active={false}
				now={() => NOW}
			/>,
		);
		expect(container.innerHTML).toBe("");
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("shows the count collapsed and the rows when expanded", async () => {
		mocks.read.mockResolvedValue(running);
		render(
			<NativeAgentBackgroundWork
				workspaceId="workspace-1"
				sessionId="session-1"
				active
				now={() => NOW}
			/>,
		);
		const summary = await screen.findByText("1 running · 1 shell");
		expect(mocks.read).toHaveBeenCalledWith("workspace-1", "session-1");
		const details = summary.closest("details");
		expect(details?.open).toBe(false);
		fireEvent.click(summary);
		details?.setAttribute("open", "");
		fireEvent(details as Element, new Event("toggle"));
		await waitFor(() =>
			expect(screen.getByText("typing-accuracy-first")).toBeTruthy(),
		);
		expect(screen.getByText("1/2")).toBeTruthy();
		expect(screen.getByText("34m")).toBeTruthy();
		expect(screen.getByText("515k")).toBeTruthy();
		expect(screen.getByText("Watch CI")).toBeTruthy();
	});

	it("starts no second read while one is in flight", async () => {
		vi.useFakeTimers();
		try {
			let finish: (list: BackgroundWorkList) => void = () => {};
			mocks.read.mockImplementation(
				() =>
					new Promise<BackgroundWorkList>((resolve) => {
						finish = resolve;
					}),
			);
			render(
				<NativeAgentBackgroundWork
					workspaceId="workspace-1"
					sessionId="session-1"
					active
					now={() => NOW}
				/>,
			);
			expect(mocks.read).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_REFRESH_MS * 3);
			expect(mocks.read).toHaveBeenCalledTimes(1);
			finish(running);
			await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_REFRESH_MS);
			expect(mocks.read).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("hides the line when the list comes back empty or the read fails", async () => {
		mocks.read.mockRejectedValue(new Error("session_not_found"));
		const { container } = render(
			<NativeAgentBackgroundWork
				workspaceId="workspace-1"
				sessionId="session-1"
				active
				now={() => NOW}
			/>,
		);
		await waitFor(() => expect(mocks.read).toHaveBeenCalled());
		expect(container.innerHTML).toBe("");
	});
});
