import { t } from "@/lib/i18n";
import { withDesktopDockview } from "@/lib/workspace/dock";
import { dockPanelReference } from "@/lib/workspace/dock/dockPanelParameters";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

export function openMobileSimulatorPanelOnDesktop(desktopId: string): void {
	withDesktopDockview(desktopId, (api) => {
		const existing = api.panels.find(
			(panel) => dockPanelReference(panel).component === "mobileSimulator",
		);
		openOrFocusPanel({
			api,
			panelId: existing?.id ?? createPaneId(),
			component: "mobileSimulator",
			title: t("panels.mobile.title"),
			params: {},
		});
	});
}
