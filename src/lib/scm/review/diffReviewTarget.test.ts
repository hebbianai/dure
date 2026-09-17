import { describe, expect, it } from "vitest";
import {
	newDiffReviewId,
	reviewIdsFromLayouts,
	resolveDiffReviewTarget,
} from "@/lib/scm/review/diffReviewTarget";
import { agentFixture } from "@/test/agentFixtures";
import type { Agent } from "@/types";

function agent(overrides: Partial<Agent> = {}): Agent {
	return agentFixture({
		name: "Agent",
		worktreePath: "/repo/.worktrees/feature",
		branch: "feature",
		...overrides,
	});
}

describe("resolveDiffReviewTarget", () => {
	it("keeps the durable managed worktree authoritative", () => {
		expect(
			resolveDiffReviewTarget(
				{ agentId: "agent-1", cwd: "/untrusted/live/cwd" },
				agent(),
			),
		).toEqual({
			status: "ready",
			sourcePath: "/repo/.worktrees/feature",
			revisionLabel: "feature",
			feedbackAgentId: "agent-1",
		});
	});

	it("creates a durable review id from injected entropy", () => {
		expect(newDiffReviewId(() => "018f-aaaa")).toBe("review-018f-aaaa");
	});

	it("uses a standalone cwd without inventing an agent feedback route", () => {
		expect(
			resolveDiffReviewTarget({ cwd: "/repo/subdir " }, undefined),
		).toEqual({
			status: "ready",
			sourcePath: "/repo/subdir ",
			revisionLabel: "HEAD",
		});
	});

	it("fails closed for stale agents and empty managed or standalone paths", () => {
		expect(resolveDiffReviewTarget({ agentId: "deleted" }, undefined)).toEqual({
			status: "missing-agent",
		});
		expect(
			resolveDiffReviewTarget(
				{ agentId: "agent-1" },
				agent({ worktreePath: "  " }),
			),
		).toEqual({
			status: "missing-path",
		});
		expect(resolveDiffReviewTarget({}, undefined)).toEqual({
			status: "missing-path",
		});
	});
});

describe("reviewIdsFromLayouts", () => {
	it("collects only valid durable roots from every persisted desktop", () => {
		expect(
			reviewIdsFromLayouts({
				first: {
					panels: {
						"diff:agent-1": {
							contentComponent: "diff",
							params: { reviewId: "review-b" },
						},
						"term:1": {
							contentComponent: "terminal",
							params: { reviewId: "review-not-a-diff" },
						},
					},
				},
				second: {
					panels: {
						"diff:session:1": {
							contentComponent: "diff",
							params: { reviewId: "review-a" },
						},
						"diff:copy": {
							contentComponent: "diff",
							params: { reviewId: "review-b" },
						},
						"diff:invalid": {
							contentComponent: "diff",
							params: { reviewId: "bad id" },
						},
					},
				},
				stale: { panels: null },
			}),
		).toEqual(["review-a", "review-b"]);
	});

	it("uses explicit current Diff content without interpreting the pane spelling", () => {
		expect(
			reviewIdsFromLayouts({
				space: {
					panels: {
						"pane-review": {
							contentComponent: "diff",
							params: { reviewId: "review-current" },
						},
						"agent:previous": {
							component: "diff",
							params: { reviewId: "review-alias" },
						},
						"diff:changed": {
							contentComponent: "terminal",
							params: { reviewId: "review-old" },
						},
						"diff:unknown": {
							contentComponent: "unknown",
							params: { reviewId: "review-unknown" },
						},
						"diff:untyped": { params: { reviewId: "review-untyped" } },
						"diff:invalid": {
							contentComponent: "diff",
							params: { reviewId: "bad id" },
						},
					},
				},
			}),
		).toEqual(["review-alias", "review-current"]);
	});
});
