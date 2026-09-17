import { describe, expect, it } from "vitest";
import type { IssueTrackerWatchEventV1 } from "@/contracts/generated/extensionContracts";
import { IssueTrackerWatchReceiver } from "./issueTrackerWatchReceiver";

const identity = {
	pluginId: "tracker",
	contributionId: "issues",
	workspaceKey: "workspace",
};
function event(generation: number, revision: number): IssueTrackerWatchEventV1 {
	return {
		plugin_id: identity.pluginId,
		contribution_id: identity.contributionId,
		workspace_key: identity.workspaceKey,
		generation,
		revision,
		state: { kind: "unavailable", code: "tracker_offline" },
	};
}
function subscription(
	generation: number,
	latest: IssueTrackerWatchEventV1 | null = null,
) {
	return {
		workspace_key: identity.workspaceKey,
		generation,
		latest,
		reused_watcher: false,
	};
}

describe("issue tracker watch receiver", () => {
	it("bounds pre-ack delivery to the newest event across generations", () => {
		const receiver = new IssueTrackerWatchReceiver(identity);
		for (let revision = 0; revision < 1000; revision += 1) {
			expect(receiver.receive(event(3, revision))).toBeNull();
		}
		receiver.receive(event(4, 0));
		receiver.receive(event(3, 1001));
		expect(receiver.generation).toBeNull();
		expect(receiver.acknowledge(subscription(4))).toEqual([event(4, 0)]);
	});

	it("rejects other identities and unknown generations without advancing the current cursor", () => {
		const receiver = new IssueTrackerWatchReceiver(identity);
		receiver.acknowledge(subscription(4));
		for (const foreign of [
			{ ...event(4, 99), plugin_id: "another" },
			{ ...event(4, 99), contribution_id: null },
			{ ...event(4, 99), workspace_key: "another" },
			event(5, 99),
			event(3, 99),
		])
			expect(receiver.receive(foreign)).toBeNull();
		expect(receiver.receive(event(4, 1))).toEqual(event(4, 1));
		expect(receiver.acknowledge(subscription(5))).toEqual([]);
		expect(receiver.generation).toBe(4);
	});

	it("renews the request while preserving only the matching generation's cursor", () => {
		const first = new IssueTrackerWatchReceiver(identity);
		first.acknowledge(subscription(4, event(4, 100)));
		const renewed = first.renew();
		expect(renewed.generation).toBeNull();
		expect(renewed.acknowledge(subscription(4, event(4, 99)))).toEqual([]);
		expect(renewed.receive(event(4, 101))).toEqual(event(4, 101));
		const restarted = renewed.renew();
		expect(restarted.acknowledge(subscription(5, event(5, 0)))).toEqual([
			event(5, 0),
		]);
		expect(restarted.receive(event(4, 102))).toBeNull();
	});
});
