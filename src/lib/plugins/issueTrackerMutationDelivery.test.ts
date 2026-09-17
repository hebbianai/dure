import { describe, expect, it } from "vitest";

import { renderIssueTrackerTerminalCommand } from "@/lib/plugins/issueTrackerMutationDelivery";

const template = [
	"pnpm",
	"beads",
	"--",
	"mutate",
	"delete",
	"{issue_id}",
	"--force",
];

describe("issue tracker terminal command rendering", () => {
	it("renders one bounded command line for the issue", () => {
		expect(
			renderIssueTrackerTerminalCommand(template, "hebbian-frontend-3dll6"),
		).toBe("pnpm beads -- mutate delete hebbian-frontend-3dll6 --force");
	});

	it("refuses anything but a bounded template with one issue id", () => {
		for (const [candidate, issueId] of [
			[template, "Bad Id"],
			[template, "3dll6"],
			[["rm -rf", "{issue_id}"], "x-1"],
			[["pnpm", "beads;", "{issue_id}"], "x-1"],
			[["{issue_id}", "{issue_id}"], "x-1"],
			[["pnpm", "beads", "--", "mutate", "delete"], "x-1"],
			[[], "x-1"],
		] as [readonly string[], string][]) {
			expect(
				renderIssueTrackerTerminalCommand(candidate, issueId),
				`${candidate.join(" ")} / ${issueId}`,
			).toBeNull();
		}
	});
});
