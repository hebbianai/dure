// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RecoveryObservation } from "@/lib/agents/accountRecoveryContract";
import type { LatestTurnFailure } from "@/lib/agents/chat/turnFailureReason";
import { usageRecent } from "@/lib/ipc";
import { useUsageLimitHandoff } from "./useUsageLimitHandoff";

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
	};
}

it("observes a new quota failure without executing an automatic account switch in any client", async () => {
	const props = input();
	const first = renderHook(() => useUsageLimitHandoff(props));
	renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(first.result.current.view.kind).not.toBe("deciding"),
	);
	expect(props.performAccountSwitch).not.toHaveBeenCalled();
});

it("switches only on an explicit request and retains the outcome across remount", async () => {
	const props = input();
	const first = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() => expect(first.result.current.view.kind).toBe("decided"));
	await act(async () => first.result.current.requestHandoff());
	expect(props.performAccountSwitch).toHaveBeenCalledExactlyOnceWith(
		"account-next",
	);
	expect(first.result.current.view).toMatchObject({
		kind: "handled",
		outcome: { toName: "Next" },
	});
	first.unmount();
	renderHook(() => useUsageLimitHandoff(props));
	await act(async () => {});
	expect(props.performAccountSwitch).toHaveBeenCalledOnce();
});

it("retains a failed manual attempt and retries only after another explicit request", async () => {
	const props = input(
		vi
			.fn()
			.mockRejectedValueOnce(new Error("account unavailable"))
			.mockResolvedValue({ kind: "completed" }),
	);
	const first = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() => expect(first.result.current.view.kind).toBe("decided"));
	await act(async () => {
		await expect(first.result.current.requestHandoff()).rejects.toThrow(
			"account unavailable",
		);
	});
	first.unmount();
	const next = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(next.result.current.view).toMatchObject({
			kind: "failed",
			decision: { kind: "handoff" },
		}),
	);
	expect(props.performAccountSwitch).toHaveBeenCalledOnce();
	await act(async () => next.result.current.requestHandoff());
	expect(props.performAccountSwitch).toHaveBeenCalledTimes(2);
});

function recovery(
	turnState: RecoveryObservation["turnState"],
): RecoveryObservation {
	return {
		attemptId: "server-attempt",
		failureItemId: "failed-row",
		createdAtMs: 100,
		target: {
			profile: {
				schemaVersion: 1,
				providerId: "codex",
				referenceId: "team",
				credentialGeneration: "generation-a",
			},
			name: "Team",
		},
		stopped: null,
		turnState,
	};
}

it.each(["prepared", "accepted", "uncertain"] as const)(
	"renders the shared %s outcome without a client resend",
	async (turnState) => {
		const props = input();
		const first = renderHook(() =>
			useUsageLimitHandoff({ ...props, recovery: recovery(turnState) }),
		);
		expect(first.result.current.view).toMatchObject({
			kind: "handled",
			outcome: {
				toName: "Team",
				resume: turnState === "accepted" ? "accepted" : "uncertain",
			},
		});
		await act(async () => {});
		expect(props.performAccountSwitch).not.toHaveBeenCalled();
	},
);

it("allows manual recovery after a server failure", async () => {
	const props = input();
	const failed = {
		...recovery(null),
		stopped: { kind: "failed", code: "runtime_unavailable" },
	} as const;
	const first = renderHook(
		({ observation }) =>
			useUsageLimitHandoff({ ...props, recovery: observation }),
		{ initialProps: { observation: failed as RecoveryObservation } },
	);
	await waitFor(() =>
		expect(first.result.current.view).toMatchObject({
			kind: "failed",
			decision: { kind: "handoff" },
		}),
	);
	await act(async () => first.result.current.requestHandoff());
	expect(first.result.current.view.kind).toBe("handled");
	expect(props.performAccountSwitch).toHaveBeenCalledOnce();
});

it("offers an explicitly requested alternative without usage readings", async () => {
	vi.mocked(usageRecent).mockRejectedValueOnce(new Error("usage unavailable"));
	const props = input();
	const first = renderHook(() => useUsageLimitHandoff(props));
	await waitFor(() =>
		expect(first.result.current.view).toMatchObject({
			kind: "decided",
			decision: { kind: "handoff" },
		}),
	);
	expect(props.performAccountSwitch).not.toHaveBeenCalled();
	await act(async () => first.result.current.requestHandoff());
	expect(props.performAccountSwitch).toHaveBeenCalledOnce();
});

it("does not announce an account move while the backend transition is pending", () => {
	const props = input();
	const result = renderHook(() =>
		useUsageLimitHandoff({ ...props, recovery: recovery(null) }),
	);
	expect(result.result.current.view).toEqual({ kind: "handled" });
});

it.each(["failed", "uncertain"] as const)(
	"shows a current %s recovery after the original quota row is no longer latest",
	(turnState) => {
		const props = input();
		const result = renderHook(() =>
			useUsageLimitHandoff({
				...props,
				failure:
					turnState === "failed"
						? {
								...props.failure,
								itemId: "resend-failed",
								reason: "provider_error",
							}
						: undefined,
				recovery: recovery(turnState),
			}),
		);
		expect(result.result.current.view.kind).toBe(
			turnState === "failed" ? "failed" : "handled",
		);
		expect(props.performAccountSwitch).not.toHaveBeenCalled();
	},
);
