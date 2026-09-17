/** Guide entry policy and presentation; runtime ownership stays elsewhere. */
import type { IDockviewPanel } from "dockview-react";
import { addPanePreservingSizes } from "@/lib/workspace/pane/paneMutationSizing";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";
import { autoSplitPosition } from "@/lib/workspace/dock/gridPanePlacement";
import { dockviewRegistry as registry } from "@/lib/workspace/dock/dockRegistry";
import { t } from "@/lib/i18n";
import { shouldAutoOpenOnboarding } from "@/lib/onboarding/onboardingSteps";
import { useStore } from "@/store";

/** Reuse current guide content, including a restored view with a legacy ID. */
function ensureOnboardingPanel(desktopId: string): IDockviewPanel | undefined {
	const api = registry.get(desktopId);
	if (!api) return;
	const existing = api.panels.find((pane) => pane.api.component === "onboarding");
	if (existing) return existing;
	// 다른 opener와 같은 분할 규칙. 완전한 첫 실행에서는 이 pane 하나가 화면을
	// 채우고, 사용자가 이미 다른 pane을 열었다면 탭 뒤에 숨지 않고 나란히 둔다.
	const position = autoSplitPosition(api);
	return addPanePreservingSizes(api, {
		id: createPaneId(),
		component: "onboarding",
		title: t("common.getStarted"),
		params: {},
		...(position ? { position: position as never } : {}),
	});
}

/** An explicit user command selects the guide, including an existing one. */
export function openOnboardingPanel(desktopId: string): void {
	ensureOnboardingPanel(desktopId)?.api.setActive();
}

/** Automatic entry ensures the guide without overriding restored selection. */
export function maybeAutoOpenOnboarding(desktopId: string): void {
	const state = useStore.getState();
	const open = shouldAutoOpenOnboarding({
		projectCount: state.projects.length,
		dismissed: state.uiPrefs.onboardingDismissed,
	});
	if (open) ensureOnboardingPanel(desktopId);
}

/** 사용자가 가이드를 닫았다 — 다시 자동으로 띄우지 않는다. 저장하는 것은 이
 *  한 비트뿐이다(단계별 완료 플래그를 저장하면 실제 상태와 어긋난다). */
export function markOnboardingDismissed(): void {
	const store = useStore.getState();
	if (store.uiPrefs.onboardingDismissed) return;
	store.setUiPrefs({ onboardingDismissed: true });
}
