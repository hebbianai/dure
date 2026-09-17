import { describe, expect, it } from "vitest";
import {
	buildOnboardingImportDraft,
	setOnboardingImportPaneSelected,
	type OnboardingImportProjection,
} from "@/lib/onboarding/onboardingImportDraft";
import { nudgeOnboardingImportPane } from "@/lib/onboarding/onboardingImportPaneOrder";

function draft() {
	const projection: OnboardingImportProjection = {
		total: 4,
		groups: [
			{
				id: "repo:dure",
				name: "Dure",
				cwd: "/repo",
				items: Array.from({ length: 4 }, (_, index) => ({
					key: `codex:${index}`,
					conversationId: `conversation-${index}`,
					title: `Session ${index}`,
					mtime: 100 - index,
					provider: "codex" as const,
					cwd: "/repo",
					workspaceRoot: "/repo",
					groupIdentity: "repo:dure",
					defaultSelected: true,
					executionLocation: "local" as const,
				})),
			},
		],
	};
	return buildOnboardingImportDraft(projection);
}

describe("nudgeOnboardingImportPane", () => {
	it("moves in the exact selected-pane sequence used by the layout", () => {
		const initial = draft();
		const desktop = initial.desktops[0];
		const keys = desktop.panes.map((pane) => pane.key);
		const withGap = setOnboardingImportPaneSelected(
			initial,
			desktop.id,
			keys[1],
			false,
		).draft;

		const previous = nudgeOnboardingImportPane(
			withGap,
			desktop.id,
			keys[2],
			"previous",
		).draft;
		expect(previous.desktops[0].panes.map((pane) => pane.key)).toEqual([
			keys[2],
			keys[0],
			keys[1],
			keys[3],
		]);

		const next = nudgeOnboardingImportPane(
			previous,
			desktop.id,
			keys[2],
			"next",
		).draft;
		expect(
			next.desktops[0].panes
				.filter((pane) => pane.selected)
				.map((pane) => pane.key),
		).toEqual([keys[0], keys[2], keys[3]]);
	});

	it("is a no-op at either selected boundary", () => {
		const initial = draft();
		const desktop = initial.desktops[0];
		expect(
			nudgeOnboardingImportPane(
				initial,
				desktop.id,
				desktop.panes[0].key,
				"previous",
			).draft,
		).toBe(initial);
		expect(
			nudgeOnboardingImportPane(
				initial,
				desktop.id,
				desktop.panes[3].key,
				"next",
			).draft,
		).toBe(initial);
	});
});
