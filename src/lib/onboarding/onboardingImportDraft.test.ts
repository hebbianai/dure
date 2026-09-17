import { describe, expect, it } from "vitest";
import {
	addOnboardingImportDesktop,
	buildOnboardingImportDraft,
	mergeOnboardingImportDesktops,
	moveOnboardingImportPane,
	onboardingImportCounts,
	onboardingImportDraftReady,
	onboardingImportLayout,
	onboardingImportLayoutPlan,
	renameOnboardingImportDesktop,
	setOnboardingImportDesktopIncluded,
	setOnboardingImportPaneSelected,
	splitOnboardingImportDesktop,
	type OnboardingImportProjection,
} from "@/lib/onboarding/onboardingImportDraft";

function projection(count: number, selectedCount = 3): OnboardingImportProjection {
	return {
		total: count,
		groups: [
			{
				id: "repo:hebbian",
				name: "HebbianIDE",
				cwd: "/repo",
				items: Array.from({ length: count }, (_, index) => ({
					key: `codex:${index}`,
					conversationId: `conversation-${index}`,
					title: `Conversation ${index}`,
					mtime: 100 - index,
					provider: "codex" as const,
					cwd: `/repo/worktree-${index}`,
					workspaceRoot: "/repo",
					groupIdentity: "repo:hebbian",
					defaultSelected: index < selectedCount,
					executionLocation: "local" as const,
				})),
			},
		],
	};
}

describe("buildOnboardingImportDraft", () => {
	it("chunks a repository into desktops of at most eight panes", () => {
		const draft = buildOnboardingImportDraft(projection(23));

		expect(draft.desktops.map((desktop) => desktop.name)).toEqual([
			"HebbianIDE 1",
			"HebbianIDE 2",
			"HebbianIDE 3",
		]);
		expect(draft.desktops.map((desktop) => desktop.panes.length)).toEqual([8, 8, 7]);
		expect(onboardingImportCounts(draft)).toEqual({
			desktopCount: 1,
			paneCount: 3,
		});
	});

	it("builds deterministic identities and keeps the projection selection", () => {
		const first = buildOnboardingImportDraft(projection(4));
		const second = buildOnboardingImportDraft(projection(4));

		expect(first).toEqual(second);
		expect(first.desktops[0].panes.map((pane) => pane.selected)).toEqual([
			true,
			true,
			true,
			false,
		]);
	});
});

describe("onboardingImportLayout", () => {
	it.each([
		[0, "empty", 0, 0],
		[1, "single", 1, 0],
		[2, "split", 2, 0],
		[4, "grid", 4, 0],
		[8, "grid", 8, 0],
	] as const)("recommends the bounded %s-pane layout", (count, kind, visible, tabbed) => {
		const desktop = buildOnboardingImportDraft(projection(8, count)).desktops[0];
		expect(onboardingImportLayout(desktop)).toEqual({
			kind,
			visiblePaneCount: visible,
			tabbedPaneCount: tabbed,
		});
	});

	it("plans three panes as one equal-width row", () => {
		const desktop = buildOnboardingImportDraft(projection(3, 3)).desktops[0];
		expect(onboardingImportLayoutPlan(desktop)).toMatchObject({
			columns: 3,
			rows: 1,
			cells: [
				{ row: 1, column: 1, rowSpan: 1 },
				{ row: 1, column: 2, rowSpan: 1 },
				{ row: 1, column: 3, rowSpan: 1 },
			],
			tabbedPaneKeys: [],
		});
	});

	it.each([
		[5, [2, 2, 1]],
		[7, [2, 2, 2, 1]],
	] as const)("plans %s panes in filled, column-first groups", (count, columnSizes) => {
		const desktop = buildOnboardingImportDraft(projection(count, count)).desktops[0];
		const plan = onboardingImportLayoutPlan(desktop);
		const plannedColumnSizes = Array.from({ length: plan.columns }, (_, index) =>
			plan.cells.filter((cell) => cell.column === index + 1).length,
		);

		expect(plannedColumnSizes).toEqual(columnSizes);
		expect(plan.cells[plan.cells.length - 1]).toMatchObject({ row: 1, rowSpan: 2 });
		expect(plan.tabbedPaneKeys).toEqual([]);
	});
});

describe("onboarding import draft edits", () => {
	it("adds an empty desktop that can receive panes by drag", () => {
		const initial = buildOnboardingImportDraft(projection(3));
		const added = addOnboardingImportDesktop(initial).draft;
		const custom = added.desktops[1];
		const pane = added.desktops[0].panes[0];
		const moved = moveOnboardingImportPane(
			added,
			pane.key,
			added.desktops[0].id,
			custom.id,
		).draft;

		expect(custom).toMatchObject({
			id: "import-custom-1",
			name: "Desktop 1",
			panes: [],
		});
		expect(moved.desktops[1].panes).toMatchObject([{ key: pane.key }]);
		expect(addOnboardingImportDesktop(added).draft.desktops[2].id).toBe(
			"import-custom-2",
		);
	});

	it("renames and excludes a desktop without changing its pane selections", () => {
		const initial = buildOnboardingImportDraft(projection(3));
		const id = initial.desktops[0].id;
		const renamed = renameOnboardingImportDesktop(initial, id, "Core").draft;
		const excluded = setOnboardingImportDesktopIncluded(renamed, id, false).draft;

		expect(excluded.desktops[0].name).toBe("Core");
		expect(excluded.desktops[0].panes.every((pane) => pane.selected)).toBe(true);
		expect(onboardingImportCounts(excluded)).toEqual({
			desktopCount: 0,
			paneCount: 0,
		});
	});

	it("does not allow a ninth selected pane", () => {
		const initial = buildOnboardingImportDraft(projection(9, 9));
		const firstDesktop = initial.desktops[0];
		const ninth = initial.desktops[1].panes[0];
		const moved = moveOnboardingImportPane(
			initial,
			ninth.key,
			initial.desktops[1].id,
			firstDesktop.id,
		);

		expect(moved.error).toBe("desktop_pane_limit");
		expect(moved.draft).toBe(initial);
	});

	it("moves an unchecked pane and can select it in its destination", () => {
		const base = projection(11);
		const initial = buildOnboardingImportDraft(base);
		const source = initial.desktops[1];
		const target = initial.desktops[0];
		const pane = source.panes[0];

		const moved = moveOnboardingImportPane(
			initial,
			pane.key,
			source.id,
			target.id,
		).draft;
		const selected = setOnboardingImportPaneSelected(
			moved,
			target.id,
			pane.key,
			true,
		).draft;

		const targetPanes = selected.desktops[0].panes;
		expect(targetPanes[targetPanes.length - 1]).toMatchObject({
			key: pane.key,
			selected: true,
		});
	});

	it("reorders panes within a desktop and inserts at an exact destination", () => {
		const initial = buildOnboardingImportDraft(projection(4));
		const desktop = initial.desktops[0];
		const keys = desktop.panes.map((pane) => pane.key);

		const reordered = moveOnboardingImportPane(
			initial,
			keys[3],
			desktop.id,
			desktop.id,
			keys[1],
		).draft;

		expect(reordered.desktops[0].panes.map((pane) => pane.key)).toEqual([
			keys[0],
			keys[3],
			keys[1],
			keys[2],
		]);
	});

	it("splits and merges a desktop while preserving exact pane records", () => {
		const initial = buildOnboardingImportDraft(projection(6));
		const source = initial.desktops[0];
		const movedKeys = source.panes.slice(4).map((pane) => pane.key);
		const split = splitOnboardingImportDesktop(
			initial,
			source.id,
			movedKeys,
			"HebbianIDE review",
		).draft;

		expect(split.desktops.map((desktop) => desktop.panes.length)).toEqual([4, 2]);
		const merged = mergeOnboardingImportDesktops(
			split,
			split.desktops[1].id,
			split.desktops[0].id,
		).draft;
		expect(merged.desktops[0].panes.map((pane) => pane.key).sort()).toEqual(
			source.panes.map((pane) => pane.key).sort(),
		);
	});

	it("requires a selected pane and non-empty included desktop name", () => {
		const initial = buildOnboardingImportDraft(projection(1));
		const desktop = initial.desktops[0];
		expect(onboardingImportDraftReady(initial)).toBe(true);

		const emptyName = renameOnboardingImportDesktop(
			initial,
			desktop.id,
			"  ",
		).draft;
		expect(onboardingImportDraftReady(emptyName)).toBe(false);

		const unchecked = setOnboardingImportPaneSelected(
			initial,
			desktop.id,
			desktop.panes[0].key,
			false,
		).draft;
		expect(onboardingImportDraftReady(unchecked)).toBe(false);
	});
});
