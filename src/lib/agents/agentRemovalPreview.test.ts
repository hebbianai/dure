import { describe, expect, it } from "vitest";
import { sameAgentRemovalPreview } from "@/lib/agents/agentRemovalPreview";
import { agentFixture } from "@/test/agentFixtures";

describe("Agent removal preview", () => {
	it("accepts already-absent cleanup but reconfirms expansion back to disk deletion", () => {
		const preview = {
			agents: [agentFixture()],
			worktree: { kind: "local" as const, repo: "/repo", wtPath: "/repo/agent" },
		};
		const absent = { ...preview, worktreeAlreadyAbsent: true };
		expect(sameAgentRemovalPreview(preview, absent)).toBe(true);
		expect(sameAgentRemovalPreview(absent, preview)).toBe(false);
	});
	it("requires confirmation again when the worktree plan changes", () => {
		const agent = agentFixture({ worktreePath: "/repo/.worktrees/agent" });
		const preview = {
			agents: [agent],
			worktree: {
				kind: "local" as const,
				repo: "/repo",
				wtPath: agent.worktreePath,
			},
		};

		expect(
			sameAgentRemovalPreview(preview, {
				...preview,
				worktree: { ...preview.worktree, repo: "/replacement" },
			}),
		).toBe(false);
	});
});
