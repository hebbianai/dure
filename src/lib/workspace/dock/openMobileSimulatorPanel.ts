import type { DockviewApi } from "dockview-react";
import { t } from "@/lib/i18n";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

export function openMobileSimulatorPanel(api: DockviewApi) {
	const existing = api.panels.find(
		(panel) => dockPanelReference(panel).component === "mobileSimulator",
	);
	const panelId = existing?.id ?? createPaneId();
	openOrFocusPanel({
		api,
		panelId,
		component: "mobileSimulator",
		title: t("panels.mobile.title"),
		params: {},
	});
	return { panelId, component: "mobileSimulator", reused: Boolean(existing) };
}

export function openMobileSimulatorPanelOnDesktop(desktopId: string): void {
	withDesktopDockview(desktopId, openMobileSimulatorPanel);
}
