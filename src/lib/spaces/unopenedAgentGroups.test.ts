import { describe, expect, it } from "vitest";
import { groupSpacesByRepository } from "@/lib/spaces/spaceRepositoryGroups";
import {
	UNOPENED_SECTION_FOLD_KEY,
	unopenedFoldKey,
	unopenedRepositoryRow,
} from "@/lib/spaces/unopenedAgentGroups";

describe("unopenedFoldKey", () => {
	it("namespaces the repository key so the open list's fold stays separate", () => {
		expect(unopenedFoldKey('["project","p1"]')).toBe('unopened ["project","p1"]');
		expect(unopenedFoldKey("x")).not.toBe("x");
		expect(UNOPENED_SECTION_FOLD_KEY).toBe("unopened");
	});
});

describe("unopenedRepositoryRow", () => {
	const row = (id: string, projectId: string, projectName: string) => ({
		agent: { id, projectId, worktreePath: `/work/${projectId}/wt-${id}` },
		projectName,
		unread: false,
	});

	it("keys the row by its registered project and keeps the row itself", () => {
		const mapped = unopenedRepositoryRow(row("a", "p1", "Repo One"));
		expect(mapped.key).toBe("a");
		expect(mapped.projectId).toBe("p1");
		expect(mapped.cwd).toBe("/work/p1/wt-a");
		expect(mapped.unread).toBe(false);
	});

	it("groups through the same repository grouping as the open list, in order", () => {
		const groups = groupSpacesByRepository(
			[row("a", "p1", "Repo One"), row("c", "p2", "Repo Two"), row("b", "p1", "Repo One")].map(
				unopenedRepositoryRow,
			),
		);
		expect(groups.map((group) => [group.key, group.spaces.map((r) => r.key)])).toEqual([
			['["project","p1"]', ["a", "b"]],
			['["project","p2"]', ["c"]],
		]);
	});
});
