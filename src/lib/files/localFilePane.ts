import { localFilePanePath } from "../../../cli/lib/contracts/local-file-pane.mjs";
import { openFileViewerOn } from "@/lib/files/fileViewerPane";
import { waitForDesktopDockview } from "@/lib/workspace/dock/dockRegistry";
import { PaneCommandError } from "@/lib/workspace/pane/paneCommandError";
import { useStore } from "@/store";

/** The GUI opener owns reuse, hidden panes, drafts and the renderer. The
 * receipt confirms placement; loading and read errors belong to the viewer. */
export async function openLocalFilePane(spaceId: string, path: string) {
	const target = {
		source: "local" as const,
		path: localFilePanePath(path, { absolute: true }),
	};
	const state = useStore.getState();
	if (!state.spaces.some((space) => space.id === spaceId)) {
		throw new PaneCommandError(
			"space_not_found",
			`Space ${spaceId} does not exist`,
		);
	}
	state.setActiveSpace(spaceId);
	const api = await waitForDesktopDockview(spaceId);
	if (!api)
		throw new Error(
			`Space ${spaceId} is not mounted; to show the file in front instead, use: dure client pane open file PATH --window`,
		);
	const existingIds = new Set(api.panels.map((pane) => pane.id));
	const pane = openFileViewerOn(api, target);
	return {
		panelId: pane.id,
		component: pane.api.component,
		file: target,
		mounted: true,
		reused: existingIds.has(pane.id),
	};
}
