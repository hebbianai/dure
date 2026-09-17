import { describe, expect, it } from "vitest";
import { repositoryGroupKeyForProject } from "@/lib/spaces/spaceRepositoryGroups";
import { projectSpacesFacetHierarchy } from "@/lib/spaces/spacesFacetHierarchy";
import { spacesFacetGroupKey } from "@/lib/spaces/spacesViewProjection";

describe("projectSpacesFacetHierarchy", () => {
	it("owns nesting, fold visibility, focused context, and empty repositories", () => {
		const rows = [
			{
				key: "a",
				desktopId: "one",
				projectId: "p1",
				projectName: "Repo One",
				displayState: "blocked" as const,
			},
			{
				key: "a2",
				desktopId: "two",
				projectId: "p1",
				projectName: "Repo One",
				displayState: "blocked" as const,
			},
			{
				key: "b",
				desktopId: "two",
				projectId: "p2",
				projectName: "Repo Two",
				displayState: "working" as const,
			},
		];
		const blockedKey = spacesFacetGroupKey({
			axis: "status",
			value: "blocked",
		});
		const workingKey = spacesFacetGroupKey({
			axis: "status",
			value: "working",
		});
		const repoOneKey = repositoryGroupKeyForProject("p1");
		const repoTwoKey = repositoryGroupKeyForProject("p2");
		const projection = projectSpacesFacetHierarchy({
			rows,
			visibleRowKeys: new Set(rows.map((row) => row.key)),
			desktops: [
				{ id: "one", name: "One" },
				{ id: "two", name: "Two" },
			],
			projects: [
				{ id: "p1", name: "Repo One" },
				{ id: "p2", name: "Repo Two" },
				{ id: "p3", name: "Repo Three" },
			],
			axis: "status",
			nowMs: 0,
			includeEmptyRepositories: true,
			collapsed: { [blockedKey]: true },
			focusedRowKey: "a2",
		});

		expect(projection.groups.map((group) => group.key)).toEqual([
			blockedKey,
			workingKey,
		]);
		expect(projection.groups[0]?.repositoryGroups[0]?.desktops).toEqual([
			{ desktop: { id: "one", name: "One" }, spaces: [rows[0]] },
			{ desktop: { id: "two", name: "Two" }, spaces: [rows[1]] },
		]);
		expect(projection.groups[0]?.focusedRepository).toMatchObject({
			key: repoOneKey,
			spaces: [rows[1]],
			desktops: [{ desktop: { id: "two", name: "Two" }, spaces: [rows[1]] }],
		});
		expect(projection.selectionOrder).toEqual(["a2", "b"]);
		expect(projection.collapsibleGroupKeys).toEqual([
			blockedKey,
			workingKey,
			repoOneKey,
			repoTwoKey,
			repositoryGroupKeyForProject("p3"),
		]);
		expect(projection.visibleCollapsibleGroupKeys).toEqual([
			blockedKey,
			workingKey,
			repoTwoKey,
			repositoryGroupKeyForProject("p3"),
		]);
		expect(projection.trailingRepositories.map((group) => group.key)).toEqual([
			repositoryGroupKeyForProject("p3"),
		]);
	});
});
