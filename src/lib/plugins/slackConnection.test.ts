import { describe, expect, it } from "vitest";
import {
	parseSlackConnection,
	parseSlackShare,
	slackConnectIntent,
	slackReference,
} from "@/lib/plugins/slackConnection";

it("accepts only the receipt for the requested Slack conversation and channel", () => {
	const intent = {
		requestId: "share-1",
		teamId: "T1",
		channelId: "C1",
		agentId: "agent-1",
		interactionSessionId: "conversation-1",
	};
	const receipt = { ...intent, state: "succeeded", threadTs: "200.001" };
	expect(parseSlackShare(receipt, intent)).toEqual({
		teamId: "T1",
		channelId: "C1",
		threadTs: "200.001",
	});
	for (const field of [
		"teamId",
		"channelId",
		"agentId",
		"interactionSessionId",
		"state",
		"threadTs",
	])
		expect(() =>
			parseSlackShare({ ...receipt, [field]: "different" }, intent),
		).toThrow();
});

describe("Slack connection form boundary", () => {
	it("normalizes copied links and preserves optional routes without sending empty token replacements", () => {
		expect(
			slackConnectIntent(
				{
					schemaVersion: 1,
					teamId: "https://app.slack.com/client/T1/C1",
					channels: [
						{
							channelId: "https://team.slack.com/archives/C2",
							projectId: " project-team ",
							providerId: " claude ",
							backend: " worker-two ",
							objective: " Continue the shared goal ",
							space: " Team ",
						},
					],
				},
				"",
				"",
			),
		).toEqual({
			config: {
				schemaVersion: 1,
				teamId: "T1",
				channels: [
					{
						channelId: "C2",
						projectId: "project-team",
						providerId: "claude",
						backend: "worker-two",
						objective: "Continue the shared goal",
						space: "Team",
					},
				],
			},
		});
		expect(slackReference("slack://open?team=T1&channel=D1", "channel")).toBe(
			"D1",
		);
		expect(slackReference("unresolved workspace", "workspace")).toBe(
			"unresolved workspace",
		);
	});
	it("returns only the public projection even if an older response includes additional private fields", () => {
		const connection = parseSlackConnection({
			config: {
				schemaVersion: 1,
				teamId: "T1",
				channels: [],
				appToken: "private",
			},
			enabled: true,
			credentialsConfigured: true,
			connection: "connected",
			generation: "g1",
			failure: null,
			appToken: "private",
			botToken: "private",
		});
		expect(JSON.stringify(connection)).not.toContain("private");
		expect(connection.config.channels).toEqual([]);
	});
});
