// Token Inspector pane opener — one per Space.
import { dockviewRegistry as registry } from "@/lib/workspace/dock/dockRegistry";
import { openOrFocusPanel } from "@/lib/workspace/dock/openOrFocusPanel";
import { t } from "@/lib/i18n";
import { createPaneId } from "@/lib/workspace/pane/paneIdentity";

/** Open the Token Inspector pane (activate the existing one if present). */
export function openTokenInspectorPanel(desktopId: string): void {
	const api = registry.get(desktopId);
	if (!api) return;
	const existing = api.panels.find(
		(panel) => panel.api.component === "tokeninspector",
	);
	openOrFocusPanel({
		api,
		panelId: existing?.id ?? createPaneId(),
		component: "tokeninspector",
		title: t("design.tokenInspector.title"),
		params: {},
	});
}
