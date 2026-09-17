import { describe, expect, it } from "vitest";
import {
	addOnboardingImportDesktop,
	buildOnboardingImportDraft,
	moveOnboardingImportPane,
	renameOnboardingImportDesktop,
	setOnboardingImportPaneSelected,
	type OnboardingImportProjection,
} from "@/lib/onboarding/onboardingImportDraft";
import { reconcileOnboardingImportDraft } from "@/lib/onboarding/onboardingImportReconcile";

function projection(
	items: readonly {
		key: string;
		mtime: number;
		title?: string;
		executionLocation?: "local" | "ssh";
		hostId?: string;
	}[],
): OnboardingImportProjection {
	return {
		total: items.length,
		groups: [
			{
				id: "repo:dure",
				name: "HebbianIDE",
				cwd: "/repo",
				items: items.map((item) => ({
					key: item.key,
					conversationId: item.key,
					title: item.title ?? item.key,
					mtime: item.mtime,
					provider: "codex" as const,
					cwd: `/repo/${item.key}`,
					workspaceRoot: "/repo",
					groupIdentity: "repo:dure",
					defaultSelected: true,
					executionLocation: item.executionLocation ?? "local",
					...(item.hostId ? { hostId: item.hostId } : {}),
					repositoryCommonDir: "/repo/.git",
				})),
			},
		],
	};
}

describe("reconcileOnboardingImportDraft", () => {
	it("preserves user names, selection, order, and moves while merging refreshes", () => {
		const initial = buildOnboardingImportDraft(
			projection([
				{ key: "a", mtime: 30 },
				{ key: "b", mtime: 20 },
				{ key: "c", mtime: 10 },
			]),
		);
		const withCustom = addOnboardingImportDesktop(initial).draft;
		const sourceId = withCustom.desktops[0].id;
		const customId = withCustom.desktops[1].id;
		const renamed = renameOnboardingImportDesktop(
			withCustom,
			sourceId,
			"Core",
		).draft;
		const deselected = setOnboardingImportPaneSelected(
			renamed,
			sourceId,
			"a",
			false,
		).draft;
		const moved = moveOnboardingImportPane(
			deselected,
			"b",
			sourceId,
			customId,
		).draft;
		const reordered = moveOnboardingImportPane(
			moved,
			"c",
			sourceId,
			sourceId,
			"a",
		).draft;
		const incoming = buildOnboardingImportDraft(
			projection([
				{ key: "a", mtime: 40, title: "A refreshed" },
				{ key: "b", mtime: 30 },
				{ key: "d", mtime: 20 },
			]),
		);

		const reconciled = reconcileOnboardingImportDraft(reordered, incoming, [
			"local",
		], "recent");

		expect(reconciled.desktops.map((desktop) => desktop.name)).toEqual([
			"Core",
			"Desktop 1",
		]);
		expect(reconciled.desktops[0].panes.map((pane) => pane.key)).toEqual([
			"a",
			"d",
		]);
		expect(reconciled.desktops[0].panes[0]).toMatchObject({
			title: "A refreshed",
			selected: false,
		});
		expect(reconciled.desktops[1].panes.map((pane) => pane.key)).toEqual(["b"]);
		expect(reconciled.discoveredCount).toBe(3);
	});

	it("retains pending or failed remote panes until that exact host succeeds", () => {
		const current = buildOnboardingImportDraft(
			projection([
				{ key: "local", mtime: 20 },
				{
					key: "remote",
					mtime: 10,
					executionLocation: "ssh",
					hostId: "ssh-dev",
				},
			]),
		);
		const incoming = buildOnboardingImportDraft(
			projection([{ key: "local", mtime: 30 }]),
		);

		const whileRemoteUnavailable = reconcileOnboardingImportDraft(
			current,
			incoming,
			["local"],
			"recent",
		);
		expect(
			whileRemoteUnavailable.desktops.flatMap((desktop) => desktop.panes),
		).toHaveLength(2);

		const afterRemoteSuccess = reconcileOnboardingImportDraft(
			whileRemoteUnavailable,
			incoming,
			["local", "ssh:ssh-dev"],
			"recent",
		);
		expect(
			afterRemoteSuccess.desktops.flatMap((desktop) => desktop.panes),
		).toHaveLength(1);
	});

	it("is idempotent and creates another desktop rather than a ninth pane", () => {
		const current = buildOnboardingImportDraft(
			projection(
				Array.from({ length: 8 }, (_, index) => ({
					key: `pane-${index}`,
					mtime: 100 - index,
				})),
			),
		);
		const incoming = buildOnboardingImportDraft(
			projection(
				Array.from({ length: 9 }, (_, index) => ({
					key: `pane-${index}`,
					mtime: 110 - index,
				})),
			),
		);

		const first = reconcileOnboardingImportDraft(current, incoming, ["local"], "recent");
		const second = reconcileOnboardingImportDraft(first, incoming, ["local"], "recent");

		expect(first.desktops.map((desktop) => desktop.panes.length)).toEqual([
			8, 1,
		]);
		expect(second).toEqual(first);
	});
});
