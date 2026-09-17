// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetIssueTrackerClaimProjectionResourcesForTests,
	useIssueTrackerClaimProjection,
} from "@/components/plugins/useIssueTrackerClaimProjection";
import type {
	IssueTrackerIssueSummaryV1,
	IssueTrackerQueryResultV1,
	IssueTrackerWatchEventV1,
} from "@/contracts/generated/extensionContracts";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	subscribe: vi.fn(),
	unsubscribe: vi.fn(),
	listen: vi.fn(),
	watchListeners: [] as Array<(event: IssueTrackerWatchEventV1) => void>,
}));

vi.mock("@/lib/ipc", () => ({
	dureIssueTrackerQuery: mocks.query,
	dureIssueTrackerWatchSubscribe: mocks.subscribe,
	dureIssueTrackerWatchUnsubscribe: mocks.unsubscribe,
	onDureIssueTrackerWatchEvent: mocks.listen,
}));

function resetWatchListenerMock() {
	mocks.listen.mockReset();
	mocks.listen.mockImplementation(
		async (callback: (event: IssueTrackerWatchEventV1) => void) => {
			mocks.watchListeners.push(callback);
			return vi.fn();
		},
	);
}

resetWatchListenerMock();

beforeEach(() => {
	mocks.unsubscribe.mockResolvedValue(true);
});

const workspace = {
	root: "/work/project",
	projectId: "project-1",
	scopeKey: "local:local:project-1",
	watchKey: "local:local:project-1",
	source: "local" as const,
};
const input = {
	pluginId: "dure.beads",
	viewContributionId: "dure.beads.views",
	viewId: "dure.beads.issues.list",
	contributionId: "dure.beads.issue-tracker",
	workspace,
	statuses: ["in_progress"],
	watchEnabled: true,
	intervalSeconds: 30,
	agentClaimPolicyEpoch: 1,
};

function issue(id: string, title: string): IssueTrackerIssueSummaryV1 {
	return {
		id,
		title,
		status: "in_progress",
		priority: 1,
		issue_type: "task",
		assignee: null,
		updated_at: null,
		dependency_count: 0,
		dependent_count: 0,
		agent_binding: { kind: "scm_branch", branch: "agent/test" },
	};
}

function listResult(
	row: IssueTrackerIssueSummaryV1,
): IssueTrackerQueryResultV1 {
	return { kind: "list", issues: [row], complete: true };
}

function watchEvent(row: IssueTrackerIssueSummaryV1): IssueTrackerWatchEventV1 {
	return {
		plugin_id: "dure.beads",
		contribution_id: "dure.beads.issue-tracker",
		workspace_key: workspace.watchKey,
		generation: 7,
		revision: 3,
		state: {
			kind: "snapshot",
			revision_digest: "new",
			snapshot: {
				issues: [],
				issues_complete: true,
				human_issues: [],
				human_issues_complete: true,
				agent_claim_issues: [row],
				agent_claim_issues_complete: true,
			},
		},
	};
}

afterEach(() => {
	resetIssueTrackerClaimProjectionResourcesForTests();
	mocks.query.mockReset();
	mocks.subscribe.mockReset();
	mocks.unsubscribe.mockReset();
	mocks.watchListeners.length = 0;
	resetWatchListenerMock();
	vi.useRealTimers();
});

describe("useIssueTrackerClaimProjection", () => {
	it("shares one query and watcher across all agent panes", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});
		const first = renderHook(() => useIssueTrackerClaimProjection(input));
		const second = renderHook(() => useIssueTrackerClaimProjection(input));

		await waitFor(() =>
			expect(first.result.current.issues[0]?.id).toBe("bd-1"),
		);
		expect(second.result.current.issues[0]?.id).toBe("bd-1");
		expect(mocks.query).toHaveBeenCalledTimes(1);
		expect(mocks.subscribe).toHaveBeenCalledTimes(1);
		expect(mocks.subscribe).toHaveBeenCalledWith(
			expect.objectContaining({
				include_agent_claims: true,
				agent_claim_policy_epoch: 1,
				subscriber_epoch: expect.any(Number),
			}),
		);
		expect(mocks.query).toHaveBeenCalledWith(
			expect.objectContaining({ agent_claim_policy_epoch: 1 }),
		);

		first.unmount();
		expect(mocks.unsubscribe).not.toHaveBeenCalled();
		second.unmount();
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
	});

	it("does not let an older foreground query overwrite a newer watcher snapshot", async () => {
		let resolveQuery!: (result: IssueTrackerQueryResultV1) => void;
		mocks.query.mockReturnValue(
			new Promise<IssueTrackerQueryResultV1>((resolve) => {
				resolveQuery = resolve;
			}),
		);
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});
		const hook = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(mocks.watchListeners).toHaveLength(1));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));

		act(() => mocks.watchListeners[0](watchEvent(issue("bd-new", "New"))));
		await waitFor(() =>
			expect(hook.result.current.issues[0]?.id).toBe("bd-new"),
		);
		await act(async () => {
			resolveQuery(listResult(issue("bd-old", "Old")));
		});
		expect(hook.result.current.issues[0]?.id).toBe("bd-new");
	});

	it("preserves foreground rows but fails closed when the watch listener is unavailable", async () => {
		mocks.listen.mockRejectedValueOnce(new Error("listener offline"));
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Claimed")));

		const hook = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(hook.result.current.loading).toBe(false));

		expect(hook.result.current.issues.map((row) => row.id)).toEqual(["bd-1"]);
		expect(hook.result.current.complete).toBe(false);
		expect(hook.result.current.error).toContain(
			"issue_tracker_watch_listener_failed",
		);
		expect(hook.result.current.error).toContain("listener offline");
		expect(mocks.subscribe).not.toHaveBeenCalled();
		hook.unmount();
	});

	it("recovers automatically after a transient watch listener failure", async () => {
		vi.useFakeTimers();
		mocks.listen.mockRejectedValueOnce(new Error("listener offline"));
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Claimed")));
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});
		const hook = renderHook(() => useIssueTrackerClaimProjection(input));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(hook.result.current.error).toContain(
			"issue_tracker_watch_listener_failed",
		);
		expect(mocks.listen).toHaveBeenCalledTimes(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(250);
		});
		expect(mocks.listen).toHaveBeenCalledTimes(2);
		expect(mocks.subscribe).toHaveBeenCalledTimes(1);
		expect(hook.result.current.issues.map((row) => row.id)).toEqual(["bd-1"]);
		expect(hook.result.current.complete).toBe(true);
		expect(hook.result.current.error).toBeNull();
	});

	it("retries a failed subscription with a new epoch and releases the old lease exactly", async () => {
		vi.useFakeTimers();
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Claimed")));
		mocks.subscribe
			.mockRejectedValueOnce(new Error("subscribe offline"))
			.mockResolvedValueOnce({
				workspace_key: workspace.watchKey,
				generation: 8,
				reused_watcher: false,
				latest: null,
			});

		const hook = renderHook(() => useIssueTrackerClaimProjection(input));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(mocks.subscribe).toHaveBeenCalledTimes(1);
		const firstLease = mocks.subscribe.mock.calls[0][0];
		expect(hook.result.current.issues.map((row) => row.id)).toEqual(["bd-1"]);
		expect(hook.result.current.complete).toBe(false);
		expect(hook.result.current.error).toContain(
			"issue_tracker_watch_subscribe_failed",
		);
		expect(mocks.unsubscribe).toHaveBeenCalledWith({
			plugin_id: input.pluginId,
			contribution_id: input.contributionId,
			workspace_root: input.workspace.root,
			subscriber_id: firstLease.subscriber_id,
			subscriber_epoch: firstLease.subscriber_epoch,
		});

		await act(async () => {
			await vi.advanceTimersByTimeAsync(249);
		});
		expect(mocks.subscribe).toHaveBeenCalledTimes(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});

		expect(mocks.subscribe).toHaveBeenCalledTimes(2);
		const secondLease = mocks.subscribe.mock.calls[1][0];
		expect(secondLease.subscriber_id).toBe(firstLease.subscriber_id);
		expect(secondLease.subscriber_epoch).toBeGreaterThan(
			firstLease.subscriber_epoch,
		);
		expect(hook.result.current.issues.map((row) => row.id)).toEqual(["bd-1"]);
		expect(hook.result.current.complete).toBe(true);
		expect(hook.result.current.error).toBeNull();
		hook.unmount();
	});

	it("keeps a complete foreground result when watching is disabled", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Claimed")));

		const hook = renderHook(() =>
			useIssueTrackerClaimProjection({ ...input, watchEnabled: false }),
		);
		await waitFor(() => expect(hook.result.current.loading).toBe(false));

		expect(hook.result.current.issues.map((row) => row.id)).toEqual(["bd-1"]);
		expect(hook.result.current.complete).toBe(true);
		expect(hook.result.current.error).toBeNull();
		expect(mocks.listen).not.toHaveBeenCalled();
		expect(mocks.subscribe).not.toHaveBeenCalled();
		hook.unmount();
	});

	it("replaces a remounted logical subscriber with a newer epoch", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});

		const first = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
		const firstLease = mocks.subscribe.mock.calls[0][0];
		first.unmount();
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));

		const second = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
		const secondLease = mocks.subscribe.mock.calls[1][0];
		expect(secondLease.subscriber_id).toBe(firstLease.subscriber_id);
		expect(secondLease.subscriber_epoch).toBeGreaterThan(
			firstLease.subscriber_epoch,
		);
		expect(mocks.unsubscribe).toHaveBeenCalledWith(
			expect.objectContaining({
				subscriber_id: firstLease.subscriber_id,
				subscriber_epoch: firstLease.subscriber_epoch,
				generation: 7,
			}),
		);
		second.unmount();
	});

	it("keeps the snapshot and skips the foreground query when a pane returns inside the disposal grace", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});

		const first = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(first.result.current.issues).toHaveLength(1));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
		first.unmount();
		// The watcher lease goes back at once: a hidden pane must not keep a
		// backend cycle alive.
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));

		const second = renderHook(() => useIssueTrackerClaimProjection(input));
		expect(second.result.current.issues).toHaveLength(1);
		expect(second.result.current.loading).toBe(false);
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
		expect(mocks.query).toHaveBeenCalledTimes(1);
		second.unmount();
	});

	it("releases the exact epoch when a subscribe response is lost", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockRejectedValue(new Error("response lost"));

		const hook = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalled());
		const subscribeRequest = mocks.subscribe.mock.calls[0][0];
		expect(mocks.unsubscribe.mock.calls[0][0]).toEqual({
			plugin_id: input.pluginId,
			contribution_id: input.contributionId,
			workspace_root: input.workspace.root,
			subscriber_id: subscribeRequest.subscriber_id,
			subscriber_epoch: subscribeRequest.subscriber_epoch,
		});
		hook.unmount();
	});

	it("releases again with the generation when subscribe resolves after unmount", async () => {
		let resolveSubscribe!: (value: {
			workspace_key: string;
			generation: number;
			reused_watcher: boolean;
			latest: null;
		}) => void;
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockReturnValue(
			new Promise((resolve) => {
				resolveSubscribe = resolve;
			}),
		);

		const hook = renderHook(() => useIssueTrackerClaimProjection(input));
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
		const request = mocks.subscribe.mock.calls[0][0];
		hook.unmount();
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
		expect(mocks.unsubscribe.mock.calls[0][0]).not.toHaveProperty("generation");

		await act(async () => {
			resolveSubscribe({
				workspace_key: workspace.watchKey,
				generation: 9,
				reused_watcher: false,
				latest: null,
			});
		});
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(2));
		expect(mocks.unsubscribe.mock.calls[1][0]).toEqual({
			plugin_id: input.pluginId,
			contribution_id: input.contributionId,
			workspace_root: input.workspace.root,
			subscriber_id: request.subscriber_id,
			subscriber_epoch: request.subscriber_epoch,
			generation: 9,
		});
	});

	it("keeps separate declarative views on separate logical leases", async () => {
		mocks.query.mockResolvedValue(listResult(issue("bd-1", "Shared")));
		mocks.subscribe.mockResolvedValue({
			workspace_key: workspace.watchKey,
			generation: 7,
			reused_watcher: false,
			latest: null,
		});

		const first = renderHook(() => useIssueTrackerClaimProjection(input));
		const second = renderHook(() =>
			useIssueTrackerClaimProjection({
				...input,
				viewContributionId: "dure.beads.alternate-views",
				intervalSeconds: 60,
			}),
		);
		await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(2));
		expect(mocks.subscribe.mock.calls[0][0].subscriber_id).not.toBe(
			mocks.subscribe.mock.calls[1][0].subscriber_id,
		);

		first.unmount();
		await waitFor(() => expect(mocks.unsubscribe).toHaveBeenCalledTimes(1));
		expect(mocks.unsubscribe.mock.calls[0][0].subscriber_id).not.toBe(
			mocks.subscribe.mock.calls[1][0].subscriber_id,
		);
		second.unmount();
	});
});
