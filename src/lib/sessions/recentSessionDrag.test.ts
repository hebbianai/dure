import { describe, expect, it } from "vitest";
import {
	parseRecentSessionDragPayload,
	recentSessionDragPayload,
} from "@/lib/sessions/recentSessionDrag";
import type { RecentWorkItem } from "@/lib/sessions/recentWork";

function item(overrides: Partial<RecentWorkItem> = {}): RecentWorkItem {
	return {
		key: "local\0claude\0conversation-1",
		conversationId: "conversation-1",
		title: "Resume the release",
		mtime: 1,
		provider: "claude",
		cwd: "/repo/app",
		workspaceRoot: "/repo",
		groupIdentity: "local\0/repo",
		defaultSelected: true,
		recencyBucket: "recent",
		executionLocation: "local",
		recentTurns: [],
		subagentCount: 0,
		action: {
			kind: "register_and_resume",
			decision: {
				kind: "register_or_import",
				provider: "claude",
				conversationId: "conversation-1",
				cwd: "/repo/app",
				workspaceRoot: "/repo",
				workspaceKind: "git_repository",
				groupIdentity: "local\0/repo",
				executionLocation: "local",
				title: "Resume the release",
				mtime: 1,
				defaultSelected: true,
			},
		},
		...overrides,
	};
}

describe("recent session drag payload", () => {
	it("projects only the exact local launch identity", () => {
		const payload = recentSessionDragPayload(item());
		expect(payload).toEqual({
			type: "recent-session",
			provider: "claude",
			conversationId: "conversation-1",
			executionLocation: "local",
			cwd: "/repo/app",
			workspaceRoot: "/repo",
		});
		expect(parseRecentSessionDragPayload(payload)).toEqual(payload);
	});

	it("keeps unregistered SSH history behind its explicit decision", () => {
		expect(
			recentSessionDragPayload(
				item({
					executionLocation: "ssh",
					hostId: "build-host",
					action: {
						kind: "needs_registration_decision",
						decision: {
							kind: "register_or_import",
							provider: "claude",
							conversationId: "conversation-1",
							cwd: "/repo/app",
							workspaceRoot: "/repo",
							workspaceKind: "git_repository",
							groupIdentity: "ssh\0build-host\0/repo",
							executionLocation: "ssh",
							hostId: "build-host",
							title: "Resume the release",
							mtime: 1,
							defaultSelected: true,
						},
					},
				}),
			),
		).toBeNull();
	});

	it("rejects provider, host, and owner combinations it cannot prove", () => {
		expect(
			parseRecentSessionDragPayload({
				type: "recent-session",
				provider: "unknown",
				conversationId: "conversation-1",
				executionLocation: "local",
				cwd: "/repo/app",
				workspaceRoot: "/repo",
			}),
		).toBeNull();
		expect(
			parseRecentSessionDragPayload({
				type: "recent-session",
				provider: "claude",
				conversationId: "conversation-1",
				executionLocation: "ssh",
				hostId: "build-host",
				cwd: "/repo/app",
				workspaceRoot: "/repo",
			}),
		).toBeNull();
	});
});
