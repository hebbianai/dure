import { describe, expect, it } from "vitest";
import { wireWorktree } from "./dureAgentRunWorktree";

describe("Agent Run worktree wire intent", () => {
	it("preserves the explicit destination alongside the immutable branch and base", () => {
		expect(
			wireWorktree({
				kind: "dedicated",
				branch: "agent/feature-x",
				baseCommitSha: "a".repeat(40),
				branchMode: "existing",
				checkoutPath: "/selected/work/feature-x",
			}),
		).toEqual({
			kind: "dedicated",
			branch: "agent/feature-x",
			base_commit_sha: "a".repeat(40),
			branch_mode: "existing",
			checkout_path: "/selected/work/feature-x",
		});
	});

	it("leaves the legacy default destination and service-resolved base absent", () => {
		expect(
			wireWorktree({ kind: "dedicated", branch: "agent/feature-x" }),
		).toEqual({
			kind: "dedicated",
			branch: "agent/feature-x",
		});
	});
});
