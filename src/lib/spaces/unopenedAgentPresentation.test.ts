import { describe, expect, it } from "vitest";
import type { ProviderConversationRecord } from "@/lib/agents/providerConversationDiscovery";
import {
	indexUnopenedAgentConversations,
	resolveUnopenedAgentPresentation,
	unopenedAgentConversation,
} from "@/lib/spaces/unopenedAgentPresentation";
import type { Agent, Project } from "@/types";

const agent: Agent = {
	id: "agent-1",
	name: "agent-slug",
	provider: "claude",
	projectId: "project-local",
	worktreePath: "/repo/.worktrees/agent-slug",
	branch: "agent/agent-slug",
	sessionId: "session-1",
	sessionKind: "pty",
	conversationId: "conversation-1",
};

const localProject: Project = {
	id: "project-local",
	name: "Repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function record(
	overrides: Partial<ProviderConversationRecord> = {},
): ProviderConversationRecord {
	return {
		provider: "claude",
		id: "conversation-1",
		cwd: "/repo/.worktrees/agent-slug",
		title: "Provider thread title",
		mtime: 100,
		resumeCapability: "exact",
		executionLocation: "local",
		...overrides,
	};
}

describe("unopened agent conversation projection", () => {
	it("does not count a transcript file touch as conversation activity", () => {
		expect(resolveUnopenedAgentPresentation({
			agent,
			conversation: record({ mtime: 1_788_612_456 }),
			promptActivity: { text: "Actual earlier work", at: 1_788_396_429_463 },
		}).activityAt).toBe(1_788_396_429_463);
		expect(resolveUnopenedAgentPresentation({
			agent,
			conversation: record({ mtime: 1_788_612_456 }),
		}).activityAt).toBeUndefined();
	});

	it("shows exact Codex activity even when the recent inventory omits the conversation", () => {
		expect(resolveUnopenedAgentPresentation({
			agent: { ...agent, provider: "codex" },
			conversationActivityAt: 1_788_615_558_095,
		}).activityAt).toBe(1_788_615_558_095);
	});

	it("joins only the exact provider and execution location identity", () => {
		const exact = record();
		const index = indexUnopenedAgentConversations([
			record({ executionLocation: "ssh", hostId: "host-1", title: "Remote" }),
			record({ provider: "codex", title: "Other provider" }),
			exact,
		]);

		expect(unopenedAgentConversation(index, agent, localProject)).toBe(exact);
	});

	it("uses pane title precedence and the newest known activity timestamp", () => {
		const conversation = record({ mtime: 500 });
		expect(
			resolveUnopenedAgentPresentation({
				agent,
				liveConversationTitle: "Live thread title",
				conversationActivityAt: 100_000,
				liveSessionTitle: "Terminal session title",
				conversation,
				promptActivity: { text: "Latest prompt", at: 120_000 },
			}),
		).toEqual({ title: "Live thread title", activityAt: 120_000 });

		expect(
			resolveUnopenedAgentPresentation({
				agent: { ...agent, displayName: "My review" },
				conversationActivityAt: 100_000,
				liveConversationTitle: "Live thread title",
				conversation,
			}),
		).toEqual({ title: "My review", activityAt: 100_000 });
	});

	it("falls through opaque identities to session and history titles", () => {
		expect(
			resolveUnopenedAgentPresentation({
				agent,
				liveConversationTitle: "conversation-1",
				conversationActivityAt: 100_000,
				liveSessionTitle: "Terminal session title",
				conversation: record(),
			}),
		).toEqual({ title: "Terminal session title", activityAt: 100_000 });
	});

	it("does not replace a useful agent folder name with a provider fallback", () => {
		expect(
			resolveUnopenedAgentPresentation({
				agent,
				conversation: record({ title: "Claude Code" }),
				conversationActivityAt: 100_000,
			}),
		).toEqual({ title: "agent-slug", activityAt: 100_000 });
	});
});
