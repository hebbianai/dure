import {
	moveOnboardingImportPane,
	type OnboardingImportDraft,
	type OnboardingImportDraftMutation,
} from "@/lib/onboarding/onboardingImportDraft";

export type OnboardingImportPaneDirection = "previous" | "next";

/** Reorder one selected pane in the same sequence consumed by the layout plan. */
export function nudgeOnboardingImportPane(
	draft: OnboardingImportDraft,
	desktopId: string,
	paneKey: string,
	direction: OnboardingImportPaneDirection,
): OnboardingImportDraftMutation {
	const desktop = draft.desktops.find(
		(candidate) => candidate.id === desktopId,
	);
	if (!desktop) return { draft, error: "desktop_not_found" };
	const selected = desktop.panes.filter((pane) => pane.selected);
	const index = selected.findIndex((pane) => pane.key === paneKey);
	if (index < 0) return { draft, error: "pane_not_found" };
	if (direction === "previous") {
		if (index === 0) return { draft };
		return moveOnboardingImportPane(
			draft,
			paneKey,
			desktopId,
			desktopId,
			selected[index - 1].key,
		);
	}
	if (index === selected.length - 1) return { draft };
	return moveOnboardingImportPane(
		draft,
		paneKey,
		desktopId,
		desktopId,
		selected[index + 2]?.key,
	);
}
