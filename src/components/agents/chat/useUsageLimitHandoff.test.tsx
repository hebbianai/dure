// @vitest-environment jsdom

import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usageRecent } from "@/lib/ipc";
import { useUsageLimitHandoff } from "./useUsageLimitHandoff";
import type { LatestTurnFailure } from "@/lib/agents/chat/turnFailureReason";

vi.mock("@/lib/ipc", () => ({
	usageRecent: vi.fn(async () => ({
		codexAccountSnapshots: [
			{
				credentialId: "account-next",
				capturedAt: Date.now() / 1000,
				attemptedAt: Date.now() / 1000,
				error: null,
				rateLimits: [
					{
						limitId: "codex",
						limitName: null,
						usedPercent: 10,
						usedPercentWeekly: 20,
						resetsAt: null,
						weeklyResetsAt: null,
					},
				],
			},
		],
		claudeAccounts: [],
		codexAccounts: [],
		claude: {},
		codex: {},
	})),
}));
afterEach(cleanup);
let sequence = 0;
function input(
	performAccountSwitch = vi
		.fn()
		.mockResolvedValue({ kind: "completed", conversationId: "thread" }),
) {
	return {
		agentId: `handoff-test-${++sequence}`,
		provider: "codex" as const,
		automatic: true,
		accountMovesLocked: false,
		currentCredentialId: "account-old",
		pool: [
			{
				id: "account-next",
				provider: "codex" as const,
				name: "Next",
				dir: "/fixture/next",
			},
		],
		failure: {
			itemId: "failed-row",
			createdAtMs: Date.now() + 60_000,
			reason: "usage_limit",
			recoveries: ["switch_account"],
			userInput: "Continue the report",
		} as LatestTurnFailure,
		performAccountSwitch,
		resumeAfterHandoff: vi.fn().mockResolvedValue("accepted"),
	};
}

it("resumes the failed input only after a completed account handoff, once across remount", async () => {
	let finish!: (value: unknown) => void;
	const pending = new Promise((resolve) => {
		finish = resolve;
	});
	const props = input(vi.fn().mockReturnValue(pending));
	const mounted = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(props.performAccountSwitch).toHaveBeenCalledTimes(1),
	);
	expect(props.resumeAfterHandoff).not.toHaveBeenCalled();
	const result = { kind: "completed", conversationId: "thread" };
	await act(async () => {
		finish(result);
	});
	await waitFor(() =>
		expect(props.resumeAfterHandoff).toHaveBeenCalledWith(
			props.failure,
			result,
		),
	);
	mounted.unmount();
	renderHook(() => useUsageLimitHandoff(props));
	await act(async () => {});
	expect(props.performAccountSwitch).toHaveBeenCalledTimes(1);
	expect(props.resumeAfterHandoff).toHaveBeenCalledTimes(1);
});

it.each(["failed", "scheduled"])(
	"does not resume a %s account switch",
	async (kind) => {
		const switchAccount =
			kind === "failed"
				? vi.fn().mockRejectedValue(new Error("switch failed"))
				: vi
						.fn()
						.mockResolvedValue({ kind: "scheduled", conversationId: "thread" });
		const props = input(switchAccount);
		renderHook(() => useUsageLimitHandoff(props));
		await waitFor(() => expect(switchAccount).toHaveBeenCalledTimes(1));
		await act(async () => {});
		expect(props.resumeAfterHandoff).not.toHaveBeenCalled();
	},
);

it("keeps a failed background handoff visible across observers and remount without switching again", async () => {
	let reject!: (error: Error) => void;
	const pending = new Promise<never>((_resolve, fail) => {
		reject = fail;
	});
	const props = input(vi.fn().mockReturnValue(pending));
	const background = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(props.performAccountSwitch).toHaveBeenCalledTimes(1),
	);
	const pane = renderHook(() => useUsageLimitHandoff(props));
	await act(async () => {
		reject(new Error("The replacement account could not start."));
	});
	expect(pane.result.current.view).toMatchObject({
		kind: "failed",
		error: "The replacement account could not start.",
	});
	background.unmount();
	pane.unmount();
	const reopened = renderHook(() => useUsageLimitHandoff(props));
	await act(async () => {});
	expect(reopened.result.current.view).toMatchObject({
		kind: "failed",
		error: "The replacement account could not start.",
	});
	expect(props.performAccountSwitch).toHaveBeenCalledTimes(1);
	expect(props.resumeAfterHandoff).not.toHaveBeenCalled();
});

it("recovers a failed automatic switch only after one explicit request", async () => {
	const transition = vi.fn().mockRejectedValueOnce(new Error("switch failed"));
	const props = input(transition);
	const mounted = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(mounted.result.current.view).toMatchObject({
			kind: "failed",
			decision: { kind: "handoff" },
		}),
	);
	expect(transition).toHaveBeenCalledTimes(1);
	let finish!: (value: unknown) => void;
	transition.mockImplementationOnce(
		() => new Promise((resolve) => { finish = resolve; }),
	);
	let recovery!: Promise<void>;
	act(() => { recovery = mounted.result.current.requestHandoff(); });
	await expect(mounted.result.current.requestHandoff()).rejects.toThrow(
		"handoff_undecided",
	);
	await act(async () => {
		finish({ kind: "completed", conversationId: "thread" });
		await recovery;
	});
	expect(mounted.result.current.view).toMatchObject({
		kind: "handled",
		outcome: { toName: "Next" },
	});
	expect(transition).toHaveBeenCalledTimes(2);
	expect(props.resumeAfterHandoff).not.toHaveBeenCalled();
});

it("does not resubmit an uncertain continuation or act while automatic switching is disabled", async () => {
	const props = input();
	props.resumeAfterHandoff.mockResolvedValue("uncertain");
	const mounted = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(props.resumeAfterHandoff).toHaveBeenCalledTimes(1),
	);
	mounted.rerender();
	await act(async () => {});
	expect(props.resumeAfterHandoff).toHaveBeenCalledTimes(1);
	const disabled = { ...input(), automatic: false };
	renderHook(() => useUsageLimitHandoff(disabled));
	await act(async () => {});
	expect(disabled.performAccountSwitch).not.toHaveBeenCalled();
	expect(disabled.resumeAfterHandoff).not.toHaveBeenCalled();
});

it("continues without a usage report and excludes accounts that just failed", async () => {
	vi.mocked(usageRecent).mockRejectedValueOnce(new Error("usage unavailable"));
	const props = input();
	const second = {
		id: "account-spare",
		provider: "codex" as const,
		name: "Spare",
		dir: "/fixture/spare",
	};
	props.pool.push(second);
	const mounted = renderHook((args) => useUsageLimitHandoff(args), {
		initialProps: props,
	});
	await waitFor(() =>
		expect(props.performAccountSwitch).toHaveBeenCalledExactlyOnceWith(
			"account-next",
		),
	);
	await waitFor(() =>
		expect(props.resumeAfterHandoff).toHaveBeenCalledTimes(1),
	);
	mounted.rerender({
		...props,
		currentCredentialId: "account-next",
		failure: {
			...props.failure,
			itemId: "second-failure",
			createdAtMs: props.failure.createdAtMs + 1000,
		},
	});
	await waitFor(() =>
		expect(props.performAccountSwitch).toHaveBeenLastCalledWith(
			"account-spare",
		),
	);
	await waitFor(() =>
		expect(props.resumeAfterHandoff).toHaveBeenCalledTimes(2),
	);
	mounted.rerender({
		...props,
		currentCredentialId: "account-spare",
		failure: {
			...props.failure,
			itemId: "third-failure",
			createdAtMs: props.failure.createdAtMs + 2000,
		},
	});
	await waitFor(() =>
		expect(mounted.result.current.view).toMatchObject({
			kind: "decided",
			decision: {
				kind: "refused",
				code: "no_available_account",
			},
		}),
	);
	expect(props.performAccountSwitch).toHaveBeenCalledTimes(2);
});
