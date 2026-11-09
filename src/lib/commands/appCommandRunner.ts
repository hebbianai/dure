// Runs registry commands through the code their shortcuts and menu items
// already use, and reads the app facts that decide which commands apply.

import type {
	AppCommandContext,
	RunnableAppCommandId,
} from "@/lib/commands/appCommands";
import { hasNextUp, goToNextUp } from "@/lib/agents/nextUpNavigation";
import { requestQuickDispatch } from "@/lib/agents/quickDispatch/quickDispatchActivation";
import { toggleDesignMode } from "@/lib/design/designModeRuntime";
import { requestPinpointBrowser } from "@/lib/design/pinpointBrowserActivation";
import { openTokenInspectorPanel } from "@/lib/design/tokenInspectorPane";
import { requestFeedback } from "@/lib/feedback/feedbackActivation";
import { openOnboardingPanel } from "@/lib/onboarding/onboardingEntry";
import { openSettingsPage } from "@/lib/settings/settingsBus";
import { useWindowSidebarStore } from "@/lib/sidebar/windowSidebarStore";
import { DEFAULT_TERMINAL_FONT_SIZE } from "@/lib/terminal/renderer/terminalFont";
import { openInheritedTerminalPanel } from "@/lib/workspace/dock";
import { getDockview } from "@/lib/workspace/dock/dockRegistry";
import { openBrowserPanelOnDesktop } from "@/lib/workspace/dock/openBrowserPanel";
import { openMobileSimulatorPanelOnDesktop } from "@/lib/workspace/dock/openMobileSimulatorPanel";
import { resolveEffectiveInterfaceMode } from "@/lib/workspace/pane/interfaceMode";
import {
	balanceActiveSpacePanes,
	canBalanceActiveSpacePanes,
	canUndoActivePaneMove,
	runPaneShortcutAction,
	toggleActivePaneMaximized,
	undoActivePaneMove,
} from "@/lib/workspace/pane/paneShortcuts";
import { closeActivePane } from "@/lib/workspace/window/windowShortcutHooks";
import { useStore } from "@/store";

export function readAppCommandContext(): AppCommandContext {
	const state = useStore.getState();
	return {
		hasActivePane: Boolean(getDockview(state.activeSpaceId)?.activePanel),
		canBalancePanes: canBalanceActiveSpacePanes(),
		canUndoPaneMove: canUndoActivePaneMove(),
		hasNextUp: hasNextUp(),
		devBuild: import.meta.env.DEV,
		proInterface:
			resolveEffectiveInterfaceMode(state.uiPrefs?.interfaceMode).mode === "pro",
	};
}

function activeSpaceId(): string {
	return useStore.getState().activeSpaceId;
}

function changeTerminalFontSize(size: number | ((current: number) => number)) {
	useStore.getState().setTerminalFontSize(size);
}

const RUNNERS: Record<RunnableAppCommandId, () => void> = {
	"quick-dispatch": () => requestQuickDispatch(),
	"toggle-sidebar": () => useWindowSidebarStore.getState().toggle(),
	"open-settings": () => openSettingsPage(),
	"close-pane": () => closeActivePane(),
	"new-desktop": () => useStore.getState().addSpace(),
	"focus-pane-previous": () => runPaneShortcutAction("focus-pane-previous"),
	"focus-pane-next": () => runPaneShortcutAction("focus-pane-next"),
	"go-to-next-up": () => goToNextUp(),
	"split-right": () => runPaneShortcutAction("split-right"),
	"split-below": () => runPaneShortcutAction("split-below"),
	"balance-panes": () => balanceActiveSpacePanes(),
	"focus-pane-left": () => runPaneShortcutAction("focus-pane-left"),
	"focus-pane-right": () => runPaneShortcutAction("focus-pane-right"),
	"focus-pane-up": () => runPaneShortcutAction("focus-pane-up"),
	"focus-pane-down": () => runPaneShortcutAction("focus-pane-down"),
	"toggle-maximize-pane": () => toggleActivePaneMaximized(),
	"undo-pane-move": () => undoActivePaneMove(),
	"font-inc": () => changeTerminalFontSize((size) => size + 1),
	"font-dec": () => changeTerminalFontSize((size) => size - 1),
	"font-reset": () => changeTerminalFontSize(DEFAULT_TERMINAL_FONT_SIZE),
	"pinpoint-self": () => void toggleDesignMode(),
	"pinpoint-browser": () => requestPinpointBrowser(),
	"send-feedback": () => requestFeedback(),
	"new-terminal": () => openInheritedTerminalPanel(activeSpaceId()),
	"open-browser": () => openBrowserPanelOnDesktop(activeSpaceId()),
	"open-mobile-simulator": () =>
		openMobileSimulatorPanelOnDesktop(activeSpaceId()),
	"open-onboarding": () => openOnboardingPanel(activeSpaceId()),
	"open-token-inspector": () => openTokenInspectorPanel(activeSpaceId()),
};

export function runAppCommand(id: RunnableAppCommandId): void {
	RUNNERS[id]();
}
