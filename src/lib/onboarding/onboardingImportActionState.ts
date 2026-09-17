import {
	ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
	onboardingImportDraftBlocker,
	type OnboardingImportDraftBlocker,
	type OnboardingImportDraft,
} from "@/lib/onboarding/onboardingImportDraft";

export type OnboardingImportApplyState = "idle" | "applying" | "failed";

export type OnboardingImportActionState =
	| { kind: "applying" }
	| { kind: "ready" }
	| { kind: "retry" }
	| ({ kind: "blocked" } & OnboardingImportDraftBlocker);

export function onboardingImportActionState({
	draft,
	journalLocked,
	applyState,
	desktopPaneLimit = ONBOARDING_IMPORT_DESKTOP_PANE_LIMIT,
}: {
	draft: OnboardingImportDraft;
	journalLocked: boolean;
	applyState: OnboardingImportApplyState;
	desktopPaneLimit?: number;
}): OnboardingImportActionState {
	if (applyState === "applying") return { kind: "applying" };

	const blocker = onboardingImportDraftBlocker(draft, desktopPaneLimit);
	if (blocker) return { kind: "blocked", ...blocker };

	if (journalLocked || applyState === "failed") return { kind: "retry" };
	return { kind: "ready" };
}

export function onboardingImportActionEnabled(
	state: OnboardingImportActionState,
): boolean {
	return state.kind === "ready" || state.kind === "retry";
}
