import { describe, expect, it, vi } from "vitest";
import {
	issueTrackerWatchSubscriberId,
	nextIssueTrackerSubscriberEpoch,
	releaseIssueTrackerWatchLease,
} from "@/lib/plugins/issueTrackerWatchLease";

const request = {
	plugin_id: "dure.beads",
	contribution_id: "dure.beads.issue-tracker",
	workspace_root: "/work/project",
	subscriber_id: "plugin-agent-claims:logical",
	subscriber_epoch: 7,
};

describe("issue tracker watch leases", () => {
	it("derives a bounded stable logical subscriber without exposing its identity", () => {
		const identity = [
			"dure.beads",
			"dure.beads.issue-tracker",
			"/private/work/project",
			["in_progress"],
		];
		const first = issueTrackerWatchSubscriberId(
			"plugin-agent-claims",
			identity,
		);

		expect(first).toBe(
			issueTrackerWatchSubscriberId("plugin-agent-claims", identity),
		);
		expect(first).not.toContain("/private/work/project");
		expect(first.length).toBeLessThanOrEqual(128);
		expect(
			issueTrackerWatchSubscriberId("plugin-agent-claims", [
				...identity,
				"another-view",
			]),
		).not.toBe(first);
	});

	it("allocates monotonically increasing JSON-safe subscriber epochs", () => {
		const first = nextIssueTrackerSubscriberEpoch();
		const second = nextIssueTrackerSubscriberEpoch();

		expect(second).toBeGreaterThan(first);
		expect(Number.isSafeInteger(first)).toBe(true);
		expect(second).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
	});

	it("retains the exact lease identity across bounded transport retries", async () => {
		const unsubscribe = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockRejectedValueOnce(new Error("still offline"))
			.mockResolvedValue(true);
		const delays: number[] = [];

		await expect(
			releaseIssueTrackerWatchLease(unsubscribe, request, async (delay) => {
				delays.push(delay);
			}),
		).resolves.toBe(true);
		expect(unsubscribe).toHaveBeenCalledTimes(3);
		expect(unsubscribe.mock.calls.every(([value]) => value === request)).toBe(
			true,
		);
		expect(delays).toEqual([50, 250]);
	});

	it("stops after the bounded retry budget", async () => {
		const unsubscribe = vi.fn().mockRejectedValue(new Error("offline"));

		await expect(
			releaseIssueTrackerWatchLease(unsubscribe, request, async () => {}),
		).resolves.toBe(false);
		expect(unsubscribe).toHaveBeenCalledTimes(4);
	});

	it("retries a false cleanup receipt until the exact lease is removed", async () => {
		const unsubscribe = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const delays: number[] = [];

		await expect(
			releaseIssueTrackerWatchLease(unsubscribe, request, async (delay) => {
				delays.push(delay);
			}),
		).resolves.toBe(true);
		expect(unsubscribe).toHaveBeenCalledTimes(3);
		expect(delays).toEqual([50, 250]);
	});
});
