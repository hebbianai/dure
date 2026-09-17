import { describe, expect, it } from "vitest";
import {
	projectRecentWork,
	type RecentWorkConversation,
} from "@/lib/sessions/recentWork";
import { managedAgentFixture, managedBindingFixture } from "@/test/agentFixtures";
import type { Agent, Project, Provider } from "@/types";

const NOW = 1_000_000;

const localProject: Project = {
	id: "local-project",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function agent(
	id: string,
	provider: Provider = "codex",
	conversationId?: string,
): Agent {
	return managedAgentFixture({
		id,
		name: id,
		provider,
		projectId: localProject.id,
		worktreePath: localProject.path,
		branch: "agent/work",
		sessionId: id,
		runtimeBinding: managedBindingFixture({
			sessionId: id,
			createIdempotencyKey: id,
		}),
		conversationId,
	});
}

function conversation(
	id: string,
	title: string,
	mtime: number,
	cwd = localProject.path,
	provider: Provider = "codex",
	patch: Partial<RecentWorkConversation> = {},
): RecentWorkConversation {
	return {
		provider,
		id,
		title,
		mtime,
		cwd,
		resumeCapability: "exact",
		executionLocation: "local",
		...patch,
	};
}

describe("recent session projection", () => {
	it("keeps provider-native history visible before any project or agent is registered", () => {
		const result = projectRecentWork({
			entries: [
				conversation(
					"conversation-before-dure",
					"Existing provider work",
					NOW,
					"/unregistered/repo",
				),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.total).toBe(1);
		expect(result.groups[0]).toMatchObject({
			name: "repo",
			cwd: "/unregistered/repo",
		});
		expect(result.groups[0]?.items[0]).toMatchObject({
			conversationId: "conversation-before-dure",
			action: {
				kind: "register_and_resume",
				decision: {
					kind: "register_or_import",
					cwd: "/unregistered/repo",
					workspaceRoot: "/unregistered/repo",
					workspaceKind: "standalone_folder",
					conversationId: "conversation-before-dure",
					defaultSelected: true,
				},
			},
		});
	});

	it("defers managed ownership and exact-resume decisions until activation", () => {
		const source = agent("source");
		const live = agent("live", "codex", "conversation-live");

		const result = projectRecentWork({
			entries: [
				conversation("conversation-old", "Older work", 10),
				conversation("conversation-live", "Live work", 20),
			],
			agents: [source, live],
			projects: [localProject],
			activity: { live: "waiting", source: "exited" },
			nowSeconds: NOW,
		});

		expect(result.groups[0].items.map((item) => item.action)).toMatchObject([
			{ kind: "register_and_resume" },
			{ kind: "register_and_resume" },
		]);
	});

	it("does not grant focus authority to a persisted managed owner candidate", () => {
		const stale = agent("agent-import", "claude", "conversation-design-labs");
		stale.worktreePath = "/repo/.worktrees/design-labs";

		const result = projectRecentWork({
			entries: [
				conversation(
					"conversation-design-labs",
					"Continued design work",
					NOW,
					"/repo/.worktrees/design-labs",
					"claude",
				),
			],
			agents: [stale],
			projects: [localProject],
			// Persisted Agents have no authoritative activity after a reload. The
			// exact Hmux session+workspace generation must be resolved on click.
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups[0].items[0]).toMatchObject({
			paneAgentIdCandidate: "agent-import",
			action: {
				kind: "register_and_resume",
			},
		});
	});

	it("does not hide history when a matching Dure agent is unmanaged", () => {
		const unmanaged = agent("legacy");
		unmanaged.runtimeBinding = {
			schemaVersion: 1,
			runtime: "legacy_session_v1",
			source: "local",
			hostId: "local",
			sessionId: "legacy",
		} as unknown as Agent["runtimeBinding"];
		const result = projectRecentWork({
			entries: [conversation("provider-history", "Still visible", 20)],
			agents: [unmanaged],
			projects: [localProject],
			activity: { legacy: "exited" },
			nowSeconds: NOW,
		});

		expect(result.total).toBe(1);
		expect(result.groups[0].items[0].action.kind).toBe("register_and_resume");
	});

	it("searches title cwd project label and provider before the global limit", () => {
		const source = agent("source");
		const result = projectRecentWork({
			entries: [
				conversation("one", "Overflow fix", 30),
				conversation("two", "Conversation UX", 20),
				conversation("three", "Other work", 10),
			],
			agents: [source],
			projects: [localProject],
			activity: { source: "exited" },
			query: "dure",
			limit: 2,
			nowSeconds: NOW,
		});

		expect(result.total).toBe(2);
		expect(result.groups[0].items.map((item) => item.conversationId)).toEqual([
			"one",
			"two",
		]);
	});

	it("searches and preserves bounded recent-turn previews", () => {
		const recentTurns = [
			{ role: "user" as const, text: "Find the session history needle" },
			{ role: "agent" as const, text: "The grouped card is ready" },
		];
		const result = projectRecentWork({
			entries: [
				conversation("preview", "Unrelated title", NOW, "/repo", "codex", {
					recentTurns,
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			query: "history needle",
			nowSeconds: NOW,
		});

		expect(result.total).toBe(1);
		expect(result.groups[0].items[0].recentTurns).toEqual(recentTurns);
	});

	it("preserves exact branch and the lightweight subagent count", () => {
		const result = projectRecentWork({
			entries: [
				conversation("details", "Unrelated title", NOW, "/repo", "codex", {
					branch: "agent/session-details",
					subagentCount: 1,
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			query: "session-details",
			nowSeconds: NOW,
		});

		expect(result.total).toBe(1);
		expect(result.groups[0].items[0]).toMatchObject({
			branch: "agent/session-details",
			subagentCount: 1,
		});
	});

	it("matches a transcript cwd to the longest known containing worktree", () => {
		const source = agent("source");
		source.worktreePath = "/repo/.worktrees/session-details";
		const result = projectRecentWork({
			entries: [
				conversation(
					"nested-cwd",
					"Nested working directory",
					NOW,
					"/repo/.worktrees/session-details/packages/app",
				),
			],
			agents: [source],
			projects: [localProject],
			activity: { source: "exited" },
			nowSeconds: NOW,
		});

		expect(result.groups[0].items[0]).toMatchObject({
			workspaceRoot: "/repo/.worktrees/session-details",
			action: { kind: "register_and_resume" },
		});
	});

	it("applies the 7-day default and 30-day visibility policy in the pure planner", () => {
		const day = 24 * 60 * 60;
		const result = projectRecentWork({
			entries: [
				conversation("recent", "Recent", NOW - 7 * day),
				conversation("available", "Available", NOW - 8 * day),
				conversation("boundary", "Boundary", NOW - 30 * day),
				conversation("hidden", "Hidden", NOW - 30 * day - 1),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
			limit: 10,
		});

		expect(
			result.groups[0].items.map((item) => [
				item.conversationId,
				item.defaultSelected,
			]),
		).toEqual([
			["recent", true],
			["available", false],
			["boundary", false],
		]);
	});

	it("keeps non-interactive provider history visible without selecting it by default", () => {
		const result = projectRecentWork({
			entries: [
				conversation("interactive", "Interactive", NOW, "/repo", "codex", {
					interactionKind: "interactive",
				}),
				conversation("one-shot", "One shot", NOW, "/repo", "codex", {
					interactionKind: "non_interactive",
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
			limit: 10,
		});

		expect(result.total).toBe(2);
		expect(
			result.groups[0].items.map((item) => [
				item.conversationId,
				item.defaultSelected,
				item.recencyBucket,
			]),
		).toEqual([
			["interactive", true, "recent"],
			["one-shot", false, "recent"],
		]);
	});

	it("does not propose a pane whose exact working directory no longer exists", () => {
		const result = projectRecentWork({
			entries: [
				conversation("available", "Available", NOW),
				conversation("removed", "Removed", NOW, "/removed/worktree", "codex", {
					workingDirectoryAvailable: false,
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
			limit: 10,
		});

		expect(result.total).toBe(1);
		expect(result.groups[0].items[0].conversationId).toBe("available");
	});

	it("groups linked worktrees by common-dir while preserving each exact cwd", () => {
		const common = "/repo/.git";
		const result = projectRecentWork({
			entries: [
				conversation("one", "One", NOW, "/repo", "codex", {
					repositoryRoot: "/repo",
					repositoryCommonDir: common,
				}),
				conversation(
					"two",
					"Two",
					NOW - 1,
					"/repo/.worktrees/two/src",
					"claude",
					{
						repositoryRoot: "/repo/.worktrees/two",
						repositoryCommonDir: common,
					},
				),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
			limit: 10,
		});

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].items.map((item) => item.cwd)).toEqual([
			"/repo",
			"/repo/.worktrees/two/src",
		]);
	});

	it("names a linked-worktree group from its canonical remote instead of the checkout directory", () => {
		const result = projectRecentWork({
			entries: [
				conversation(
					"komojini",
					"Coordinator work",
					NOW,
					"/projects/HebbianIDE/.worktrees/komojini-1",
					"codex",
					{
						repositoryRoot: "/projects/HebbianIDE/.worktrees/komojini-1",
						repositoryCommonDir: "/projects/HebbianIDE/.git",
						repositoryRemoteIdentity: "github.com/hebbianai/dure-internal",
					},
				),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups[0].name).toBe("dure-internal");
	});

	it("keeps remote records behind an explicit host-scoped import decision", () => {
		const result = projectRecentWork({
			entries: [
				conversation("remote", "Remote", NOW, "/srv/repo", "codex", {
					executionLocation: "ssh",
					hostId: "saved-host",
					repositoryRoot: "/srv/repo",
					repositoryCommonDir: "/srv/repo/.git",
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups[0].items[0].action).toMatchObject({
			kind: "needs_registration_decision",
			decision: {
				executionLocation: "ssh",
				hostId: "saved-host",
			},
		});
	});

	it("groups same-repository checkouts by origin while retaining their exact cwd", () => {
		const remote = "github.com/hebbianai/dure-internal";
		const result = projectRecentWork({
			entries: [
				conversation("main", "Main", NOW, "/projects/HebbianIDE", "codex", {
					repositoryRoot: "/projects/HebbianIDE",
					repositoryCommonDir: "/projects/HebbianIDE/.git",
					repositoryRemoteIdentity: remote,
				}),
				conversation(
					"copy",
					"Copy",
					NOW - 1,
					"/projects/HebbianIDE-copy",
					"codex",
					{
						repositoryRoot: "/projects/HebbianIDE-copy",
						repositoryCommonDir: "/projects/HebbianIDE-copy/.git",
						repositoryRemoteIdentity: remote,
					},
				),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].name).toBe("dure-internal");
		expect(result.groups[0].items.map((item) => item.cwd)).toEqual([
			"/projects/HebbianIDE",
			"/projects/HebbianIDE-copy",
		]);
	});

	it("uses the canonical remote name instead of a representative copy checkout", () => {
		const remote = "github.com/hebbianai/dure-internal";
		const result = projectRecentWork({
			entries: [
				conversation(
					"copy",
					"Copy",
					NOW,
					"/projects/HebbianIDE-copy",
					"codex",
					{
						repositoryRoot: "/projects/HebbianIDE-copy",
						repositoryCommonDir: "/projects/HebbianIDE-copy/.git",
						repositoryRemoteIdentity: remote,
					},
				),
				conversation("main", "Main", NOW - 1, "/projects/HebbianIDE", "codex", {
					repositoryRoot: "/projects/HebbianIDE",
					repositoryCommonDir: "/projects/HebbianIDE/.git",
					repositoryRemoteIdentity: remote,
				}),
				conversation(
					"linked",
					"Linked",
					NOW - 2,
					"/projects/HebbianIDE/.worktrees/komojini-1",
					"claude",
					{
						repositoryRoot: "/projects/HebbianIDE/.worktrees/komojini-1",
						repositoryCommonDir: "/projects/HebbianIDE/.git",
						repositoryRemoteIdentity: remote,
					},
				),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].name).toBe("dure-internal");
	});

	it("federates an unambiguous primary origin across hosts and preserves pane facts", () => {
		const remote = "github.com/acme/product";
		const result = projectRecentWork({
			entries: [
				conversation("local", "Local", NOW, "/local/product/src", "codex", {
					repositoryRoot: "/local/product",
					repositoryCommonDir: "/local/product/.git",
					repositoryRemoteIdentity: remote,
				}),
				conversation("host-a", "Host A", NOW - 1, "/srv/product", "claude", {
					executionLocation: "ssh",
					hostId: "host-a",
					repositoryRoot: "/srv/product",
					repositoryCommonDir: "/srv/product/.git",
					repositoryRemoteIdentity: remote,
				}),
			],
			agents: [],
			projects: [],
			activity: {},
			nowSeconds: NOW,
		});

		expect(result.groups).toHaveLength(1);
		expect(result.groups[0].name).toBe("product");
		expect(result.groups[0].items).toMatchObject([
			{ cwd: "/local/product/src", executionLocation: "local" },
			{ cwd: "/srv/product", executionLocation: "ssh", hostId: "host-a" },
		]);
	});

	it("focuses only the exact live host when provider ids collide across hosts", () => {
		const live = agent("live", "codex", "shared-id");
		live.runtimeBinding = {
			schemaVersion: 1,
			runtime: "legacy_ssh_session_v1",
			source: "ssh",
			hostId: "host-a",
			sessionId: "remote-live",
		} as unknown as Agent["runtimeBinding"];
		const result = projectRecentWork({
			entries: [
				conversation("shared-id", "Host A", NOW, "/srv/a", "codex", {
					executionLocation: "ssh",
					hostId: "host-a",
				}),
				conversation("shared-id", "Host B", NOW - 1, "/srv/b", "codex", {
					executionLocation: "ssh",
					hostId: "host-b",
				}),
			],
			agents: [live],
			projects: [localProject],
			activity: { live: "waiting" },
			nowSeconds: NOW,
		});

		expect(
			result.groups
				.flatMap((group) => group.items)
				.map((item) => item.action.kind),
		).toEqual(["focus", "needs_registration_decision"]);
	});
});
