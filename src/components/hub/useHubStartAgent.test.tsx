// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, Space, SshHostConfig } from "@/types";

const mocks = vi.hoisted(() => ({
	isMainWindow: vi.fn(() => true),
	listen: vi.fn(),
	createSaga: vi.fn(),
	runSaga: vi.fn(),
	receipt: vi.fn(),
	report: vi.fn(),
	getDockview: vi.fn(() => ({}) as unknown),
	handlers: [] as Array<(event: { payload: unknown }) => void>,
}));

vi.mock("@/lib/workspace/window/windows", () => ({
	isMainWindow: mocks.isMainWindow,
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
		mocks.handlers.push(handler);
		return mocks.listen(_name, handler);
	},
}));
vi.mock("@/lib/ipc/spawn", () => ({
	spawnJournal: { createSaga: mocks.createSaga, receipt: mocks.receipt },
}));
vi.mock("@/lib/sessions/launch/spawnSaga", () => ({
	runSpawnSagaFromCli: mocks.runSaga,
	artifactIdFromReceipt: () => "agent-1",
}));
vi.mock("@/lib/ipc/system", () => ({ hubStartAgentResult: mocks.report }));
vi.mock("@/lib/workspace/dock/dockRegistry", () => ({
	getDockview: mocks.getDockview,
}));

import { useHubStartAgent } from "@/components/hub/useHubStartAgent";
import { useStore } from "@/store";

const press = {
	request_id: "start-agent-1",
	target_id: "s1 p1",
	kind_id: "claude",
	action_id: "act-1",
};

beforeEach(() => {
	mocks.handlers.length = 0;
	mocks.isMainWindow.mockReturnValue(true);
	mocks.listen.mockResolvedValue(() => {});
	mocks.createSaga.mockResolvedValue({ receiptId: "sp_1" });
	mocks.runSaga.mockResolvedValue(undefined);
	mocks.receipt.mockResolvedValue({ state: "succeeded", steps: [] });
	mocks.report.mockResolvedValue(true);
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "pro" },
		desktops: [{ id: "s1", name: "Main" }] as Space[],
		projects: [
			{
				id: "p1",
				name: "HebbianIDE",
				path: "~/dev/x",
				kind: "local",
				isRepo: true,
			},
		] as Project[],
		agents: [],
		installedAgents: ["claude"],
		sshHosts: [],
	});
});

afterEach(() => {
	cleanup();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.clearAllMocks();
});

describe("useHubStartAgent", () => {
	it.each(["aws", "tailscale"])(
		"starts a provider on the exact %s host without using the Mac inventory",
		async (hostId) => {
			useStore.setState({
				projects: [
					{
						id: "remote",
						name: "Remote",
						kind: "ssh",
						sshHostId: hostId,
						path: "/srv/qa",
						isRepo: true,
					},
				],
				sshHosts: [
					{
						id: hostId,
						name: hostId,
						host: `${hostId}.test`,
						port: 22,
						user: "qa",
						auth: "auto",
					},
				] as SshHostConfig[],
				installedAgents: [],
			});
			renderHook(() => useHubStartAgent());
			mocks.handlers[0]?.({
				payload: {
					...press,
					target_id: "s1 remote",
					kind_id: "qwen-code",
					use_worktree: false,
				},
			});
			await waitFor(() => expect(mocks.report).toHaveBeenCalled());
			expect(mocks.createSaga).toHaveBeenCalledWith(
				expect.objectContaining({
					project: "remote",
					provider: "qwen-code",
					useWorktree: false,
				}),
				"hub-start:act-1",
			);
			expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({ started: true });
			mocks.handlers[0]?.({
				payload: {
					...press,
					target_id: "s1 remote",
					kind_id: "qwen-code",
					use_worktree: false,
				},
			});
			await waitFor(() => expect(mocks.createSaga).toHaveBeenCalledTimes(2));
			expect(mocks.createSaga.mock.calls[1]).toEqual(
				mocks.createSaga.mock.calls[0],
			);
			await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(2));
		},
	);

	it.each(["qwen-code", "not-a-provider"])(
		"does not borrow remote eligibility for missing local provider %s",
		async (kindId) => {
			renderHook(() => useHubStartAgent());
			mocks.handlers[0]?.({
				payload: { ...press, kind_id: kindId, use_worktree: false },
			});
			await waitFor(() => expect(mocks.report).toHaveBeenCalled());
			expect(mocks.createSaga).not.toHaveBeenCalled();
			expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
				started: false,
				code: "kind_missing",
			});
		},
	);

	it("refuses an explicit SSH worktree before creating a journal or pane", async () => {
		useStore.setState({
			projects: [
				{
					id: "remote",
					name: "Remote",
					kind: "ssh",
					sshHostId: "aws",
					path: "/srv/qa",
					isRepo: true,
				},
			],
			sshHosts: [
				{
					id: "aws",
					name: "AWS",
					host: "aws.test",
					port: 22,
					user: "qa",
					auth: "auto",
				},
			] as SshHostConfig[],
		});
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({
			payload: { ...press, target_id: "s1 remote", use_worktree: true },
		});
		await waitFor(() => expect(mocks.report).toHaveBeenCalled());
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
			started: false,
			code: "remote_worktree_unsupported",
		});
	});

	it("never substitutes another configured SSH host for a missing target host", async () => {
		useStore.setState({
			projects: [
				{
					id: "remote",
					name: "Remote",
					kind: "ssh",
					sshHostId: "aws",
					path: "/srv/qa",
					isRepo: true,
				},
			],
			sshHosts: [
				{
					id: "tailscale",
					name: "Tail",
					host: "tailscale.test",
					port: 22,
					user: "qa",
					auth: "auto",
				},
			] as SshHostConfig[],
		});
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({
			payload: { ...press, target_id: "s1 remote", use_worktree: false },
		});
		await waitFor(() => expect(mocks.report).toHaveBeenCalled());
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
			started: false,
			code: "target_missing",
		});
	});

	it("runs the spawn saga for the seat that was pressed", async () => {
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		await waitFor(() => expect(mocks.createSaga).toHaveBeenCalledTimes(1));
		expect(mocks.createSaga.mock.calls[0]?.[0]).toMatchObject({
			project: "p1",
			provider: "claude",
			spaceId: "s1",
		});
		// The press's own name, so a retry rejoins this run instead of starting
		// a second agent.
		expect(mocks.createSaga.mock.calls[0]?.[1]).toBe("hub-start:act-1");
		await waitFor(() =>
			expect(mocks.report).toHaveBeenCalledWith(
				"start-agent-1",
				expect.objectContaining({ started: true, agentId: "agent-1" }),
			),
		);
	});

	/**
	 * This is the whole reason both halves of the feature sit on one window.
	 * The round trip settles on the first reply and discards the second — but
	 * discarding a reply does not undo the agent that reply was about.
	 */
	it("starts one agent when a popout window is open beside the main one", async () => {
		renderHook(() => useHubStartAgent());
		mocks.isMainWindow.mockReturnValue(false);
		renderHook(() => useHubStartAgent());

		for (const handler of mocks.handlers) handler({ payload: press });
		await waitFor(() => expect(mocks.createSaga).toHaveBeenCalledTimes(1));

		expect(mocks.handlers).toHaveLength(1);
		await waitFor(() => expect(mocks.report).toHaveBeenCalledTimes(1));
	});

	/**
	 * A retry arrives while the first run is still going: the idempotency key
	 * hands back the same receipt, and `runSpawnSagaFromCli` returns at once
	 * because that receipt is already being driven. Reading the receipt right
	 * then finds it mid-run — and reporting *that* as a failure puts "다시
	 * 고르기" in front of somebody whose agent is starting perfectly well,
	 * which is how one press becomes two agents.
	 */
	it("waits out a run already in flight instead of calling it a failure", async () => {
		const states = ["running", "running", "succeeded"];
		mocks.receipt.mockImplementation(async () => ({
			state: states.shift() ?? "succeeded",
			steps: [],
		}));
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		await waitFor(
			() =>
				expect(mocks.report).toHaveBeenCalledWith(
					"start-agent-1",
					expect.objectContaining({ started: true }),
				),
			{ timeout: 4000 },
		);
	});

	/**
	 * The watch gives up before the run does. Saying "failed" there would be a
	 * guess, and the phone reads a failure as an invitation to press again.
	 */
	it("says it does not know when the run outlives the watch", async () => {
		vi.useFakeTimers();
		mocks.receipt.mockResolvedValue({ state: "running", steps: [] });
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.report).toHaveBeenCalledWith(
			"start-agent-1",
			expect.objectContaining({ started: false, code: "still_starting" }),
		);
	});

	it("answers the first press at the watch deadline while its saga keeps running", async () => {
		vi.useFakeTimers();
		let finishRun = () => {};
		mocks.runSaga.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishRun = resolve;
				}),
		);
		mocks.receipt.mockResolvedValue({ state: "running", steps: [] });
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		try {
			await vi.advanceTimersByTimeAsync(14_999);
			expect(mocks.runSaga).toHaveBeenCalledExactlyOnceWith({
				receiptId: "sp_1",
			});
			expect(mocks.report).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(mocks.report).toHaveBeenCalledExactlyOnceWith(
				"start-agent-1",
				expect.objectContaining({ started: false, code: "still_starting" }),
			);

			mocks.receipt.mockResolvedValue({ state: "succeeded", steps: [] });
			finishRun();
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.report).toHaveBeenCalledTimes(1);
			mocks.handlers[0]?.({
				payload: { ...press, request_id: "start-agent-retry" },
			});
			await vi.advanceTimersByTimeAsync(200);
			expect(mocks.createSaga).toHaveBeenCalledTimes(2);
			expect(mocks.createSaga.mock.calls[1]).toEqual(
				mocks.createSaga.mock.calls[0],
			);
			expect(mocks.runSaga).toHaveBeenNthCalledWith(2, { receiptId: "sp_1" });
			expect(mocks.report).toHaveBeenLastCalledWith(
				"start-agent-retry",
				expect.objectContaining({ started: true, agentId: "agent-1" }),
			);
		} finally {
			mocks.receipt.mockResolvedValue({ state: "succeeded", steps: [] });
			finishRun();
			await vi.advanceTimersByTimeAsync(0);
		}
	});

	it.each(["failed", "manual_intervention_required"])(
		"waits for a resumed %s receipt to reflect the current run",
		async (state) => {
			vi.useFakeTimers();
			let finishRun = () => {};
			mocks.runSaga.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						finishRun = resolve;
					}),
			);
			mocks.receipt.mockResolvedValue({ state, steps: [] });
			renderHook(() => useHubStartAgent());
			mocks.handlers[0]?.({ payload: press });

			try {
				await vi.advanceTimersByTimeAsync(14_800);
				expect(mocks.report).not.toHaveBeenCalled();
				expect(mocks.receipt).not.toHaveBeenCalled();
				mocks.receipt.mockResolvedValue({ state: "succeeded", steps: [] });
				finishRun();
				await vi.advanceTimersByTimeAsync(200);
				expect(mocks.report).toHaveBeenCalledExactlyOnceWith(
					"start-agent-1",
					expect.objectContaining({ started: true, agentId: "agent-1" }),
				);
				expect(mocks.runSaga).toHaveBeenCalledTimes(1);
			} finally {
				finishRun();
				await vi.advanceTimersByTimeAsync(200);
			}
		},
	);

	it.each([0, 15_000])(
		"observes a runner rejection after %i ms without reporting twice",
		async (elapsed) => {
			vi.useFakeTimers();
			let rejectRun = (_error: Error) => {};
			mocks.runSaga.mockImplementationOnce(
				() =>
					new Promise<void>((_resolve, reject) => {
						rejectRun = reject;
					}),
			);
			mocks.receipt.mockResolvedValue({ state: "running", steps: [] });
			renderHook(() => useHubStartAgent());
			mocks.handlers[0]?.({ payload: press });

			await vi.advanceTimersByTimeAsync(elapsed);
			expect(mocks.report).toHaveBeenCalledTimes(elapsed === 0 ? 0 : 1);
			rejectRun(new Error("runner unavailable"));
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.report).toHaveBeenCalledExactlyOnceWith(
				"start-agent-1",
				expect.objectContaining({
					started: false,
					code: elapsed === 0 ? "failed" : "still_starting",
				}),
			);
			if (elapsed === 0) {
				expect(mocks.report.mock.calls[0]?.[1].detail).toContain(
					"runner unavailable",
				);
			}
		},
	);

	it("refuses a seat whose folder is gone rather than starting something else", async () => {
		useStore.setState({ projects: [] });
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		await waitFor(() => expect(mocks.report).toHaveBeenCalled());
		expect(mocks.createSaga).not.toHaveBeenCalled();
		expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
			started: false,
			code: "target_missing",
		});
	});

	it("turns a failed saga into a refusal carrying the step that failed", async () => {
		mocks.receipt.mockResolvedValue({
			state: "failed",
			steps: [
				{
					step: "worktree",
					status: "failed",
					endedAt: 2,
					error: { code: "worktree_locked", message: "worktree is locked" },
				},
			],
		});
		renderHook(() => useHubStartAgent());
		mocks.handlers[0]?.({ payload: press });

		await waitFor(() => expect(mocks.report).toHaveBeenCalled());
		expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
			started: false,
			code: "failed",
		});
		expect(String(mocks.report.mock.calls[0]?.[1].detail)).toContain(
			"worktree is locked",
		);
	});
});

it("refuses a stale Pro launch request after switching to Basic", async () => {
	useStore.setState({ installedAgents: ["gemini"] });
	renderHook(() => useHubStartAgent());
	useStore.setState({
		uiPrefs: { ...useStore.getState().uiPrefs, interfaceMode: "basic" },
	});
	mocks.handlers[0]?.({
		payload: { ...press, kind_id: "gemini", use_worktree: false },
	});
	await waitFor(() => expect(mocks.report).toHaveBeenCalled());
	expect(mocks.createSaga).not.toHaveBeenCalled();
	expect(mocks.report.mock.calls[0]?.[1]).toMatchObject({
		started: false,
		code: "kind_missing",
	});
});
