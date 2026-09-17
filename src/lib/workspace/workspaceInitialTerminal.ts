import { panelsFromLayout } from "@/lib/workspace/layout/layoutLifecycle";

export function shouldCreateDefaultInitialTerminal({
  projectCount,
  onboardingDismissed,
}: {
  projectCount: number;
  onboardingDismissed: boolean;
}): boolean {
	return projectCount > 0 || onboardingDismissed;
}

export function shouldCreateDefaultInitialTerminalFromState(state: {
	projects: readonly unknown[];
	uiPrefs: { onboardingDismissed: boolean };
}): boolean {
	return shouldCreateDefaultInitialTerminal({
		projectCount: state.projects.length,
		onboardingDismissed: state.uiPrefs.onboardingDismissed,
	});
}

export function shouldOpenPendingInitialTerminal({
  livePanelCount,
  persistedLayout,
}: {
  livePanelCount: number;
  persistedLayout: unknown;
}): boolean {
  if (livePanelCount > 0) return false;
  return panelsFromLayout(persistedLayout).length === 0;
}
