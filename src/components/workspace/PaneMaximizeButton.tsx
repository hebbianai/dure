import type { IDockviewPanelHeaderProps } from "dockview-react";
import { Maximize2, Minimize2 } from "lucide-react";
import { PaneActionButton } from "@/components/workspace/PaneActionButton";
import { useDockviewPaneMaximized } from "@/components/workspace/useDockviewPaneMaximized";
import { t } from "@/lib/i18n";
import { toggleMaximizedPane } from "@/lib/workspace/pane/paneMaximize";

/** The pane header's Maximize / Restore toggle (#392). Maximized, the pane
 * covers the window's layout area; the rest returns unchanged on restore.
 * Grid panes only — a floating pane already sits above the layout. The same
 * toggle is a rebindable shortcut, and Esc also restores (paneShortcuts.ts). */
export function PaneMaximizeButton({
	api,
	containerApi,
}: Pick<IDockviewPanelHeaderProps, "api" | "containerApi">) {
	const state = useDockviewPaneMaximized(api, containerApi);
	if (!state) return null;
	const maximized = state === "maximized";
	return (
		<PaneActionButton
			label={
				maximized ? t("workspace.pane.restore") : t("workspace.pane.maximize")
			}
			onClick={() => {
				toggleMaximizedPane(containerApi, containerApi.getPanel(api.id));
			}}
			active={maximized}
		>
			{maximized ? <Minimize2 /> : <Maximize2 />}
		</PaneActionButton>
	);
}
