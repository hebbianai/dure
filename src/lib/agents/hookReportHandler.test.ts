import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	reportAgentState: vi.fn(),
	handleActivity: vi.fn(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc")>();
	return {
		...original,
		hmux: {
			...original.hmux,
			reportAgentState: mocks.reportAgentState,
		},
	};
});

vi.mock("@/lib/agents/hookActivity", () => ({
	handleActivity: mocks.handleActivity,
}));

import {
	HOOK_REPORT_QUEUE_LIMIT,
	handleHookState,
	resetHookReportQueueForTests,
} from "@/lib/agents/hookReportHandler";
import { useStore } from "@/store";

beforeEach(() => {
	vi.clearAllMocks();
	resetHookReportQueueForTests();
	mocks.reportAgentState.mockResolvedValue({ outcome: "applied" });
	useStore.setState({
		agents: [],
		projects: [],
		sessionAgent: {},
		sessionAgentPin: {},
	});
});

it("routes an agentless managed-shell hook through its exact Host fence", () => {
	const sessionId = "term-zbO69IzS";
	const workspaceId = "dure-local-shells-v1";
	const sessionFence = {
		sessionId,
		workspaceId,
		runnerPrincipal: "runner-source",
		runnerInstance: "instance-source",
		channelEpoch: "1",
		hostInstanceId: "host-source",
		terminalEpoch: "terminal-source",
	};

	handleHookState({
		sessionId,
		state: "waiting",
		provider: "codex",
		conversationId: "conversation-1",
		terminalEvents: true,
		sessionFence,
	});

	expect(mocks.reportAgentState).toHaveBeenCalledWith({
		sessionId,
		workspaceId,
		activity: "waiting",
		attention: "none",
		turnCompleted: false,
		conversationIdentity: {
			providerId: "codex",
			conversationId: "conversation-1",
			expectedFence: sessionFence,
		},
	});
});

it("does not promote an unbound hook report into frontend runtime state", () => {
	handleHookState({
		sessionId: "orphan-session",
		state: "done",
		provider: "codex",
		terminalEvents: true,
	});

	expect(mocks.reportAgentState).not.toHaveBeenCalled();
});

/** The drain hands off through catch → finally → next call: a few
 * microtasks per report, so yield generously. */
const flush = async () => {
	for (let i = 0; i < 512; i += 1) await Promise.resolve();
};

function managedHook(state: "working" | "waiting" | "blocked" | "done", n: number) {
	const sessionId = `term-burst-${n}`;
	return {
		sessionId,
		state,
		provider: "codex",
		terminalEvents: true,
		sessionFence: {
			sessionId,
			workspaceId: "dure-local-shells-v1",
			runnerPrincipal: "runner",
			runnerInstance: "instance",
			channelEpoch: "1",
			hostInstanceId: "host",
			terminalEpoch: "terminal",
		},
	};
}

it("forwards every report of a burst, in order, instead of dropping past a per-second count", async () => {
	// Three subagents each firing PreToolUse hooks exceed the old 20/s window;
	// a dropped working or Stop report was never resent and left the Host stale.
	for (let n = 0; n < 40; n += 1) handleHookState(managedHook(n % 2 ? "working" : "waiting", n));
	await flush();
	expect(mocks.reportAgentState).toHaveBeenCalledTimes(40);
	expect(
		mocks.reportAgentState.mock.calls.map(([request]) => request.sessionId),
	).toEqual(Array.from({ length: 40 }, (_, n) => `term-burst-${n}`));
});

it("keeps one Host report in flight so folds arrive in hook order", async () => {
	let settleFirst: (value: { outcome: string }) => void = () => {};
	mocks.reportAgentState.mockImplementationOnce(
		() => new Promise((resolve) => { settleFirst = resolve; }),
	);
	handleHookState(managedHook("working", 1));
	handleHookState(managedHook("done", 2));
	await flush();
	expect(mocks.reportAgentState).toHaveBeenCalledTimes(1);
	settleFirst({ outcome: "applied" });
	await flush();
	expect(mocks.reportAgentState).toHaveBeenCalledTimes(2);
	expect(mocks.reportAgentState.mock.calls[1][0].sessionId).toBe("term-burst-2");
});

it("a failed Host report does not hold back the ones behind it", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.reportAgentState.mockRejectedValueOnce(new Error("hmux_session_not_found"));
	handleHookState(managedHook("working", 1));
	handleHookState(managedHook("done", 2));
	await flush();
	expect(mocks.reportAgentState).toHaveBeenCalledTimes(2);
	expect(warn).toHaveBeenCalledTimes(1);
	warn.mockRestore();
});

it("bounds the queue: past the limit the newest report is dropped and said once", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	mocks.reportAgentState.mockImplementationOnce(() => new Promise(() => {}));
	handleHookState(managedHook("working", 0)); // in flight forever
	for (let n = 1; n <= HOOK_REPORT_QUEUE_LIMIT + 3; n += 1) handleHookState(managedHook("working", n));
	await flush();
	expect(mocks.reportAgentState).toHaveBeenCalledTimes(1);
	expect(warn).toHaveBeenCalledTimes(1);
	expect(warn.mock.calls[0][0]).toMatch(/hook report queue/);
	warn.mockRestore();
});
