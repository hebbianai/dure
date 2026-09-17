// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	IssueTrackerIssueSummaryV1,
	IssueTrackerWatchEventV1,
} from "@/contracts/generated/extensionContracts";
import type { IssueTrackerClaimProjectionInput } from "@/lib/plugins/issueTrackerClaimConfiguration";
import {
	resetIssueTrackerClaimProjectionResourcesForTests,
	useIssueTrackerClaimProjection,
} from "./useIssueTrackerClaimProjection";
import { useIssueTrackerWatch } from "./useIssueTrackerWatch";

const ipc = vi.hoisted(() => ({
	query: vi.fn(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	listen: vi.fn(),
	listeners: new Set<(event: IssueTrackerWatchEventV1) => void>(),
}));

vi.mock("@/lib/ipc", () => ({
	dureIssueTrackerQuery: ipc.query,
	dureIssueTrackerWatchSubscribe: ipc.subscribe,
	dureIssueTrackerWatchUnsubscribe: ipc.unsubscribe,
	onDureIssueTrackerWatchEvent: ipc.listen,
}));

const input: IssueTrackerClaimProjectionInput = {
	pluginId: "example.tracker",
	contributionId: "example.issues",
	viewContributionId: "example.views",
	viewId: "claims",
	workspace: {
		root: "/work/project",
		projectId: "project",
		scopeKey: "local:project",
		watchKey: "local:project",
		source: "local",
	},
	statuses: ["working"],
	watchEnabled: true,
	intervalSeconds: 30,
	agentClaimPolicyEpoch: 1,
};

function issue(id: string): IssueTrackerIssueSummaryV1 {
	return {
		id,
		title: id,
		status: "working",
		priority: null,
		issue_type: "task",
		assignee: null,
		updated_at: null,
		dependency_count: 0,
		dependent_count: 0,
		agent_binding: null,
	};
}

function event(
	generation: number,
	revision: number,
	id: string,
): IssueTrackerWatchEventV1 {
	return {
		plugin_id: input.pluginId,
		contribution_id: input.contributionId,
		workspace_key: input.workspace.watchKey,
		generation,
		revision,
		state: {
			kind: "snapshot",
			revision_digest: id,
			snapshot: {
				issues: [issue(id)],
				issues_complete: true,
				human_issues: [],
				human_issues_complete: true,
				agent_claim_issues: [issue(id)],
				agent_claim_issues_complete: true,
			},
		},
	};
}

function subscription(
	generation: number,
	latest: IssueTrackerWatchEventV1 | null = null,
) {
	return {
		generation,
		workspace_key: input.workspace.watchKey,
		reused_watcher: false,
		latest,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

function emit(value: IssueTrackerWatchEventV1) {
	act(() => {
		for (const listener of ipc.listeners) listener(value);
	});
}

function useObservation(consumer: "issues" | "claims") {
	const [latest, setLatest] = useState<IssueTrackerWatchEventV1 | null>(null);
	useIssueTrackerWatch({
		enabled: consumer === "issues",
		...input,
		subscriberId: "issue-list",
		includeAgentClaims: false,
		onEvent: setLatest,
	});
	const claims = useIssueTrackerClaimProjection(
		consumer === "claims" ? input : null,
	);
	return consumer === "claims"
		? claims
		: {
				issues:
					latest?.state.kind === "snapshot" ? latest.state.snapshot.issues : [],
				error: latest?.state.kind === "unavailable" ? latest.state.code : null,
			};
}

beforeEach(() => {
	ipc.query.mockResolvedValue({
		kind: "list",
		issues: [issue("foreground")],
		complete: true,
	});
	ipc.subscribe.mockResolvedValue(subscription(7));
	ipc.unsubscribe.mockResolvedValue(true);
	ipc.listen.mockImplementation(
		async (listener: (value: IssueTrackerWatchEventV1) => void) => {
			ipc.listeners.add(listener);
			return () => {
				ipc.listeners.delete(listener);
			};
		},
	);
});

afterEach(() => {
	resetIssueTrackerClaimProjectionResourcesForTests();
	vi.resetAllMocks();
	ipc.listeners.clear();
});

describe.each(["issues", "claims"] as const)(
	"%s watch consumer",
	(consumer) => {
		it("converges pre-ack and out-of-order snapshots only within the acknowledged generation", async () => {
			const pending = deferred<ReturnType<typeof subscription>>();
			ipc.subscribe.mockReturnValueOnce(pending.promise);
			const hook = renderHook(() => useObservation(consumer));
			await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(1));
			emit(event(7, 3, "newest"));
			emit(event(7, 2, "older"));
			emit({ ...event(7, 99, "foreign"), contribution_id: "other.issues" });
			await act(async () =>
				pending.resolve(subscription(7, event(7, 1, "ack"))),
			);
			expect(hook.result.current.issues[0]?.id).toBe("newest");
			for (const stale of [
				event(7, 3, "duplicate"),
				event(7, 2, "older"),
				event(6, 99, "retired"),
				event(8, 99, "unacknowledged"),
			])
				emit(stale);
			expect(hook.result.current.issues[0]?.id).toBe("newest");
			emit(event(7, 4, "next"));
			expect(hook.result.current.issues[0]?.id).toBe("next");
			hook.unmount();
		});

		it("releases a delayed acknowledgement for the retired exact lease", async () => {
			const pending = deferred<ReturnType<typeof subscription>>();
			ipc.subscribe.mockReturnValueOnce(pending.promise);
			const hook = renderHook(() => useObservation(consumer));
			await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(1));
			const request = ipc.subscribe.mock.calls[0][0];
			hook.unmount();
			await waitFor(() =>
				expect(ipc.unsubscribe).toHaveBeenCalledWith(
					expect.objectContaining({
						subscriber_epoch: request.subscriber_epoch,
					}),
				),
			);
			await act(async () =>
				pending.resolve(subscription(7, event(7, 1, "late"))),
			);
			expect(ipc.unsubscribe).toHaveBeenLastCalledWith(
				expect.objectContaining({
					subscriber_epoch: request.subscriber_epoch,
					generation: 7,
				}),
			);
		});
	},
);

describe("retained claim observation", () => {
	it("retains revision order when another window keeps the same generation alive", async () => {
		const first = renderHook(() => useObservation("claims"));
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(1));
		emit(event(7, 20, "observed"));
		first.unmount();
		await waitFor(() => expect(ipc.unsubscribe).toHaveBeenCalledTimes(1));
		// Native can clear its cached claim snapshot when the last claim
		// subscriber leaves while an issue-only window retains the watcher.
		ipc.subscribe.mockResolvedValueOnce({
			...subscription(7),
			reused_watcher: true,
		});
		const second = renderHook(() => useObservation("claims"));
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(2));
		emit(event(7, 19, "delayed"));
		expect(second.result.current.issues[0]?.id).toBe("observed");
		emit(event(7, 21, "next"));
		expect(second.result.current.issues[0]?.id).toBe("next");
		second.unmount();
	});

	it("accepts a lower revision in a new generation after the last pane returns", async () => {
		const first = renderHook(() => useObservation("claims"));
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(1));
		emit(event(7, 20, "previous-generation"));
		expect(first.result.current.issues[0]?.id).toBe("previous-generation");
		first.unmount();
		await waitFor(() => expect(ipc.unsubscribe).toHaveBeenCalledTimes(1));
		ipc.subscribe.mockResolvedValueOnce(
			subscription(8, event(8, 1, "fresh-generation")),
		);
		const second = renderHook(() => useObservation("claims"));
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(2));
		expect(second.result.current.issues[0]?.id).toBe("fresh-generation");
		emit(event(7, 21, "late-previous-generation"));
		expect(second.result.current.issues[0]?.id).toBe("fresh-generation");
		expect(ipc.query).toHaveBeenCalledTimes(1);
		second.unmount();
	});

	it("does not replay an older foreground result when the next watch acknowledges without a snapshot", async () => {
		const first = renderHook(() => useObservation("claims"));
		await waitFor(() =>
			expect(first.result.current.issues[0]?.id).toBe("foreground"),
		);
		emit(event(7, 20, "observed"));
		first.unmount();
		await waitFor(() => expect(ipc.unsubscribe).toHaveBeenCalledTimes(1));
		ipc.subscribe.mockResolvedValueOnce(subscription(8));
		const second = renderHook(() => useObservation("claims"));
		expect(second.result.current.issues[0]?.id).toBe("observed");
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(2));
		expect(second.result.current.issues[0]?.id).toBe("observed");
		second.unmount();
	});

	it("does not let a retired subscribe failure change the resumed observation", async () => {
		const pending = deferred<ReturnType<typeof subscription>>();
		ipc.subscribe.mockReturnValueOnce(pending.promise);
		const first = renderHook(() => useObservation("claims"));
		await waitFor(() => expect(ipc.subscribe).toHaveBeenCalledTimes(1));
		first.unmount();
		await waitFor(() => expect(ipc.unsubscribe).toHaveBeenCalledTimes(1));
		ipc.subscribe.mockResolvedValueOnce(
			subscription(8, event(8, 1, "current")),
		);
		const second = renderHook(() => useObservation("claims"));
		await waitFor(() =>
			expect(second.result.current.issues[0]?.id).toBe("current"),
		);
		await act(async () => pending.reject(new Error("retired response lost")));
		expect(second.result.current.error).toBeNull();
		expect(second.result.current.issues[0]?.id).toBe("current");
		expect(ipc.subscribe).toHaveBeenCalledTimes(2);
		second.unmount();
	});
});
